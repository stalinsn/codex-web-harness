// /api/integrations/*: server-to-server access for other systems of the same owner.
// Login and verify reuse the web password + e-mail code; the other routes take
// `Authorization: Bearer <token>` or, because the public reverse proxy drops
// Authorization, `X-Nyx-Integration-Token: <token>`. None accepts browser requests.
import { AuthError } from '../auth/auth-manager.mjs';
import { limits } from '../config.mjs';
import { getClientIp } from '../http/request.mjs';
import { fail, json, readBody } from '../http/respond.mjs';

const MAX_GENERATE_BODY = 512 * 1024;
const BEARER = /^Bearer ([A-Za-z0-9_-]{1,200})$/u;
const SESSION = /^\/api\/integrations\/sessions\/([a-f0-9]{16})$/;

/** Bearer/login routes, handled before the browser session gate. */
export const INTEGRATION_PATHS = new Set([
  '/api/integrations/login',
  '/api/integrations/verify',
  '/api/integrations/status',
  '/api/integrations/logout',
  '/api/integrations/generate-text',
  '/api/integrations/refresh-usage',
]);

/** Browsers always send one of these on cross-site or scripted requests. */
export function isBrowserRequest(req) {
  return Boolean(req.headers.origin || req.headers['sec-fetch-site'] || req.headers['sec-fetch-mode']);
}

const RAW_TOKEN = /^[A-Za-z0-9_-]{1,200}$/u;

export function bearerToken(req) {
  const bearer = BEARER.exec(String(req.headers.authorization || '').trim())?.[1];
  if (bearer) return bearer;
  const header = String(req.headers['x-nyx-integration-token'] || '').trim();
  return RAW_TOKEN.test(header) ? header : '';
}

/** Intervalo dos espaços enviados enquanto a IA trabalha (Cloudflare corta sem resposta em 100 s). */
export const KEEPALIVE_MS = 20_000;

/**
 * Geração longa: responde 200 na hora, manda um espaço a cada KEEPALIVE_MS (JSON aceita
 * espaços antes do valor) e termina com o resultado, ou com { error, statusCode, retryAfter? }
 * quando falha. Só com o cabeçalho X-Nyx-Keepalive: 1; sem ele, a rota segue igual.
 */
export async function keepAliveGenerate(integrations, session, body, res, intervalMs = KEEPALIVE_MS) {
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Accel-Buffering': 'no',
  });
  res.write(' ');
  const timer = setInterval(() => { try { res.write(' '); } catch { /* conexão fechada */ } }, intervalMs);
  try {
    const result = await integrations.generate(session, body);
    res.end(JSON.stringify(result));
  } catch (error) {
    const statusCode = error instanceof AuthError || error.statusCode ? (error.statusCode || 400) : 500;
    const message = statusCode === 500 && !error.statusCode ? 'Não foi possível concluir a solicitação da integração.' : error.message;
    if (statusCode === 500) console.error('Falha interna na geração da integração:', error?.message);
    res.end(JSON.stringify({ error: message, statusCode, ...(error.retryAfter ? { retryAfter: error.retryAfter } : {}) }));
  } finally {
    clearInterval(timer);
  }
}

export async function handleIntegrationApi(integrations, req, res, pathName) {
  try {
    if (isBrowserRequest(req)) return fail(res, 403, 'Esta rota aceita apenas chamadas entre servidores.');
    const isStatus = pathName === '/api/integrations/status';
    if (req.method !== (isStatus ? 'GET' : 'POST')) return fail(res, 405, 'Método não permitido.');

    if (pathName === '/api/integrations/login') {
      return json(res, 200, await integrations.startLogin(await readBody(req, limits.maxAuthBody), getClientIp(req)));
    }
    if (pathName === '/api/integrations/verify') {
      return json(res, 200, await integrations.verify(await readBody(req, limits.maxAuthBody)));
    }

    const session = integrations.authenticate(bearerToken(req));
    if (!session) {
      res.setHeader('WWW-Authenticate', 'Bearer');
      return fail(res, 401, 'Token de integração inválido, expirado ou revogado.');
    }
    if (isStatus) return json(res, 200, integrations.status(session));
    if (pathName === '/api/integrations/logout') return json(res, 200, await integrations.logout(session));
    if (pathName === '/api/integrations/refresh-usage') return json(res, 200, await integrations.refreshUsage(session, await readBody(req, limits.maxAuthBody).catch(() => ({}))));

    let body;
    try { body = await readBody(req, MAX_GENERATE_BODY); }
    catch (error) {
      if (error.statusCode === 413) return fail(res, 413, 'A solicitação ultrapassa o limite de 512 KB.');
      throw error;
    }
    if (String(req.headers['x-nyx-keepalive'] || '') === '1') return keepAliveGenerate(integrations, session, body, res);
    return json(res, 200, await integrations.generate(session, body));
  } catch (error) {
    if (error.retryAfter) res.setHeader('Retry-After', String(error.retryAfter));
    if (error instanceof AuthError || error.statusCode) return fail(res, error.statusCode || 400, error.message);
    console.error('Falha interna na rota de integração:', error?.message);
    return fail(res, 500, 'Não foi possível concluir a solicitação da integração.');
  }
}

/** Owner-only routes behind the browser session: list and revoke integration tokens. */
export function registerIntegrationRoutes(router, { integrations }) {
  if (!integrations) return;
  router.get('/api/integrations/sessions', ({ res }) => json(res, 200, { sessions: integrations.sessions.list() }));
  router.delete(SESSION, async ({ res, params: [id] }) => {
    if (!await integrations.sessions.revoke(id)) return fail(res, 404, 'Integração não encontrada.');
    return json(res, 200, { sessions: integrations.sessions.list() });
  });
}
