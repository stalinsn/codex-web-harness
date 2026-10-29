// Conversations held by the harness itself (any non-Codex account, extra Codex accounts
// and continuous tasks). They use the same thread/turn/item shapes as the Codex
// app-server so the client renders them identically. One JSON file per thread in
// CODEX_HOME/web-threads/.
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../config.mjs';

export const LOCAL_PREFIX = 'ext-';
export const isLocalThread = (id) => typeof id === 'string' && id.startsWith(LOCAL_PREFIX) && /^ext-[a-f0-9-]{36}$/.test(id);
const SAVE_DELAY_MS = 400;
const CACHE_SIZE = 30;
const nowSeconds = () => Math.floor(Date.now() / 1000);

export class LocalThreadStore {
  constructor({ dir = join(config.codexHome, 'web-threads') } = {}) {
    this.dir = dir;
    this.index = new Map(); // id -> thread meta
    this.cache = new Map(); // id -> full record (LRU)
    this.timers = new Map();
    this.loading = new Map(); // id -> in-flight read, so concurrent loads share one copy
    this.writing = new Map(); // id -> in-flight write
  }

  async load() {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    for (const file of await readdir(this.dir)) {
      if (!file.endsWith('.json')) continue;
      try {
        const record = JSON.parse(await readFile(join(this.dir, file), 'utf8'));
        if (!isLocalThread(record?.thread?.id)) continue;
        record.sessions ||= {};
        record.sessionModels ||= {};
        record.sessionTurnCounts ||= {};
        if (record.lastAccountId && record.sessions[record.lastAccountId]) {
          record.sessionModels[record.lastAccountId] ||= record.thread.model || '';
          record.sessionTurnCounts[record.lastAccountId] ??= (record.turns || []).length;
        }
        // A turn cut by a restart cannot resume its process; close it.
        this.index.set(record.thread.id, record.thread);
        if (record.thread.status?.type === 'active') {
          record.thread.status = { type: 'idle' };
          for (const turn of record.turns || []) if (turn.status === 'inProgress') Object.assign(turn, { status: 'interrupted', error: { message: 'O serviço foi reiniciado durante esta resposta.' } });
          await this.#write(record);
        }
      } catch { /* skip unreadable file */ }
    }
    return this;
  }

  has(id) { return this.index.has(id); }

  meta(id) { return this.index.get(id) || null; }

  list({ archived = false, search = '' } = {}) {
    const term = search.trim().toLowerCase();
    return [...this.index.values()]
      .filter((thread) => Boolean(thread.archived) === Boolean(archived))
      .filter((thread) => !term || `${thread.name || ''} ${thread.preview || ''}`.toLowerCase().includes(term))
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  /** Native Codex sessions backing local conversations should not appear twice. */
  internalCodexThreadIds() {
    return [...this.index.values()].flatMap((thread) => [
      ...(Array.isArray(thread.internalCodexThreadIds) ? thread.internalCodexThreadIds : []),
      ...(thread.internalCodexThreadId ? [thread.internalCodexThreadId] : []),
    ]).filter(Boolean);
  }

  async get(id) {
    if (!this.index.has(id)) return null;
    let record = this.cache.get(id);
    if (!record) {
      if (!this.loading.has(id)) {
        this.loading.set(id, (async () => {
          await this.writing.get(id);
          const loaded = JSON.parse(await readFile(this.#file(id), 'utf8'));
          loaded.thread = this.index.get(id);
          this.cache.set(id, loaded);
          return loaded;
        })().finally(() => this.loading.delete(id)));
      }
      record = await this.loading.get(id);
      if (!this.index.has(id)) return null;
    }
    this.cache.delete(id);
    this.cache.set(id, record);
    for (const candidate of this.cache.keys()) {
      if (this.cache.size <= CACHE_SIZE) break;
      // Never drop a record with unsaved or in-flight changes, nor one being used.
      if (candidate === id || this.timers.has(candidate) || this.writing.has(candidate) || this.cache.get(candidate)?.thread?.status?.type === 'active') continue;
      this.cache.delete(candidate);
    }
    return record;
  }

  async create({ cwd, accountId, provider, model = '', name = '', taskId = '', accessMode = '' }) {
    const id = `${LOCAL_PREFIX}${randomUUID()}`;
    const thread = { id, name, preview: '', cwd, createdAt: nowSeconds(), updatedAt: nowSeconds(), status: { type: 'idle' }, model, modelProvider: provider, accountId, provider, archived: false, source: 'harness', taskId, ...(accessMode ? { accessMode } : {}) };
    const record = { version: 1, thread, turns: [], queue: [], sessions: {}, sessionModels: {}, sessionTurnCounts: {}, lastAccountId: '' };
    this.index.set(id, thread);
    this.cache.set(id, record);
    await this.#write(record);
    return record;
  }

  /** Mutate a record and persist it shortly after (coalesced). */
  async update(id, mutate) {
    const record = await this.get(id);
    if (!record) return null;
    mutate(record);
    record.thread.updatedAt = nowSeconds();
    this.index.set(id, record.thread);
    clearTimeout(this.timers.get(id));
    this.timers.set(id, setTimeout(() => {
      this.#write(record).catch((error) => console.error('Falha ao salvar conversa local:', error.message)).finally(() => this.timers.delete(id));
    }, SAVE_DELAY_MS));
    return record;
  }

  async flush(id) {
    if (this.timers.has(id)) {
      clearTimeout(this.timers.get(id));
      this.timers.delete(id);
      const record = this.cache.get(id);
      if (record) await this.#write(record);
    }
    await this.writing.get(id);
  }

  async remove(id) {
    clearTimeout(this.timers.get(id));
    this.timers.delete(id);
    this.index.delete(id);
    this.cache.delete(id);
    await this.writing.get(id)?.catch(() => {});
    await rm(this.#file(id), { force: true });
  }

  #file(id) { return join(this.dir, `${id}.json`); }

  /** Writes of one thread are serialized; a removed thread is never written again. */
  #write(record) {
    const id = record.thread.id;
    const previous = this.writing.get(id) || Promise.resolve();
    const run = previous.catch(() => {}).then(async () => {
      if (!this.index.has(id)) return;
      const file = this.#file(id);
      const temporary = `${file}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(record), { mode: 0o600 });
      await rename(temporary, file);
    });
    const tracked = run.finally(() => { if (this.writing.get(id) === tracked) this.writing.delete(id); });
    this.writing.set(id, tracked);
    return tracked;
  }
}
