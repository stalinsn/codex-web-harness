// Routes for harness-held conversations (ids "ext-…"). Registered before the Codex
// thread routes, so the same URLs serve both kinds and the client needs no changes.
import { json, fail, readBody } from '../http/respond.mjs';
import { ACCESS_MODES } from '../codex/access-mode.mjs';
import { isWriterLockError } from '../codex/app-server.mjs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { PINNED_THREAD_SECTION_ID, config } from '../config.mjs';
import { findProjectForCwd, getProjects, saveProjects } from '../projects.mjs';

const LOCAL = '(ext-[a-f0-9-]{36})';
const route = (suffix) => new RegExp(`^/api/threads/${LOCAL}/${suffix}$`);
const PAGE = 20;

export function registerLocalThreadRoutes(router, { localThreads: store, providerChat: chat, codex }) {
  const load = async (id) => {
    const record = await store.get(id);
    if (!record) throw Object.assign(new Error('Conversa não encontrada.'), { statusCode: 404 });
    return record;
  };
  const touch = (id, mutate) => store.update(id, mutate).then((record) => store.flush(id).then(() => record));

  router.get(route('history'), async ({ res, url, params: [id] }) => {
    const record = await load(id);
    const end = Math.min(record.turns.length, Number(url.searchParams.get('cursor')) || record.turns.length);
    const start = Math.max(0, end - PAGE);
    return json(res, 200, { thread: record.thread, turns: record.turns.slice(start, end), nextCursor: start > 0 ? String(start) : null, accessMode: record.thread.accessMode || '' });
  });
  router.get(route('context-usage'), ({ res }) => json(res, 200, { contextUsage: null }));

  router.post(route('access-mode'), async ({ req, res, params: [id] }) => {
    const body = await readBody(req);
    if (!ACCESS_MODES.has(body.mode)) return fail(res, 400, 'Escolha Pedir aprovação ou Automático.');
    try { return json(res, 200, await chat.setAccessMode(id, body.mode)); }
    catch (error) {
      if (isWriterLockError(error)) return fail(res, 409, 'Esta sessão do Codex está aberta em outro processo. Feche-a antes de alterar as permissões.');
      throw error;
    }
  });

  router.post(route('archive'), async ({ res, params: [id] }) => { await touch(id, (record) => { record.thread.archived = true; }); return json(res, 200, { ok: true }); });
  router.post(route('unarchive'), async ({ res, params: [id] }) => { await touch(id, (record) => { record.thread.archived = false; }); return json(res, 200, { ok: true }); });
  router.post(route('pin'), async ({ req, res, params: [id] }) => {
    const body = await readBody(req);
    if (typeof body.pinned !== 'boolean') return fail(res, 400, 'Informe se a conversa deve ficar fixada.');
    await touch(id, (record) => { record.thread.section = body.pinned ? { id: PINNED_THREAD_SECTION_ID } : null; });
    return json(res, 200, { ok: true, pinned: body.pinned });
  });
  router.post(route('rename'), async ({ req, res, params: [id] }) => {
    const body = await readBody(req);
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name || name.length > 120) return fail(res, 400, 'O nome precisa ter entre 1 e 120 caracteres.');
    await touch(id, (record) => { record.thread.name = name; });
    return json(res, 200, { ok: true, name });
  });
  router.delete(route('delete'), async ({ res, params: [id] }) => {
    if (chat.isRunning(id)) return fail(res, 409, 'Aguarde a resposta terminar antes de excluir a conversa.');
    const record = await load(id);
    if (record.thread.taskId && record.thread.status?.type === 'active') return fail(res, 409, 'A execução contínua desta conversa ainda está rodando. Pare a execução antes de excluir.');
    const internalCodexThreadIds = [...new Set([
      ...(Array.isArray(record.thread.internalCodexThreadIds) ? record.thread.internalCodexThreadIds : []),
      ...(record.thread.internalCodexThreadId ? [record.thread.internalCodexThreadId] : []),
    ])];
    if (internalCodexThreadIds.length) {
      try {
        for (const internalThreadId of internalCodexThreadIds) {
          await codex.rpc('thread/archive', { threadId: internalThreadId });
          codex.resumedThreads.delete(internalThreadId);
        }
      } catch {
        return fail(res, 503, 'Não consegui arquivar a sessão Codex vinculada. A conversa continua intacta; tente excluir novamente.');
      }
    }
    await store.remove(id);
    const projects = await getProjects();
    if (projects.some((project) => project.threadIds.includes(id))) {
      for (const project of projects) project.threadIds = project.threadIds.filter((threadId) => threadId !== id);
      await saveProjects(projects);
    }
    await rm(join(config.uploadDir, id), { recursive: true, force: true });
    return json(res, 200, { ok: true });
  });
  router.post(route('interrupt'), async ({ res, params: [id] }) => json(res, 200, { ok: true, interrupted: await chat.interrupt(id) }));
  router.post(route('approval'), ({ res }) => fail(res, 404, 'A solicitação de aprovação não está mais pendente.'));
  router.post(route('steer'), ({ res }) => fail(res, 409, 'Esta conta não aceita orientação durante a resposta. Envie a mensagem para a fila.'));

  router.get(route('queue'), async ({ res, params: [id] }) => json(res, 200, { items: await chat.queue(id) }));
  router.post(route('queue/([a-zA-Z0-9_-]{1,100})'), ({ res }) => fail(res, 409, 'Esta conta não aceita orientação durante a resposta; a mensagem continua na fila.'));
  router.delete(route('queue/([a-zA-Z0-9_-]{1,100})'), async ({ res, params: [id, queuedId] }) => {
    await chat.dequeue(id, queuedId);
    return json(res, 200, { ok: true });
  });

  router.post(route('project-association'), async ({ res, params: [id] }) => {
    const record = await load(id);
    const projects = await getProjects();
    const project = findProjectForCwd(projects, record.thread.cwd) || projects.find((item) => item.threadIds.includes(id)) || null;
    if (project && !project.threadIds.includes(id)) {
      for (const item of projects) item.threadIds = item.threadIds.filter((threadId) => threadId !== id);
      project.threadIds.push(id);
      await saveProjects(projects);
    }
    return json(res, 200, { projectId: project?.id || '', projects });
  });
}
