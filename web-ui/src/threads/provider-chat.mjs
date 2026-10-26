// Chat turns on harness-held conversations: any account (Claude Code, Antigravity,
// Gemini, extra Codex accounts). Keeps one CLI session per account and thread, falls
// back to a transcript when the account changes, queues follow-ups while a turn runs
// and, when the account hits its limit, continues on the next one of the rotation.
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { HANDOFF_FILE } from '../accounts/codex-usage.mjs';
import { PRIMARY_ID } from '../accounts/registry.mjs';
import { config } from '../config.mjs';
import { httpError } from '../http/respond.mjs';
import { TurnRecorder } from './recorder.mjs';

const TRANSCRIPT_TURNS = 8;
const TRANSCRIPT_BYTES = 24_000;
const MAX_POLICY = 12_000;
const MAX_QUEUE = 20;

const readText = (path, max) => readFile(path, 'utf8').then((text) => text.slice(0, max), () => '');
const textOf = (item) => (item.content || []).filter((part) => part.type === 'text').map((part) => part.text).join('\n');

/** Recent conversation as plain text for a model that has not seen it yet. */
export function transcriptOf(turns, maxBytes = TRANSCRIPT_BYTES) {
  const lines = [];
  for (const turn of turns.slice(-TRANSCRIPT_TURNS)) {
    const user = turn.items.find((item) => item.type === 'userMessage');
    const answers = turn.items.filter((item) => item.type === 'agentMessage' && item.text);
    const final = answers.find((item) => item.phase === 'final_answer') || answers.at(-1);
    if (user) lines.push(`Usuário: ${textOf(user)}`);
    if (final) lines.push(`Assistente: ${final.text}`);
  }
  let text = lines.join('\n\n');
  while (Buffer.byteLength(text) > maxBytes) text = text.slice(Math.floor(text.length / 4));
  return text;
}

export class ProviderChat {
  constructor({ store, accounts, emit }) {
    this.store = store;
    this.accounts = accounts;
    this.emit = emit;
    this.running = new Map(); // threadId -> { controller, accountId }
  }

  isRunning(threadId) { return this.running.has(threadId); }

  accountFor(record, accountId) {
    // "codex" (the chat's own account) cannot answer here; keep the conversation's account.
    const wanted = accountId && accountId !== PRIMARY_ID ? accountId : record.thread.accountId;
    const account = this.accounts.registry.get(wanted);
    if (!account || account.id === PRIMARY_ID) throw httpError('Escolha uma conta conectada para esta conversa.', 400);
    return account;
  }

  /** Fail before creating anything when the account cannot answer now. */
  assertUsable(accountId) {
    const account = this.accounts.registry.get(accountId);
    if (!account || account.primary) throw httpError('Escolha uma conta conectada para esta conversa.', 400);
    const availability = this.accounts.availability(account);
    if (!availability.ok) throw httpError(`${account.label}: ${availability.reason.toLowerCase()}. Escolha outra conta para continuar.`, 409);
    return account;
  }

  /** Create a conversation bound to an account. */
  async create({ accountId, cwd, name = '', taskId = '', seed = '' }) {
    const account = this.accounts.registry.get(accountId);
    if (!account || account.primary) throw httpError('Escolha uma conta conectada para esta conversa.', 400);
    const record = await this.store.create({ cwd, accountId: account.id, provider: account.provider, model: this.#modelLabel(account), name, taskId });
    if (seed) await this.store.update(record.thread.id, (stored) => { stored.seed = seed.slice(-24_000); });
    this.emit('thread-created', { thread: record.thread });
    return record;
  }

  #modelLabel(account) {
    return [account.label, account.model].filter(Boolean).join(' · ');
  }

  /**
   * Send a user message. Starts a turn, or queues it while one is running.
   * @returns {Promise<{threadId: string, turnId?: string, queued?: boolean, queuedSubmission?: object}>}
   */
  async send({ threadId, accountId, text, extraText = '', content = null }) {
    const record = await this.store.get(threadId);
    if (!record) throw httpError('Conversa não encontrada.', 404);
    if (record.thread.taskId) throw httpError('Esta conversa pertence a uma execução contínua. Para orientar, use Retomar no painel Execuções contínuas.', 409);
    const account = this.accountFor(record, accountId);
    const message = [text, extraText].filter(Boolean).join('\n\n');
    if (this.running.has(threadId)) {
      if (record.queue.length >= MAX_QUEUE) throw httpError('A fila desta conversa está cheia.', 409);
      const queued = { id: `q-${randomUUID()}`, accountId: account.id, input: content || [{ type: 'text', text: message }], prompt: message, createdAt: Date.now() };
      await this.store.update(threadId, (stored) => { stored.queue.push(queued); });
      this.emit('thread-queue-changed', { threadId });
      return { threadId, queued: true, queuedSubmission: queued };
    }
    const availability = this.accounts.availability(account);
    if (!availability.ok) throw httpError(`${account.label}: ${availability.reason.toLowerCase()}. Escolha outra conta para continuar.`, 409);
    const turnId = await this.#startTurn(record, account, { text: message, content });
    return { threadId, turnId };
  }

  async interrupt(threadId) {
    const run = this.running.get(threadId);
    if (!run) return false;
    run.controller.abort();
    return true;
  }

  async queue(threadId) {
    const record = await this.store.get(threadId);
    return record ? record.queue : [];
  }

  async dequeue(threadId, id) {
    await this.store.update(threadId, (record) => { record.queue = record.queue.filter((item) => item.id !== id); });
    this.emit('thread-queue-changed', { threadId });
  }

  async #prompt(record, account, text, { handoff = false } = {}) {
    const sessionId = record.sessions[account.id] || '';
    if (sessionId && record.lastAccountId === account.id && !handoff) return { prompt: text, sessionId };
    const parts = [];
    if (account.provider !== 'codex') {
      const policies = (await Promise.all([join(config.codexHome, 'AGENTS.md'), join(record.thread.cwd, 'AGENTS.md')].map((file) => readText(file, MAX_POLICY)))).filter((policy) => policy.trim());
      if (policies.length) parts.push(`## Diretrizes da instalação (obrigatórias)\n\n${policies.join('\n\n---\n\n')}\n\nQuando estas diretrizes exigirem pedido explícito ou confirmação, explique o plano e peça a confirmação em vez de executar.`);
    }
    parts.push(`Você está conversando pelo Codex Web Harness. Pasta de trabalho: \`${record.thread.cwd}\`.`);
    const history = [record.seed ? `(Conversa anterior no Codex)\n${record.seed}` : '', transcriptOf(record.turns.slice(0, -1))].filter(Boolean).join('\n\n');
    if (history) parts.push(`## Conversa até aqui (outra conta ou modelo pode ter respondido antes)\n\n${history}`);
    if (handoff) {
      const file = await readText(join(record.thread.cwd, HANDOFF_FILE), 30_000);
      if (file) parts.push(`## Registro de retomada (${HANDOFF_FILE})\n\n${file}`);
    }
    parts.push(`## Mensagem do usuário\n\n${text}`);
    return { prompt: parts.join('\n\n'), sessionId: '' };
  }

  async #startTurn(record, account, { text, content = null, handoff = false, label = '' }) {
    const threadId = record.thread.id;
    // Claim the thread before any await: one turn per conversation at a time.
    if (this.running.has(threadId)) throw httpError('Esta conversa já está respondendo.', 409);
    const controller = new AbortController();
    this.running.set(threadId, { controller, accountId: account.id });
    const recorder = new TurnRecorder({ store: this.store, threadId, emit: this.emit });
    let turnId;
    try { turnId = await recorder.start({ text: label || text, content: label ? null : content, account }); }
    catch (error) { this.running.delete(threadId); throw error; }
    this.emit('turn-accepted', { threadId, turnId, model: this.#modelLabel(account), cwd: record.thread.cwd });
    this.#run(record, account, recorder, { text, handoff, controller }).catch((error) => console.error('Falha numa conversa do harness:', error.message));
    return turnId;
  }

  async #run(record, account, recorder, { text, handoff, controller }) {
    const threadId = record.thread.id;
    let outcome;
    try {
      const { prompt, sessionId } = await this.#prompt(record, account, text, { handoff });
      outcome = await this.accounts.runSegment(account, {
        taskId: `chat:${threadId}`, prompt, cwd: record.thread.cwd, sessionId, title: record.thread.name || record.thread.preview || 'Conversa', signal: controller.signal,
        // Codex accounts are mirrored item by item (onCodexMessage); CLIs go through the parser events.
        onEvent: (event) => { if (event.type !== 'session' && (account.provider !== 'codex' || event.type === 'error')) recorder.handle(event).catch(() => {}); },
        onCodexMessage: (message) => recorder.mirrorCodex(message).catch(() => {}),
      });
    } catch (error) {
      outcome = { status: 'failed', error: error.message, text: '', sessionId: '' };
    }
    let next = null;
    let fresh = null;
    try {
      const status = outcome.status === 'completed' ? 'completed' : outcome.status === 'stopped' ? 'interrupted' : 'failed';
      const limitNote = outcome.status === 'rate-limited' ? `Limite de uso atingido em ${account.label}.` : '';
      await recorder.finish({ status, error: limitNote || (status === 'failed' ? outcome.error || 'A conta não concluiu a resposta.' : ''), finalText: status === 'completed' ? outcome.text : '' });
      await this.store.update(threadId, (stored) => {
        if (outcome.sessionId) stored.sessions[account.id] = outcome.sessionId;
        stored.lastAccountId = account.id;
        stored.thread.accountId = account.id;
        stored.thread.provider = account.provider;
        stored.thread.model = this.#modelLabel(account);
      });
      // On a usage limit, keep going on the next account of the rotation.
      if (outcome.status === 'rate-limited' && this.accounts.registry.rotation.autoContinue) {
        next = this.accounts.pick(this.accounts.registry.rotation.order.filter((id) => id !== PRIMARY_ID), { exclude: [account.id] });
        if (next) fresh = await this.store.get(threadId);
      }
    } catch (error) {
      console.error('Falha ao concluir a resposta de uma conversa do harness:', error.message);
      next = null;
    } finally {
      this.running.delete(threadId);
    }
    if (next && fresh) {
      // No await between releasing the thread and claiming it again.
      await this.#startTurn(fresh, next, { text: 'Continue de onde a resposta anterior parou, sem refazer o que já foi feito.', handoff: true, label: `↪ Limite atingido em ${account.label}. Continuando em ${next.label}.` }).catch(() => this.#drainQueue(threadId));
      return;
    }
    await this.#drainQueue(threadId);
  }

  async #drainQueue(threadId) {
    const record = await this.store.get(threadId);
    const [next] = record?.queue || [];
    if (!next || this.running.has(threadId)) return;
    const text = next.prompt || next.input.filter((part) => part.type === 'text').map((part) => part.text).join('\n');
    try {
      const account = this.accountFor(record, next.accountId);
      if (!this.accounts.availability(account).ok) throw new Error(`${account.label} indisponível`);
      const started = this.#startTurn(record, account, { text, content: next.input });
      await this.store.update(threadId, (stored) => { stored.queue = stored.queue.filter((item) => item.id !== next.id); });
      this.emit('thread-queue-changed', { threadId });
      await started;
    } catch (error) {
      this.emit('codex-event', { method: 'error', params: { threadId, error: { message: `Não consegui enviar a mensagem da fila: ${error.message}` }, willRetry: false } });
    }
  }

  stopAll() {
    for (const run of this.running.values()) run.controller.abort();
  }
}
