import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { StaticAssets } from '../src/http/static.mjs';

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'harness-static-'));
  await mkdir(join(dir, 'js'));
  await writeFile(join(dir, 'index.html'), '<html><head><link rel="stylesheet" href="/p/styles.css" /></head><body><script type="module" src="/p/js/app.js"></script></body></html>');
  await writeFile(join(dir, 'styles.css'), `body{color:red}${' '.repeat(2000)}`);
  await writeFile(join(dir, 'js', 'app.js'), "import './util.js';");
  await writeFile(join(dir, 'js', 'util.js'), 'export {};');
  await writeFile(join(dir, 'service-worker.js'), "const BUILD = 'dev';\nconst SHELL = [];\n");
  return new StaticAssets({ publicDir: dir, prefix: '/p' }).load();
}

function call(assets, path, { headers = {}, method = 'GET' } = {}) {
  const url = new URL(path, 'http://localhost');
  const res = { status: 0, headers: {}, body: null, writeHead(status, headers) { this.status = status; Object.assign(this.headers, headers); }, setHeader(name, value) { this.headers[name] = value; }, end(body) { this.body = body; } };
  const applied = [];
  return assets.serve({ method, headers }, res, url.pathname.slice(2) || '/', url, (r, options) => applied.push(options)).then(() => ({ res, applied }));
}

test('index.html gets versioned URLs, an import map and modulepreload hints', async () => {
  const assets = await fixture();
  const { res, applied } = await call(assets, '/p/');
  const html = res.body.toString();
  const css = assets.assets.get('/styles.css').hash;
  assert.match(html, new RegExp(`/p/styles.css\\?v=${css}`));
  assert.match(html, /<script type="importmap">.*"\/p\/js\/util.js":"\/p\/js\/util.js\?v=/);
  assert.match(html, /rel="modulepreload" href="\/p\/js\/app.js\?v=/);
  assert.equal(res.headers['Cache-Control'], 'no-cache');
  assert.equal(applied[0].scriptHashes.length, 1);
});

test('versioned assets are immutable, others revalidate with ETag', async () => {
  const assets = await fixture();
  const hash = assets.assets.get('/styles.css').hash;
  const pinned = await call(assets, `/p/styles.css?v=${hash}`);
  assert.match(pinned.res.headers['Cache-Control'], /immutable/);
  const stale = await call(assets, '/p/styles.css?v=old');
  assert.equal(stale.res.headers['Cache-Control'], 'no-cache');
  const notModified = await call(assets, '/p/styles.css', { headers: { 'if-none-match': `"${hash}"` } });
  assert.equal(notModified.res.status, 304);
});

test('compressed bodies follow Accept-Encoding', async () => {
  const assets = await fixture();
  const br = await call(assets, '/p/styles.css', { headers: { 'accept-encoding': 'gzip, br' } });
  assert.equal(br.res.headers['Content-Encoding'], 'br');
  const plain = await call(assets, '/p/styles.css');
  assert.equal(plain.res.headers['Content-Encoding'], undefined);
});

test('service worker receives build id and shell list; unknown paths 404', async () => {
  const assets = await fixture();
  const sw = (await call(assets, '/p/service-worker.js')).res.body.toString();
  assert.match(sw, new RegExp(`const BUILD = '${assets.buildId}'`));
  assert.match(sw, /"\/p\/js\/app.js\?v=/);
  assert.equal((await call(assets, '/p/../server.mjs')).res.status, 404);
  assert.equal((await call(assets, '/p/styles.css', { method: 'POST' })).res.status, 405);
});
