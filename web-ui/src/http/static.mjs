// Static client files from public/ (the app shell is public; data needs a session).
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { fail } from './respond.mjs';

export const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

export async function serveStatic(publicDir, req, res, pathName) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return fail(res, 405, 'Método não permitido.');
  const relative = pathName === '/' ? '/index.html' : pathName;
  const filePath = resolve(publicDir, `.${relative}`);
  if (!filePath.startsWith(`${publicDir}${sep}`) && filePath !== join(publicDir, 'index.html')) return fail(res, 404, 'Arquivo não encontrado.');
  try {
    const info = await stat(filePath);
    if (!info.isFile()) return fail(res, 404, 'Arquivo não encontrado.');
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': extname(filePath) === '.html' ? 'no-store' : 'private, max-age=300',
      'X-Content-Type-Options': 'nosniff',
    });
    if (req.method === 'HEAD') return res.end();
    return createReadStream(filePath).pipe(res);
  } catch { return fail(res, 404, 'Arquivo não encontrado.'); }
}
