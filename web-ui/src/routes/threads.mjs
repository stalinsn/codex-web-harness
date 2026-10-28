// Conversation list, history, actions, approvals, the follow-up queue and uploaded files.
import { randomUUID } from 'node:crypto';
import { PINNED_THREAD_SECTION_ID, config } from '../config.mjs';
import { ACCESS_MODES } from '../codex/access-mode.mjs';
import { isWriterLockError } from '../codex/app-server.mjs';
import { fail, json, readBody } from '../http/respond.mjs';
import { serveFile, serveImage } from '../uploads.mjs';

const ID = '([a-zA-Z0-9_-]{1,100})';
const thread = (suffix) => new RegExp(`^/api/threads/${ID}/${suffix}$`);
const DECISIONS = ['accept', 'acceptForSession', 'decline', 'cancel'];

/** Codex threads and harness-held threads in one list, most recent first. */
export function mergeThreads(codexThreads, localThreads) {
  // Keep the app-server's own order; slot harness threads in by update time.
  const merged = [];
  let local = 0;
  for (const thread of codexThreads) {
    while (local < localThreads.length && (Number(localThreads[local].updatedAt) || 0) > (Number(thread.updatedAt) || 0)) merged.push(localThreads[local++]);
    merged.push(thread);
  }
  return [...merged, ...localThreads.slice(local)];
}

export function registerThreadRoutes(router, { codex, events, localThreads }) {
  router.get('/api/threads', async ({ res, url }) => {
    const params = { limit: 50, sortKey: 'updated_at', sortDirection: 'desc' };
    const search = url.searchParams.get('search')?.trim();
    if (search) params.searchTerm = search;
    if (url.searchParams.get('archived') === 'true') params.archived = true;
    const result = await codex.rpc('thread/list', params);
    const local = localThreads.list({ archived: params.archived === true, search: search || '' });
    return json(res, 200, { threads: mergeThreads(result.data || [], local), nextCursor: result.nextCursor || null });
  });

  router.get(thread('context-usage'), ({ res, params: [threadId] }) => json(res, 200, { contextUsage: codex.threadContextUsage.get(threadId) || null }));

  router.get(thread('history'), async ({ res, url, params: [threadId] }) => {
    // Turn history is read-only, so a foreign writer (CLI TUI) is tolerated.
    await codex.ensureResumed(threadId);
    const params = { threadId, limit: 20, sortDirection: 'desc', itemsView: 'full' };
    const cursor = url.searchParams.get('cursor');
    if (cursor) params.cursor = cursor;
    const result = await codex.rpc('thread/turns/list', params);
    const read = await codex.rpc('thread/read', { threadId });
    return json(res, 200, { thread: read.thread, turns: [...(result.data || [])].reverse(), nextCursor: result.nextCursor || null, accessMode: codex.accessModeForThread(threadId) });
  });

  router.post(thread('access-mode'), async ({ req, res, params: [threadId] }) => {
    const body = await readBody(req);
    if (!ACCESS_MODES.has(body.mode)) return fail(res, 400, 'Escolha Pedir aprovação ou Automático.');
    try { return json(res, 200, await codex.setThreadAccessMode(threadId, body.mode)); }
    catch (error) {
      if (isWriterLockError(error)) return fail(res, 409, 'Esta conversa está aberta em outra sessão do Codex. Altere as permissões nessa sessão.');
      throw error;
    }
  });

  router.post(thread('archive'), async ({ res, params: [threadId] }) => {
    await codex.rpc('thread/archive', { threadId });
    codex.resumedThreads.delete(threadId);
    return json(res, 200, { ok: true });
  });

  router.post(thread('unarchive'), async ({ res, params: [threadId] }) => {
    await codex.rpc('thread/unarchive', { threadId });
    return json(res, 200, { ok: true });
  });

  router.post(thread('pin'), async ({ req, res, params: [threadId] }) => {
    const body = await readBody(req);
    if (typeof body.pinned !== 'boolean') return fail(res, 400, 'Informe se a conversa deve ficar fixada.');
    await codex.rpc('thread/section/move', { threadId, sectionId: body.pinned ? PINNED_THREAD_SECTION_ID : null });
    return json(res, 200, { ok: true, pinned: body.pinned });
  });

  router.post(thread('rename'), async ({ req, res, params: [threadId] }) => {
    const body = await readBody(req);
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name || name.length > 120) return fail(res, 400, 'O nome precisa ter entre 1 e 120 caracteres.');
    await codex.rpc('thread/name/set', { threadId, name });
    return json(res, 200, { ok: true, name });
  });

  router.delete(thread('delete'), async ({ res, params: [threadId] }) => {
    if (codex.activeTurns.size || codex.pendingRequests.size) return fail(res, 409, 'Aguarde todas as execuções e aprovações antes de excluir uma conversa.');
    try {
      await codex.ensureResumed(threadId, { allowForeignWriter: false });
    } catch (error) {
      if (isWriterLockError(error)) return fail(res, 409, 'Esta conversa está aberta por outra sessão do Codex. Feche-a nessa sessão e tente novamente.');
      throw error;
    }
    const queue = await codex.rpc('thread/queue/list', { threadId, limit: 100 });
    if ((queue.data || []).length) return fail(res, 409, 'Remova as mensagens pendentes da fila antes de excluir esta conversa.');
    // Restart the app-server so it releases this thread's writer before deletion.
    if (codex.resumedThreads.has(threadId) && !(await codex.restart())) {
      return fail(res, 503, 'O Codex não voltou a tempo para concluir a exclusão. Tente novamente.');
    }
    await codex.rpc('thread/delete', { threadId });
    codex.resumedThreads.delete(threadId);
    return json(res, 200, { ok: true });
  });

  router.post(thread('interrupt'), async ({ res, params: [threadId] }) => {
    const turnId = codex.activeTurns.get(threadId);
    if (!turnId) return json(res, 200, { ok: true, interrupted: false });
    await codex.rpc('turn/interrupt', { threadId, turnId });
    return json(res, 200, { ok: true, interrupted: true });
  });

  router.post(thread('approval'), async ({ req, res, params: [threadId] }) => {
    const body = await readBody(req);
    const approval = codex.pendingRequests.get(String(body.requestId));
    if (!approval || approval.params?.threadId !== threadId) return fail(res, 404, 'A solicitação de aprovação não está mais pendente.');
    const decision = String(body.decision || '');
    if (!DECISIONS.includes(decision)) return fail(res, 400, 'Decisão inválida.');
    codex.respondToServerRequest(approval.id, { decision });
    return json(res, 200, { ok: true });
  });

  // Follow-up queue kept by the app-server while a turn is running.
  router.get(thread('queue'), async ({ res, params: [threadId] }) => {
    // A full resume lets the app-server replay the persisted token-usage snapshot.
    await codex.ensureResumed(threadId, { excludeTurns: false });
    const result = await codex.rpc('thread/queue/list', { threadId, limit: 100 });
    return json(res, 200, { items: result.data || [] });
  });

  router.post(thread(`queue/${ID}`), async ({ res, params: [threadId, queuedSubmissionId] }) => {
    const queue = await codex.rpc('thread/queue/list', { threadId, limit: 100 });
    const queuedItem = (queue.data || []).find((item) => item.id === queuedSubmissionId);
    if (!queuedItem) return fail(res, 404, 'A mensagem não está mais na fila.');
    const input = Array.isArray(queuedItem.input) ? queuedItem.input.filter((part) => part && ['text', 'localImage'].includes(part.type)) : [];
    if (!input.length) return fail(res, 400, 'Não consegui ler o conteúdo desta mensagem da fila.');
    const expectedTurnId = await codex.activeTurnIdFor(threadId);
    if (!expectedTurnId) return fail(res, 409, 'Não há uma execução ativa para receber a orientação; a mensagem continua na fila.');

    await codex.rpc('thread/queue/delete', { threadId, queuedSubmissionId });
    try {
      await codex.rpc('turn/steer', { threadId, expectedTurnId, clientUserMessageId: randomUUID(), input });
      events.emit('thread-queue-changed', { threadId });
      return json(res, 200, { ok: true, steered: true });
    } catch {
      try {
        await codex.rpc('thread/queue/add', { threadId, clientUserMessageId: randomUUID(), input });
        events.emit('thread-queue-changed', { threadId });
        return fail(res, 409, 'Não consegui enviar como orientação; a mensagem voltou para o fim da fila.');
      } catch {
        events.emit('thread-queue-changed', { threadId });
        return json(res, 503, { error: 'Não consegui enviar ou recolocar a mensagem na fila. Ela continua disponível aqui para voltar ao rascunho.', recoverableItem: queuedItem });
      }
    }
  });

  router.delete(thread(`queue/${ID}`), async ({ res, params: [threadId, queuedSubmissionId] }) => {
    await codex.rpc('thread/queue/delete', { threadId, queuedSubmissionId });
    events.emit('thread-queue-changed', { threadId });
    return json(res, 200, { ok: true });
  });

  const FILE = '([a-zA-Z0-9._-]{1,200})';
  router.get(new RegExp(`^/api/files/${ID}/${FILE}$`), ({ req, res, url, params: [threadId, name] }) => serveFile(config.uploadDir, threadId, name, req, res, url));
  router.get(new RegExp(`^/api/images/${ID}/${FILE}$`), ({ res, params: [threadId, name] }) => serveImage(config.uploadDir, threadId, name, res));
}
