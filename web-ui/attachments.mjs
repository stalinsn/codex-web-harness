import { mkdir, writeFile, lstat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

const failure = (message) => Object.assign(new Error(message), { statusCode: 400 });

export async function saveFiles(root, threadId, files = []) {
  if (!Array.isArray(files) || files.length > 8) throw failure('Envie no máximo 8 arquivos por mensagem.');
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(threadId)) throw failure('Conversa inválida.');
  const decoded = files.map((file) => {
    if (!file || typeof file.data !== 'string' || file.data.length > 16 * 1024 * 1024 || !/^[A-Za-z0-9+/]*={0,2}$/.test(file.data)) throw failure('Arquivo inválido ou maior que 12 MB.');
    const bytes = Buffer.from(file.data, 'base64');
    if (bytes.length > 12 * 1024 * 1024) throw failure('O limite é 12 MB por arquivo.');
    const name = basename(String(file.name || 'arquivo').replace(/\\/g, '/')).replace(/[\x00-\x1f\x7f]/g, '').slice(0, 180) || 'arquivo';
    const extension = /^\.[a-z0-9]{1,12}$/i.test(extname(name)) ? extname(name).toLowerCase() : '.bin';
    return { name, extension, bytes, mime: String(file.mime || 'application/octet-stream').slice(0, 100) };
  });
  if (decoded.reduce((total, file) => total + file.bytes.length, 0) > 24 * 1024 * 1024) throw failure('O limite total é 24 MB por mensagem.');
  if (!decoded.length) return [];
  const directory = join(root, threadId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const input = [];
  for (const file of decoded) {
    const path = join(directory, `${Date.now()}-${randomUUID()}${file.extension}`);
    await writeFile(path, file.bytes, { mode: 0o600, flag: 'wx' });
    const metadata = { name: file.name, path, mime: file.mime, size: file.bytes.length };
    input.push({ type: 'text', text: `[Arquivo anexado]\n${JSON.stringify(metadata)}\n[/Arquivo anexado]` });
  }
  return input;
}

export async function serveFile(root, threadId, name, req, res, url) {
  const path = join(root, threadId, name);
  let info;
  try { info = await lstat(path); } catch { res.writeHead(404); return res.end('Arquivo não encontrado.'); }
  if (!info.isFile() || info.isSymbolicLink()) { res.writeHead(404); return res.end('Arquivo não encontrado.'); }
  const audioType = { '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.mp4': 'audio/mp4', '.webm': 'audio/webm', '.ogg': 'audio/ogg', '.aac': 'audio/aac' }[extname(name).toLowerCase()];
  const download = !audioType || url.searchParams.has('download');
  const displayName = String(url.searchParams.get('name') || name).replace(/[\x00-\x1f\x7f]/g, '').slice(0, 180);
  const headers = { 'Content-Type': audioType || 'application/octet-stream', 'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(displayName)}`, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, max-age=300', 'Accept-Ranges': 'bytes' };
  let start = 0; let end = info.size - 1; let status = 200;
  if (req.headers.range && info.size) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
    if (!match || (!match[1] && !match[2])) { res.writeHead(416, { 'Content-Range': `bytes */${info.size}` }); return res.end(); }
    start = match[1] ? Number(match[1]) : Math.max(0, info.size - Number(match[2]));
    end = match[1] && match[2] ? Math.min(Number(match[2]), end) : end;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= info.size) { res.writeHead(416, { 'Content-Range': `bytes */${info.size}` }); return res.end(); }
    status = 206; headers['Content-Range'] = `bytes ${start}-${end}/${info.size}`;
  }
  headers['Content-Length'] = info.size ? end - start + 1 : 0;
  res.writeHead(status, headers);
  if (!info.size) return res.end();
  const stream = createReadStream(path, { start, end });
  stream.on('error', () => res.destroy());
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}
