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
  }

  async load() {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    for (const file of await readdir(this.dir)) {
      if (!file.endsWith('.json')) continue;
      try {
        const record = JSON.parse(await readFile(join(this.dir, file), 'utf8'));
        if (!isLocalThread(record?.thread?.id)) continue;
        // A turn cut by a restart cannot resume its process; close it.
        if (record.thread.status?.type === 'active') {
          record.thread.status = { type: 'idle' };
          for (const turn of record.turns || []) if (turn.status === 'inProgress') Object.assign(turn, { status: 'interrupted', error: { message: 'O serviço foi reiniciado durante esta resposta.' } });
          await this.#write(record);
        }
        this.index.set(record.thread.id, record.thread);
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

  async get(id) {
    if (!this.index.has(id)) return null;
    let record = this.cache.get(id);
    if (!record) {
      record = JSON.parse(await readFile(this.#file(id), 'utf8'));
      record.thread = this.index.get(id);
    }
    this.cache.delete(id);
    this.cache.set(id, record);
    while (this.cache.size > CACHE_SIZE) {
      const [oldest] = this.cache.keys();
      if (this.timers.has(oldest)) break;
      this.cache.delete(oldest);
    }
    return record;
  }

  async create({ cwd, accountId, provider, model = '', name = '', taskId = '' }) {
    const id = `${LOCAL_PREFIX}${randomUUID()}`;
    const thread = { id, name, preview: '', cwd, createdAt: nowSeconds(), updatedAt: nowSeconds(), status: { type: 'idle' }, model, modelProvider: provider, accountId, provider, archived: false, source: 'harness', taskId };
    const record = { version: 1, thread, turns: [], queue: [], sessions: {}, lastAccountId: '' };
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
    this.timers.set(id, setTimeout(() => { this.timers.delete(id); this.#write(record).catch((error) => console.error('Falha ao salvar conversa local:', error.message)); }, SAVE_DELAY_MS));
    return record;
  }

  async flush(id) {
    if (!this.timers.has(id)) return;
    clearTimeout(this.timers.get(id));
    this.timers.delete(id);
    const record = this.cache.get(id);
    if (record) await this.#write(record);
  }

  async remove(id) {
    clearTimeout(this.timers.get(id));
    this.timers.delete(id);
    this.index.delete(id);
    this.cache.delete(id);
    await rm(this.#file(id), { force: true });
  }

  #file(id) { return join(this.dir, `${id}.json`); }

  async #write(record) {
    const file = this.#file(record.thread.id);
    const temporary = `${file}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(record), { mode: 0o600 });
    await rename(temporary, file);
  }
}
