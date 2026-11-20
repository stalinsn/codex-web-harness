// Authenticated read-only access to files in the user's projects.
import { readFile, realpath, stat } from 'node:fs/promises';
import { basename, extname, sep } from 'node:path';
import { fail } from '../http/respond.mjs';
import { getProjects, projectsRoot } from '../projects.mjs';

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const inDirectory = (path, directory) => path === directory || path.startsWith(directory.endsWith(sep) ? directory : `${directory}${sep}`);

// Rendered previews (?preview=1). Images are shown by the browser; HTML runs in an
// opaque-origin sandbox: its own inline scripts and styles work, but it can't read
// the harness session, call the API or load other files from the server.
const IMAGE_TYPES = new Map([
  ['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'], ['.gif', 'image/gif'], ['.svg', 'image/svg+xml'],
]);
const HTML_TYPES = new Set(['.html', '.htm']);
const IMAGE_POLICY = "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox";
const HTML_POLICY = [
  'sandbox allow-scripts allow-popups allow-modals',
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  'img-src data: blob: https:',
  'font-src data: https:',
  'media-src data: blob:',
  "frame-ancestors 'self'",
].join('; ');

export function previewKind(path) {
  const extension = extname(path).toLowerCase();
  if (IMAGE_TYPES.has(extension)) return { kind: 'image', type: IMAGE_TYPES.get(extension) };
  if (HTML_TYPES.has(extension)) return { kind: 'html', type: 'text/html; charset=utf-8' };
  return null;
}

export function registerLocalFileRoutes(router) {
  router.get('/api/local-files', async ({ res, url }) => {
    const requested = url.searchParams.get('path') || '';
    if (!requested.startsWith('/') || requested.includes('\0')) return fail(res, 400, 'O link não contém um caminho de arquivo válido.');

    let canonical;
    try { canonical = await realpath(requested); }
    catch { return fail(res, 404, 'O arquivo não foi encontrado no servidor.'); }
    const roots = [await projectsRoot(), ...(await getProjects()).map((project) => project.cwd)];
    const allowed = await Promise.all(roots.map((root) => realpath(root).catch(() => '')));
    if (!allowed.some((root) => root && inDirectory(canonical, root))) return fail(res, 403, 'Links de arquivo só podem abrir conteúdo dentro das pastas de projetos autorizadas.');

    const info = await stat(canonical).catch(() => null);
    if (!info?.isFile()) return fail(res, 404, 'O caminho não é um arquivo disponível.');
    if (info.size > MAX_FILE_BYTES) return fail(res, 413, 'Este arquivo é grande demais para abrir na prévia (limite de 8 MB).');

    let contents;
    try { contents = await readFile(canonical); }
    catch { return fail(res, 404, 'O arquivo não pôde ser lido.'); }
    const displayName = basename(canonical).replace(/[\r\n"\\]/g, '_');
    const safeAsciiName = displayName.replace(/[^\x20-\x7e]/g, '_');
    const disposition = (mode) => `${mode}; filename="${safeAsciiName}"; filename*=UTF-8''${encodeURIComponent(displayName)}`;

    const preview = url.searchParams.get('preview') === '1' ? previewKind(canonical) : null;
    if (preview) {
      if (preview.kind === 'html') res.setHeader('X-Frame-Options', 'SAMEORIGIN');
      res.writeHead(200, {
        'Content-Type': preview.type,
        'Content-Disposition': disposition('inline'),
        'Content-Security-Policy': preview.kind === 'html' ? HTML_POLICY : IMAGE_POLICY,
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'private, no-cache',
        'Last-Modified': info.mtime.toUTCString(),
        'Content-Length': contents.length,
      });
      return res.end(contents);
    }

    const isText = !contents.includes(0);
    res.writeHead(200, {
      'Content-Type': isText ? 'text/plain; charset=utf-8' : 'application/octet-stream',
      'Content-Disposition': disposition(isText ? 'inline' : 'attachment'),
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store',
      'Content-Length': contents.length,
    });
    return res.end(contents);
  });
}
