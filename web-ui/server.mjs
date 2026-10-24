import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, readFile, realpath, rename, rmdir, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import readline from 'node:readline';
import { AuthError, AuthManager } from './auth.mjs';

const HOME_DIR = process.env.HOME || homedir();
const HOST = process.env.CODEX_UI_HOST || '127.0.0.1';
const PORT = Number(process.env.CODEX_UI_PORT || 7682);
const PREFIX = '/codex-agent';
const CODEX = process.env.CODEX_BIN || join(HOME_DIR, '.local', 'bin', 'codex');
const CODEX_HOME = process.env.CODEX_HOME || join(HOME_DIR, '.codex');
const DEFAULT_CWD = process.env.CODEX_DEFAULT_CWD || HOME_DIR;
const PUBLIC_DIR = resolve(process.env.CODEX_UI_PUBLIC || join(import.meta.dirname, 'public'));
const UPLOAD_DIR = join(CODEX_HOME, 'web-uploads');
const PROJECTS_FILE = join(CODEX_HOME, 'web-projects.json');
const MAX_BODY = 48 * 1024 * 1024;
const MAX_IMAGE = 8 * 1024 * 1024;
const MAX_IMAGES = 4;
const AUTH_ORIGIN = process.env.CODEX_UI_ORIGIN ? new URL(process.env.CODEX_UI_ORIGIN).origin : null;
const PINNED_THREAD_SECTION_ID = '01984de2-8f74-7c91-a3b2-5c5e937cf318';
const sseClients = new Set();
const eventHistory = [];
const pendingRequests = new Map();
const activeTurns = new Map();
const resumedThreads = new Set();
const rpcPending = new Map();
let appServer;
let appReady = false;
let restartTimer;
let requestId = 1;
let eventSequence = 1;
let shutdown = false;
let modelsCache = [];
let accountCache = null;
let rateLimitsCache = null;
let usageCache = null;
let lastRefresh = 0;
const auth = new AuthManager(join(CODEX_HOME, 'web-auth.json'));

const MIME_TYPES = {
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

function emit(type, data = {}) {
  const event = { id: eventSequence++, type, data, at: new Date().toISOString() };
  eventHistory.push(event);
  if (eventHistory.length > 500) eventHistory.shift();
  const frame = `id: ${event.id}\nevent: message\ndata: ${JSON.stringify(event)}\n\n`;
  for (const res of sseClients) res.write(frame);
}

function isAllowedOrigin(req, required = false) {
  const origin = String(req.headers.origin || '');
  if (!origin) return !required;
  if (AUTH_ORIGIN) return origin === AUTH_ORIGIN;
  let parsed;
  try { parsed = new URL(origin); } catch { return false; }
  const forwardedHost = String(req.headers['x-forwarded-host'] || '').split(',')[0].trim();
  const requestHost = forwardedHost || String(req.headers.host || '').split(',')[0].trim();
  if (!requestHost || parsed.host.toLowerCase() !== requestHost.toLowerCase()) return false;
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  return !forwardedProto || parsed.protocol === `${forwardedProto}:`;
}

function writeRpc(message) {
  if (!appServer || appServer.killed || !appServer.stdin.writable) {
    throw new Error('O servidor Codex ainda está iniciando. Tente novamente em alguns segundos.');
  }
  appServer.stdin.write(`${JSON.stringify(message)}\n`);
}

function rpc(method, params = {}, timeoutMs = 45000) {
  return new Promise((resolvePromise, rejectPromise) => {
    const id = requestId++;
    const timer = setTimeout(() => {
      rpcPending.delete(id);
      rejectPromise(new Error(`Tempo esgotado ao chamar ${method}.`));
    }, timeoutMs);
    rpcPending.set(id, { resolve: resolvePromise, reject: rejectPromise, timer, method });
    try {
      writeRpc({ method, id, params });
    } catch (error) {
      clearTimeout(timer);
      rpcPending.delete(id);
      rejectPromise(error);
    }
  });
}

function respondToServerRequest(id, result) {
  try { writeRpc({ id, result }); } catch (error) { console.error('Falha ao responder uma solicitação do app-server:', error.message); }
  pendingRequests.delete(String(id));
  emit('request-resolved', { requestId: String(id) });
}

function handleServerMessage(message) {
  if (message && Object.hasOwn(message, 'id') && !message.method) {
    const waiting = rpcPending.get(message.id);
    if (waiting) {
      clearTimeout(waiting.timer);
      rpcPending.delete(message.id);
      if (message.error) waiting.reject(new Error(message.error.message || `${waiting.method} falhou.`));
      else waiting.resolve(message.result ?? {});
    }
    return;
  }

  if (message && Object.hasOwn(message, 'id') && message.method) {
    const request = { id: message.id, method: message.method, params: message.params || {} };
    pendingRequests.set(String(message.id), request);
    emit('server-request', request);
    return;
  }

  if (!message?.method) return;
  if (message.method === 'turn/started') {
    const { threadId, turn } = message.params || {};
    if (threadId && turn?.id) activeTurns.set(threadId, turn.id);
  }
  if (message.method === 'turn/completed') {
    const { threadId, turn } = message.params || {};
    if (threadId) activeTurns.delete(threadId);
    emit('turn-completed', { threadId, turn });
    return;
  }
  if (message.method === 'thread/queue/changed') {
    emit('thread-queue-changed', message.params || {});
  }
  if (message.method === 'thread/started' && message.params?.thread?.id) {
    resumedThreads.add(message.params.thread.id);
  }
  if (message.method === 'account/updated') accountCache = message.params;
  if (message.method === 'account/rateLimits/updated') rateLimitsCache = message.params;
  if (message.method === 'thread/tokenUsage/updated') emit('thread-usage', message.params);
  emit('codex-event', message);
}

function startAppServer() {
  if (shutdown || (appServer && !appServer.killed)) return;
  appReady = false;
  const env = {
    ...process.env,
    HOME: HOME_DIR,
    CODEX_HOME,
    PATH: `${join(HOME_DIR, '.local', 'bin')}:${process.env.PATH || '/usr/local/bin:/usr/bin:/bin'}`,
  };
  appServer = spawn(CODEX, ['app-server', '--listen', 'stdio://'], {
    cwd: HOME_DIR,
    env,
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  const child = appServer;
  const lines = readline.createInterface({ input: child.stdout });
  lines.on('line', (line) => {
    try { handleServerMessage(JSON.parse(line)); } catch { /* Ignore malformed or diagnostic output. */ }
  });
  child.on('error', (error) => {
    console.error('Não foi possível iniciar o Codex app-server:', error.message);
    emit('server-state', { online: false, message: 'Não foi possível iniciar o Codex.' });
  });
  child.on('close', () => {
    if (appServer === child) {
      appServer = null;
      appReady = false;
      resumedThreads.clear();
    }
    for (const [id, waiting] of rpcPending) {
      clearTimeout(waiting.timer);
      waiting.reject(new Error('O processo Codex foi reiniciado. A conversa salva continua no histórico.'));
      rpcPending.delete(id);
    }
    emit('server-state', { online: false, message: 'Reconectando ao Codex…' });
    if (!shutdown) restartTimer = setTimeout(startAppServer, 1800);
  });

  rpc('initialize', {
    capabilities: { experimentalApi: true },
    clientInfo: { name: 'codex_web_harness', title: 'Codex Web Harness', version: '1.0.0' },
  }, 30000).then(async () => {
    if (appServer !== child || child.killed) return;
    writeRpc({ method: 'initialized', params: {} });
    appReady = true;
    emit('server-state', { online: true, message: 'Codex conectado.' });
    try { await refreshAccountData(true); } catch (error) { console.error('Não foi possível atualizar os dados da conta:', error.message); }
  }).catch((error) => {
    console.error('Falha na inicialização do Codex app-server:', error.message);
    if (child === appServer) child.kill('SIGTERM');
  });
}

async function refreshAccountData(force = false) {
  if (!appReady) throw new Error('O Codex ainda está iniciando.');
  if (!force && Date.now() - lastRefresh < 60000) return;
  const tasks = await Promise.allSettled([
    rpc('model/list', { limit: 100, includeHidden: false }),
    rpc('account/read', { refreshToken: false }),
    rpc('account/rateLimits/read'),
    rpc('account/usage/read'),
  ]);
  const [models, account, rateLimits, usage] = tasks;
  if (models.status === 'fulfilled') modelsCache = models.value.data || [];
  if (account.status === 'fulfilled') accountCache = account.value.account || null;
  if (rateLimits.status === 'fulfilled') rateLimitsCache = rateLimits.value.rateLimitsByLimitId || rateLimits.value.rateLimits || null;
  if (usage.status === 'fulfilled') usageCache = usage.value || null;
  lastRefresh = Date.now();
  emit('account-data', { account: accountCache, rateLimits: rateLimitsCache, usage: usageCache });
}

function json(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify(data));
}

function fail(res, status, message) { json(res, status, { error: message }); }

function readBody(req, limit = MAX_BODY) {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        rejectPromise(Object.assign(new Error(limit <= 16 * 1024 ? 'A solicitação de autenticação é muito grande.' : 'A solicitação ultrapassa o limite de 48 MB.'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try { resolvePromise(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch { rejectPromise(Object.assign(new Error('JSON inválido.'), { statusCode: 400 })); }
    });
    req.on('error', rejectPromise);
  });
}

function getClientIp(req) {
  const forwarded = String(req.headers['cf-connecting-ip'] || '').trim();
  if (forwarded.length <= 64 && isIP(forwarded)) return forwarded;
  return req.socket.remoteAddress || 'unknown';
}

async function handleAuthApi(req, res, pathName) {
  if (req.method === 'GET' && pathName === '/api/auth/status') {
    return json(res, 200, auth.status(req.headers.cookie));
  }
  if (req.method === 'POST' && !isAllowedOrigin(req, true)) return fail(res, 403, 'Origem não autorizada.');
  if (req.method !== 'POST') return fail(res, 405, 'Método não permitido.');

  const body = await readBody(req, 16 * 1024);
  if (pathName === '/api/auth/login/start') {
    return json(res, 200, await auth.startLogin(body.password, getClientIp(req)));
  }
  if (pathName === '/api/auth/setup/start') {
    return json(res, 200, await auth.startSetup(getClientIp(req)));
  }
  if (pathName === '/api/auth/reset/start') {
    return json(res, 200, await auth.startReset(getClientIp(req)));
  }
  if (pathName === '/api/auth/resend') {
    return json(res, 200, await auth.resendCode(body.challengeId, getClientIp(req)));
  }
  if (pathName === '/api/auth/login/verify' || pathName === '/api/auth/setup/complete' || pathName === '/api/auth/reset/complete') {
    let session;
    if (pathName === '/api/auth/login/verify') session = await auth.verifyLogin(body.challengeId, body.code);
    else if (pathName === '/api/auth/setup/complete') session = await auth.completeSetup(body.challengeId, body.code, body.password, body.confirmPassword);
    else session = await auth.completeReset(body.challengeId, body.code, body.password, body.confirmPassword);
    res.setHeader('Set-Cookie', auth.sessionCookie(session.token));
    return json(res, 200, { ok: true, expiresIn: session.maxAge });
  }
  if (pathName === '/api/auth/logout') {
    await auth.logout(req.headers.cookie);
    res.setHeader('Set-Cookie', auth.clearCookie());
    return json(res, 200, { ok: true });
  }
  return fail(res, 404, 'Rota de autenticação não encontrada.');
}

async function validateCwd(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.includes('\0')) throw Object.assign(new Error(`Informe uma pasta absoluta do servidor, por exemplo ${DEFAULT_CWD}.`), { statusCode: 400 });
  let canonical;
  let info;
  try { canonical = await realpath(value); info = await stat(canonical); }
  catch { throw Object.assign(new Error('A pasta não existe ou não pode ser acessada pelo usuário do Codex.'), { statusCode: 400 }); }
  if (!info.isDirectory()) throw Object.assign(new Error('O caminho informado não é uma pasta.'), { statusCode: 400 });
  return canonical;
}

async function createProjectDirectory(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.includes('\0')) {
    throw Object.assign(new Error('Informe a pasta nova dentro da pasta de projetos da VPS.'), { statusCode: 400 });
  }
  const home = await realpath(HOME_DIR);
  const projectsRoot = join(home, 'projects');
  await mkdir(projectsRoot, { recursive: true, mode: 0o750 });
  const actualRoot = await realpath(projectsRoot);
  if (actualRoot !== projectsRoot) {
    throw Object.assign(new Error('A pasta ~/projects precisa ser um diretório local, não um link para outro caminho.'), { statusCode: 400 });
  }
  const target = resolve(value);
  const slug = basename(target);
  if (dirname(target) !== projectsRoot || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(slug)) {
    throw Object.assign(new Error(`Projetos novos precisam ser pastas diretas de ${projectsRoot}, com nome simples em letras minúsculas, números e hífens.`), { statusCode: 400 });
  }
  try {
    await mkdir(target, { mode: 0o750 });
  } catch (error) {
    if (error.code === 'EEXIST') throw Object.assign(new Error('Essa pasta já existe. Selecione “Usar uma pasta existente” para associá-la.'), { statusCode: 409 });
    throw error;
  }
  try {
    const canonical = await realpath(target);
    if (dirname(canonical) !== projectsRoot) throw new Error('O caminho criado saiu da pasta de projetos permitida.');
    return canonical;
  } catch (error) {
    await rmdir(target).catch(() => {});
    throw error;
  }
}

async function getProjects() {
  try {
    const config = JSON.parse(await readFile(PROJECTS_FILE, 'utf8'));
    if (!Array.isArray(config.projects)) return [];
    return config.projects
      .filter((project) => project && typeof project.id === 'string' && typeof project.name === 'string' && typeof project.cwd === 'string')
      .map((project) => ({
        id: project.id,
        name: project.name,
        cwd: project.cwd,
        threadIds: Array.isArray(project.threadIds) ? project.threadIds.filter((id) => typeof id === 'string') : [],
      }));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function saveProjects(projects) {
  const temporary = join(CODEX_HOME, 'web-projects-' + randomUUID() + '.tmp');
  await writeFile(temporary, JSON.stringify({ projects }, null, 2) + '\n', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  await rename(temporary, PROJECTS_FILE);
}

function normalizeModel(value) {
  const model = modelsCache.find((candidate) => candidate.id === value || candidate.model === value);
  if (!model) throw new Error('Selecione um modelo disponível para a conta autenticada.');
  return model;
}

async function saveImages(threadId, files) {
  if (!Array.isArray(files) || files.length > MAX_IMAGES) throw new Error(`Envie no máximo ${MAX_IMAGES} imagens por mensagem.`);
  const items = [];
  if (files.length) {
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(threadId)) throw new Error('ID de conversa inválido.');
    const targetDir = join(UPLOAD_DIR, threadId);
    await mkdir(targetDir, { recursive: true, mode: 0o700 });
    for (const file of files) {
      if (!file || typeof file.data !== 'string') throw new Error('Uma imagem enviada está inválida.');
      const mime = String(file.mime || '').toLowerCase();
      const extension = ({ 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif' })[mime];
      if (!extension) throw new Error('Aceito imagens PNG, JPG, WEBP ou GIF.');
      const buffer = Buffer.from(file.data, 'base64');
      if (!buffer.length || buffer.length > MAX_IMAGE) throw new Error('Cada imagem precisa ter até 8 MB.');
      const name = `${Date.now()}-${randomUUID()}${extension}`;
      const destination = join(targetDir, name);
      await writeFile(destination, buffer, { mode: 0o600, flag: 'wx' });
      items.push({ type: 'localImage', path: destination });
    }
  }
  return items;
}

async function threadHasActiveTurn(threadId) {
  if (activeTurns.has(threadId)) return true;
  const result = await rpc('thread/read', { threadId });
  return result.thread?.status?.type === 'active';
}

async function activeTurnIdFor(threadId) {
  const cached = activeTurns.get(threadId);
  if (cached) return cached;
  const result = await rpc('thread/turns/list', { threadId, limit: 20, sortDirection: 'desc', itemsView: 'full' });
  const active = (result.data || []).find((turn) => {
    const status = typeof turn.status === 'string' ? turn.status : turn.status?.type;
    return status === 'inProgress' || status === 'active';
  });
  if (active?.id) activeTurns.set(threadId, active.id);
  return active?.id || null;
}

function getPublicPath(pathname) {
  if (!pathname.startsWith(PREFIX)) return null;
  const local = pathname.slice(PREFIX.length) || '/';
  return local.startsWith('/') ? local : `/${local}`;
}

async function handleApi(req, res, pathName, url) {
  if (!appReady) return fail(res, 503, 'O Codex está iniciando. Aguarde alguns segundos e tente novamente.');

  if (req.method === 'GET' && pathName === '/api/health') {
    return json(res, 200, { online: true, codex: appReady, service: 'codex-web-harness' });
  }

  if (req.method === 'GET' && pathName === '/api/bootstrap') {
    await refreshAccountData(url.searchParams.get('refresh') === 'true');
    const threads = await rpc('thread/list', { limit: 50, sortKey: 'updated_at', sortDirection: 'desc' });
    return json(res, 200, {
      models: modelsCache,
      threads: threads.data || [],
      projects: await getProjects(),
      account: accountCache,
      rateLimits: rateLimitsCache,
      usage: usageCache,
      pending: [...pendingRequests.values()],
      defaultCwd: DEFAULT_CWD,
      projectsRoot: join(await realpath(HOME_DIR), 'projects'),
      server: { online: true, version: '1.0.0' },
    });
  }

  if (req.method === 'GET' && pathName === '/api/projects') {
    return json(res, 200, { projects: await getProjects() });
  }

  if (req.method === 'POST' && pathName === '/api/projects') {
    const body = await readBody(req);
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name || name.length > 80) return fail(res, 400, 'Informe um nome de projeto com até 80 caracteres.');
    const projects = await getProjects();
    if (projects.length >= 100) return fail(res, 400, 'O limite de projetos foi atingido.');
    const createDirectory = body.createDirectory === true;
    const requestedPath = typeof body.cwd === 'string' ? resolve(body.cwd) : '';
    if (projects.some((project) => resolve(project.cwd) === requestedPath)) return fail(res, 409, 'Já existe um projeto para essa pasta.');
    let cwd;
    if (createDirectory) cwd = await createProjectDirectory(body.cwd);
    else cwd = await validateCwd(body.cwd);
    if (projects.some((project) => resolve(project.cwd) === resolve(cwd))) {
      if (createDirectory) await rmdir(cwd).catch(() => {});
      return fail(res, 409, 'Já existe um projeto para essa pasta.');
    }
    const project = { id: randomUUID(), name, cwd, threadIds: [] };
    const updated = [...projects, project];
    try { await saveProjects(updated); }
    catch (error) { if (createDirectory) await rmdir(cwd).catch(() => {}); throw error; }
    return json(res, 201, { project, projects: updated });
  }

  if (req.method === 'GET' && pathName === '/api/threads') {
    const params = { limit: 50, sortKey: 'updated_at', sortDirection: 'desc' };
    const search = url.searchParams.get('search')?.trim();
    if (search) params.searchTerm = search;
    if (url.searchParams.get('archived') === 'true') params.archived = true;
    const result = await rpc('thread/list', params);
    return json(res, 200, { threads: result.data || [], nextCursor: result.nextCursor || null });
  }

  const imageMatch = pathName.match(/^\/api\/images\/([a-zA-Z0-9_-]{1,100})\/([a-zA-Z0-9._-]{1,200})$/);
  if (req.method === 'GET' && imageMatch) {
    const imagePath = join(UPLOAD_DIR, imageMatch[1], imageMatch[2]);
    const safeRoot = resolve(UPLOAD_DIR) + sep;
    if (!resolve(imagePath).startsWith(safeRoot)) return fail(res, 404, 'Imagem não encontrada.');
    let imageStat;
    try { imageStat = await lstat(imagePath); } catch { return fail(res, 404, 'Imagem não encontrada.'); }
    if (!imageStat.isFile() || imageStat.isSymbolicLink()) return fail(res, 404, 'Imagem não encontrada.');
    const ext = extname(imagePath).toLowerCase();
    if (!['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(ext)) return fail(res, 404, 'Imagem não encontrada.');
    res.writeHead(200, { 'Content-Type': MIME_TYPES[ext], 'Cache-Control': 'private, max-age=86400', 'X-Content-Type-Options': 'nosniff' });
    return createReadStream(imagePath).pipe(res);
  }

  const queueRoute = pathName.match(/^\/api\/threads\/([a-zA-Z0-9_-]{1,100})\/queue(?:\/([a-zA-Z0-9_-]{1,100}))?$/);
  if (queueRoute && req.method === 'GET' && !queueRoute[2]) {
    const threadId = queueRoute[1];
    if (!resumedThreads.has(threadId)) {
      try {
        await rpc('thread/resume', { threadId, excludeTurns: true });
        resumedThreads.add(threadId);
      } catch (error) {
        if (!/already has an active writer/i.test(error.message)) throw error;
      }
    }
    const result = await rpc('thread/queue/list', { threadId, limit: 100 });
    return json(res, 200, { items: result.data || [] });
  }
  if (queueRoute && req.method === 'DELETE' && queueRoute[2]) {
    await rpc('thread/queue/delete', { threadId: queueRoute[1], queuedSubmissionId: queueRoute[2] });
    emit('thread-queue-changed', { threadId: queueRoute[1] });
    return json(res, 200, { ok: true });
  }

  const steerRoute = pathName.match(/^\/api\/threads\/([a-zA-Z0-9_-]{1,100})\/steer$/);
  if (steerRoute && req.method === 'POST') {
    const threadId = steerRoute[1];
    const body = await readBody(req);
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (!text && (!Array.isArray(body.images) || body.images.length === 0)) return fail(res, 400, 'Escreva uma orientação ou anexe uma imagem.');
    const expectedTurnId = await activeTurnIdFor(threadId);
    if (!expectedTurnId) return fail(res, 409, 'Não encontrei uma execução ativa para orientar. A mensagem continua no campo para você reenviar.');
    const input = [];
    if (text) input.push({ type: 'text', text });
    input.push(...await saveImages(threadId, body.images || []));
    const result = await rpc('turn/steer', {
      threadId,
      expectedTurnId,
      clientUserMessageId: randomUUID(),
      input,
    });
    return json(res, 202, { threadId, turnId: result.turnId, steered: true });
  }

  const threadMatch = pathName.match(/^\/api\/threads\/([a-zA-Z0-9_-]{1,100})(?:\/(history|archive|unarchive|pin|rename|delete|interrupt|approval))?$/);
  if (threadMatch && req.method === 'GET' && threadMatch[2] === 'history') {
    const threadId = threadMatch[1];
    if (!resumedThreads.has(threadId)) {
      try {
        await rpc('thread/resume', { threadId, excludeTurns: true });
        resumedThreads.add(threadId);
      } catch (error) {
        // A CLI TUI may currently own the writer lock for this thread. Turn
        // history is read-only, so still try listing it without taking over.
        if (!/already has an active writer/i.test(error.message)) throw error;
      }
    }
    const result = await rpc('thread/turns/list', { threadId, limit: 100, sortDirection: 'desc', itemsView: 'full' });
    const thread = await rpc('thread/read', { threadId });
    return json(res, 200, { thread: thread.thread, turns: [...(result.data || [])].reverse(), nextCursor: result.nextCursor || null });
  }

  if (threadMatch && req.method === 'POST' && threadMatch[2] === 'archive') {
    await rpc('thread/archive', { threadId: threadMatch[1] });
    resumedThreads.delete(threadMatch[1]);
    return json(res, 200, { ok: true });
  }

  if (threadMatch && req.method === 'POST' && threadMatch[2] === 'unarchive') {
    await rpc('thread/unarchive', { threadId: threadMatch[1] });
    return json(res, 200, { ok: true });
  }

  if (threadMatch && req.method === 'POST' && threadMatch[2] === 'pin') {
    const body = await readBody(req);
    if (typeof body.pinned !== 'boolean') return fail(res, 400, 'Informe se a conversa deve ficar fixada.');
    await rpc('thread/section/move', {
      threadId: threadMatch[1],
      sectionId: body.pinned ? PINNED_THREAD_SECTION_ID : null,
    });
    return json(res, 200, { ok: true, pinned: body.pinned });
  }

  if (threadMatch && req.method === 'POST' && threadMatch[2] === 'rename') {
    const body = await readBody(req);
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name || name.length > 120) return fail(res, 400, 'O nome precisa ter entre 1 e 120 caracteres.');
    await rpc('thread/name/set', { threadId: threadMatch[1], name });
    return json(res, 200, { ok: true, name });
  }

  if (threadMatch && req.method === 'DELETE' && threadMatch[2] === 'delete') {
    if (activeTurns.size || pendingRequests.size) return fail(res, 409, 'Aguarde todas as execuções e aprovações antes de excluir uma conversa.');
    const threadId = threadMatch[1];
    if (!resumedThreads.has(threadId)) {
      try {
        await rpc('thread/resume', { threadId, excludeTurns: true });
        resumedThreads.add(threadId);
      } catch (error) {
        if (/already has an active writer/i.test(error.message)) return fail(res, 409, 'Esta conversa está aberta por outra sessão do Codex. Feche-a nessa sessão e tente novamente.');
        throw error;
      }
    }
    const queue = await rpc('thread/queue/list', { threadId, limit: 100 });
    if ((queue.data || []).length) return fail(res, 409, 'Remova as mensagens pendentes da fila antes de excluir esta conversa.');
    if (resumedThreads.has(threadId)) {
      const child = appServer;
      if (child && !child.killed) child.kill('SIGTERM');
      const deadline = Date.now() + 30000;
      while ((appServer === child || !appReady) && Date.now() < deadline) await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
      if (!appReady || appServer === child) return fail(res, 503, 'O Codex não voltou a tempo para concluir a exclusão. Tente novamente.');
    }
    await rpc('thread/delete', { threadId });
    resumedThreads.delete(threadId);
    return json(res, 200, { ok: true });
  }

  if (threadMatch && req.method === 'POST' && threadMatch[2] === 'interrupt') {
    const activeTurnId = activeTurns.get(threadMatch[1]);
    if (!activeTurnId) return json(res, 200, { ok: true, interrupted: false });
    await rpc('turn/interrupt', { threadId: threadMatch[1], turnId: activeTurnId });
    return json(res, 200, { ok: true, interrupted: true });
  }

  if (threadMatch && req.method === 'POST' && threadMatch[2] === 'approval') {
    const body = await readBody(req);
    const approval = pendingRequests.get(String(body.requestId));
    if (!approval || approval.params?.threadId !== threadMatch[1]) return fail(res, 404, 'A solicitação de aprovação não está mais pendente.');
    const decision = String(body.decision || '');
    if (!['accept', 'acceptForSession', 'decline', 'cancel'].includes(decision)) return fail(res, 400, 'Decisão inválida.');
    respondToServerRequest(approval.id, { decision });
    return json(res, 200, { ok: true });
  }

  if (req.method === 'POST' && pathName === '/api/turn') {
    const body = await readBody(req);
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    const selectedModel = normalizeModel(body.model || modelsCache.find((model) => model.isDefault)?.id || modelsCache[0]?.id);
    const effort = String(body.effort || selectedModel.defaultReasoningEffort || 'medium');
    const supportedEfforts = (selectedModel.supportedReasoningEfforts || []).map((item) => item.reasoningEffort);
    if (!supportedEfforts.includes(effort)) return fail(res, 400, 'O nível de raciocínio não é compatível com o modelo selecionado.');
    const cwd = await validateCwd(body.cwd || DEFAULT_CWD);
    let threadId = typeof body.threadId === 'string' ? body.threadId : '';
    const currentThreadId = Boolean(threadId);
    let queueForActiveTurn = false;
    if (!text && (!Array.isArray(body.images) || body.images.length === 0)) return fail(res, 400, 'Escreva uma mensagem ou anexe uma imagem.');

    if (threadId) {
      if (!/^[a-zA-Z0-9_-]{1,100}$/.test(threadId)) return fail(res, 400, 'ID de conversa inválido.');
      if (!resumedThreads.has(threadId)) {
        try {
          await rpc('thread/resume', { threadId, excludeTurns: true });
          resumedThreads.add(threadId);
        } catch (error) {
          if (!/already has an active writer/i.test(error.message)) throw error;
        }
      }
      queueForActiveTurn = await threadHasActiveTurn(threadId);
    } else {
      const created = await rpc('thread/start', { model: selectedModel.id, cwd });
      threadId = created.thread.id;
      resumedThreads.add(threadId);
      try {
        const projects = await getProjects();
        const project = projects.find((item) => cwd === item.cwd || cwd.startsWith(item.cwd.endsWith('/') ? item.cwd : item.cwd + '/'));
        if (project && !project.threadIds.includes(threadId)) {
          project.threadIds.push(threadId);
          await saveProjects(projects);
        }
      } catch {
        console.error('Não foi possível associar a nova conversa ao projeto.');
      }
      emit('thread-created', { thread: created.thread });
    }

    const input = [];
    if (text) input.push({ type: 'text', text });
    input.push(...await saveImages(threadId, body.images || []));
    if (queueForActiveTurn) {
      const queued = await rpc('thread/queue/add', {
        threadId,
        clientUserMessageId: randomUUID(),
        input,
      });
      emit('thread-queue-changed', { threadId });
      return json(res, 202, { threadId, queued: true, queuedSubmission: queued.queuedSubmission || null });
    }
    const turn = await rpc('turn/start', {
      threadId,
      input,
      model: selectedModel.id,
      effort,
      cwd,
      clientUserMessageId: randomUUID(),
    });
    if (turn.turn?.id) activeTurns.set(threadId, turn.turn.id);
    emit('turn-accepted', { threadId, turnId: turn.turn?.id, model: selectedModel.id, effort, cwd });
    return json(res, 202, { threadId, turn: turn.turn || null });
  }

  return fail(res, 404, 'Rota não encontrada.');
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const pathName = getPublicPath(decodeURIComponent(url.pathname));
  if (pathName === null) return fail(res, 404, 'Rota não encontrada.');

  if (pathName.startsWith('/api/')) {
    if (pathName.startsWith('/api/auth/')) {
      try { return await handleAuthApi(req, res, pathName); }
      catch (error) {
        if (error instanceof AuthError) return fail(res, error.statusCode, error.message);
        console.error('Falha interna no fluxo de autenticação do Codex.');
        return fail(res, 500, 'Não foi possível concluir a autenticação. Tente novamente.');
      }
    }
    if (req.headers.origin && !isAllowedOrigin(req)) return fail(res, 403, 'Origem não autorizada.');
    if (req.method === 'POST' && !isAllowedOrigin(req, true)) return fail(res, 403, 'Origem não autorizada.');
    if (!auth.getSession(req.headers.cookie)) return fail(res, 401, 'Entre para usar o Codex.');
    if (!appReady) return fail(res, 503, 'O Codex está iniciando. Aguarde alguns segundos e tente novamente.');
    if (req.method === 'GET' && pathName === '/api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-store',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
        'X-Content-Type-Options': 'nosniff',
      });
      res.write(': connected\n\n');
      const lastId = Number(req.headers['last-event-id'] || 0);
      for (const event of eventHistory.filter((item) => item.id > lastId)) {
        res.write(`id: ${event.id}\nevent: message\ndata: ${JSON.stringify(event)}\n\n`);
      }
      sseClients.add(res);
      const heartbeat = setInterval(() => res.write(': ping\n\n'), 20000);
      req.on('close', () => { clearInterval(heartbeat); sseClients.delete(res); });
      return;
    }
    try { return await handleApi(req, res, pathName, url); }
    catch (error) {
      const status = error.statusCode || (error.message?.includes('not a directory') ? 400 : 500);
      return fail(res, status, error.message || 'Erro interno do harness.');
    }
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') return fail(res, 405, 'Método não permitido.');
  const relative = pathName === '/' ? '/index.html' : pathName;
  const filePath = resolve(PUBLIC_DIR, `.${relative}`);
  if (!filePath.startsWith(`${PUBLIC_DIR}${sep}`) && filePath !== join(PUBLIC_DIR, 'index.html')) return fail(res, 404, 'Arquivo não encontrado.');
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
});

await auth.initialize();

server.listen(PORT, HOST, () => {
  console.log(`Codex web UI ouvindo em ${HOST}:${PORT}.`);
  startAppServer();
});

setInterval(() => { if (appReady) refreshAccountData(true).catch(() => {}); }, 5 * 60 * 1000).unref();

function stop() {
  shutdown = true;
  clearTimeout(restartTimer);
  if (appServer && !appServer.killed) appServer.kill('SIGTERM');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 4000).unref();
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
