// Composer controls, attachments, sending and steering.
import { api } from './api.js';
import { syncComposerSelect } from './custom-selects.js';
import { openThread, setBusy } from './conversation.js';
import { queueDraftForRateLimit } from './deferred-queue.js';
import { $, installIcons, toast } from './dom.js';
import { formatBytes, formatCountdown } from './format.js';
import { refreshUsage, updateThreadHeader } from './inspector.js';
import { openImagePreview } from './layout.js';
import { getComposerModelSelection, getSelectedModel } from './models.js';
import { associateThreadWithSelectedProject } from './projects.js';
import { refreshQueue } from './queue.js';
import { getEffectiveRateLimitBlock, getRateLimitBlock, isRateLimitError, renderRateLimitNotice } from './rate-limit.js';
import { state, voice } from './state.js';
import { refreshThreadList } from './thread-list.js';
import { clearRecordedAudio, prepareVoicePreview, sendVoiceRecording, touchComposer } from './voice.js';

function renderComposerOptionsSummary() {
  const summary = $('#composerOptionsSummary');
  if (!summary) return;
  const model = $('#modelSelect')?.selectedOptions?.[0]?.textContent.trim() || 'Modelo';
  const shortModel = model.replace(/^GPT-6[-.]?/i, '').replace(/^Codex /i, '');
  const effort = $('#effortSelect')?.selectedOptions?.[0]?.textContent.trim() || '';
  const accountSelect = $('#accountSelect');
  const account = accountSelect?.selectedOptions?.[0]?.textContent.trim() || '';
  const codexAccount = !accountSelect || accountSelect.value === 'codex';
  const permission = $('#accessModeSelect')?.value === 'automatic' ? 'Auto' : 'Manual';
  const parts = [codexAccount ? permission : account, shortModel, effort].filter(Boolean);
  summary.textContent = parts.join(' · ');
  const toggle = $('#composerOptionsToggle');
  if (toggle) {
    toggle.classList.toggle('is-automatic', codexAccount && $('#accessModeSelect')?.value === 'automatic');
    toggle.title = `Modelo: ${model}${effort ? `; esforço: ${effort}` : ''}${codexAccount ? `; permissões: ${permission}` : `; conta: ${account}`}; pasta: ${$('#cwdLabel')?.textContent.trim() || ''}`;
    toggle.setAttribute('aria-label', `Configurações da mensagem: ${parts.join(', ')}`);
  }
}

function renderAccessModeControl(usesCodex) {
  const control = $('#permissionModeControl');
  const select = $('#accessModeSelect');
  const note = $('#accessModeNote');
  if (!control || !select || !note) return;
  control.classList.toggle('hidden', !usesCodex);
  note.classList.toggle('hidden', !usesCodex);
  if (!usesCodex) return;
  const automatic = state.accessMode === 'automatic';
  select.value = state.accessMode;
  select.disabled = state.accessModeUpdating;
  control.classList.toggle('is-automatic', automatic);
  note.classList.toggle('is-automatic', automatic);
  note.textContent = state.accessModeUpdating ? 'Atualizando as permissões desta conversa…' : automatic
    ? state.busy ? 'Comandos pendentes desta conversa serão liberados; acesso completo vale no próximo turno.' : 'Comandos e alterações seguem sem pedir aprovação nesta conversa.'
    : state.busy ? 'Pedidos de aprovação voltam a aparecer; a execução atual conserva as permissões com que começou.' : 'Codex pede sua aprovação quando necessário.';
  syncComposerSelect(select);
}

export function updateComposerControls() {
  const hasDraft = Boolean($('#messageInput')?.value.trim() || state.files.length);
  const usesCodex = (state.chatAccountId || 'codex') === 'codex' && !String(state.selectedThreadId || '').startsWith('ext-');
  renderAccessModeControl(usesCodex);
  const limitBlock = usesCodex ? getEffectiveRateLimitBlock() : null;
  const limitBlocked = Boolean(limitBlock);
  const send = $('#sendButton');
  const modelSelect = $('#modelSelect');
  const effortSelect = $('#effortSelect');
  const externalAccount = state.chatAccountId && state.chatAccountId !== 'codex';
  const loadingModels = externalAccount && state.chatModelsLoading;
  renderComposerOptionsSummary();
  if (modelSelect) modelSelect.disabled = loadingModels || (externalAccount ? !state.chatModels.length : !state.models.length);
  if (effortSelect) effortSelect.disabled = !getSelectedModel()?.supportedReasoningEfforts?.length;
  if (send) {
    const transcriptReady = voice.phase === 'ready' && voice.transcriptInserted && Boolean($('#messageInput')?.value.trim());
    const sendingAudio = voice.phase === 'ready' && !transcriptReady;
    const voiceLabel = transcriptReady ? 'Enviar texto' : 'Enviar áudio';
    send.title = voice.phase === 'ready'
      ? limitBlocked ? `Guardar ${transcriptReady ? 'texto' : 'áudio'} na fila até o limite liberar` : voiceLabel
      : state.busy ? 'Adicionar mensagem à fila' : 'Enviar mensagem';
    send.setAttribute('aria-label', limitBlocked ? 'Guardar mensagem na fila até o limite liberar' : state.busy ? 'Adicionar mensagem à fila' : 'Enviar mensagem');
    send.disabled = state.sending || state.accessModeUpdating || loadingModels || !['idle', 'ready'].includes(voice.phase) || (!hasDraft && !voice.blob);
    $('#sendLabel').textContent = loadingModels ? 'Carregando…' : state.sending ? 'Enviando…' : (state.busy || limitBlocked) ? (voice.phase === 'ready' ? `${transcriptReady ? 'Texto' : 'Áudio'} à fila` : 'Fila') : voice.phase === 'ready' ? voiceLabel : 'Enviar';
    if (voice.phase === 'ready' && !state.sending) send.setAttribute('aria-label', send.title);
    send.classList.toggle('queue-mode', state.busy || limitBlocked);
    send.classList.toggle('audio-mode', sendingAudio);
  }
  if ($('#attachImage')) $('#attachImage').disabled = state.sending;
  if ($('#transcribeAudio')) $('#transcribeAudio').disabled = state.sending || voice.phase !== 'ready';
  if ($('#discardAudio')) $('#discardAudio').disabled = state.sending;
  if ($('#steerButton')) {
    $('#steerButton').classList.toggle('hidden', !state.busy || !state.selectedThreadId || limitBlocked);
    $('#steerButton').disabled = state.sending || voice.phase !== 'idle' || !hasDraft;
  }
  if ($('#stopTurn')) {
    $('#stopTurn').classList.toggle('hidden', !state.busy || !state.selectedThreadId);
    $('#stopTurn').disabled = state.interrupting;
    $('.stop-button-label', $('#stopTurn')).textContent = state.interrupting ? 'Parando…' : 'Parar';
  }
  if ($('#composerHint')) $('#composerHint').textContent = loadingModels ? 'Carregando modelos e esforços da conta…' : voice.phase === 'recording'
    ? 'Gravando · até 3 minutos'
    : limitBlocked ? `Limite de uso atingido${limitBlock.resetAt ? ` · libera ${formatCountdown(limitBlock.resetAt)}` : ''} · envios entram na fila`
    : voice.phase === 'ready' ? voice.transcriptInserted ? 'Revise sua transcrição e toque em Enviar texto' : 'Prévia pronta · ouça e toque em Enviar áudio'
    : state.busy ? 'Em execução · sua próxima mensagem entra na fila'
    : touchComposer() ? 'Escreva ou grave sua mensagem' : 'Enter envia · Shift+Enter cria uma linha';
  if ($('#composerFootnote')) $('#composerFootnote').textContent = limitBlocked ? 'As mensagens e anexos ficam salvos na fila deste navegador e serão tentados quando o limite liberar.' : voice.phase === 'ready' ? voice.transcriptInserted ? 'Revise o texto acima e toque em Enviar texto.' : 'Ouça a prévia. Enviar áudio manda a gravação; Transcrever coloca o texto para revisão.' : voice.phase === 'transcribing' ? 'O áudio é processado na VPS. O player continua disponível e o texto aparece aqui ao terminar.' : state.busy ? 'Use Orientar agora para enviar uma instrução à execução atual.' : 'Grave, ouça e envie sua mensagem de voz.';

}

export function renderAttachments() {
  const box = $('#attachmentStrip');
  box.replaceChildren();
  box.classList.toggle('hidden', !state.files.length);
  state.files.forEach((file, index) => {
    const tile = document.createElement('div'); tile.className = file.isImage ? 'attachment-preview' : 'attachment-file';
    if (file.isImage) {
      const preview = document.createElement('button'); preview.type = 'button'; preview.className = 'attachment-image-open'; preview.setAttribute('aria-label', `Ampliar ${file.name}`);
      const image = document.createElement('img'); image.src = file.dataUrl; image.alt = file.name;
      preview.addEventListener('click', () => openImagePreview(image.src, file.name)); preview.append(image); tile.append(preview);
    } else {
      const name = document.createElement('a'); name.href = file.dataUrl; name.download = file.name; name.textContent = file.name; name.title = `Baixar ${file.name}`;
      const size = document.createElement('small'); size.textContent = formatBytes(file.size || 0); tile.append(name, size);
      if (file.mime.startsWith('audio/')) {
        const player = document.createElement('audio'); player.controls = true; player.preload = 'metadata'; player.src = file.dataUrl; player.setAttribute('aria-label', `Ouvir ${file.name}`); tile.append(player);
        const transcribe = document.createElement('button'); transcribe.type = 'button'; transcribe.className = 'attachment-transcribe'; transcribe.textContent = 'Usar como voz';
        transcribe.addEventListener('click', async () => {
          if (voice.phase !== 'idle') { toast('Conclua ou descarte o áudio atual primeiro.', 'error'); return; }
          const response = await fetch(file.dataUrl); const blob = await response.blob();
          state.files = state.files.filter((entry) => entry !== file); renderAttachments();
          voice.cancelled = false; voice.generation += 1; prepareVoicePreview(blob);
        }); tile.append(transcribe);
      }
    }
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'attachment-remove'; remove.textContent = '×'; remove.setAttribute('aria-label', `Remover ${file.name}`);
    remove.addEventListener('click', () => { state.files.splice(index, 1); renderAttachments(); }); tile.append(remove); box.append(tile);
  });
  installIcons();
  updateComposerControls();
}

export function blobDataUrl(blob) {
  return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(new Error('Não consegui ler o arquivo.')); reader.readAsDataURL(blob); });
}

export async function addFiles(files) {
  for (const file of [...files]) {
    const isImage = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type);
    if (file.size > (isImage ? 8 : 12) * 1024 * 1024) { toast(`${file.name}: limite de ${isImage ? 8 : 12} MB por arquivo.`, 'error'); continue; }
    if (state.files.length >= 8) { toast('O limite é de 8 anexos por mensagem.', 'error'); break; }
    if (isImage && state.files.filter((entry) => entry.isImage).length >= 4) { toast('O limite é de 4 imagens por mensagem.', 'error'); continue; }
    if (state.files.reduce((total, entry) => total + (entry.size || 0), 0) + file.size > 24 * 1024 * 1024) { toast('O limite total é de 24 MB por mensagem.', 'error'); continue; }
    const dataUrl = await blobDataUrl(file).catch((error) => { toast(error.message, 'error'); return null; });
    if (!dataUrl) continue;
    const extension = file.name.split('.').pop().toLowerCase();
    const audioType = { m4a: 'audio/mp4', mp3: 'audio/mpeg', wav: 'audio/wav', webm: 'audio/webm', ogg: 'audio/ogg', aac: 'audio/aac' }[extension];
    state.files.push({ name: file.name, isImage, size: file.size, mime: audioType || file.type || 'application/octet-stream', dataUrl, data: String(dataUrl).split(',')[1] });
  }
  renderAttachments();
}

export function attachmentPayload(files) {
  return {
    images: files.filter((file) => file.isImage).map(({ name, mime, data }) => ({ name, mime, data })),
    files: files.filter((file) => !file.isImage).map(({ name, mime, data }) => ({ name, mime, data })),
  };
}

export async function submitMessage(event, { allowVoice = false } = {}) {
  event?.preventDefault();
  if (state.sending) return;
  if (state.accessModeUpdating) { toast('Aguarde a atualização das permissões antes de enviar.', 'error'); return false; }
  if (voice.phase === 'ready' && !allowVoice) {
    if (voice.transcriptInserted && $('#messageInput').value.trim()) {
      const sent = await submitMessage(event, { allowVoice: true });
      if (sent) clearRecordedAudio();
      return sent;
    }
    voice.transcriptInserted = false;
    return sendVoiceRecording();
  }
  if (voice.phase !== 'idle' && !allowVoice) { toast('Conclua a gravação antes de enviar.', 'error'); return false; }
  const textarea = $('#messageInput');
  const text = textarea.value.trim();
  if (!text && !state.files.length) return;
  const currentThread = state.selectedThreadId;
  const files = [...state.files];
  const accountId = state.chatAccountId || 'codex';
  const selection = getComposerModelSelection();
  // The browser-side limit queue only concerns the Codex account; other accounts answer directly.
  const rateLimitBlock = accountId === 'codex' && !String(currentThread || '').startsWith('ext-') ? getEffectiveRateLimitBlock() : null;
  if (rateLimitBlock) return queueDraftForRateLimit(text, files, currentThread, rateLimitBlock);
  state.sending = true; updateComposerControls();
  try {
    const result = await api('/api/turn', {
      method: 'POST',
      body: JSON.stringify({ threadId: currentThread, accountId, text, model: selection.model, effort: selection.effort, cwd: state.cwd, ...(accountId === 'codex' ? { accessMode: state.accessMode } : {}), ...attachmentPayload(files) }),
    });
    // Another account continuing a Codex conversation answers in a new harness conversation.
    if (currentThread && result.threadId && result.threadId !== currentThread) {
      if (textarea.value.trim() === text) { textarea.value = ''; textarea.style.height = 'auto'; }
      if (files.length === state.files.length && files.every((file, index) => state.files[index] === file)) { state.files = []; renderAttachments(); }
      toast('A conversa continua com a outra conta, levando o contexto desta.');
      await openThread(result.threadId);
      return true;
    }
    state.rateLimitFailure = null;
    renderRateLimitNotice();
    state.selectedThreadId = result.threadId;
    if (!currentThread) {
      state.activeThreadProjectId = state.selectedProjectId;
      associateThreadWithSelectedProject(result.threadId);
    }
    if (!currentThread && !result.queued) updateThreadHeader({ id: result.threadId, name: 'Nova conversa', model: getSelectedModel()?.displayName || state.modelId, status: { type: 'active' } });
    if (result.queued) {
      setBusy(true);
      toast('Mensagem adicionada à fila.');
      refreshQueue(result.threadId).catch((error) => toast(error.message, 'error'));
    } else {
      if (!state.turnStartedAtMs) state.turnStartedAtMs = Date.now();
      if (!result.turn?.id || !state.completedTurnIds.has(result.turn.id)) {
        state.activeTurnId = result.turn?.id || state.activeTurnId;
        setBusy(true);
      }
    }
    if (textarea.value.trim() === text) { textarea.value = ''; textarea.style.height = 'auto'; }
    if (files.length === state.files.length && files.every((file, index) => state.files[index] === file)) { state.files = []; renderAttachments(); }
    return true;
  } catch (error) {
    if (isRateLimitError(error.message)) {
      state.rateLimitFailure = { message: error.message, resetAt: getRateLimitBlock()?.resetAt || 0, createdAt: Date.now() };
      await refreshUsage(true).catch(() => {});
      const failedThreadId = currentThread || error.data?.threadId || state.selectedThreadId || null;
      if (!currentThread && failedThreadId) {
        state.selectedThreadId = failedThreadId;
        state.activeThreadProjectId = state.selectedProjectId;
        updateThreadHeader({ id: failedThreadId, name: 'Nova conversa', model: getSelectedModel()?.displayName || state.modelId });
        refreshThreadList().catch(() => {});
      }
      return await queueDraftForRateLimit(text, files, failedThreadId, getEffectiveRateLimitBlock());
    }
    toast(error.message, 'error');
    return false;
  } finally {
    state.sending = false;
    updateComposerControls();
    textarea.dispatchEvent(new Event('input'));
    if (!touchComposer()) textarea.focus();
  }
}

export async function steerMessage() {
  if (state.sending || voice.phase !== 'idle' || !state.selectedThreadId) return;
  const textarea = $('#messageInput');
  const text = textarea.value.trim();
  if (!text && !state.files.length) return;
  const threadId = state.selectedThreadId;
  const files = [...state.files];
  const rateLimitBlock = getEffectiveRateLimitBlock();
  if (rateLimitBlock) return queueDraftForRateLimit(text, files, threadId, rateLimitBlock);
  state.sending = true; updateComposerControls();
  try {
    await api(`/api/threads/${encodeURIComponent(threadId)}/steer`, {
      method: 'POST',
      body: JSON.stringify({ text, ...attachmentPayload(files) }),
    });
    state.rateLimitFailure = null;
    renderRateLimitNotice();
    if (textarea.value.trim() === text) { textarea.value = ''; textarea.style.height = 'auto'; }
    if (files.length === state.files.length && files.every((file, index) => state.files[index] === file)) { state.files = []; renderAttachments(); }
    toast('Orientação enviada para a execução atual.');
  } catch (error) {
    if (isRateLimitError(error.message)) {
      state.rateLimitFailure = { message: error.message, resetAt: getRateLimitBlock()?.resetAt || 0, createdAt: Date.now() };
      await refreshUsage(true).catch(() => {});
      await queueDraftForRateLimit(text, files, threadId, getEffectiveRateLimitBlock());
    } else toast(error.message, 'error');
  }
  finally {
    state.sending = false;
    updateComposerControls();
    textarea.dispatchEvent(new Event('input'));
    textarea.focus();
  }
}
