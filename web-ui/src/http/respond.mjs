// JSON responses, request bodies and HTTP-aware errors.
import { limits } from '../config.mjs';

export function httpError(message, statusCode = 400, extra = {}) {
  return Object.assign(new Error(message), { statusCode, ...extra });
}

export function json(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify(data));
}

export function fail(res, status, message) { json(res, status, { error: message }); }

export function readBody(req, limit = limits.maxBody) {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        rejectPromise(httpError(limit <= limits.maxAuthBody ? 'A solicitação de autenticação é muito grande.' : 'A solicitação ultrapassa o limite de 48 MB.', 413));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try { resolvePromise(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch { rejectPromise(httpError('JSON inválido.', 400)); }
    });
    req.on('error', rejectPromise);
  });
}
