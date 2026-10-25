// Server-side follow-up queue for the active thread.
import { api } from './api.js';
import { blobDataUrl, renderAttachments } from './composer.js';
import { PREFIX } from './config.js';
import { sendDeferredQueueItem, updateDeferredQueueItems } from './deferred-queue.js';
import { $, installIcons, toast } from './dom.js';
import { formatCountdown } from './format.js';
import { openImagePreview } from './layout.js';
import { splitAttachmentText } from './messages.js';
import { getEffectiveRateLimitBlock } from './rate-limit.js';
import { queueActions, runtime, state } from './state.js';

function queueItemLabel(item) {
  if (item.localDeferred) {
    const text = String(item.text || '');
    const files = (item.files || []).map((file) => file.name);
    const images = (item.files || []).filter((file) => file.isImage).length;
    const fileNames = files.filter((name) => !(item.files || []).some((file) => file.name === name && file.isImage));
    const attachments = [...fileNames, ...(images ? [images + ' imagem' + (images === 1 ? '' : 'ns')] : [])].join(', ');
    return text + (text && attachments ? ' · ' : '') + (attachments || 'Mensagem sem texto');
  }
  const parsed = splitAttachmentText((item.input || []).filter((part) => part.type === 'text').map((part) => part.text).join('\n'), state.selectedThreadId);
  const text = parsed.text;
  const images = (item.input || []).filter((part) => part.type === 'image' || part.type === 'localImage').length;
  if (parsed.files.length) return `${text}${text ? ' · ' : ''}${parsed.files.map((file) => file.name).join(', ')}${images ? ` · ${images} imagem(ns)` : ''}`;
  if (text && images) return `${text} · ${images} imagem${images === 1 ? '' : 's'}`;
  if (text) return text;
  return images ? `${images} imagem${images === 1 ? '' : 's'} anexada${images === 1 ? '' : 's'}` : 'Mensagem sem texto';
}

export function renderQueue() {
  const panel = $('#queuePanel');
  const list = $('#queueList');
  if (!panel || !list) return;
  const threadId = state.selectedThreadId;
  const items = [...(threadId ? state.queueItems : []), ...state.deferredQueueItems.filter((item) => (item.threadId || null) === (threadId || null))];
  panel.classList.toggle('hidden', !items.length);
  $('#queueCount').textContent = items.length ? `${items.length} ${items.length === 1 ? 'mensagem' : 'mensagens'}` : '';
  list.replaceChildren();
  items.forEach((item, index) => {
    const row = document.createElement('div'); row.className = 'queued-item';
    const position = document.createElement('span'); position.className = 'queued-position'; position.textContent = String(index + 1);
    const text = document.createElement('span'); text.className = 'queued-text'; text.textContent = queueItemLabel(item);
    const imageParts = item.localDeferred
      ? (item.files || []).filter((file) => file.isImage).map((file) => ({ url: file.dataUrl, name: file.name }))
      : (item.input || []).filter((part) => part.type === 'image' || part.type === 'localImage');
    const imagePreviews = document.createElement('div'); imagePreviews.className = 'queued-image-previews';
    imageParts.forEach((part, imageIndex) => {
      let src = part.url || '';
      if (part.type === 'localImage' && part.path) {
        const name = String(part.path).split('/').pop();
        src = `${PREFIX}/api/images/${encodeURIComponent(threadId)}/${encodeURIComponent(name)}`;
      }
      if (!src) return;
      const imageButton = document.createElement('button'); imageButton.type = 'button'; imageButton.className = 'queued-image-open'; imageButton.title = 'Ampliar imagem da mensagem na fila'; imageButton.setAttribute('aria-label', `Ampliar imagem ${imageIndex + 1} da fila`);
      const image = document.createElement('img'); image.src = src; image.alt = `Imagem ${imageIndex + 1} da mensagem na fila`;
      imageButton.addEventListener('click', () => openImagePreview(image.currentSrc || image.src, image.alt));
      imageButton.append(image); imagePreviews.append(imageButton);
    });
    if (!imagePreviews.children.length) imagePreviews.remove();
    const deferredState = item.localDeferred ? document.createElement('small') : null;
    if (deferredState) {
      deferredState.className = 'queued-state';
      const block = getEffectiveRateLimitBlock();
      deferredState.textContent = item.attemptingAt ? 'Enviando…' : item.lastError ? 'Envio pendente: ' + item.lastError : block && block.resetAt ? 'Aguardando limite · libera ' + formatCountdown(block.resetAt) : 'Aguardando liberação do limite.';
    }
    const actions = document.createElement('div'); actions.className = 'queued-actions';
    const steer = document.createElement('button'); steer.type = 'button'; steer.className = 'queue-action queue-steer'; steer.textContent = 'Orientar agora'; steer.title = 'Tirar da fila e enviar como orientação para a execução atual';
    steer.hidden = Boolean(item.localOnly);
    steer.addEventListener('click', () => withQueueAction(item, threadId, 'steer', async () => {
      try {
        await api(`/api/threads/${encodeURIComponent(threadId)}/queue/${encodeURIComponent(item.id)}`, { method: 'POST' });
        toast('Mensagem enviada como orientação.');
        await refreshQueue(threadId);
      } catch (error) {
        if (error.data?.recoverableItem) {
          const recovered = { ...error.data.recoverableItem, id: `local-recovery-${Date.now()}`, localOnly: true, threadId };
          state.recoveredQueueItems = [...state.recoveredQueueItems.filter((queued) => queued.id !== item.id), recovered];
          if (state.selectedThreadId === threadId) state.queueItems = [recovered, ...state.queueItems.filter((queued) => queued.id !== item.id)];
        } else refreshQueue(threadId).catch(() => {});
        throw error;
      }
    }));
    const sendDeferred = document.createElement('button'); sendDeferred.type = 'button'; sendDeferred.className = 'queue-action queue-send'; sendDeferred.textContent = 'Enviar agora'; sendDeferred.title = 'Tentar enviar esta mensagem agora';
    sendDeferred.hidden = !item.localDeferred;
    sendDeferred.disabled = Boolean(getEffectiveRateLimitBlock() || item.attemptingAt);
    if (getEffectiveRateLimitBlock()) sendDeferred.title = 'Disponível quando o limite liberar';
    sendDeferred.addEventListener('click', () => withQueueAction(item, threadId, 'send', async () => sendDeferredQueueItem(item, { manual: true })));
    const restore = document.createElement('button'); restore.type = 'button'; restore.className = 'queue-action queue-restore'; restore.textContent = 'Voltar ao rascunho'; restore.title = 'Tirar da fila e devolver ao campo de mensagem';
    restore.addEventListener('click', () => withQueueAction(item, threadId, 'restore', async () => {
      await restoreQueueItem(item, threadId);
      toast('Mensagem devolvida ao rascunho.');
    }));
    const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'queue-action queue-cancel'; cancel.textContent = 'Cancelar'; cancel.title = 'Remover esta mensagem da fila'; cancel.setAttribute('aria-label', `Cancelar mensagem ${index + 1} da fila`);
    cancel.addEventListener('click', () => withQueueAction(item, threadId, 'cancel', async () => {
      const result = await cancelQueueItem(item, threadId);
      toast(result.alreadyGone ? 'Esta mensagem já saiu da fila. A lista foi atualizada.' : 'Mensagem removida da fila.');
    }));
    actions.append(steer, sendDeferred, restore, cancel);
    const pending = queueActions.get(`${threadId}:${item.id}`);
    for (const button of actions.children) button.disabled = Boolean(pending);
    if (!pending && !state.busy) { steer.disabled = true; steer.title = 'Disponível durante uma execução ativa'; }
    if (pending === 'cancel') cancel.textContent = 'Cancelando…';
    if (pending === 'restore') restore.textContent = 'Restaurando…';
    if (pending === 'steer') steer.textContent = 'Enviando…';
    if (pending === 'send') sendDeferred.textContent = 'Enviando…';
    row.append(position, text);
    if (imagePreviews.isConnected || imagePreviews.children.length) row.append(imagePreviews);
    if (deferredState) row.append(deferredState);
    row.append(actions); list.append(row);
  });
  installIcons();
}

async function withQueueAction(item, threadId, action, callback) {
  const key = `${threadId}:${item.id}`;
  if (queueActions.has(key)) return;
  queueActions.set(key, action);
  runtime.queueRefreshSequence += 1;
  renderQueue();
  try { await callback(); }
  catch (error) { toast(error.message || 'Não consegui atualizar a fila. Tente novamente.', 'error'); }
  finally { queueActions.delete(key); renderQueue(); }
}

async function cancelQueueItem(item, threadId) {
  if (item.localDeferred) {
    await updateDeferredQueueItems(state.deferredQueueItems.filter((queued) => queued.id !== item.id));
    return { alreadyGone: false };
  }
  let alreadyGone = false;
  if (!item.localOnly) {
    try { await api(`/api/threads/${encodeURIComponent(threadId)}/queue/${encodeURIComponent(item.id)}`, { method: 'DELETE' }); }
    catch (error) {
      if (error.status !== 404) throw error;
      alreadyGone = true;
      // Already consumed or removed by another tab: reconcile the queue below.
    }
  }
  runtime.queueRefreshSequence += 1;
  if (state.selectedThreadId === threadId) {
    state.queueItems = state.queueItems.filter((queued) => queued.id !== item.id);
  }
  state.recoveredQueueItems = state.recoveredQueueItems.filter((queued) => queued.id !== item.id);
  renderQueue();
  if (!item.localOnly) refreshQueue(threadId).catch(() => {});
  return { alreadyGone };
}

async function restoreQueueItem(item, threadId) {
  if (item.localDeferred) {
    const text = String(item.text || '');
    const restoredFiles = (item.files || []).map((file) => ({ ...file, dataUrl: file.dataUrl || ('data:' + (file.mime || 'application/octet-stream') + ';base64,' + (file.data || '')) }));
    if (state.selectedThreadId !== (threadId || null)) throw new Error('Volte ao rascunho desta conversa para devolver a mensagem. Ela continua guardada.');
    if (state.files.length + restoredFiles.length > 8) throw new Error('Remova um anexo do rascunho antes de devolver esta mensagem.');
    if ([...state.files, ...restoredFiles].filter((file) => file.isImage).length > 4) throw new Error('O limite é de 4 imagens por mensagem. Remova uma imagem do rascunho primeiro.');
    if ([...state.files, ...restoredFiles].reduce((total, file) => total + (file.size || 0), 0) > 24 * 1024 * 1024) throw new Error('O total dos anexos ultrapassa 24 MB. A mensagem continua na fila.');
    await updateDeferredQueueItems(state.deferredQueueItems.filter((queued) => queued.id !== item.id));
    const textarea = $('#messageInput');
    const draft = textarea.value.trimEnd();
    textarea.value = draft + (draft && text ? '\n\n' : '') + text;
    state.files.push(...restoredFiles);
    renderAttachments();
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    textarea.focus();
    return;
  }
  const input = Array.isArray(item.input) ? item.input : [];
  const parsed = splitAttachmentText(input.filter((part) => part.type === 'text').map((part) => String(part.text || '')).join('\n'), threadId);
  const text = parsed.text;
  const imageParts = input.filter((part) => part.type === 'image' || part.type === 'localImage');
  const localImageParts = imageParts.filter((part) => part.type === 'localImage' && typeof part.path === 'string');
  if (imageParts.length !== localImageParts.length) throw new Error('Não consegui recuperar todas as imagens. A mensagem continua na fila.');
  if (state.files.length + localImageParts.length + parsed.files.length > 8) throw new Error('Remova um anexo do rascunho antes de devolver esta mensagem.');
  if (state.files.filter((file) => file.isImage).length + localImageParts.length > 4) throw new Error('O limite é de 4 imagens por mensagem. Remova uma imagem do rascunho primeiro.');

  const restoredFiles = [];
  for (const part of localImageParts) {
    const name = part.path.split(/[\\/]/).pop();
    if (!/^[a-zA-Z0-9._-]{1,200}$/.test(name)) throw new Error('Uma imagem da fila tem um nome inválido. A mensagem continua na fila.');
    const response = await fetch(`${PREFIX}/api/images/${encodeURIComponent(threadId)}/${encodeURIComponent(name)}`, { credentials: 'same-origin', cache: 'no-store' });
    if (!response.ok) throw new Error('Não consegui recuperar uma imagem. A mensagem continua na fila.');
    const blob = await response.blob();
    const dataUrl = await new Promise((resolvePromise, rejectPromise) => {
      const reader = new FileReader(); reader.onload = () => resolvePromise(reader.result); reader.onerror = () => rejectPromise(new Error('Não consegui recuperar uma imagem.')); reader.readAsDataURL(blob);
    });
    restoredFiles.push({ name, isImage: true, size: blob.size, mime: blob.type || 'image/png', dataUrl, data: String(dataUrl).split(',')[1] });
  }

  for (const file of parsed.files) {
    const response = await fetch(file.url, { credentials: 'same-origin', cache: 'no-store' });
    if (!response.ok) throw new Error('Não consegui recuperar um arquivo. A mensagem continua na fila.');
    const blob = await response.blob(); const dataUrl = await blobDataUrl(blob);
    restoredFiles.push({ name: file.name, isImage: false, size: blob.size, mime: file.mime || blob.type || 'application/octet-stream', dataUrl, data: String(dataUrl).split(',')[1] });
  }
  if (state.selectedThreadId !== threadId) throw new Error('Volte a esta conversa para devolver a mensagem da fila. Ela continua guardada.');
  if (state.files.length + restoredFiles.length > 8) throw new Error('Remova um anexo do rascunho antes de devolver esta mensagem.');
  if ([...state.files, ...restoredFiles].reduce((total, file) => total + (file.size || 0), 0) > 24 * 1024 * 1024) throw new Error('O total dos anexos ultrapassa 24 MB. A mensagem continua na fila.');
  if (!item.localOnly) await api(`/api/threads/${encodeURIComponent(threadId)}/queue/${encodeURIComponent(item.id)}`, { method: 'DELETE' });
  const textarea = $('#messageInput');
  const draft = textarea.value.trimEnd();
  textarea.value = `${draft}${draft && text ? '\n\n' : ''}${text}`;
  state.files.push(...restoredFiles);
  renderAttachments();
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
  textarea.focus();
  state.queueItems = state.queueItems.filter((queued) => queued.id !== item.id);
  state.recoveredQueueItems = state.recoveredQueueItems.filter((queued) => queued.id !== item.id);
  renderQueue();
  if (!item.localOnly) await refreshQueue(threadId);
}

export async function refreshQueue(threadId = state.selectedThreadId) {
  if (!threadId) { state.queueItems = []; renderQueue(); return; }
  const sequence = ++runtime.queueRefreshSequence;
  const data = await api(`/api/threads/${encodeURIComponent(threadId)}/queue`);
  if (threadId !== state.selectedThreadId || sequence !== runtime.queueRefreshSequence) return;
  const recoverable = state.recoveredQueueItems.filter((item) => item.threadId === threadId);
  state.queueItems = [...(data.items || []), ...recoverable];
  renderQueue();
}
