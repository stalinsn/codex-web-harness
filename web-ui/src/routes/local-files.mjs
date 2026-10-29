// Authenticated read-only access to files in the user's projects.
import { readFile, realpath, stat } from 'node:fs/promises';
import { basename, sep } from 'node:path';
import { fail } from '../http/respond.mjs';
import { getProjects, projectsRoot } from '../projects.mjs';

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const inDirectory = (path, directory) => path === directory || path.startsWith(directory.endsWith(sep) ? directory : `${directory}${sep}`);

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
    const isText = !contents.includes(0);
    const displayName = basename(canonical).replace(/[\r\n"\\]/g, '_');
    const safeAsciiName = displayName.replace(/[^\x20-\x7e]/g, '_');
    res.writeHead(200, {
      'Content-Type': isText ? 'text/plain; charset=utf-8' : 'application/octet-stream',
      'Content-Disposition': `${isText ? 'inline' : 'attachment'}; filename="${safeAsciiName}"; filename*=UTF-8''${encodeURIComponent(displayName)}`,
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store',
      'Content-Length': contents.length,
    });
    return res.end(contents);
  });
}
