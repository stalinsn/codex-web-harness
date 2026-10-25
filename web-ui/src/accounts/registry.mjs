// Account registry (CODEX_HOME/web-accounts.json) and per-account runtime state
// (CODEX_HOME/web-accounts-state.json). The primary Codex account — the one the chat
// UI talks to — is always present with id "codex".
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../config.mjs';
import { httpError } from '../http/respond.mjs';
import { PROVIDERS } from './providers.mjs';

export const PRIMARY_ID = 'codex';
const RESERVED_IDS = new Set([PRIMARY_ID, 'rotation']);
const ACCOUNT_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const DEFAULT_ROTATION = { order: [PRIMARY_ID], switchAtPercent: 95, proactiveHandoff: true, autoContinue: true, defaultCooldownMinutes: 60 };
const EDITABLE = ['label', 'enabled', 'model', 'effort', 'permissionMode', 'bin', 'args', 'resumeArgs', 'parser', 'env'];

export const accountsDir = () => join(config.codexHome, 'web-accounts');
const registryFile = () => join(config.codexHome, 'web-accounts.json');
const stateFile = () => join(config.codexHome, 'web-accounts-state.json');

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}

async function writeJson(path, value) {
  await mkdir(config.codexHome, { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  await rename(temporary, path);
}

function sanitizeEnv(env) {
  if (!env || typeof env !== 'object' || Array.isArray(env)) return {};
  return Object.fromEntries(Object.entries(env).filter(([key, value]) => /^[A-Z_][A-Z0-9_]{0,63}$/.test(key) && typeof value === 'string' && value.length < 4096));
}

function sanitizeArgs(args) {
  if (args == null) return undefined;
  if (!Array.isArray(args)) throw httpError('Os argumentos precisam ser uma lista.', 400);
  const ok = (part) => typeof part === 'string' && part.length < 2048;
  for (const part of args) if (!(ok(part) || (Array.isArray(part) && part.every(ok)))) throw httpError('Argumento inválido na lista.', 400);
  return args;
}

function normalizeAccount(raw) {
  const preset = PROVIDERS[raw.provider];
  if (!preset) return null;
  return {
    id: raw.id,
    provider: raw.provider,
    label: typeof raw.label === 'string' && raw.label.trim() ? raw.label.trim().slice(0, 60) : preset.label,
    enabled: raw.enabled !== false,
    dir: typeof raw.dir === 'string' && raw.dir ? raw.dir : join(accountsDir(), raw.id),
    model: typeof raw.model === 'string' ? raw.model.slice(0, 100) : '',
    effort: typeof raw.effort === 'string' ? raw.effort.slice(0, 30) : '',
    permissionMode: typeof raw.permissionMode === 'string' ? raw.permissionMode.slice(0, 40) : '',
    bin: typeof raw.bin === 'string' ? raw.bin.slice(0, 300) : '',
    args: Array.isArray(raw.args) ? raw.args : undefined,
    resumeArgs: Array.isArray(raw.resumeArgs) ? raw.resumeArgs : undefined,
    parser: typeof raw.parser === 'string' ? raw.parser : '',
    env: sanitizeEnv(raw.env),
  };
}

export class AccountRegistry {
  constructor() {
    this.accounts = [];
    this.rotation = { ...DEFAULT_ROTATION };
    this.state = {};
  }

  async load() {
    const stored = await readJson(registryFile(), { accounts: [], rotation: {} });
    const accounts = (Array.isArray(stored.accounts) ? stored.accounts : [])
      .filter((item) => item && ACCOUNT_ID.test(item.id) && item.id !== PRIMARY_ID)
      .map(normalizeAccount).filter(Boolean);
    const primary = stored.accounts?.find?.((item) => item?.id === PRIMARY_ID) || {};
    this.accounts = [{ ...normalizeAccount({ ...primary, id: PRIMARY_ID, provider: 'codex', label: primary.label || 'Codex' }), dir: config.codexHome, primary: true }, ...accounts];
    const rotation = stored.rotation || {};
    const known = new Set(this.accounts.map((account) => account.id));
    const order = (Array.isArray(rotation.order) ? rotation.order : []).filter((id) => known.has(id));
    for (const account of this.accounts) if (!order.includes(account.id)) order.push(account.id);
    this.rotation = {
      order: [...new Set(order)],
      switchAtPercent: clampPercent(rotation.switchAtPercent ?? DEFAULT_ROTATION.switchAtPercent),
      proactiveHandoff: rotation.proactiveHandoff ?? DEFAULT_ROTATION.proactiveHandoff,
      autoContinue: rotation.autoContinue ?? DEFAULT_ROTATION.autoContinue,
      defaultCooldownMinutes: Math.min(24 * 60, Math.max(1, Number(rotation.defaultCooldownMinutes) || DEFAULT_ROTATION.defaultCooldownMinutes)),
    };
    this.state = await readJson(stateFile(), {});
    return this;
  }

  async save() {
    const serialize = ({ primary, dir, ...account }) => ({ ...account, ...(primary ? {} : { dir }) });
    await writeJson(registryFile(), { version: 1, accounts: this.accounts.map(serialize), rotation: this.rotation });
  }

  async saveState() { await writeJson(stateFile(), this.state); }

  get(id) { return this.accounts.find((account) => account.id === id) || null; }

  stateOf(id) {
    this.state[id] ||= { cooldownUntil: 0, percent: null, percentAt: 0, resetsAt: 0, lastLimit: null, segments: 0, lastUsedAt: 0, loggedIn: null, checkedAt: 0, statusDetail: '' };
    return this.state[id];
  }

  ordered() {
    return this.rotation.order.map((id) => this.get(id)).filter(Boolean);
  }

  async add({ id, provider, label, ...rest }) {
    const slug = String(id || '').trim().toLowerCase();
    if (!ACCOUNT_ID.test(slug) || RESERVED_IDS.has(slug)) throw httpError('Use um identificador com letras minúsculas, números e hífens (até 40).', 400);
    if (this.get(slug)) throw httpError('Já existe uma conta com esse identificador.', 409);
    if (!PROVIDERS[provider]) throw httpError('Provedor desconhecido.', 400);
    const account = normalizeAccount({ id: slug, provider, label, ...pick(rest), args: sanitizeArgs(rest.args), resumeArgs: sanitizeArgs(rest.resumeArgs) });
    await mkdir(account.dir, { recursive: true, mode: 0o700 });
    this.accounts.push(account);
    this.rotation.order.push(account.id);
    await this.save();
    return account;
  }

  async update(id, changes) {
    const account = this.get(id);
    if (!account) throw httpError('Conta não encontrada.', 404);
    const patch = pick(changes);
    if ('args' in changes) patch.args = sanitizeArgs(changes.args);
    if ('resumeArgs' in changes) patch.resumeArgs = sanitizeArgs(changes.resumeArgs);
    if (account.primary) for (const key of ['bin', 'args', 'resumeArgs', 'parser', 'env']) delete patch[key];
    const next = { ...normalizeAccount({ ...account, ...patch }), ...(account.primary ? { dir: account.dir, primary: true } : {}) };
    this.accounts = this.accounts.map((item) => (item.id === id ? next : item));
    await this.save();
    return next;
  }

  async remove(id) {
    const account = this.get(id);
    if (!account) throw httpError('Conta não encontrada.', 404);
    if (account.primary) throw httpError('A conta principal do Codex não pode ser removida.', 400);
    this.accounts = this.accounts.filter((item) => item.id !== id);
    this.rotation.order = this.rotation.order.filter((item) => item !== id);
    delete this.state[id];
    await this.save();
    await this.saveState();
    return account;
  }

  async setRotation(changes) {
    const next = { ...this.rotation };
    if (Array.isArray(changes.order)) {
      const known = new Set(this.accounts.map((account) => account.id));
      const order = [...new Set(changes.order.filter((id) => known.has(id)))];
      for (const account of this.accounts) if (!order.includes(account.id)) order.push(account.id);
      next.order = order;
    }
    if (changes.switchAtPercent != null) next.switchAtPercent = clampPercent(changes.switchAtPercent);
    if (typeof changes.proactiveHandoff === 'boolean') next.proactiveHandoff = changes.proactiveHandoff;
    if (typeof changes.autoContinue === 'boolean') next.autoContinue = changes.autoContinue;
    if (changes.defaultCooldownMinutes != null) next.defaultCooldownMinutes = Math.min(24 * 60, Math.max(1, Number(changes.defaultCooldownMinutes) || 60));
    this.rotation = next;
    await this.save();
    return next;
  }
}

function clampPercent(value) {
  return Math.min(100, Math.max(50, Math.round(Number(value) || 95)));
}

function pick(source) {
  return Object.fromEntries(EDITABLE.filter((key) => key in source && key !== 'args' && key !== 'resumeArgs').map((key) => [key, source[key]]));
}
