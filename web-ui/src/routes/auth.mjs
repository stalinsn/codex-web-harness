// /api/auth/*: login with password + e-mail code, first access, reset, logout.
import { limits } from '../config.mjs';
import { getClientIp, isAllowedOrigin } from '../http/request.mjs';
import { fail, json, readBody } from '../http/respond.mjs';

export async function handleAuthApi(auth, req, res, pathName) {
  if (req.method === 'GET' && pathName === '/api/auth/status') {
    return json(res, 200, auth.status(req.headers.cookie));
  }
  if (req.method === 'POST' && !isAllowedOrigin(req, true)) return fail(res, 403, 'Origem não autorizada.');
  if (req.method !== 'POST') return fail(res, 405, 'Método não permitido.');

  const body = await readBody(req, limits.maxAuthBody);
  const ip = getClientIp(req);
  switch (pathName) {
    case '/api/auth/login/start': return json(res, 200, await auth.startLogin(body.password, ip));
    case '/api/auth/setup/start': return json(res, 200, await auth.startSetup(ip));
    case '/api/auth/reset/start': return json(res, 200, await auth.startReset(ip));
    case '/api/auth/resend': return json(res, 200, await auth.resendCode(body.challengeId, ip));
    case '/api/auth/login/verify':
      return startSession(auth, res, await auth.verifyLogin(body.challengeId, body.code));
    case '/api/auth/setup/complete':
      return startSession(auth, res, await auth.completeSetup(body.challengeId, body.code, body.password, body.confirmPassword));
    case '/api/auth/reset/complete':
      return startSession(auth, res, await auth.completeReset(body.challengeId, body.code, body.password, body.confirmPassword));
    case '/api/auth/logout':
      await auth.logout(req.headers.cookie);
      res.setHeader('Set-Cookie', auth.clearCookie());
      return json(res, 200, { ok: true });
    default:
      return fail(res, 404, 'Rota de autenticação não encontrada.');
  }
}

function startSession(auth, res, session) {
  res.setHeader('Set-Cookie', auth.sessionCookie(session.token));
  return json(res, 200, { ok: true, expiresIn: session.maxAge });
}
