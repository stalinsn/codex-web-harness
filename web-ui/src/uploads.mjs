// Message attachments: validation, storage under CODEX_HOME/web-uploads/<thread>, cleanup and download.
import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, unlink, writeFile } from 'node:fs/promises';
import { basename, extname, join, resolve, sep } from 'node:path';
import { limits } from './config.mjs';
import { fail, httpError } from './http/respond.mjs';

const failure = (message) => httpError(message, 400);
const THREAD_ID = /^[a-zA-Z0-9_-]{1,100}$/;
const IMAGE_EXTENSIONS = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif' };
const IMAGE_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
const ATTACHMENT_BLOCK = /\[Arquivo anexado\]\s*\n([\s\S]*?)\n\[\/Arquivo anexado\]/;

/** Shared limits for images + files sent with one message. */
export function validateAttachments(body) {
  const images = body.images || [];
  const files = body.files || [];
  if (!Array.isArray(images) || !Array.isArray(files) || images.length + files.length > limits.maxAttachments) throw httpError('Envie no máximo 8 anexos por mensagem.', 400);
  const bytes = [...images, ...files].reduce((total, file) => total + Math.ceil(String(file?.data || '').length * 0.75), 0);
  if (bytes > limits.maxAttachmentBytes + 16) throw httpError('O limite total é 24 MB por mensagem.', 413);
}

/** Store base64 images and return `localImage` input parts for the app-server. */
export async function saveImages(root, threadId, files) {
  if (!Array.isArray(files) || files.length > limits.maxImages) throw new Error(`Envie no máximo ${limits.maxImages} imagens por mensagem.`);
  const items = [];
  if (!files.length) return items;
  if (!THREAD_ID.test(threadId)) throw new Error('ID de conversa inválido.');
  const targetDir = join(root, threadId);
  await mkdir(targetDir, { recursive: true, mode: 0o700 });
  for (const file of files) {
    if (!file || typeof file.data !== 'string') throw new Error('Uma imagem enviada está inválida.');
    const extension = IMAGE_EXTENSIONS[String(file.mime || '').toLowerCase()];
    if (!extension) throw new Error('Aceito imagens PNG, JPG, WEBP ou GIF.');
    const buffer = Buffer.from(file.data, 'base64');
    if (!buffer.length || buffer.length > limits.maxImage) throw new Error('Cada imagem precisa ter até 8 MB.');
    const destination = join(targetDir, `${Date.now()}-${randomUUID()}${extension}`);
    await writeFile(destination, buffer, { mode: 0o600, flag: 'wx' });
    items.push({ type: 'localImage', path: destination });
  }
  return items;
}

/** Remove files stored for a turn that never started (e.g. rate limited). */
export async function cleanupTurnUploads(root, threadId, imageParts, fileParts) {
  const threadRoot = resolve(join(root, threadId)) + sep;
  const paths = (imageParts || []).map((item) => item.path).filter(Boolean);
  for (const part of fileParts || []) {
    const match = ATTACHMENT_BLOCK.exec(String(part?.text || ''));
    if (!match) continue;
    try {
      const metadata = JSON.parse(match[1]);
      if (typeof metadata.path === 'string') paths.push(metadata.path);
    } catch { /* Ignore malformed attachment metadata. */ }
  }
  await Promise.all(paths.map(async (path) => {
    const target = resolve(path);
    if (!target.startsWith(threadRoot)) return;
    await unlink(target).catch(() => {});
  }));
}

export async function serveImage(root, threadId, name, res) {
  const imagePath = join(root, threadId, name);
  if (!resolve(imagePath).startsWith(resolve(root) + sep)) return fail(res, 404, 'Imagem não encontrada.');
  let info;
  try { info = await lstat(imagePath); } catch { return fail(res, 404, 'Imagem não encontrada.'); }
  if (!info.isFile() || info.isSymbolicLink()) return fail(res, 404, 'Imagem não encontrada.');
  const type = IMAGE_TYPES[extname(imagePath).toLowerCase()];
  if (!type) return fail(res, 404, 'Imagem não encontrada.');
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'private, max-age=86400', 'X-Content-Type-Options': 'nosniff' });
  return createReadStream(imagePath).pipe(res);
}

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
