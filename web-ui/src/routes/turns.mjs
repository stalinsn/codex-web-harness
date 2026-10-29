// Starting turns (or queueing them while one is running) and steering the active turn.
import { randomUUID } from 'node:crypto';
import { ACCESS_MODES, accessParams } from '../codex/access-mode.mjs';
import { config } from '../config.mjs';
import { fail, json, readBody } from '../http/respond.mjs';
import { attachThreadToProject, validateCwd } from '../projects.mjs';
import { isLocalThread } from '../threads/local-store.mjs';
import { transcriptOf } from '../threads/provider-chat.mjs';
import { cleanupTurnUploads, saveFiles, saveImages, validateAttachments } from '../uploads.mjs';

const THREAD_ID = /^[a-zA-Z0-9_-]{1,100}$/;
const RATE_LIMIT_MESSAGE = /rate[ -]?limit|usage limit|quota|too many requests|reached.{0,30}limit|limit.{0,30}reached|limit.{0,30}exceed|exceed.{0,30}limit|hit.{0,20}limit|limite.{0,30}atingid|atingid.{0,30}limite/i;

export const isRateLimitErrorMessage = (message) => RATE_LIMIT_MESSAGE.test(String(message || ''));

async function buildInput(threadId, text, body) {
  const input = [];
  if (text) input.push({ type: 'text', text });
  const imageParts = await saveImages(config.uploadDir, threadId, body.images || []);
  const fileParts = await saveFiles(config.uploadDir, threadId, body.files || []);
  input.push(...imageParts, ...fileParts);
  return { input, cleanup: () => cleanupTurnUploads(config.uploadDir, threadId, imageParts, fileParts) };
}

/** A message for a harness-held conversation (non-Codex account or extra Codex account). */
async function sendLocalTurn(res, body, { providerChat, codex }) {
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  validateAttachments(body);
  if (!text && !body.images?.length && !body.files?.length) return fail(res, 400, 'Escreva uma mensagem ou anexe um arquivo.');
  let threadId = isLocalThread(body.threadId) ? body.threadId : '';
  if (!threadId) {
    providerChat.assertUsable(String(body.accountId || ''));
    // Continuing a Codex conversation with another account: carry its context over.
    let seed = '';
    let name = '';
    let cwdHint = body.cwd;
    let sourceCodexThreadId = '';
    let sourceCodexModel = '';
    let accessMode = ACCESS_MODES.has(body.accessMode) ? body.accessMode : '';
    if (typeof body.threadId === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(body.threadId)) {
      const read = await codex.rpc('thread/read', { threadId: body.threadId });
      const turns = await codex.rpc('thread/turns/list', { threadId: body.threadId, limit: 20, sortDirection: 'desc', itemsView: 'full' });
      seed = transcriptOf([...(turns.data || [])].reverse());
      name = `${read.thread?.name || read.thread?.preview || 'Conversa'} (continuação)`.slice(0, 120);
      cwdHint = read.thread?.cwd || cwdHint;
      sourceCodexThreadId = body.threadId;
      sourceCodexModel = typeof read.thread?.model === 'string' ? read.thread.model : '';
      accessMode ||= codex.accessModeForThread(body.threadId);
    }
    const cwd = await validateCwd(cwdHint || config.defaultCwd);
    const record = await providerChat.create({ accountId: String(body.accountId || ''), cwd, name, seed, sourceCodexThreadId, sourceCodexModel, accessMode });
    threadId = record.thread.id;
    try { await attachThreadToProject(threadId, cwd); } catch { console.error('Não foi possível associar a nova conversa ao projeto.'); }
  }
  const imageParts = await saveImages(config.uploadDir, threadId, body.images || []);
  const fileParts = await saveFiles(config.uploadDir, threadId, body.files || []);
  const content = [...(text ? [{ type: 'text', text }] : []), ...imageParts, ...fileParts];
  // CLIs read attachments from disk: point them at the stored files.
  const extraText = [
    ...fileParts.map((part) => part.text),
    ...(imageParts.length ? [`Imagens anexadas (leia os arquivos):\n${imageParts.map((part) => `- ${part.path}`).join('\n')}`] : []),
  ].join('\n\n');
  const result = await providerChat.send({ threadId, accountId: body.accountId, text, extraText, content, model: body.model, effort: body.effort, accessMode: body.accessMode });
  return json(res, 202, result.queued ? result : { threadId, turn: { id: result.turnId } });
}

export function registerTurnRoutes(router, { codex, events, providerChat }) {
  router.post(/^\/api\/threads\/([a-zA-Z0-9_-]{1,100})\/steer$/, async ({ req, res, params: [threadId] }) => {
    const body = await readBody(req);
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    validateAttachments(body);
    if (!text && !body.images?.length && !body.files?.length) return fail(res, 400, 'Escreva uma orientação ou anexe um arquivo.');
    const expectedTurnId = await codex.activeTurnIdFor(threadId);
    if (!expectedTurnId) return fail(res, 409, 'Não encontrei uma execução ativa para orientar. A mensagem continua no campo para você reenviar.');
    const { input, cleanup } = await buildInput(threadId, text, body);
    let result;
    try {
      result = await codex.rpc('turn/steer', { threadId, expectedTurnId, clientUserMessageId: randomUUID(), input });
    } catch (error) {
      if (isRateLimitErrorMessage(error.message)) await cleanup();
      throw error;
    }
    return json(res, 202, { threadId, turnId: result.turnId, steered: true });
  });

  router.post('/api/turn', async ({ req, res }) => {
    const body = await readBody(req);
    const accountId = typeof body.accountId === 'string' ? body.accountId : '';
    if (isLocalThread(body.threadId) || (accountId && accountId !== 'codex')) return sendLocalTurn(res, body, { providerChat, codex });
    const accessMode = body.accessMode == null ? '' : String(body.accessMode);
    if (accessMode && !ACCESS_MODES.has(accessMode)) return fail(res, 400, 'Modo de desenvolvimento inválido.');
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    const selectedModel = codex.findModel(body.model || codex.defaultModelId());
    if (!selectedModel) return fail(res, 400, 'Selecione um modelo disponível para a conta autenticada.');
    const effort = String(body.effort || selectedModel.defaultReasoningEffort || 'medium');
    const supportedEfforts = (selectedModel.supportedReasoningEfforts || []).map((item) => item.reasoningEffort);
    if (!supportedEfforts.includes(effort)) return fail(res, 400, 'O nível de raciocínio não é compatível com o modelo selecionado.');
    const cwd = await validateCwd(body.cwd || config.defaultCwd);
    let threadId = typeof body.threadId === 'string' ? body.threadId : '';
    let queueForActiveTurn = false;
    validateAttachments(body);
    if (!text && !body.images?.length && !body.files?.length) return fail(res, 400, 'Escreva uma mensagem ou anexe um arquivo.');

    if (threadId) {
      if (!THREAD_ID.test(threadId)) return fail(res, 400, 'ID de conversa inválido.');
      await codex.ensureResumed(threadId);
      if (accessMode && codex.accessModeForThread(threadId) !== accessMode) await codex.setThreadAccessMode(threadId, accessMode);
      queueForActiveTurn = await codex.threadHasActiveTurn(threadId);
    } else {
      const created = await codex.rpc('thread/start', { model: selectedModel.id, cwd, ...(accessMode ? accessParams(accessMode, { threadStart: true }) : {}) });
      threadId = created.thread.id;
      codex.resumedThreads.add(threadId);
      codex.rememberThreadAccessMode(threadId, created);
      try { await attachThreadToProject(threadId, cwd); }
      catch { console.error('Não foi possível associar a nova conversa ao projeto.'); }
      events.emit('thread-created', { thread: created.thread });
    }

    const { input, cleanup } = await buildInput(threadId, text, body);
    if (queueForActiveTurn) {
      const queued = await codex.rpc('thread/queue/add', { threadId, clientUserMessageId: randomUUID(), input });
      events.emit('thread-queue-changed', { threadId });
      return json(res, 202, { threadId, queued: true, queuedSubmission: queued.queuedSubmission || null });
    }
    let turn;
    try {
      turn = await codex.rpc('turn/start', { threadId, input, model: selectedModel.id, effort, cwd, clientUserMessageId: randomUUID(), ...(accessMode ? accessParams(accessMode) : {}) });
    } catch (error) {
      if (isRateLimitErrorMessage(error.message)) {
        await cleanup();
        return json(res, 429, { error: error.message, threadId, rateLimited: true });
      }
      throw error;
    }
    if (turn.turn?.id) codex.activeTurns.set(threadId, turn.turn.id);
    events.emit('turn-accepted', { threadId, turnId: turn.turn?.id, model: selectedModel.id, effort, cwd });
    return json(res, 202, { threadId, turn: turn.turn || null });
  });
}

