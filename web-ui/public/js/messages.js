// Message rendering, history replay, streaming rows and approvals.
import { indexAgentThreads, registerIntermediate, renderActivity, renderReasoningSummary, startProgressSegment, updateTurnIntermediateTitle } from './activity.js';
import { api } from './api.js';
import { PREFIX } from './config.js';
import { loadOlderHistory, turnStatus } from './conversation.js';
import { $, $$, icons, toast } from './dom.js';
import { formatDuration } from './format.js';
import { openImagePreview } from './layout.js';
import { markdown } from './markdown.js';
import { state } from './state.js';

function makeAvatar() {
  return '<div class="message-avatar" aria-hidden="true"><svg viewBox="0 0 32 32"><path d="M16 3.2 27.1 9.6v12.8L16 28.8 4.9 22.4V9.6L16 3.2Z"/><path d="m11.2 11.2 4.8 4.8-4.8 4.8M20.8 11.2 16 16l4.8 4.8"/></svg></div>';
}

/** Who answers in the open conversation: Codex, or the account of a harness conversation. */
function assistantLabel() {
  const threadId = String(state.selectedThreadId || '');
  if (!threadId.startsWith('ext-')) return 'Codex';
  const thread = state.selectedThread?.id === threadId ? state.selectedThread : state.threads.find((item) => item.id === threadId);
  return state.accounts.find((account) => account.id === thread?.accountId)?.label || 'Assistente';
}

export function makeMessage(role, { text = '', images = [], files = [], time = null, id = '', turnId = '', phase = '', finalAnswer = true, parent = null } = {}) {
  $('#welcome').classList.add('hidden');
  const row = document.createElement('article');
  row.className = `message ${role}`;
  if (id) row.dataset.itemId = id;
  if (turnId) row.dataset.turnId = turnId;
  if (role === 'assistant') {
    row.dataset.finalAnswer = finalAnswer ? 'true' : 'false';
    if (phase) row.dataset.phase = phase;
  }
  if (role === 'assistant') {
    row.innerHTML = `${makeAvatar()}<div class="message-body"><div class="assistant-label"></div><div class="message-content"></div><div class="message-meta"></div></div>`;
    $('.assistant-label', row).textContent = assistantLabel();
  }
  else row.innerHTML = '<div class="message-body"><div class="message-content"></div><div class="message-images"></div><div class="message-meta"></div></div>';
  if (role === 'assistant') $('.message-content', row).innerHTML = markdown(text);
  else $('.message-content', row).textContent = text;
  const imageBox = $('.message-images', row);
  for (const image of images) {
    const preview = document.createElement('button');
    preview.type = 'button';
    preview.className = 'message-image-open';
    preview.title = 'Abrir imagem em tamanho maior';
    preview.setAttribute('aria-label', `Ampliar ${image.name || 'imagem anexada'}`);
    const img = document.createElement('img');
    img.alt = image.name || 'Imagem anexada';
    img.loading = 'lazy';
    img.decoding = 'async';
    if (image.url) img.src = image.url;
    else if (image.dataUrl) img.src = image.dataUrl;
    else img.alt = 'Imagem anexada';
    preview.addEventListener('click', () => openImagePreview(img.currentSrc || img.src, img.alt));
    preview.append(img);
    imageBox?.append(preview);
  }
  if (files.length) {
    const box = document.createElement('div'); box.className = 'message-files';
    for (const file of files) {
      const link = document.createElement('a'); link.className = 'message-file'; link.href = file.url; link.download = file.name; link.textContent = `📎 ${file.name}`;
      box.append(link);
      if (file.mime?.startsWith('audio/')) { const player = document.createElement('audio'); player.controls = true; player.preload = 'metadata'; player.src = file.url; player.setAttribute('aria-label', `Ouvir ${file.name}`); box.append(player); }
    }
    $('.message-body', row).append(box);
  }
  if (imageBox && !imageBox.children.length) imageBox.remove();
  if (time) $('.message-meta', row).textContent = time;
  (parent || $('#messages')).append(row);
  scrollConversation();
  return row;
}

export function scrollConversation(force = false) {
  const area = $('#messages');
  if (force) {
    state.followLatest = true;
    $('#scrollToLatest')?.classList.add('hidden');
  }
  if (!state.followLatest) return;
  requestAnimationFrame(() => {
    if (state.followLatest) area.scrollTop = area.scrollHeight;
  });
}

export function splitAttachmentText(raw, threadId) {
  const files = [];
  const text = String(raw || '').replace(/\[Arquivo anexado\]\s*\n([^\n]+)\n\[\/Arquivo anexado\]/g, (block, json) => {
    try {
      const file = JSON.parse(json);
      const storedName = String(file.path || '').split(/[\\/]/).pop();
      if (!file.name || !/^[a-zA-Z0-9._-]{1,200}$/.test(storedName)) return block;
      files.push({ ...file, storedName, url: `${PREFIX}/api/files/${encodeURIComponent(threadId)}/${encodeURIComponent(storedName)}?name=${encodeURIComponent(file.name)}` });
      return '';
    } catch { return block; }
  }).trim();
  return { text, files };
}

export function imageFromContent(content, threadId) {
  const images = [];
  for (const part of content || []) {
    if (part.type === 'image' && part.url) images.push({ url: part.url, name: 'Imagem' });
    if (part.type === 'localImage' && part.path) {
      const name = String(part.path).split('/').pop();
      images.push({ url: `${PREFIX}/api/images/${encodeURIComponent(threadId)}/${encodeURIComponent(name)}`, name: 'Imagem enviada' });
    }
  }
  return images;
}

function isFinalAgentMessage(item) {
  const phase = String(item?.phase || '').toLowerCase().replace(/[\s-]/g, '_');
  return !phase || phase === 'final_answer' || phase === 'finalanswer' || phase === 'final';
}

export function renderTurnHistory(turns, threadId) {
  indexAgentThreads(turns);
  const sameThread = $('#messages').dataset.threadId === threadId;
  const previousScrollTop = $('#messages').scrollTop;
  if (!sameThread) state.followLatest = true;
  $('#messages').dataset.threadId = threadId;
  state.streamedMessages.clear();
  state.activityCards.clear();
  state.commandGroups.clear();
  state.reasoningGroups.clear();
  state.turnIntermediates.clear();
  state.progressSegments.clear();
  state.userMessageIds.clear();
  $('#messages').replaceChildren();
  if (state.historyThreadId === threadId && state.historyNextCursor) {
    const loadOlder = document.createElement('button');
    loadOlder.type = 'button';
    loadOlder.id = 'loadOlderHistory';
    loadOlder.className = 'history-load-older';
    loadOlder.textContent = state.historyLoadingOlder ? 'Carregando mensagens anteriores…' : 'Carregar mensagens anteriores';
    loadOlder.disabled = state.historyLoadingOlder;
    loadOlder.addEventListener('click', loadOlderHistory);
    $('#messages').append(loadOlder);
  }
  let count = 0;
  for (const turn of turns || []) {
    const items = turn.items || [];
    let lastFinalIndex = -1;
    let lastAgentIndex = -1;
    items.forEach((item, index) => {
      if (item.type !== 'agentMessage') return;
      lastAgentIndex = index;
      if (isFinalAgentMessage(item)) lastFinalIndex = index;
    });
    const visibleAnswerIndex = lastFinalIndex >= 0 ? lastFinalIndex : (turnStatus(turn) === 'inProgress' || turnStatus(turn) === 'active' ? -1 : lastAgentIndex);
    let lastAssistant = null;
    items.forEach((item, index) => {
      if (item.type === 'userMessage') {
        const { text, files } = splitAttachmentText((item.content || []).filter((part) => part.type === 'text').map((part) => part.text).join('\n'), threadId);
        const images = imageFromContent(item.content, threadId);
        if (text || images.length || files.length) {
          if (item.id) state.userMessageIds.add(item.id);
          makeMessage('user', { text, images, files, id: item.id }); startProgressSegment(turn.id); count++;
        }
      } else if (item.type === 'agentMessage') {
        if (item.text) {
          const finalAnswer = index === visibleAnswerIndex;
          let row;
          if (finalAnswer) {
            row = lastAssistant = makeMessage('assistant', { text: item.text, id: item.id, turnId: turn.id, phase: item.phase, finalAnswer: true });
          } else {
            const group = registerIntermediate(turn.id, `message:${item.id || index}`, true);
            row = makeMessage('assistant', { text: item.text, id: item.id, turnId: turn.id, phase: item.phase, finalAnswer: false, parent: group.content });
          }
          if (item.id) state.streamedMessages.set(`${threadId}:${item.id}`, { row, text: item.text, phase: item.phase || '', turnId: turn.id, finalAnswer });
          count++;
        }
      } else if (item.type === 'reasoning') {
        if (renderReasoningSummary(item, turn.id, true)) count++;
      } else if (['commandExecution', 'fileChange', 'webSearch', 'mcpToolCall', 'collabToolCall', 'subAgentActivity', 'plan'].includes(item.type)) {
        renderActivity(item, true, turn.id); count++;
      }
    });
    const durationMs = Number(turn.durationMs) || (turn.startedAt && turn.completedAt ? (Number(turn.completedAt) - Number(turn.startedAt)) * 1000 : 0);
    const groups = [...state.turnIntermediates.values()].filter((group) => group.turnId === turn.id);
    if (groups.length && durationMs > 0) groups.forEach((group) => { group.durationMs = durationMs; updateTurnIntermediateTitle(group); });
    else if (lastAssistant && durationMs > 0) $('.message-meta', lastAssistant).textContent = `Trabalhou por ${formatDuration(durationMs)}`;
  }
  $('#welcome').classList.toggle('hidden', count > 0);
  if (sameThread && !state.followLatest) $('#messages').scrollTop = previousScrollTop;
  else scrollConversation(true);
}

export function getOrCreateStreamMessage(itemId, turnId = '', phase = '') {
  const key = `${state.selectedThreadId}:${itemId}`;
  let message = state.streamedMessages.get(key);
  if (!message) {
    const normalizedTurnId = turnId || state.activeTurnId || '';
    const finalAnswer = Boolean(phase) && isFinalAgentMessage({ phase });
    const group = finalAnswer ? null : registerIntermediate(normalizedTurnId, `message:${itemId}`, true);
    const row = makeMessage('assistant', { id: itemId, turnId: normalizedTurnId, phase, finalAnswer, parent: group?.content || null });
    message = { row, text: '', phase, turnId: normalizedTurnId, finalAnswer };
    state.streamedMessages.set(key, message);
  }
  return message;
}

export function placeStreamMessage(stream, phase) {
  if (phase) stream.phase = phase;
  const finalAnswer = Boolean(stream.phase) && isFinalAgentMessage({ phase: stream.phase });
  const target = finalAnswer ? $('#messages') : registerIntermediate(stream.turnId, `message:${stream.row.dataset.itemId}`, true).content;
  if (stream.row.parentElement !== target) target.append(stream.row);
  stream.finalAnswer = finalAnswer;
  stream.row.dataset.finalAnswer = finalAnswer ? 'true' : 'false';
  if (stream.phase) stream.row.dataset.phase = stream.phase;
  return stream;
}

export function addApproval(request) {
  const threadId = request.params?.threadId;
  const requestId = String(request.id);
  state.pendingApprovals.set(requestId, request);
  if (threadId !== state.selectedThreadId) return;
  $('#welcome').classList.add('hidden');
  const card = document.createElement('div');
  card.className = 'activity-card approval-card';
  card.dataset.requestId = requestId;
  const command = request.params?.command || request.params?.commandActions?.map((action) => action.command).filter(Boolean).join('\n') || '';
  const reason = request.params?.reason || 'O Codex precisa da sua decisão para continuar.';
  card.innerHTML = `<div class="activity-heading"><span class="icon"><svg viewBox="0 0 24 24">${icons.shield}</svg></span><span>Confirmação necessária</span></div><div class="approval-reason"></div>${command ? '<pre class="approval-command"></pre>' : ''}<div class="approval-actions"><button class="approve" data-decision="accept">Permitir agora</button><button data-decision="acceptForSession">Permitir nesta sessão</button><button data-decision="decline">Recusar</button></div>`;
  $('.approval-reason', card).textContent = reason;
  if (command) $('.approval-command', card).textContent = command;
  $$('.approval-actions button', card).forEach((button) => button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      await api(`/api/threads/${encodeURIComponent(threadId)}/approval`, { method: 'POST', body: JSON.stringify({ requestId, decision: button.dataset.decision }) });
      card.remove(); state.pendingApprovals.delete(requestId);
      toast(button.dataset.decision.startsWith('accept') ? 'Aprovação enviada.' : 'Solicitação recusada.');
    } catch (error) { button.disabled = false; toast(error.message, 'error'); }
  }));
  $('#messages').append(card);
  scrollConversation();
}
