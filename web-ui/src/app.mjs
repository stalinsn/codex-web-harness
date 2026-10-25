// HTTP request handling: auth API, session gate, JSON API routes, SSE and static files.
import { AuthError } from './auth/auth-manager.mjs';
import { config } from './config.mjs';
import { getPublicPath, isAllowedOrigin, isSafeMethod } from './http/request.mjs';
import { fail } from './http/respond.mjs';
import { Router } from './http/router.mjs';
import { applySecurityHeaders } from './http/security.mjs';
import { serveStatic } from './http/static.mjs';
import { handleAuthApi } from './routes/auth.mjs';
import { registerProjectRoutes } from './routes/projects.mjs';
import { registerSystemRoutes } from './routes/system.mjs';
import { registerThreadRoutes } from './routes/threads.mjs';
import { registerTurnRoutes } from './routes/turns.mjs';

export function createRequestHandler({ auth, codex, events }) {
  const router = new Router();
  const deps = { codex, events };
  registerSystemRoutes(router, deps);
  registerProjectRoutes(router, deps);
  registerThreadRoutes(router, deps);
  registerTurnRoutes(router, deps);

  async function handleRequest(req, res) {
    applySecurityHeaders(res);
    let url;
    let pathName;
    try {
      url = new URL(req.url || '/', 'http://localhost');
      pathName = getPublicPath(decodeURIComponent(url.pathname));
    } catch {
      return fail(res, 400, 'Endereço inválido.');
    }
    if (pathName === null) return fail(res, 404, 'Rota não encontrada.');
    if (!pathName.startsWith('/api/')) return serveStatic(config.publicDir, req, res, pathName);

    if (pathName.startsWith('/api/auth/')) {
      try { return await handleAuthApi(auth, req, res, pathName); }
      catch (error) {
        if (error instanceof AuthError) return fail(res, error.statusCode, error.message);
        console.error('Falha interna no fluxo de autenticação do Codex.');
        return fail(res, 500, 'Não foi possível concluir a autenticação. Tente novamente.');
      }
    }
    if (req.headers.origin && !isAllowedOrigin(req)) return fail(res, 403, 'Origem não autorizada.');
    if (!isSafeMethod(req.method) && !isAllowedOrigin(req, true)) return fail(res, 403, 'Origem não autorizada.');
    if (!auth.getSession(req.headers.cookie)) return fail(res, 401, 'Entre para usar o Codex.');
    if (!codex.ready) return fail(res, 503, 'O Codex está iniciando. Aguarde alguns segundos e tente novamente.');
    if (req.method === 'GET' && pathName === '/api/events') return events.attach(req, res);

    const route = router.match(req.method, pathName);
    if (!route) return fail(res, 404, 'Rota não encontrada.');
    try { return await route.handler({ req, res, url, params: route.params }); }
    catch (error) {
      const status = error.statusCode || (error.message?.includes('not a directory') ? 400 : 500);
      return fail(res, status, error.message || 'Erro interno do harness.');
    }
  }

  // Never let one bad request take the process down.
  return (req, res) => handleRequest(req, res).catch((error) => {
    console.error('Falha inesperada ao responder', req.method, error?.message);
    if (!res.headersSent) fail(res, 500, 'Erro interno do harness.');
    else res.destroy();
  });
}
