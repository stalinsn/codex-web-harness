// Continuous tasks: run a goal on the first available account of the rotation and,
// when an account hits its usage limit, hand the work over to the next one using the
// .harness/HANDOFF.md written by the agents. State lives in CODEX_HOME/web-tasks/<id>/.
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../config.mjs';
import { HANDOFF_FILE } from '../accounts/codex-usage.mjs';
import { ACCESS_MODES } from '../codex/access-mode.mjs';
import { httpError } from '../http/respond.mjs';
import { validateCwd } from '../projects.mjs';
import { TurnRecorder } from '../threads/recorder.mjs';
import { fitPrompt, goalFromThread, outcomeMarker } from './prompt.mjs';

const TASK_ID = /^[a-f0-9-]{36}$/;
const ACTIVE = new Set(['queued', 'running', 'waiting']);
const TERMINAL = new Set(['completed', 'failed', 'blocked', 'stopped']);
const MAX_NUDGES = 2;
const MAX_LOG_BYTES = 20 * 1024 * 1024;
const RECENT_EVENTS = 200;
const RETRY_WHEN_NOTHING_KNOWN_MS = 5 * 60 * 1000;
const MAX_TIMER_MS = 2 ** 31 - 1;

const tasksDir = () => join(config.codexHome, 'web-tasks');

/** Streamed text arrives in chunks; log it as whole messages. */
function coalescer(log) {
  let key = '';
  let text = '';
  const flush = () => { if (text) log({ type: 'text', text }); key = ''; text = ''; };
  const handle = (event) => {
    if (event.type === 'text' && event.delta) {
      if (event.key !== key) flush();
      key = event.key;
      text += event.text;
      return;
    }
    flush();
    log(event);
  };
  handle.flush = flush;
  return handle;
}
const OUTCOME_LABEL = { completed: 'concluiu a etapa', 'rate-limited': 'limite de uso atingido', failed: 'falhou', stopped: 'foi interrompida' };

async function readText(path, max = 200_000) {
  try {
    const text = await readFile(path, 'utf8');
    return text.length > max ? text.slice(0, max) : text;
  } catch { return ''; }
}

export class TaskOrchestrator {
  constructor({ accounts, primaryCodex, emit, localThreads }) {
    this.localThreads = localThreads;
    this.accounts = accounts;
    this.primaryCodex = primaryCodex;
    this.emit = emit;
    this.tasks = new Map();
    this.recent = new Map(); // taskId -> recent events
    this.controllers = new Map();
    this.timers = new Map();
    this.running = new Set();
    this.shuttingDown = false;
  }

  async load() {
    await mkdir(tasksDir(), { recursive: true, mode: 0o700 });
    for (const id of await readdir(tasksDir())) {
      if (!TASK_ID.test(id)) continue;
      try {
        const task = JSON.parse(await readFile(join(tasksDir(), id, 'task.json'), 'utf8'));
        // A segment cut by a restart is resumed from the handoff file.
        if (task.status === 'running') { task.status = 'queued'; task.note = 'Retomada após reinício do serviço.'; }
        this.tasks.set(id, task);
      } catch { /* skip unreadable task */ }
    }
    for (const task of this.tasks.values()) {
      if (TERMINAL.has(task.status)) await this.#releaseThread(task).catch((error) => console.error('Não foi possível liberar uma conversa encerrada:', error.message));
    }
    for (const task of this.tasks.values()) if (ACTIVE.has(task.status)) this.#schedule(task, 2000);
    return this;
  }

  list() {
    return [...this.tasks.values()].sort((a, b) => b.createdAt - a.createdAt).map((task) => this.#summary(task));
  }

  async get(id) {
    const task = this.#require(id);
    return { ...this.#summary(task), goal: task.goal, segments: task.segments, events: this.recent.get(id) || await this.#tailLog(id), handoff: await readText(join(task.cwd, HANDOFF_FILE), 60_000) };
  }

  async create({ goal, cwd, title, order, fromThreadId, accessMode = '' }) {
    let text = typeof goal === 'string' ? goal.trim() : '';
    let workdir = cwd;
    let sourceTitle = '';
    let threadAccessMode = ACCESS_MODES.has(accessMode) ? accessMode : '';
    if (fromThreadId) {
      if (!/^[a-zA-Z0-9_-]{1,100}$/.test(fromThreadId)) throw httpError('Conversa inválida.', 400);
      const read = await this.primaryCodex.rpc('thread/read', { threadId: fromThreadId });
      const turns = await this.primaryCodex.rpc('thread/turns/list', { threadId: fromThreadId, limit: 20, sortDirection: 'desc', itemsView: 'full' });
      const derived = goalFromThread({ thread: read.thread, turns: [...(turns.data || [])].reverse() });
      text = text ? `${derived}\n\nOrientação adicional:\n${text}` : derived;
      workdir ||= read.thread?.cwd;
      sourceTitle = read.thread?.name || read.thread?.preview || '';
      threadAccessMode ||= this.primaryCodex.accessModeForThread(fromThreadId);
    }
    if (!text || text.length > 50_000) throw httpError('Descreva o objetivo da tarefa (até 50 mil caracteres).', 400);
    const canonical = await validateCwd(workdir || config.defaultCwd);
    const knownOrder = Array.isArray(order) ? order.filter((id) => this.accounts.registry.get(id)) : null;
    const now = Date.now();
    const task = {
      id: randomUUID(),
      title: String(title || sourceTitle || text.split('\n')[0]).trim().slice(0, 80) || 'Tarefa contínua',
      goal: text,
      cwd: canonical,
      order: knownOrder?.length ? knownOrder : null,
      fromThreadId: fromThreadId || '',
      threadId: '',
      status: 'queued',
      createdAt: now,
      updatedAt: now,
      currentAccountId: '',
      accessMode: ACCESS_MODES.has(threadAccessMode) ? threadAccessMode : '',
      nextAttemptAt: 0,
      nudges: 0,
      note: '',
      error: '',
      segments: [],
    };
    await mkdir(join(tasksDir(), task.id), { recursive: true, mode: 0o700 });
    // The whole task reads as one conversation in the chat, whichever account runs it.
    if (this.localThreads) {
      const record = await this.localThreads.create({ cwd: canonical, accountId: '', provider: '', name: `Contínua · ${task.title}`, taskId: task.id, accessMode: task.accessMode });
      task.threadId = record.thread.id;
      this.emit('thread-created', { thread: record.thread });
    }
    this.tasks.set(task.id, task);
    await this.#save(task);
    this.#schedule(task, 0);
    return this.#summary(task);
  }

  async stop(id) {
    const task = this.#require(id);
    clearTimeout(this.timers.get(id));
    task.status = 'stopped';
    task.note = 'Parada pelo usuário.';
    this.controllers.get(id)?.abort();
    await this.#save(task);
    if (!this.running.has(id)) await this.#releaseThread(task);
    return this.#summary(task);
  }

  async resume(id, { note = '' } = {}) {
    const task = this.#require(id);
    if (this.running.has(id)) throw httpError('A tarefa já está em execução.', 409);
    if (note) task.goal = `${task.goal}\n\nOrientação adicional (${new Date().toLocaleString('pt-BR')}):\n${String(note).slice(0, 10_000)}`;
    Object.assign(task, { status: 'queued', note: '', error: '', nudges: 0 });
    await this.#bindThread(task);
    await this.#save(task);
    this.#schedule(task, 0);
    return this.#summary(task);
  }

  /** Service shutdown: abort segments but keep tasks active so they resume on the next start. */
  stopAll() {
    this.shuttingDown = true;
    for (const controller of this.controllers.values()) controller.abort();
    for (const timer of this.timers.values()) clearTimeout(timer);
  }

  #require(id) {
    const task = TASK_ID.test(String(id)) && this.tasks.get(id);
    if (!task) throw httpError('Tarefa não encontrada.', 404);
    return task;
  }

  #summary(task) {
    const last = task.segments.at(-1);
    const account = this.accounts.registry.get(task.currentAccountId);
    return {
      id: task.id, title: task.title, cwd: task.cwd, status: task.status, createdAt: task.createdAt, updatedAt: task.updatedAt,
      currentAccountId: task.currentAccountId, currentAccountLabel: account?.label || '', nextAttemptAt: task.nextAttemptAt,
      segmentCount: task.segments.length, lastOutcome: last?.outcome || '', note: task.note, error: task.error, fromThreadId: task.fromThreadId,
      order: task.order,
      threadId: task.threadId || '',
    };
  }

  #schedule(task, delayMs) {
    clearTimeout(this.timers.get(task.id));
    const timer = setTimeout(() => { this.timers.delete(task.id); this.#run(task).catch((error) => this.#fail(task, error)); }, Math.min(MAX_TIMER_MS, Math.max(0, delayMs)));
    timer.unref?.();
    this.timers.set(task.id, timer);
  }

  async #fail(task, error) {
    task.status = 'failed';
    task.error = error?.message || String(error);
    await this.#save(task).catch(() => {});
    await this.#releaseThread(task).catch(() => {});
  }

  async #bindThread(task) {
    if (!this.localThreads || !task.threadId) return;
    const record = await this.localThreads.get(task.threadId);
    if (!record) return;
    await this.localThreads.update(task.threadId, (stored) => {
      stored.thread.taskId = task.id;
      stored.thread.name = `Contínua · ${task.title}`.slice(0, 120);
    });
    await this.localThreads.flush(task.threadId);
    this.emit('thread-updated', { threadId: task.threadId, thread: record.thread });
  }

  /** A terminal task stays in the task panel; its conversation becomes a regular Codex chat. */
  async #releaseThread(task) {
    if (!this.localThreads || !task.threadId) return;
    const record = await this.localThreads.get(task.threadId);
    if (!record || record.thread.taskId !== task.id) return;
    await this.localThreads.update(task.threadId, (stored) => {
      stored.thread.taskId = '';
      stored.thread.name = task.title;
      stored.thread.accountId = 'codex';
      stored.thread.provider = 'codex';
      stored.thread.modelProvider = 'codex';
      stored.thread.model = 'Codex';
      stored.thread.accessMode = ACCESS_MODES.has(task.accessMode) ? task.accessMode : 'automatic';
    });
    await this.localThreads.flush(task.threadId);
    this.emit('thread-updated', { threadId: task.threadId, thread: record.thread });
  }

  async #save(task) {
    task.updatedAt = Date.now();
    const file = join(tasksDir(), task.id, 'task.json');
    const temporary = `${file}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(task, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, file);
    this.emit('task-updated', this.#summary(task));
  }

  async #log(task, event) {
    const entry = { at: Date.now(), segment: task.segments.length, accountId: task.currentAccountId, ...event };
    if (entry.text) entry.text = String(entry.text).slice(0, 8000);
    const recent = this.recent.get(task.id) || [];
    recent.push(entry);
    if (recent.length > RECENT_EVENTS) recent.shift();
    this.recent.set(task.id, recent);
    this.emit('task-event', { taskId: task.id, event: entry });
    const file = join(tasksDir(), task.id, 'events.jsonl');
    const size = await stat(file).then((info) => info.size, () => 0);
    if (size < MAX_LOG_BYTES) await appendFile(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 }).catch(() => {});
  }

  async #tailLog(id) {
    const text = await readText(join(tasksDir(), id, 'events.jsonl'), MAX_LOG_BYTES);
    return text.trim().split('\n').slice(-RECENT_EVENTS).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
  }

  /** One chat turn per segment in the task's conversation. */
  async #segmentRecorder(task, segment, previous, account) {
    if (!this.localThreads || !task.threadId || !this.localThreads.has(task.threadId)) return null;
    const recorder = new TurnRecorder({ store: this.localThreads, threadId: task.threadId, emit: this.emit });
    const label = segment.id === 1 ? task.goal
      : segment.mode === 'nudge' ? `↪ Continuar (${segment.accountLabel})`
      : `↪ Etapa ${segment.id} em ${segment.accountLabel}${previous ? ` — ${previous.accountLabel}: ${OUTCOME_LABEL[previous.outcome] || previous.outcome}` : ''}. Retomando pelo registro de retomada.`;
    await recorder.start({ text: label, account });
    return recorder;
  }

  /** Keep .harness/ out of git status without touching tracked files. */
  async #prepareWorkdir(cwd) {
    await mkdir(join(cwd, '.harness'), { recursive: true });
    const exclude = join(cwd, '.git', 'info', 'exclude');
    const current = await readFile(exclude, 'utf8').catch(() => null);
    if (current != null && !/^\/?\.harness\/?$/m.test(current)) await appendFile(exclude, `${current.endsWith('\n') || !current ? '' : '\n'}.harness/\n`).catch(() => {});
  }

  async #policies(cwd) {
    const files = [join(config.codexHome, 'AGENTS.md'), join(cwd, 'AGENTS.md')];
    return (await Promise.all(files.map((file) => readText(file, 20_000)))).filter((text) => text.trim());
  }

  async #run(task) {
    if (this.running.has(task.id) || !ACTIVE.has(task.status)) return;
    this.running.add(task.id);
    const controller = new AbortController();
    this.controllers.set(task.id, controller);
    const failedAccounts = [];
    let mode = task.segments.length ? 'handoff' : 'start';
    try {
      await this.#prepareWorkdir(task.cwd);
      while (ACTIVE.has(task.status) && !controller.signal.aborted) {
        const previous = task.segments.at(-1) || null;
        const sameAccountNudge = mode === 'nudge' && previous ? this.accounts.registry.get(previous.accountId) : null;
        const account = sameAccountNudge && this.accounts.availability(sameAccountNudge).ok ? sameAccountNudge : this.accounts.pick(task.order, { exclude: failedAccounts });
        if (!account) {
          const next = this.accounts.nextAvailableAt(task.order);
          if (failedAccounts.length && !next) {
            task.status = 'failed';
            task.currentAccountId = '';
            task.note = 'Todas as contas disponíveis falharam. Confira o login e a instalação das CLIs e retome.';
            await this.#save(task);
            return;
          }
          task.status = 'waiting';
          task.currentAccountId = '';
          task.nextAttemptAt = next || Date.now() + RETRY_WHEN_NOTHING_KNOWN_MS;
          task.note = failedAccounts.length ? 'As contas disponíveis falharam nesta tentativa.' : 'Nenhuma conta disponível agora; a tarefa continua quando uma janela liberar.';
          await this.#save(task);
          this.#schedule(task, task.nextAttemptAt - Date.now() + 1000);
          return;
        }
        if (!this.accounts.reserve(account.id, task.id)) continue;
        if (mode === 'nudge' && account !== sameAccountNudge) mode = 'handoff';
        if (previous && previous.accountId !== account.id) task.nudges = 0;
        try {
          const reuseSession = mode === 'nudge' && previous?.sessionId ? previous.sessionId : '';
          const segment = { id: task.segments.length + 1, accountId: account.id, accountLabel: account.label, provider: account.provider, mode, startedAt: Date.now(), endedAt: 0, outcome: '', resetsAt: 0, sessionId: reuseSession, summary: '', error: '' };
          task.segments.push(segment);
          Object.assign(task, { status: 'running', currentAccountId: account.id, nextAttemptAt: 0, note: '' });
          await this.#save(task);
          await this.#log(task, { type: 'segment-start', accountLabel: account.label, mode });

          const prompt = fitPrompt({
            task, account, mode,
            handoff: mode === 'handoff' ? await readText(join(task.cwd, HANDOFF_FILE), 60_000) : '',
            previous: previous ? { accountLabel: previous.accountLabel, outcome: OUTCOME_LABEL[previous.outcome] || previous.outcome, summary: previous.summary } : null,
            policies: await this.#policies(task.cwd),
          });
          if (controller.signal.aborted) break;
          const recorder = await this.#segmentRecorder(task, segment, previous, account);
          const logText = coalescer((event) => this.#log(task, event).catch(() => {}));
          const outcome = await this.accounts.runSegment(account, {
            taskId: task.id, prompt, cwd: task.cwd, sessionId: reuseSession, title: `Contínua · ${task.title}`, signal: controller.signal,
            onEvent: (event) => {
              if (event.type === 'session') { segment.sessionId = event.sessionId; return; }
              logText(event);
              if (recorder && (account.provider !== 'codex' || event.type === 'error')) recorder.handle(event).catch(() => {});
            },
            onCodexMessage: recorder ? (message) => recorder.mirrorCodex(message).catch(() => {}) : null,
          }).catch((error) => ({ status: 'failed', error: error.message, text: '', sessionId: '', resetsAt: 0 }));
          logText.flush();
          if (recorder) {
            const turnStatus = outcome.status === 'completed' ? 'completed' : outcome.status === 'stopped' ? 'interrupted' : 'failed';
            const note = outcome.status === 'rate-limited' ? `Limite de uso atingido em ${account.label}; a próxima conta continua.` : turnStatus === 'failed' ? outcome.error || 'A etapa falhou.' : '';
            await recorder.finish({ status: turnStatus, error: note, finalText: turnStatus === 'completed' ? outcome.text : '' }).catch(() => {});
            await this.localThreads.update(task.threadId, (record) => { Object.assign(record.thread, { accountId: account.id, provider: account.provider, model: account.label }); }).catch(() => {});
          }

          Object.assign(segment, { endedAt: Date.now(), outcome: outcome.status, resetsAt: outcome.resetsAt || 0, sessionId: outcome.sessionId || segment.sessionId, summary: String(outcome.text || '').slice(-4000), error: outcome.error || '' });
          await this.#log(task, { type: 'segment-end', outcome: outcome.status, error: outcome.error || '' });
          if (task.status === 'stopped' || this.shuttingDown) break;

          if (outcome.status === 'rate-limited') { mode = 'handoff'; task.nudges = 0; }
          else if (outcome.status === 'completed') {
            const marker = outcomeMarker(outcome.text);
            if (marker === 'done') { task.status = 'completed'; task.note = 'Objetivo concluído.'; }
            else if (marker === 'blocked') { task.status = 'blocked'; task.note = 'O agente precisa de uma decisão ou aprovação sua.'; }
            else if (task.nudges < MAX_NUDGES) { task.nudges += 1; mode = 'nudge'; }
            else { task.status = 'blocked'; task.note = 'O agente encerrou sem confirmar a conclusão. Revise e retome com uma orientação.'; }
          } else if (outcome.status === 'stopped') {
            task.status = 'failed';
            task.error = outcome.error || 'A etapa foi interrompida.';
          } else {
            failedAccounts.push(account.id);
            task.error = outcome.error || 'A etapa falhou.';
            mode = 'handoff';
          }
          await this.#save(task);
        } finally {
          this.accounts.release(account.id, task.id);
        }
      }
    } finally {
      this.running.delete(task.id);
      this.controllers.delete(task.id);
      if (task.status === 'running') { task.status = 'queued'; await this.#save(task).catch(() => {}); }
      if (TERMINAL.has(task.status)) await this.#releaseThread(task).catch((error) => console.error('Não foi possível liberar a conversa da tarefa encerrada:', error.message));
    }
  }
}
