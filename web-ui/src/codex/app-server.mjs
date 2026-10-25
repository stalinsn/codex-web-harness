// Supervises one `codex app-server` child process and speaks JSON-RPC over stdio.
// One instance per Codex account (CODEX_HOME); it reconnects automatically.
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import readline from 'node:readline';

const RESTART_DELAY_MS = 1800;
const ACCOUNT_REFRESH_MS = 60_000;
const WRITER_LOCK = /already has an active writer/i;

export const isWriterLockError = (error) => WRITER_LOCK.test(String(error?.message || ''));

export class CodexAppServer {
  constructor({ bin, homeDir, codexHome, emit }) {
    this.bin = bin;
    this.homeDir = homeDir;
    this.codexHome = codexHome;
    this.emit = emit;
    this.child = null;
    this.ready = false;
    this.stopped = false;
    this.restartTimer = null;
    this.nextRequestId = 1;
    this.rpcPending = new Map();
    // Requests the app-server sent to us (approvals), keyed by String(id).
    this.pendingRequests = new Map();
    this.activeTurns = new Map();
    this.resumedThreads = new Set();
    this.threadContextUsage = new Map();
    this.models = [];
    this.account = null;
    this.rateLimits = null;
    this.usage = null;
    this.lastRefresh = 0;
  }

  start() {
    if (this.stopped || (this.child && !this.child.killed)) return;
    this.ready = false;
    const env = {
      ...process.env,
      HOME: this.homeDir,
      CODEX_HOME: this.codexHome,
      PATH: `${join(this.homeDir, '.local', 'bin')}:${process.env.PATH || '/usr/local/bin:/usr/bin:/bin'}`,
    };
    const child = spawn(this.bin, ['app-server', '--listen', 'stdio://'], { cwd: this.homeDir, env, stdio: ['pipe', 'pipe', 'ignore'] });
    this.child = child;
    readline.createInterface({ input: child.stdout }).on('line', (line) => {
      try { this.#handleMessage(JSON.parse(line)); } catch { /* Ignore malformed or diagnostic output. */ }
    });
    child.on('error', (error) => {
      console.error('Não foi possível iniciar o Codex app-server:', error.message);
      this.emit('server-state', { online: false, message: 'Não foi possível iniciar o Codex.' });
    });
    child.on('close', () => {
      if (this.child === child) {
        this.child = null;
        this.ready = false;
        this.resumedThreads.clear();
      }
      for (const [id, waiting] of this.rpcPending) {
        clearTimeout(waiting.timer);
        waiting.reject(new Error('O processo Codex foi reiniciado. A conversa salva continua no histórico.'));
        this.rpcPending.delete(id);
      }
      this.emit('server-state', { online: false, message: 'Reconectando ao Codex…' });
      if (!this.stopped) this.restartTimer = setTimeout(() => this.start(), RESTART_DELAY_MS);
    });

    this.rpc('initialize', {
      capabilities: { experimentalApi: true },
      clientInfo: { name: 'codex_web_harness', title: 'Codex Web Harness', version: '1.0.0' },
    }, 30000).then(async () => {
      if (this.child !== child || child.killed) return;
      this.#write({ method: 'initialized', params: {} });
      this.ready = true;
      this.emit('server-state', { online: true, message: 'Codex conectado.' });
      try { await this.refreshAccountData(true); } catch (error) { console.error('Não foi possível atualizar os dados da conta:', error.message); }
    }).catch((error) => {
      console.error('Falha na inicialização do Codex app-server:', error.message);
      if (child === this.child) child.kill('SIGTERM');
    });
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.restartTimer);
    if (this.child && !this.child.killed) this.child.kill('SIGTERM');
  }

  /** Kill the current process and wait until a fresh one is ready (used to release thread writers). */
  async restart(timeoutMs = 30000) {
    const child = this.child;
    if (child && !child.killed) child.kill('SIGTERM');
    const deadline = Date.now() + timeoutMs;
    while ((this.child === child || !this.ready) && Date.now() < deadline) await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    return this.ready && this.child !== child;
  }

  rpc(method, params = {}, timeoutMs = 45000) {
    return new Promise((resolvePromise, rejectPromise) => {
      const id = this.nextRequestId++;
      const timer = setTimeout(() => {
        this.rpcPending.delete(id);
        rejectPromise(new Error(`Tempo esgotado ao chamar ${method}.`));
      }, timeoutMs);
      this.rpcPending.set(id, { resolve: resolvePromise, reject: rejectPromise, timer, method });
      try {
        this.#write({ method, id, params });
      } catch (error) {
        clearTimeout(timer);
        this.rpcPending.delete(id);
        rejectPromise(error);
      }
    });
  }

  respondToServerRequest(id, result) {
    try { this.#write({ id, result }); } catch (error) { console.error('Falha ao responder uma solicitação do app-server:', error.message); }
    this.pendingRequests.delete(String(id));
    this.emit('request-resolved', { requestId: String(id) });
  }

  async refreshAccountData(force = false) {
    if (!this.ready) throw new Error('O Codex ainda está iniciando.');
    if (!force && Date.now() - this.lastRefresh < ACCOUNT_REFRESH_MS) return;
    const [models, account, rateLimits, usage] = await Promise.allSettled([
      this.rpc('model/list', { limit: 100, includeHidden: false }),
      this.rpc('account/read', { refreshToken: false }),
      this.rpc('account/rateLimits/read'),
      this.rpc('account/usage/read'),
    ]);
    if (models.status === 'fulfilled') this.models = models.value.data || [];
    if (account.status === 'fulfilled') this.account = account.value.account || null;
    if (rateLimits.status === 'fulfilled') this.rateLimits = rateLimits.value.rateLimitsByLimitId || rateLimits.value.rateLimits || null;
    if (usage.status === 'fulfilled') this.usage = usage.value || null;
    this.lastRefresh = Date.now();
    this.emit('account-data', { account: this.account, rateLimits: this.rateLimits, usage: this.usage });
  }

  /**
   * Resume a thread once per process so it can receive turns. A CLI TUI may own the
   * writer lock; with `allowForeignWriter` that case is tolerated (read-only use).
   */
  async ensureResumed(threadId, { excludeTurns = true, allowForeignWriter = true } = {}) {
    if (this.resumedThreads.has(threadId)) return true;
    try {
      await this.rpc('thread/resume', excludeTurns ? { threadId, excludeTurns: true } : { threadId });
      this.resumedThreads.add(threadId);
      return true;
    } catch (error) {
      if (allowForeignWriter && WRITER_LOCK.test(error.message)) return false;
      throw error;
    }
  }

  async threadHasActiveTurn(threadId) {
    if (this.activeTurns.has(threadId)) return true;
    const result = await this.rpc('thread/read', { threadId });
    return result.thread?.status?.type === 'active';
  }

  async activeTurnIdFor(threadId) {
    const cached = this.activeTurns.get(threadId);
    if (cached) return cached;
    const result = await this.rpc('thread/turns/list', { threadId, limit: 20, sortDirection: 'desc', itemsView: 'full' });
    const active = (result.data || []).find((turn) => {
      const status = typeof turn.status === 'string' ? turn.status : turn.status?.type;
      return status === 'inProgress' || status === 'active';
    });
    if (active?.id) this.activeTurns.set(threadId, active.id);
    return active?.id || null;
  }

  findModel(value) {
    return this.models.find((candidate) => candidate.id === value || candidate.model === value) || null;
  }

  defaultModelId() {
    return this.models.find((model) => model.isDefault)?.id || this.models[0]?.id;
  }

  #write(message) {
    if (!this.child || this.child.killed || !this.child.stdin.writable) {
      throw new Error('O servidor Codex ainda está iniciando. Tente novamente em alguns segundos.');
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #handleMessage(message) {
    if (message && Object.hasOwn(message, 'id') && !message.method) {
      const waiting = this.rpcPending.get(message.id);
      if (waiting) {
        clearTimeout(waiting.timer);
        this.rpcPending.delete(message.id);
        if (message.error) waiting.reject(new Error(message.error.message || `${waiting.method} falhou.`));
        else waiting.resolve(message.result ?? {});
      }
      return;
    }

    if (message && Object.hasOwn(message, 'id') && message.method) {
      const request = { id: message.id, method: message.method, params: message.params || {} };
      this.pendingRequests.set(String(message.id), request);
      this.emit('server-request', request);
      return;
    }

    if (!message?.method) return;
    const params = message.params || {};
    switch (message.method) {
      case 'turn/started':
        if (params.threadId && params.turn?.id) this.activeTurns.set(params.threadId, params.turn.id);
        break;
      case 'turn/completed':
        if (params.threadId) this.activeTurns.delete(params.threadId);
        this.emit('turn-completed', { threadId: params.threadId, turn: params.turn });
        return;
      case 'thread/queue/changed':
        this.emit('thread-queue-changed', params);
        break;
      case 'thread/started':
        if (params.thread?.id) this.resumedThreads.add(params.thread.id);
        break;
      case 'account/updated':
        this.account = message.params;
        break;
      case 'account/rateLimits/updated':
        this.rateLimits = message.params;
        break;
      case 'thread/tokenUsage/updated': {
        const tokenUsage = params.tokenUsage || message.params;
        if (params.threadId && tokenUsage) this.threadContextUsage.set(params.threadId, { tokenUsage, updatedAt: new Date().toISOString() });
        this.emit('thread-usage', message.params);
        break;
      }
      default:
        break;
    }
    this.emit('codex-event', message);
  }
}
