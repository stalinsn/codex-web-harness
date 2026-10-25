// Interactive login sessions shown in the browser. Each session runs one of the
// provider's fixed login/install commands inside a pseudo-terminal (util-linux
// `script`), streams the output over SSE and accepts keystrokes back. It ends by
// itself as soon as the account is detected as signed in.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { config } from '../config.mjs';
import { httpError } from '../http/respond.mjs';
import { accountEnv, checkCliLogin, commandFor } from './cli-runner.mjs';
import { PROVIDERS } from './providers.mjs';
import { saveSecret } from './secrets.mjs';
import { assertManaged, prepareAccountDir } from './setup.mjs';

const MAX_SESSION_MS = 15 * 60 * 1000;
const BUFFER_BYTES = 256 * 1024;
const FLUSH_MS = 40;
const ROWS = 24;
const quote = (value) => `'${String(value).replace(/'/g, "'\\''")}'`;
// CSI / OSC / single-character escape sequences.
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

export function plainText(raw) {
  return String(raw).replace(ANSI, '').replace(/\r(?!\n)/g, '\n');
}

/** Links and device codes in the visible text; wrapped URLs are re-joined. */
export function extractHints(text, cols) {
  const lines = plainText(text).split('\n').map((line) => line.replace(/[│┃║|]\s*$/, '').replace(/^\s*[│┃║|]\s?/, ''));
  const joined = [];
  for (let index = 0; index < lines.length; index += 1) {
    let line = lines[index];
    while (/https?:\/\/\S+$/.test(line.trim()) && line.length >= cols - 4 && index + 1 < lines.length && /^\s*\S+$/.test(lines[index + 1])) {
      index += 1;
      line = `${line.trimEnd()}${lines[index].trim()}`;
    }
    joined.push(line);
  }
  const all = joined.join('\n');
  const links = [...new Set([...all.matchAll(/https?:\/\/[^\s"'<>]+[^\s"'<>.,;:)]/g)].map(([url]) => url))].slice(-4);
  const codes = [...new Set([...all.matchAll(/\b[A-Z0-9]{4}-[A-Z0-9]{4,5}\b/g)].map(([code]) => code))].slice(-2);
  return { links, codes };
}

export class LoginSessions {
  constructor({ accounts, emit }) {
    this.accounts = accounts;
    this.emit = emit;
    this.sessions = new Map();
  }

  get(id) {
    const session = this.sessions.get(id);
    if (!session) throw httpError('Sessão de conexão não encontrada.', 404);
    return session;
  }

  view(session) {
    return { id: session.id, accountId: session.accountId, kind: session.kind, flowId: session.flowId, cols: session.cols, rows: ROWS, status: session.status, detail: session.detail, hints: session.hints, startedAt: session.startedAt, output: session.output };
  }

  /** Start the login flow `flowId` (or the install command with kind 'install') for an account. */
  async start(accountId, { kind = 'login', flowId = '' } = {}) {
    const account = this.accounts.registry.get(accountId);
    if (!account) throw httpError('Conta não encontrada.', 404);
    assertManaged(account);
    await prepareAccountDir(account);
    const setup = PROVIDERS[account.provider].setup || {};
    let commandLine;
    let env = accountEnv(account);
    let cols = 120;
    let flow = null;
    if (kind === 'install') {
      if (!setup.install) throw httpError('Não há instalação automática para esta CLI.', 400);
      // Install for the service user (real HOME), not inside the isolated account folder.
      commandLine = setup.install;
      env = { ...env, HOME: config.homeDir };
      delete env.CODEX_HOME;
      delete env.CLAUDE_CONFIG_DIR;
    } else {
      flow = (setup.flows || []).find((item) => item.id === flowId) || setup.flows?.[0];
      if (!flow) throw httpError('Este provedor não tem um fluxo de login no painel.', 400);
      const bin = commandFor(account);
      commandLine = ['exec', quote(bin), ...flow.command.slice(1).map(quote)].join(' ');
      env = { ...env, ...(flow.env || {}) };
      cols = flow.cols || cols;
    }
    for (const existing of this.sessions.values()) if (existing.accountId === accountId && existing.status === 'running') this.stop(existing.id);

    const session = { id: randomUUID(), accountId, kind, flowId: flow?.id || '', cols, status: 'running', detail: '', hints: { links: [], codes: [] }, startedAt: Date.now(), output: '', pending: '', flushTimer: null, child: null, poll: null, timeout: null, captured: false };
    const shellCommand = `stty cols ${cols} rows ${ROWS} 2>/dev/null; ${commandLine}`;
    const child = spawn('script', ['-qfec', shellCommand, '/dev/null'], {
      cwd: kind === 'install' ? config.homeDir : account.dir,
      env: { ...env, TERM: 'xterm-256color', COLORTERM: 'truecolor', COLUMNS: String(cols), LINES: String(ROWS) },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    });
    session.child = child;
    this.sessions.set(session.id, session);

    const onData = (chunk) => this.#append(session, account, flow, chunk.toString('utf8'));
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (error) => this.#finish(session, 'failed', error.code === 'ENOENT' ? 'O utilitário "script" (util-linux) não está instalado na VPS.' : error.message));
    child.on('close', (code) => this.#onExit(session, account, code));
    session.timeout = setTimeout(() => this.stop(session.id, 'Tempo esgotado: a conexão ficou aberta por 15 minutos.'), MAX_SESSION_MS);
    if (kind === 'login') session.poll = setInterval(() => this.#checkLogin(session, account).catch(() => {}), PROVIDERS[account.provider].status?.command ? 8000 : 3000);
    this.#state(session);
    return this.view(session);
  }

  write(id, data) {
    const session = this.get(id);
    if (session.status !== 'running') throw httpError('Esta sessão já terminou.', 409);
    const text = String(data ?? '');
    if (!text || text.length > 8192) throw httpError('Entrada inválida.', 400);
    session.child.stdin.write(text);
  }

  stop(id, detail = 'Encerrada.') {
    const session = this.sessions.get(id);
    if (!session || session.status !== 'running') return;
    this.#finish(session, 'stopped', detail);
  }

  stopAll() {
    for (const session of this.sessions.values()) if (session.status === 'running') this.#finish(session, 'stopped', 'Serviço reiniciado.');
  }

  #append(session, account, flow, text) {
    session.output = `${session.output}${text}`;
    if (session.output.length > BUFFER_BYTES) session.output = session.output.slice(-BUFFER_BYTES);
    session.pending += text;
    const hints = extractHints(session.output.slice(-64 * 1024), session.cols);
    if (hints.links.join() !== session.hints.links.join() || hints.codes.join() !== session.hints.codes.join()) {
      session.hints = hints;
      this.#state(session);
    }
    if (flow?.capture && !session.captured) {
      const match = new RegExp(flow.capture.pattern).exec(plainText(session.output));
      if (match) {
        session.captured = true;
        saveSecret(account.dir, flow.capture.env, match[0])
          .then(() => this.#succeed(session, account, 'Token salvo nesta conta.'))
          .catch((error) => { session.detail = `Não consegui salvar o token: ${error.message}`; this.#state(session); });
      }
    }
    if (!session.flushTimer) {
      session.flushTimer = setTimeout(() => {
        session.flushTimer = null;
        const data = session.pending;
        session.pending = '';
        if (data) this.emit('login-output', { sessionId: session.id, data }, { replay: false });
      }, FLUSH_MS);
    }
  }

  async #checkLogin(session, account) {
    if (session.status !== 'running' || session.checking) return;
    session.checking = true;
    try {
      const result = await checkCliLogin(account);
      if (result.loggedIn) await this.#succeed(session, account, result.detail);
    } finally { session.checking = false; }
  }

  async #succeed(session, account, detail) {
    if (session.status !== 'running') return;
    Object.assign(this.accounts.registry.stateOf(account.id), { loggedIn: true, statusDetail: detail, checkedAt: Date.now() });
    await this.accounts.registry.saveState().catch(() => {});
    this.emit('accounts-changed', {});
    // Let the CLI print its own confirmation before closing the terminal.
    setTimeout(() => this.#finish(session, 'success', detail || 'Conta conectada.'), 1500);
    session.status = 'success-pending';
  }

  async #onExit(session, account, code) {
    if (session.status === 'stopped' || session.status === 'success' || session.status === 'failed') return;
    if (session.kind === 'install') return this.#finish(session, code === 0 ? 'success' : 'failed', code === 0 ? 'Instalação concluída.' : `A instalação terminou com código ${code}.`);
    const result = await checkCliLogin(account).catch(() => ({ loggedIn: false, detail: '' }));
    if (result.loggedIn) {
      Object.assign(this.accounts.registry.stateOf(account.id), { loggedIn: true, statusDetail: result.detail, checkedAt: Date.now() });
      await this.accounts.registry.saveState().catch(() => {});
      this.emit('accounts-changed', {});
      return this.#finish(session, 'success', result.detail || 'Conta conectada.');
    }
    this.#finish(session, 'failed', code === 0 ? 'A CLI fechou sem concluir o login.' : `A CLI terminou com código ${code} sem concluir o login.`);
  }

  #finish(session, status, detail) {
    if (['success', 'failed', 'stopped'].includes(session.status)) return;
    session.status = status;
    session.detail = detail;
    clearInterval(session.poll);
    clearTimeout(session.timeout);
    try { process.kill(-session.child.pid, 'SIGTERM'); } catch { /* already gone */ }
    setTimeout(() => { try { process.kill(-session.child.pid, 'SIGKILL'); } catch { /* already gone */ } }, 3000).unref();
    this.#state(session);
    // Keep finished sessions briefly so a reconnecting browser can still read the result.
    setTimeout(() => this.sessions.delete(session.id), 10 * 60 * 1000).unref();
  }

  #state(session) {
    const status = session.status === 'success-pending' ? 'running' : session.status;
    this.emit('login-state', { sessionId: session.id, accountId: session.accountId, kind: session.kind, status, detail: session.detail, hints: session.hints });
  }
}
