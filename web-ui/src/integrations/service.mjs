// Integration service: login through the web AuthManager (password + e-mail code),
// bearer sessions, and text-only generation on the account queue.
import { randomBytes } from 'node:crypto';
import { httpError } from '../http/respond.mjs';
import { PROVIDERS } from '../accounts/providers.mjs';
import { AuthError } from '../auth/auth-manager.mjs';
import { runText, textSupport } from './text-runner.mjs';

export const MAX_PROMPT_CHARS = 60_000;
export const GENERATIONS_PER_HOUR = 30;
const HOUR_MS = 60 * 60 * 1000;
const CLIENT = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,39}$/u;
const ACCOUNT_ID = /^[a-z0-9][a-z0-9-]{0,39}$/u;
const MIN_ATTEMPT_MS = 5000;

const clean = (value, max) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/gu, ' ').trim().slice(0, max);

export class IntegrationService {
  constructor({ auth, accounts, sessions, runTextImpl = runText, allowCodex, log = (line) => console.log(line), now = () => Date.now() }) {
    this.auth = auth;
    this.accounts = accounts;
    this.sessions = sessions;
    this.runText = runTextImpl;
    this.allowCodex = allowCodex;
    this.log = log;
    this.now = now;
    this.running = new Set(); // session ids with a generation in progress
    this.windows = new Map(); // session id -> generation timestamps
    auth.onPasswordReset = () => sessions.revokeAll();
  }

  support(account) {
    return textSupport(account, this.allowCodex === undefined ? undefined : { allowCodex: this.allowCodex });
  }

  /** Last known subscription usage of an account (from its most recent run). */
  #usageOf(account) {
    const state = this.accounts.registry.stateOf(account.id);
    const now = this.now();
    const tokens = state.reportedUsage || {};
    return {
      percent: state.percent ?? null,
      resetsAt: state.resetsAt || 0,
      checkedAt: state.percentAt || 0,
      windows: state.usageWindows || null,
      cooldownUntil: state.cooldownUntil > now ? state.cooldownUntil : 0,
      tokens: { total: tokens.totalTokens || 0, runs: tokens.runs || 0, lastAt: tokens.lastAt || 0 },
    };
  }

  async #recordUsage(account, outcome) {
    try {
      if (outcome.usage) {
        this.accounts.registry.stateOf(account.id).usageWindows = outcome.usage.windows;
        await this.accounts.recordUsage(account.id, outcome.usage.percent, outcome.usage.resetsAt);
      }
      if (outcome.tokens) await this.accounts.recordReportedUsage(account.id, outcome.tokens);
    } catch (error) {
      this.log(`Integração: não foi possível registrar o uso de ${account.id}: ${error.message}`);
    }
  }

  async startLogin(body, ip) {
    const client = clean(body?.client, 41);
    if (!CLIENT.test(client)) throw new AuthError('Informe o nome do sistema cliente (1 a 40 letras, números, espaço, ponto, hífen ou sublinhado).', 400);
    const { challengeId, expiresIn } = await this.auth.startIntegrationLogin(body?.password, client, ip);
    return { challengeId, expiresIn };
  }

  async verify(body) {
    const { client } = await this.auth.verifyIntegration(body?.challengeId, body?.code);
    const label = clean(body?.label, 60);
    const { token, session } = await this.sessions.issue({ client, label: label || client });
    this.log(`Integração ${session.id} (${client}) autorizada.`);
    return { token, expiresAt: session.expiresAt, scopes: session.scopes, id: session.id };
  }

  authenticate(token) { return this.sessions.authenticate(token); }

  status(session) {
    const providers = this.accounts.registry.ordered().map((account) => {
      const support = this.support(account);
      const availability = this.accounts.availability(account);
      const available = support.ok && availability.ok;
      return {
        id: account.id,
        provider: account.provider,
        label: account.label,
        available,
        ...(available ? {} : { reason: support.reason || availability.reason }),
        ...(support.ok ? { usage: this.#usageOf(account) } : {}),
      };
    });
    return { valid: true, expiresAt: session.expiresAt, client: session.client, scopes: [...session.scopes], providers };
  }

  async logout(session) {
    await this.sessions.revoke(session.id);
    this.log(`Integração ${session.id} (${session.client}) encerrada pelo cliente.`);
    return { ok: true };
  }

  /** Accounts a request may run on, in queue order. */
  candidates(requested) {
    const ordered = this.accounts.registry.ordered();
    const value = requested == null || requested === '' ? 'auto' : String(requested);
    if (value === 'auto') return { rotate: true, list: ordered.filter((account) => this.support(account).ok) };
    if (PROVIDERS[value]) {
      const list = ordered.filter((account) => account.provider === value);
      if (!list.length) throw httpError('Nenhuma conta deste provedor está cadastrada.', 404);
      const support = this.support(list[0]);
      if (!support.ok) throw httpError(support.reason, 422);
      return { rotate: true, list };
    }
    if (!ACCOUNT_ID.test(value)) throw httpError('Provedor ou conta inválido.', 400);
    const account = this.accounts.registry.get(value);
    if (!account) throw httpError('Conta não encontrada.', 404);
    const support = this.support(account);
    if (!support.ok) throw httpError(support.reason, 422);
    return { rotate: false, list: [account] };
  }

  consumeRate(sessionId) {
    const now = this.now();
    const times = (this.windows.get(sessionId) || []).filter((time) => time > now - HOUR_MS);
    if (times.length >= GENERATIONS_PER_HOUR) {
      throw httpError('Limite de gerações por hora atingido para este token.', 429, { retryAfter: Math.ceil((times[0] + HOUR_MS - now) / 1000) });
    }
    times.push(now);
    this.windows.set(sessionId, times);
  }

  async generate(session, body) {
    if (!session.scopes.includes('generate:text')) throw httpError('Este token não permite gerar texto.', 403);
    const prompt = body?.prompt;
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > MAX_PROMPT_CHARS) throw httpError(`Envie um prompt de 1 a ${MAX_PROMPT_CHARS} caracteres.`, 400);
    const timeoutSeconds = body?.timeoutSeconds ?? 240;
    if (typeof timeoutSeconds !== 'number' || !Number.isFinite(timeoutSeconds) || timeoutSeconds < 10 || timeoutSeconds > 300) throw httpError('timeoutSeconds precisa estar entre 10 e 300.', 400);
    const { rotate, list } = this.candidates(body?.provider);
    if (this.running.has(session.id)) throw httpError('Já existe uma geração em andamento para este token.', 409);
    this.consumeRate(session.id);
    this.running.add(session.id);
    try {
      return await this.#run(session, prompt, timeoutSeconds * 1000, rotate, list);
    } finally {
      this.running.delete(session.id);
    }
  }

  async #run(session, prompt, timeoutMs, rotate, list) {
    const deadline = this.now() + timeoutMs;
    const tried = new Set();
    let limited = '';
    while (true) {
      const account = list.find((item) => !tried.has(item.id) && this.accounts.availability(item).ok);
      const remaining = deadline - this.now();
      if (!account || remaining < MIN_ATTEMPT_MS) break;
      tried.add(account.id);
      const taskId = `integracao-${session.id}-${randomBytes(4).toString('hex')}`;
      if (!this.accounts.reserve(account.id, taskId)) continue;
      const started = this.now();
      let outcome;
      try {
        this.accounts.registry.stateOf(account.id).lastUsedAt = started;
        outcome = await this.runText({ account, prompt, timeoutMs: remaining, ...(this.allowCodex === undefined ? {} : { allowCodex: this.allowCodex }) });
      } catch (error) {
        outcome = { status: 'failed', text: '', error: error.message, resetsAt: 0 };
      } finally {
        this.accounts.release(account.id, taskId);
      }
      const ms = this.now() - started;
      await this.#recordUsage(account, outcome);
      this.log(`Integração ${session.id}: ${account.provider}/${account.id} ${outcome.status === 'completed' ? 'ok' : `falhou (${outcome.status})`} em ${ms} ms.`);
      if (outcome.status === 'completed') return { text: outcome.text, provider: account.provider, accountId: account.id, ms };
      if (outcome.status === 'rate-limited') {
        await this.accounts.markLimited(account.id, { resetsAt: outcome.resetsAt, message: outcome.error }).catch(() => {});
        limited = outcome.error || 'Limite de uso atingido.';
        if (rotate) continue;
        throw httpError(`A conta atingiu o limite de uso: ${limited}`.slice(0, 400), 429, { retryAfter: this.#retryAfter([account]) });
      }
      if (outcome.status === 'timeout') throw httpError('A geração excedeu o tempo máximo.', 504);
      throw httpError(`A geração falhou: ${outcome.error || 'erro desconhecido'}`.slice(0, 400), 502);
    }
    if (limited) throw httpError('Todas as contas disponíveis atingiram o limite de uso.', 429, { retryAfter: this.#retryAfter(list) });
    if (!list.length) throw httpError('Nenhuma conta conectada permite geração de texto sem ferramentas.', 503);
    throw httpError('Nenhuma conta está disponível agora. Tente novamente mais tarde.', 503, { retryAfter: this.#retryAfter(list) });
  }

  #retryAfter(list) {
    const at = this.accounts.nextAvailableAt(list.map((account) => account.id));
    return at ? Math.max(1, Math.ceil((at - this.now()) / 1000)) : 60;
  }
}
