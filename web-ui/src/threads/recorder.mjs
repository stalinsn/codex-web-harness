// Records one turn of a harness-held conversation in Codex app-server shapes and
// emits the same notifications the Codex app-server would, so the chat UI renders
// any provider exactly like Codex: user message, streamed commentary, reasoning,
// commands, file changes, tools and a final answer.
import { randomUUID } from 'node:crypto';

const OUTPUT_LIMIT = 20_000;
const SHELL_TOOLS = /^(bash|shell|run_shell_command|run_terminal_cmd|terminal|exec|execute_command|command)$/i;
const EDIT_TOOLS = /^(edit|multiedit|write|notebookedit|write_file|replace|edit_file|create_file|apply_patch|str_replace_editor)$/i;
const SEARCH_TOOLS = /^(websearch|web_search|google_web_search|search_web)$/i;
const nowSeconds = () => Date.now() / 1000;
const clip = (text, max = OUTPUT_LIMIT) => (text.length > max ? `${text.slice(0, max)}\n…` : text);

/** Map a provider tool call to the closest Codex item type. */
export function toolItem(event, id) {
  const input = event.input && typeof event.input === 'object' ? event.input : {};
  const name = String(event.name || 'ferramenta');
  if (SHELL_TOOLS.test(name)) return { type: 'commandExecution', id, command: String(input.command || input.cmd || event.detail || name), status: 'inProgress', aggregatedOutput: '' };
  if (EDIT_TOOLS.test(name)) {
    const paths = [input.file_path, input.path, input.absolute_path, input.notebook_path, ...(Array.isArray(input.edits) ? [] : [])].filter((value) => typeof value === 'string');
    return { type: 'fileChange', id, status: 'inProgress', changes: (paths.length ? paths : [name]).map((path) => ({ path, diff: typeof input.new_string === 'string' ? clip(`+${input.new_string}`, 4000) : '' })) };
  }
  if (SEARCH_TOOLS.test(name)) return { type: 'webSearch', id, query: String(input.query || event.detail || '') };
  return { type: 'mcpToolCall', id, tool: name, status: 'inProgress', result: '' };
}

export class TurnRecorder {
  /**
   * @param {object} p
   * @param {import('./local-store.mjs').LocalThreadStore} p.store
   * @param {string} p.threadId
   * @param {(type: string, data: object) => void} p.emit
   */
  constructor({ store, threadId, emit }) {
    this.store = store;
    this.threadId = threadId;
    this.emit = emit;
    this.turnId = '';
    this.items = new Map(); // item id -> item
    this.keys = new Map(); // text/reasoning key or tool id -> item id
    this.openStreams = new Set();
    this.lastAgentItem = '';
    this.sequence = 0;
  }

  #notify(method, params) {
    this.emit('codex-event', { method, params: { threadId: this.threadId, ...params } });
  }

  #nextId(kind) { this.sequence += 1; return `${this.turnId}-${kind}${this.sequence}`; }

  async #mutate(fn) {
    await this.store.update(this.threadId, (record) => {
      const turn = record.turns.find((item) => item.id === this.turnId);
      if (turn) fn(turn, record);
    });
  }

  async #saveItem(item) {
    await this.#mutate((turn) => {
      const index = turn.items.findIndex((existing) => existing.id === item.id);
      if (index >= 0) turn.items[index] = { ...item };
      else turn.items.push({ ...item });
    });
  }

  /** Begin a turn with the user's message. */
  async start({ text, content = null, account = null }) {
    this.turnId = `turn-${randomUUID()}`;
    // Who answers this turn (the client colours and labels the reply by provider).
    const who = account ? { id: account.id, label: account.label, provider: account.provider } : null;
    const user = { type: 'userMessage', id: `${this.turnId}-user`, content: content || [{ type: 'text', text }] };
    const startedAt = nowSeconds();
    await this.store.update(this.threadId, (record) => {
      record.turns.push({ id: this.turnId, status: 'inProgress', startedAt, items: [user], ...(who ? { account: who } : {}) });
      record.thread.status = { type: 'active' };
      if (!record.thread.preview) record.thread.preview = String(text || '').slice(0, 160);
    });
    this.startedAt = startedAt;
    this.#notify('thread/status/changed', { status: { type: 'active' } });
    this.#notify('turn/started', { turn: { id: this.turnId, startedAt, ...(who ? { account: who } : {}) } });
    this.#notify('item/started', { turnId: this.turnId, item: user });
    return this.turnId;
  }

  /** Persist a user message accepted by turn/steer inside the active local turn. */
  async recordSteeredMessage(content) {
    const item = {
      type: 'userMessage',
      id: `${this.turnId}-steer-${randomUUID()}`,
      content: Array.isArray(content) ? content.map((part) => ({ ...part })) : [],
    };
    await this.#mutate((turn) => turn.items.push(item));
    await this.store.flush(this.threadId);
    this.#notify('item/started', { turnId: this.turnId, item });
    return item;
  }

  /** Feed one normalized provider event (see accounts/parsers.mjs). */
  async handle(event) {
    switch (event.type) {
      case 'text': return this.#text(event);
      case 'reasoning': return this.#reasoning(event);
      case 'tool': return this.#tool(event);
      case 'tool-result': return this.#toolResult(event);
      case 'error': this.#notify('error', { turnId: this.turnId, error: { message: event.message }, willRetry: true }); return undefined;
      default: return undefined;
    }
  }

  async #text({ text, key, delta }) {
    const mapKey = `text:${key || this.sequence}`;
    let id = this.keys.get(mapKey);
    let item = id && this.items.get(id);
    if (!item) {
      id = this.#nextId('msg');
      item = { type: 'agentMessage', id, text: '', phase: 'commentary' };
      this.keys.set(mapKey, id);
      this.items.set(id, item);
      this.#notify('item/started', { turnId: this.turnId, item: { ...item } });
    }
    this.lastAgentItem = id;
    if (delta) {
      item.text += text;
      this.openStreams.add(id);
      this.#notify('item/agentMessage/delta', { turnId: this.turnId, itemId: id, delta: text, phase: item.phase });
      await this.#saveItem(item);
      return;
    }
    item.text = text;
    this.openStreams.delete(id);
    this.#notify('item/completed', { turnId: this.turnId, item: { ...item } });
    await this.#saveItem(item);
  }

  async #reasoning({ text, key, delta }) {
    const mapKey = `reasoning:${key || this.sequence}`;
    let id = this.keys.get(mapKey);
    let item = id && this.items.get(id);
    if (!item) {
      id = this.#nextId('think');
      item = { type: 'reasoning', id, summary: [''] };
      this.keys.set(mapKey, id);
      this.items.set(id, item);
      this.#notify('item/reasoning/summaryPartAdded', { turnId: this.turnId, itemId: id, summaryIndex: 0 });
    }
    if (delta) {
      item.summary[0] += text;
      this.#notify('item/reasoning/summaryTextDelta', { turnId: this.turnId, itemId: id, summaryIndex: 0, delta: text });
    } else {
      item.summary[0] = text;
      this.#notify('item/completed', { turnId: this.turnId, item: { ...item, summary: [...item.summary] } });
    }
    await this.#saveItem({ ...item, summary: [...item.summary] });
  }

  async #tool(event) {
    const id = this.#nextId('tool');
    const item = toolItem(event, id);
    this.keys.set(`tool:${event.id || id}`, id);
    this.items.set(id, item);
    if (item.type === 'webSearch') this.#notify('item/completed', { turnId: this.turnId, item: { ...item } });
    else this.#notify('item/started', { turnId: this.turnId, item: { ...item } });
    await this.#saveItem(item);
  }

  async #toolResult({ id: toolId, output = '', isError = false }) {
    const id = this.keys.get(`tool:${toolId}`);
    const item = id && this.items.get(id);
    if (!item) return;
    const text = clip(String(output || ''));
    if (item.type === 'commandExecution') Object.assign(item, { aggregatedOutput: text, status: isError ? 'failed' : 'completed' });
    else if (item.type === 'fileChange') item.status = isError ? 'failed' : 'completed';
    else if (item.type === 'mcpToolCall') Object.assign(item, { status: isError ? 'failed' : 'completed', ...(isError ? { error: text } : { result: text }) });
    this.#notify('item/completed', { turnId: this.turnId, item: { ...item } });
    await this.#saveItem(item);
  }

  /** Close the turn. The last assistant message becomes the visible final answer. */
  async finish({ status = 'completed', error = '', finalText = '' } = {}) {
    for (const item of this.items.values()) {
      if (item.status === 'inProgress') { item.status = status === 'completed' ? 'completed' : 'failed'; this.#notify('item/completed', { turnId: this.turnId, item: { ...item } }); await this.#saveItem(item); }
    }
    let final = this.lastAgentItem && this.items.get(this.lastAgentItem);
    if (!final && finalText) {
      await this.#text({ text: finalText, key: 'final' });
      final = this.items.get(this.lastAgentItem);
    }
    if (final) {
      final.phase = 'final_answer';
      this.openStreams.delete(final.id);
      this.#notify('item/completed', { turnId: this.turnId, item: { ...final } });
      await this.#saveItem(final);
    }
    for (const id of this.openStreams) {
      const item = this.items.get(id);
      if (item) this.#notify('item/completed', { turnId: this.turnId, item: { ...item } });
    }
    const completedAt = nowSeconds();
    const durationMs = Math.round((completedAt - this.startedAt) * 1000);
    const turn = { id: this.turnId, status, durationMs, ...(error ? { error: { message: error } } : {}) };
    await this.#mutate((stored, record) => {
      Object.assign(stored, { status, completedAt, durationMs, ...(error ? { error: { message: error } } : {}) });
      record.thread.status = { type: 'idle' };
    });
    await this.store.flush(this.threadId);
    if (error && status !== 'completed') this.#notify('error', { turnId: this.turnId, error: { message: error }, willRetry: false });
    this.#notify('thread/status/changed', { status: { type: 'idle' } });
    this.emit('turn-completed', { threadId: this.threadId, turn });
  }

  /** Mirror raw Codex app-server notifications of another Codex account into this turn. */
  async mirrorCodex(message) {
    const params = message.params || {};
    if (message.method === 'item/agentMessage/delta') {
      return this.#text({ text: params.delta || '', key: `codex:${params.itemId}`, delta: true });
    }
    if (message.method === 'item/reasoning/summaryTextDelta') {
      return this.#reasoning({ text: params.delta || '', key: `codex:${params.itemId}:${params.summaryIndex || 0}`, delta: true });
    }
    if (message.method !== 'item/completed' && message.method !== 'item/started') return undefined;
    const item = params.item;
    if (!item || item.type === 'userMessage') return undefined;
    if (item.type === 'agentMessage') return item.text ? this.#text({ text: item.text, key: `codex:${item.id}` }) : undefined;
    if (item.type === 'reasoning') {
      const text = (Array.isArray(item.summary) ? item.summary : []).map((part) => (typeof part === 'string' ? part : part?.text || '')).join('\n\n');
      return text ? this.#reasoning({ text, key: `codex:${item.id}:0` }) : undefined;
    }
    const id = this.keys.get(`codex:${item.id}`) || this.#nextId('tool');
    this.keys.set(`codex:${item.id}`, id);
    const copy = { ...item, id };
    this.items.set(id, copy);
    this.#notify(message.method, { turnId: this.turnId, item: { ...copy } });
    return this.#saveItem(copy);
  }
}
