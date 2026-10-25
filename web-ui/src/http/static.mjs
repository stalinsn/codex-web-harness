// Static client assets: content-hashed URLs, long-lived caching and precompression.
//
// At start-up every file in public/ is read into memory, hashed and (when useful)
// compressed with brotli and gzip. index.html is rewritten so that each asset URL
// carries `?v=<hash>` and an import map pins every ES module to its hashed URL;
// those versioned responses are cached as immutable. service-worker.js receives the
// build id and the list of versioned URLs to precache. Set CODEX_UI_DEV=1 to reload
// the files on every page load while editing.
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { extname, join, relative, sep } from 'node:path';
import { promisify } from 'node:util';
import { brotliCompress, constants as zlib, gzip } from 'node:zlib';
import { fail } from './respond.mjs';

const brotli = promisify(brotliCompress);
const gzipAsync = promisify(gzip);

export const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};
const COMPRESSIBLE = new Set(['.html', '.js', '.css', '.webmanifest', '.json', '.svg']);
const IMMUTABLE = 'public, max-age=31536000, immutable';

const hashOf = (buffer) => createHash('sha256').update(buffer).digest('base64url').slice(0, 12);

async function listFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  return entries.filter((entry) => entry.isFile() && !entry.name.startsWith('.')).map((entry) => join(entry.parentPath ?? entry.path, entry.name));
}

async function makeAsset(body, ext) {
  const asset = { body, hash: hashOf(body), type: MIME_TYPES[ext] || 'application/octet-stream' };
  if (COMPRESSIBLE.has(ext) && body.length > 1024) {
    [asset.br, asset.gzip] = await Promise.all([
      brotli(body, { params: { [zlib.BROTLI_PARAM_QUALITY]: 11, [zlib.BROTLI_PARAM_SIZE_HINT]: body.length } }),
      gzipAsync(body, { level: 9 }),
    ]);
  }
  return asset;
}

export class StaticAssets {
  constructor({ publicDir, prefix, dev = false }) {
    this.publicDir = publicDir;
    this.prefix = prefix;
    this.dev = dev;
    this.assets = new Map(); // '/path' -> asset
    this.indexScriptHashes = [];
    this.buildId = '';
  }

  async load() {
    const assets = new Map();
    for (const file of await listFiles(this.publicDir)) {
      const path = `/${relative(this.publicDir, file).split(sep).join('/')}`;
      assets.set(path, { ...(await makeAsset(await readFile(file), extname(file).toLowerCase())), path });
    }
    const versioned = (path) => `${this.prefix}${path}?v=${assets.get(path).hash}`;
    const shellPaths = [...assets.keys()].filter((path) => path !== '/index.html' && path !== '/service-worker.js').sort();
    this.buildId = hashOf(shellPaths.map((path) => assets.get(path).hash).join(':'));

    const index = assets.get('/index.html');
    if (index) {
      let html = index.body.toString('utf8').replace(/(href|src)="(\/[^"?#]+)"/g, (match, attribute, url) => {
        if (!url.startsWith(`${this.prefix}/`)) return match;
        const path = url.slice(this.prefix.length);
        return assets.has(path) ? `${attribute}="${versioned(path)}"` : match;
      });
      const modules = shellPaths.filter((path) => path.startsWith('/js/') && path.endsWith('.js'));
      const importMap = JSON.stringify({ imports: Object.fromEntries(modules.map((path) => [`${this.prefix}${path}`, versioned(path)])) });
      const preload = modules.map((path) => `    <link rel="modulepreload" href="${versioned(path)}" />`).join('\n');
      html = html.replace('</head>', `    <script type="importmap">${importMap}</script>\n${preload}\n  </head>`);
      this.indexScriptHashes = [`sha256-${createHash('sha256').update(importMap).digest('base64')}`];
      assets.set('/index.html', { ...(await makeAsset(Buffer.from(html), '.html')), path: '/index.html', html: true });
    }

    const worker = assets.get('/service-worker.js');
    if (worker) {
      const shell = [`${this.prefix}/`, ...shellPaths.map(versioned)];
      const source = worker.body.toString('utf8')
        .replace("const BUILD = 'dev';", `const BUILD = '${this.buildId}';`)
        .replace('const SHELL = [];', `const SHELL = ${JSON.stringify(shell)};`);
      assets.set('/service-worker.js', { ...(await makeAsset(Buffer.from(source), '.js')), path: '/service-worker.js', worker: true });
    }
    this.assets = assets;
    return this;
  }

  async serve(req, res, pathName, url, securityHeaders) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return fail(res, 405, 'Método não permitido.');
    const path = pathName === '/' ? '/index.html' : pathName;
    if (this.dev && path === '/index.html') await this.load();
    const asset = this.assets.get(path);
    if (!asset) return fail(res, 404, 'Arquivo não encontrado.');
    if (asset.html) securityHeaders(res, { scriptHashes: this.indexScriptHashes });

    const etag = `"${asset.hash}"`;
    const pinned = !asset.html && !asset.worker && url.searchParams.get('v') === asset.hash;
    const headers = {
      'Content-Type': asset.type,
      'Cache-Control': pinned && !this.dev ? IMMUTABLE : 'no-cache',
      'ETag': etag,
      'X-Content-Type-Options': 'nosniff',
      'Vary': 'Accept-Encoding',
    };
    if (String(req.headers['if-none-match'] || '').split(',').map((value) => value.trim()).includes(etag)) {
      res.writeHead(304, headers);
      return res.end();
    }
    const accepts = String(req.headers['accept-encoding'] || '');
    let body = asset.body;
    if (asset.br && /\bbr\b/.test(accepts)) { body = asset.br; headers['Content-Encoding'] = 'br'; }
    else if (asset.gzip && /\bgzip\b/.test(accepts)) { body = asset.gzip; headers['Content-Encoding'] = 'gzip'; }
    headers['Content-Length'] = body.length;
    res.writeHead(200, headers);
    return res.end(req.method === 'HEAD' ? undefined : body);
  }
}
