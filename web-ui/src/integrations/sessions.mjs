// Integration sessions (CODEX_HOME/web-integrations.json): bearer tokens issued to other
// systems of the same owner after the password + e-mail code login. The token is shown
// once; only its SHA-256 is stored, next to metadata the owner can list and revoke.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export const INTEGRATION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_ACTIVE_INTEGRATIONS = 10;
export const INTEGRATION_SCOPES = Object.freeze(['generate:text']);
const TOKEN = /^nyxh_([a-f0-9]{16})_([A-Za-z0-9_-]{43})$/u;
const TOUCH_EVERY_MS = 5 * 60 * 1000;
// Revoked or expired records stay listed for a while, then are dropped.
const KEEP_INACTIVE_MS = 7 * 24 * 60 * 60 * 1000;

const sha256 = (value) => createHash('sha256').update(value, 'utf8').digest('hex');
const DUMMY_HASH = sha256('nyxh-dummy');

function safeEqualHex(left, right) {
  const a = Buffer.from(String(left), 'utf8');
  const b = Buffer.from(String(right), 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

export const isActive = (entry, now = Date.now()) => !entry.revoked && entry.expiresAt > now;

/** Public view: never includes the hash. */
export function publicSession(entry, now = Date.now()) {
  return {
    id: entry.id,
    label: entry.label,
    client: entry.client,
    scopes: [...entry.scopes],
    createdAt: entry.createdAt,
    lastUsedAt: entry.lastUsedAt,
    expiresAt: entry.expiresAt,
    revoked: Boolean(entry.revoked),
    active: isActive(entry, now),
  };
}

export class IntegrationSessions {
  constructor(filePath, { now = () => Date.now() } = {}) {
    this.filePath = filePath;
    this.now = now;
    this.sessions = [];
    this.writeQueue = Promise.resolve();
  }

  async load() {
    let stored = { sessions: [] };
    try { stored = JSON.parse(await readFile(this.filePath, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    this.sessions = (Array.isArray(stored?.sessions) ? stored.sessions : [])
      .filter((entry) => entry && /^[a-f0-9]{16}$/u.test(entry.id) && /^[a-f0-9]{64}$/u.test(entry.tokenHash) && Number.isFinite(entry.expiresAt));
    if (this.#prune()) await this.persist();
    return this;
  }

  /** @returns {Promise<{token: string, session: object}>} the plain token is returned only here. */
  async issue({ client, label = '' }) {
    const now = this.now();
    this.#prune();
    const active = this.sessions.filter((entry) => isActive(entry, now)).sort((a, b) => a.createdAt - b.createdAt);
    for (const entry of active.slice(0, Math.max(0, active.length - MAX_ACTIVE_INTEGRATIONS + 1))) {
      entry.revoked = true;
      entry.revokedAt = now;
    }
    let id;
    do id = randomBytes(8).toString('hex'); while (this.sessions.some((entry) => entry.id === id));
    const token = `nyxh_${id}_${randomBytes(32).toString('base64url')}`;
    const entry = {
      id,
      tokenHash: sha256(token),
      label: String(label || client).slice(0, 60),
      client,
      scopes: [...INTEGRATION_SCOPES],
      createdAt: now,
      lastUsedAt: 0,
      expiresAt: now + INTEGRATION_TTL_MS,
      revoked: false,
    };
    this.sessions.push(entry);
    await this.persist();
    return { token, session: publicSession(entry, now) };
  }

  /** Session for a bearer token, or null. The hash comparison is constant time. */
  authenticate(token) {
    const now = this.now();
    const match = TOKEN.exec(String(token || ''));
    const entry = match ? this.sessions.find((item) => item.id === match[1]) : null;
    const candidate = sha256(String(token || ''));
    const equal = safeEqualHex(entry?.tokenHash || DUMMY_HASH, candidate);
    if (!entry || !equal || !isActive(entry, now)) return null;
    if (now - (entry.lastUsedAt || 0) > TOUCH_EVERY_MS) {
      entry.lastUsedAt = now;
      this.persist().catch(() => {});
    }
    return entry;
  }

  list() {
    const now = this.now();
    return this.sessions.map((entry) => publicSession(entry, now)).sort((a, b) => b.createdAt - a.createdAt);
  }

  async revoke(id) {
    const entry = this.sessions.find((item) => item.id === id);
    if (!entry) return false;
    if (!entry.revoked) {
      entry.revoked = true;
      entry.revokedAt = this.now();
      await this.persist();
    }
    return true;
  }

  async revokeAll() {
    const now = this.now();
    let changed = false;
    for (const entry of this.sessions) if (!entry.revoked) { entry.revoked = true; entry.revokedAt = now; changed = true; }
    if (changed) await this.persist();
  }

  #prune() {
    const now = this.now();
    const before = this.sessions.length;
    this.sessions = this.sessions.filter((entry) => {
      const endedAt = entry.revoked ? (entry.revokedAt || entry.expiresAt) : entry.expiresAt;
      return isActive(entry, now) || endedAt > now - KEEP_INACTIVE_MS;
    });
    return this.sessions.length !== before;
  }

  async persist() {
    const run = async () => {
      await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
      const temporary = `${this.filePath}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
      await writeFile(temporary, `${JSON.stringify({ version: 1, sessions: this.sessions }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await rename(temporary, this.filePath);
    };
    this.writeQueue = this.writeQueue.then(run, run);
    await this.writeQueue;
  }
}
