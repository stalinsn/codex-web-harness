// Browser-local queue (IndexedDB) for prompts held while the account is rate limited.
import { api } from './api.js';
import { attachmentPayload, renderAttachments, updateComposerControls } from './composer.js';
import { loadThreadHistory, setBusy } from './conversation.js';
import { $, randomKey, toast } from './dom.js';
import { formatCountdown } from './format.js';
import { refreshUsage, updateThreadHeader } from './inspector.js';
import { pathIsWithin } from './projects.js';
import { refreshQueue, renderQueue } from './queue.js';
import { getEffectiveRateLimitBlock, getRateLimitBlock, isRateLimitError, renderRateLimitNotice } from './rate-limit.js';
import { runtime, state } from './state.js';
import { refreshThreadList } from './thread-list.js';
import { touchComposer } from './voice.js';

function openDeferredQueueDb() {
  if (!('indexedDB' in window)) return Promise.reject(new Error('Este navegador não permite salvar a fila local. A mensagem ficou no rascunho.'));
  if (!runtime.deferredQueueDbPromise) {
    runtime.deferredQueueDbPromise = new Promise((resolvePromise, rejectPromise) => {
      const request = indexedDB.open('codex-web-harness-deferred-queue', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('items', { keyPath: 'id' });
      request.onsuccess = () => resolvePromise(request.result);
      request.onerror = () => rejectPromise(new Error('Não consegui abrir a fila local. A mensagem ficou no rascunho.'));
      request.onblocked = () => rejectPromise(new Error('A fila local está sendo atualizada em outra aba. A mensagem ficou no rascunho.'));
    });
  }
  return runtime.deferredQueueDbPromise;
}

function deferredQueueRecord(item) {
  return { ...item, files: (item.files || []).map(({ dataUrl, ...file }) => file) };
}

function hydrateDeferredQueueRecord(item) {
  return { ...item, files: (item.files || []).map((file) => ({ ...file, dataUrl: file.dataUrl || ('data:' + (file.mime || 'application/octet-stream') + ';base64,' + (file.data || '')) })) };
}

async function persistDeferredQueue(items) {
  const db = await openDeferredQueueDb();
  await new Promise((resolvePromise, rejectPromise) => {
    const transaction = db.transaction('items', 'readwrite');
    const store = transaction.objectStore('items');
    store.clear();
    items.forEach((item) => store.put(deferredQueueRecord(item)));
    transaction.oncomplete = () => resolvePromise();
    transaction.onerror = () => rejectPromise(new Error('Não consegui salvar a fila local. A mensagem ficou no rascunho.'));
    transaction.onabort = () => rejectPromise(new Error('Não consegui salvar a fila local. A mensagem ficou no rascunho.'));
  });
}

export async function loadDeferredQueue() {
  const db = await openDeferredQueueDb();
  const items = await new Promise((resolvePromise, rejectPromise) => {
    const request = db.transaction('items', 'readonly').objectStore('items').getAll();
    request.onsuccess = () => resolvePromise(request.result || []);
    request.onerror = () => rejectPromise(new Error('Não consegui ler a fila local.'));
  });
  state.deferredQueueItems = items.map(hydrateDeferredQueueRecord).map((item) => item.attemptingAt
    ? { ...item, attemptingAt: 0, needsReview: true, lastError: 'A página foi recarregada durante o envio. Confira a conversa antes de tentar novamente.' }
    : item).sort((left, right) => Number(left.createdAt) - Number(right.createdAt));
  if (items.some((item) => item.attemptingAt)) await persistDeferredQueue(state.deferredQueueItems);
  renderQueue();
  renderRateLimitNotice();
}

async function putDeferredQueueItem(item) {
  const next = [...state.deferredQueueItems, item];
  await persistDeferredQueue(next);
  state.deferredQueueItems = next;
  renderQueue();
  renderRateLimitNotice();
}

export async function updateDeferredQueueItems(items) {
  await persistDeferredQueue(items);
  state.deferredQueueItems = items;
  renderQueue();
  renderRateLimitNotice();
}

export async function queueDraftForRateLimit(text, files, threadId, block = getRateLimitBlock()) {
  const textarea = $('#messageInput');
  const wasSending = state.sending;
  state.sending = true;
  updateComposerControls();
  try {
    const item = {
      id: randomKey(),
      threadId: threadId || null,
      text,
      files: files.map((file) => ({ name: file.name, isImage: Boolean(file.isImage), size: Number(file.size) || 0, mime: file.mime || 'application/octet-stream', data: file.data || String(file.dataUrl || '').split(',')[1] || '', dataUrl: file.dataUrl || '' })),
      model: state.modelId,
      effort: state.effort,
      cwd: state.cwd,
      draftQueueGroupId: threadId ? '' : state.draftQueueGroupId,
      createdAt: Date.now(),
      localOnly: true,
      localDeferred: true,
      attemptingAt: 0,
      retryAt: 0,
      needsReview: false,
      lastError: '',
    };
    await putDeferredQueueItem(item);
    if (textarea.value.trim() === text) { textarea.value = ''; textarea.style.height = 'auto'; }
    if (files.length === state.files.length && files.every((file, index) => state.files[index] === file)) { state.files = []; renderAttachments(); }
    const wait = block && block.resetAt ? ' Libera ' + formatCountdown(block.resetAt) + '.' : '';
    toast('Limite de uso atingido. Mensagem guardada na fila.' + wait);
    textarea.dispatchEvent(new Event('input'));
    return true;
  } catch (error) {
    toast(error.message || 'Não consegui guardar a mensagem. Ela continua no rascunho.', 'error');
    return false;
  } finally {
    state.sending = wasSending;
    updateComposerControls();
    if (!touchComposer()) textarea.focus();
  }
}

export async function sendDeferredQueueItem(item, { manual = false } = {}) {
  const block = getEffectiveRateLimitBlock();
  if (block) {
    renderRateLimitNotice();
    if (manual) throw new Error('O limite ainda está ativo. A mensagem continua guardada na fila.');
    return false;
  }
  if (item.attemptingAt || (!manual && (item.needsReview || Number(item.retryAt) > Date.now()))) return false;
  const attempted = { ...item, attemptingAt: Date.now(), lastError: '' };
  await updateDeferredQueueItems(state.deferredQueueItems.map((queued) => queued.id === item.id ? attempted : queued));
  const shouldOpenNewThread = !item.threadId && !state.selectedThreadId && item.draftQueueGroupId === state.draftQueueGroupId;
  try {
    const result = await api('/api/turn', {
      method: 'POST',
      body: JSON.stringify({
        threadId: item.threadId || undefined,
        text: item.text,
        model: item.model,
        effort: item.effort,
        cwd: item.cwd,
        ...attachmentPayload(item.files || []),
      }),
    });
    const resolvedThreadId = result.threadId || item.threadId || null;
    const remaining = state.deferredQueueItems
      .filter((queued) => queued.id !== item.id)
      .map((queued) => !item.threadId && resolvedThreadId && queued.draftQueueGroupId === item.draftQueueGroupId && !queued.threadId ? { ...queued, threadId: resolvedThreadId } : queued);
    await updateDeferredQueueItems(remaining);
    state.rateLimitFailure = null;
    if (resolvedThreadId) {
      state.activeThreadIds.add(resolvedThreadId);
      if (shouldOpenNewThread) {
        state.selectedThreadId = resolvedThreadId;
        state.activeThreadProjectId = state.projects.find((project) => pathIsWithin(item.cwd, project.cwd))?.id || '';
        state.activeTurnId = result.turn?.id || null;
        state.turnStartedAtMs = Date.now();
        updateThreadHeader({ id: resolvedThreadId, name: 'Nova conversa', model: item.model });
        setBusy(true);
        loadThreadHistory(resolvedThreadId).catch(() => {});
      } else if (state.selectedThreadId === resolvedThreadId) {
        state.activeTurnId = result.turn?.id || state.activeTurnId;
        state.turnStartedAtMs ||= Date.now();
        setBusy(true);
      }
      if (result.queued && state.selectedThreadId === resolvedThreadId) refreshQueue(resolvedThreadId).catch(() => {});
    }
    refreshThreadList().catch(() => {});
    renderRateLimitNotice();
    if (manual) toast('Mensagem enviada.');
    return true;
  } catch (error) {
    if (isRateLimitError(error.message)) {
      state.rateLimitFailure = { message: error.message, resetAt: getRateLimitBlock()?.resetAt || 0 };
      const retryItem = { ...attempted, attemptingAt: 0, retryAt: Date.now() + 60_000, needsReview: false, lastError: '' };
      await updateDeferredQueueItems(state.deferredQueueItems.map((queued) => queued.id === item.id ? retryItem : queued)).catch(() => {});
      await refreshUsage(true).catch(() => {});
      if (manual) throw new Error('O limite ainda está ativo. A mensagem continua guardada na fila.');
      return false;
    }
    const failedItem = { ...attempted, attemptingAt: 0, needsReview: true, lastError: error.message || 'Não foi possível enviar.' };
    await updateDeferredQueueItems(state.deferredQueueItems.map((queued) => queued.id === item.id ? failedItem : queued)).catch(() => {});
    if (manual) throw error;
    return false;
  }
}

export function maybeDrainDeferredQueue() {
  if (runtime.deferredDrainPromise) return runtime.deferredDrainPromise;
  if (!state.deferredQueueItems.length || getEffectiveRateLimitBlock()) return Promise.resolve(false);
  const item = state.deferredQueueItems.find((queued) => !queued.attemptingAt && !queued.needsReview && Number(queued.retryAt) <= Date.now());
  if (!item) return Promise.resolve(false);
  runtime.deferredDrainPromise = sendDeferredQueueItem(item).catch(() => false).finally(() => {
    runtime.deferredDrainPromise = null;
    if (state.deferredQueueItems.length && !getEffectiveRateLimitBlock()) {
      const next = state.deferredQueueItems.find((queued) => !queued.attemptingAt && !queued.needsReview && Number(queued.retryAt) <= Date.now());
      if (next) setTimeout(() => maybeDrainDeferredQueue().catch(() => {}), 500);
    }
  });
  return runtime.deferredDrainPromise;
}
