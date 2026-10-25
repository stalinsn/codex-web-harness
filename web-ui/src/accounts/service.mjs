// Account service: status checks, usage bookkeeping, availability and running a
// segment on whichever provider an account uses.
import { rm } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { config } from '../config.mjs';
import { CodexAppServer } from '../codex/app-server.mjs';
import { httpError } from '../http/respond.mjs';
import { accountEnv, checkCliLogin, commandFor, runCliSegment } from './cli-runner.mjs';
import { codexUsage } from './codex-usage.mjs';
import { runCodexSegment } from './codex-runner.mjs';
import { PROVIDERS } from './providers.mjs';
import { accountsDir } from './registry.mjs';

const USAGE_FRESH_MS = 30 * 60 * 1000;
const shellQuote = (value) => (/^[\w@%+=:,./-]+$/.test(value) ? value : `'${String(value).replace(/'/g, "'\\''")}'`);

export class AccountService {
  constructor({ registry, primaryCodex, emit }) {
    this.registry = registry;
    this.primaryCodex = primaryCodex;
    this.emit = emit;
    this.codexServers = new Map([[primaryCodex.codexHome, primaryCodex]]);
    this.busy = new Map(); // accountId -> taskId
    this.onOrchestratedThread = () => {};
    primaryCodex.subscribe((message) => {
      if (message.method === 'account/rateLimits/updated') this.#recordCodexUsage('codex', message.params);
    });
  }

  /** Public view of every account for the UI. */
  list() {
    const now = Date.now();
    return this.registry.ordered().map((account) => {
      const preset = PROVIDERS[account.provider];
      const state = this.registry.stateOf(account.id);
      if (account.primary) {
        const { percent, resetsAt } = codexUsage(this.primaryCodex.rateLimits);
        if (percent != null) Object.assign(state, { percent, resetsAt, percentAt: now });
        if (this.primaryCodex.account) state.loggedIn = true;
      }
      return {
        id: account.id,
        provider: account.provider,
        providerLabel: preset.label,
        label: account.label,
        primary: Boolean(account.primary),
        enabled: account.enabled,
        model: account.model,
        effort: account.effort,
        permissionMode: account.permissionMode || preset.permissionMode || '',
        usageSource: preset.usage,
        loggedIn: state.loggedIn,
        statusDetail: state.statusDetail,
        checkedAt: state.checkedAt,
        percent: state.percent,
        percentAt: state.percentAt,
        resetsAt: state.resetsAt,
        cooldownUntil: state.cooldownUntil > now ? state.cooldownUntil : 0,
        lastLimit: state.lastLimit,
        segments: state.segments,
        lastUsedAt: state.lastUsedAt,
        busyWith: this.busy.get(account.id) || '',
        loginCommand: this.loginCommand(account),
        logoutCommand: this.loginCommand(account, 'logout'),
        available: this.availability(account).ok,
        unavailableReason: this.availability(account).reason,
      };
    });
  }

  loginCommand(account, kind = 'login') {
    const preset = PROVIDERS[account.provider];
    const base = kind === 'logout' ? preset.logout : preset.login;
    if (!base) return '';
    const isolation = preset.isolation?.env;
    const prefix = isolation && !(account.primary && isolation === 'CODEX_HOME' && account.dir === config.codexHome) ? `${isolation}=${shellQuote(account.dir)} ` : '';
    const extra = Object.entries(account.env || {}).map(([key, value]) => `${key}=${shellQuote(value)} `).join('');
    const bin = account.bin && account.bin !== preset.bin ? base.replace(new RegExp(`^${preset.bin}\\b`), shellQuote(account.bin)) : base;
    return `${prefix}${extra}${bin}`;
  }

  availability(account, now = Date.now()) {
    const state = this.registry.stateOf(account.id);
    if (!account.enabled) return { ok: false, reason: 'Desativada' };
    if (state.loggedIn === false) return { ok: false, reason: 'Sem login' };
    if (state.cooldownUntil > now) return { ok: false, reason: 'Aguardando a janela de uso', until: state.cooldownUntil };
    if (this.busy.has(account.id)) return { ok: false, reason: 'Em uso por outra execução', until: now + 60 * 1000 };
    const fresh = state.percentAt && now - state.percentAt < USAGE_FRESH_MS && (!state.resetsAt || state.resetsAt * 1000 > now);
    if (fresh && state.percent != null && state.percent >= this.registry.rotation.switchAtPercent) {
      return { ok: false, reason: `Uso em ${Math.round(state.percent)}%`, until: state.resetsAt ? state.resetsAt * 1000 : 0 };
    }
    return { ok: true, reason: '' };
  }

  /** First available account following `order` (task-specific or the global rotation). */
  pick(order, { exclude = [] } = {}) {
    const ids = order?.length ? order : this.registry.rotation.order;
    for (const id of ids) {
      const account = this.registry.get(id);
      if (account && !exclude.includes(id) && this.availability(account).ok) return account;
    }
    return null;
  }

  /** Earliest moment some account in `order` should become usable again (ms), or 0. */
  nextAvailableAt(order) {
    const ids = order?.length ? order : this.registry.rotation.order;
    const times = ids.map((id) => this.registry.get(id)).filter((account) => account?.enabled)
      .map((account) => this.availability(account).until || 0).filter(Boolean);
    return times.length ? Math.min(...times) : 0;
  }

  async checkStatus(id) {
    const account = this.registry.get(id);
    if (!account) throw httpError('Conta não encontrada.', 404);
    const state = this.registry.stateOf(id);
    let result;
    if (account.provider === 'codex') {
      if (account.primary) result = this.primaryCodex.ready ? { loggedIn: Boolean(this.primaryCodex.account), detail: this.primaryCodex.account ? 'Sessão do Codex ativa.' : 'O Codex não informou uma conta.' } : { loggedIn: null, detail: 'O Codex ainda está iniciando.' };
      else result = await checkCliLogin(account);
    } else result = await checkCliLogin(account);
    Object.assign(state, { loggedIn: result.loggedIn, statusDetail: result.detail, checkedAt: Date.now() });
    await this.registry.saveState();
    this.emit('accounts-changed', {});
    return result;
  }

  async checkAll() {
    for (const account of this.registry.accounts) await this.checkStatus(account.id).catch(() => {});
  }

  /** Claim an account for a task in the same tick it was picked (no double booking). */
  reserve(accountId, taskId) {
    const holder = this.busy.get(accountId);
    if (holder && holder !== taskId) return false;
    this.busy.set(accountId, taskId);
    this.emit('accounts-changed', {});
    return true;
  }

  release(accountId, taskId) {
    if (this.busy.get(accountId) === taskId) this.busy.delete(accountId);
    this.emit('accounts-changed', {});
  }

  async markLimited(id, { resetsAt = 0, message = '' } = {}) {
    const state = this.registry.stateOf(id);
    const now = Date.now();
    const fallback = now + this.registry.rotation.defaultCooldownMinutes * 60 * 1000;
    // Reset times are unix seconds; tolerate milliseconds and cap at one week.
    const resetMs = resetsAt > 1e11 ? resetsAt : resetsAt * 1000;
    state.cooldownUntil = resetsAt ? Math.min(Math.max(resetMs, now + 60 * 1000), now + 7 * 24 * 60 * 60 * 1000) : fallback;
    state.lastLimit = { at: Date.now(), resetsAt, message: String(message || '').slice(0, 300) };
    await this.registry.saveState();
    this.emit('accounts-changed', {});
  }

  async recordUsage(id, percent, resetsAt = 0) {
    Object.assign(this.registry.stateOf(id), { percent, resetsAt, percentAt: Date.now() });
    await this.registry.saveState();
    this.emit('accounts-changed', {});
  }

  #recordCodexUsage(id, params) {
    const { percent, resetsAt } = codexUsage(params);
    if (percent != null) this.recordUsage(id, percent, resetsAt).catch(() => {});
  }

  codexServerFor(account) {
    const home = account.primary ? this.primaryCodex.codexHome : account.dir;
    let server = this.codexServers.get(home);
    if (!server) {
      // Nobody can answer approval prompts of a secondary account: decline them so the
      // turn continues (the policy tells the agent to stop as BLOCKED instead).
      server = new CodexAppServer({ bin: account.bin || config.codexBin, homeDir: config.homeDir, codexHome: home, emit: (type, data) => {
        if (type === 'server-request') server.respondToServerRequest(data.id, { decision: 'decline' });
      } });
      server.subscribe((message) => { if (message.method === 'account/rateLimits/updated') this.#recordCodexUsage(account.id, message.params); });
      server.start();
      this.codexServers.set(home, server);
    }
    return server;
  }

  /** Run one segment and update the account's bookkeeping. */
  async runSegment(account, { taskId, prompt, cwd, sessionId, title, onEvent, signal }) {
    if (!this.reserve(account.id, taskId)) throw new Error('A conta já está executando outra tarefa.');
    const state = this.registry.stateOf(account.id);
    state.segments += 1;
    state.lastUsedAt = Date.now();
    this.emit('accounts-changed', {});
    const handleEvent = (event) => {
      if (event.type === 'usage' && account.provider !== 'codex') this.recordUsage(account.id, event.percent, event.resetsAt).catch(() => {});
      if (event.type === 'session' && account.primary) this.onOrchestratedThread(event.sessionId);
      onEvent(event);
    };
    try {
      const outcome = account.provider === 'codex'
        ? await runCodexSegment({ server: this.codexServerFor(account), prompt, cwd, model: account.model, effort: account.effort, threadId: sessionId, title, onEvent: handleEvent, signal, handoff: { enabled: this.registry.rotation.proactiveHandoff, atPercent: this.registry.rotation.switchAtPercent } })
        : await runCliSegment({ account, prompt, cwd, sessionId, onEvent: handleEvent, signal });
      if (outcome.status === 'rate-limited') await this.markLimited(account.id, { resetsAt: outcome.resetsAt, message: outcome.error });
      return outcome;
    } finally {
      await this.registry.saveState().catch(() => {});
      this.emit('accounts-changed', {});
    }
  }

  /** Remove the account's isolated folder (its login) — only inside the harness accounts root. */
  async forgetCredentials(account) {
    const root = resolve(accountsDir()) + sep;
    if (account.primary || !resolve(account.dir).startsWith(root)) throw httpError('Esta pasta não foi criada pelo harness; saia da conta pela própria CLI.', 400);
    await rm(account.dir, { recursive: true, force: true });
  }

  /** Stop the app-server of a removed Codex account. */
  dropAccount(account) {
    if (account.provider !== 'codex' || account.primary) return;
    const server = this.codexServers.get(account.dir);
    server?.stop();
    this.codexServers.delete(account.dir);
  }

  stop() {
    for (const server of this.codexServers.values()) if (server !== this.primaryCodex) server.stop();
  }
}

export { accountEnv, commandFor };
