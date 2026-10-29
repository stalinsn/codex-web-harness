// Server-sent events from the harness and Codex app-server notifications.
import { refreshAccountsSoon } from './accounts.js';
import { updateComposerControls } from './composer.js';
import { rememberAgentThread, renderActivity, renderReasoningSummary, setReasoningPart, startProgressSegment, updateTurnIntermediateTitle } from './activity.js';
import { PREFIX } from './config.js';
import { loadThreadHistory, rememberCompletedTurn, setBusy, syncExecutionState, turnStatus } from './conversation.js';
import { maybeDrainDeferredQueue } from './deferred-queue.js';
import { $, onNextFrame, randomKey, toast } from './dom.js';
import { rememberError } from './error-history.js';
import { applyAccountData, refreshUsage, renderContextUsage, renderUsage, updateThreadHeader } from './inspector.js';
import { setConnection } from './layout.js';
import { markdown } from './markdown.js';
import { addApproval, getOrCreateStreamMessage, imageFromContent, makeMessage, placeStreamMessage, scrollConversation, splitAttachmentText } from './messages.js';
import { getSelectedModel, populateModels, setChatAccount } from './models.js';
import { associateThreadWithSelectedProject, renderConversationContext } from './projects.js';
import { refreshQueue, renderQueue } from './queue.js';
import { clearResolvedRateLimitFailure, getEffectiveRateLimitBlock, isRateLimitError, recordRateLimitFailure } from './rate-limit.js';
import { playCompletionSound } from './sound.js';
import { rememberTurnAccount } from './responders.js';
import { state } from './state.js';
import { onTaskEvent, onTaskUpdated, refreshTasks } from './tasks.js';
import { refreshThreadList, renderThreads } from './thread-list.js';
import { onLoginOutput, onLoginState } from './wizard.js';

function handleCodexNotification(message) {
  const params = message.params || {};
  if (message.method === 'thread/settings/updated' && params.threadId === state.selectedThreadId && !state.accessModeUpdating && params.threadSettings) {
    const settings = params.threadSettings;
    state.accessMode = settings.approvalPolicy === 'never' && settings.sandboxPolicy?.type === 'dangerFullAccess' ? 'automatic' : 'manual';
    updateComposerControls();
  }
  if (message.method === 'account/rateLimits/updated') {
    const candidate = params.rateLimitsByLimitId || params.rateLimits || params;
    const values = candidate ? (Array.isArray(candidate) ? candidate : Object.values(candidate)) : [];
    if (values.some((bucket) => bucket && (bucket.primary || bucket.secondary))) state.rateLimits = candidate;
    clearResolvedRateLimitFailure();
    renderUsage();
    renderQueue();
    if (state.deferredQueueItems.length && !getEffectiveRateLimitBlock()) maybeDrainDeferredQueue().catch(() => {});
    return;
  }
  const eventThreadId = params.threadId || params.turn?.threadId || params.thread?.id;
  if (message.method === 'thread/started' && params.thread?.id && (params.thread.agentNickname || params.thread.agentRole)) {
    rememberAgentThread(params.thread.id, { nickname: params.thread.agentNickname, role: params.thread.agentRole, model: params.thread.model });
  }
  if (eventThreadId === state.selectedThreadId) {
    state.executionRevision += 1;
    state.lastExecutionEventAt = Date.now();
  }
  if (eventThreadId && message.method === 'turn/started') {
    state.activeThreadIds.add(eventThreadId);
    renderThreads(state.threads, $('#threadSearch').value.trim());
  } else if (eventThreadId && message.method === 'thread/status/changed') {
    if (params.status?.type === 'active') state.activeThreadIds.add(eventThreadId);
    else state.activeThreadIds.delete(eventThreadId);
    renderThreads(state.threads, $('#threadSearch').value.trim());
  }
  if (message.method === 'item/commandExecution/requestApproval' || message.method === 'item/fileChange/requestApproval') {
    addApproval({ id: params.requestId ?? params.itemId ?? randomKey(), method: message.method, params, serverRequestId: params.requestId });
    return;
  }
  if (message.method === 'error') {
    const errorMessage = params.error?.message || 'Ocorreu um erro no turno.';
    rememberError(errorMessage, {
      threadId: eventThreadId || state.selectedThreadId,
      turnId: params.turnId || '',
      source: 'Provedor',
      provider: state.selectedThread?.provider || '',
    });
    // Limits of other accounts are handled by the server's rotation, not by the Codex limit notice.
    if (isRateLimitError(errorMessage) && !String(eventThreadId || '').startsWith('ext-')) {
      recordRateLimitFailure(errorMessage);
      if (eventThreadId && eventThreadId === state.selectedThreadId && params.willRetry !== true) {
        state.activeThreadIds.delete(eventThreadId);
        state.activeTurnId = null;
        setBusy(false, 'Pausado pelo limite de uso');
        renderThreads(state.threads, $('#threadSearch').value.trim());
      }
      toast('Limite de uso atingido. O turno foi interrompido; a próxima mensagem pode ficar na fila.', 'error');
      return;
    }
  }
  if (message.method === 'thread/status/changed' && eventThreadId === state.selectedThreadId) {
    if (params.status?.type !== 'active') { setBusy(false); state.activeTurnId = null; }
    else if (state.activeTurnId) setBusy(true);
    else syncExecutionState().catch(() => {});
  }
  if (eventThreadId && eventThreadId !== state.selectedThreadId) return;
  if (message.method === 'turn/started') {
    rememberTurnAccount(params.turn);
    if (params.turn?.id && state.completedTurnIds.has(params.turn.id)) return;
    state.turnStartedAtMs = params.turn?.startedAt ? Number(params.turn.startedAt) * 1000 : Date.now();
    state.activeTurnId = params.turn?.id || null;
    setBusy(true);
    return;
  }
  if (message.method === 'item/reasoning/summaryPartAdded') {
    const itemId = params.itemId || params.item?.id;
    if (itemId) setReasoningPart({ itemId, summaryIndex: params.summaryIndex, turnId: params.turnId, text: '', append: true });
    return;
  }
  if (message.method === 'item/reasoning/summaryTextDelta') {
    const itemId = params.itemId || params.item?.id;
    if (itemId) setReasoningPart({ itemId, summaryIndex: params.summaryIndex, turnId: params.turnId, text: params.delta || '', delta: true, append: true });
    return;
  }
  // Raw reasoning text deltas are intentionally ignored; only user-facing summary events are rendered.
  if (message.method === 'item/agentMessage/delta') {
    const itemId = params.itemId || params.item?.id;
    if (!itemId) return;
    const stream = getOrCreateStreamMessage(itemId, params.turnId, params.phase || params.item?.phase || '');
    stream.text += params.delta || '';
    // Re-rendering the whole Markdown on every token is quadratic; do it once per frame.
    onNextFrame(stream, () => {
      $('.message-content', stream.row).innerHTML = markdown(stream.text);
      scrollConversation();
    });
    return;
  }
  if (message.method === 'item/commandExecution/outputDelta') {
    const itemId = params.itemId || params.item?.id;
    if (!itemId) return;
    const key = `${state.selectedThreadId}:${itemId}`;
    const card = state.activityCards.get(key) || renderActivity({ id: itemId, type: 'commandExecution', command: params.command, status: 'inProgress' }, true, params.turnId);
    card.pendingOutput = (card.pendingOutput || '') + (params.delta || '');
    onNextFrame(card, () => {
      const output = $('.activity-output', card);
      output.append(card.pendingOutput);
      card.pendingOutput = '';
      output.classList.remove('hidden');
      scrollConversation();
    });
    return;
  }
  if (message.method === 'item/started' || message.method === 'item/completed') {
    const item = params.item;
    if (!item) return;
    if (message.method === 'item/completed' && (item.status === 'failed' || item.error)) {
      const detail = item.error || item.aggregatedOutput || item.result || 'A ferramenta falhou sem devolver detalhes.';
      rememberError(typeof detail === 'string' ? detail : detail.message || JSON.stringify(detail), {
        threadId: eventThreadId || state.selectedThreadId,
        turnId: params.turnId || '',
        source: 'Ferramenta',
        provider: state.selectedThread?.provider || '',
        tool: item.tool || (item.type === 'commandExecution' ? 'Comando' : item.type),
      });
    }
    if (item.type === 'agentMessage') {
      const key = `${state.selectedThreadId}:${item.id}`;
      let stream = state.streamedMessages.get(key);
      if (!stream) stream = getOrCreateStreamMessage(item.id, params.turnId);
      stream.turnId = params.turnId || stream.turnId;
      placeStreamMessage(stream, item.phase);
      if (item.text) stream.text = item.text;
      $('.message-content', stream.row).innerHTML = markdown(stream.text);
    } else if (item.type === 'reasoning') {
      renderReasoningSummary(item, params.turnId, true);
    } else if (item.type === 'userMessage' && message.method === 'item/started') {
      if (!item.id || !state.userMessageIds.has(item.id)) {
        const { text, files } = splitAttachmentText((item.content || []).filter((part) => part.type === 'text').map((part) => part.text).join('\n'), state.selectedThreadId);
        const images = imageFromContent(item.content, state.selectedThreadId);
        if (item.id) state.userMessageIds.add(item.id);
        if (text || images.length || files.length) { makeMessage('user', { text, images, files, id: item.id }); startProgressSegment(params.turnId); }
      }
    } else if (item.type === 'userMessage') {
      // The user message was rendered when its item started.
    } else {
      renderActivity(item, true, params.turnId);
    }
    return;
  }
  if (message.method === 'turn/plan/updated') {
    const plan = params.plan || [];
    const text = plan.map((step) => `${step.status === 'completed' ? '✓' : step.status === 'inProgress' ? '→' : '·'} ${step.step}`).join('\n');
    renderActivity({ id: `plan-${params.turnId || 'active'}`, type: 'plan', text }, true, params.turnId);
    return;
  }
  if (message.method === 'thread/tokenUsage/updated') {
    $('#threadMeta').dataset.usage = JSON.stringify(params.tokenUsage || params);
    return;
  }
  if (message.method === 'error') toast(params.error?.message || 'Ocorreu um erro no turno.', 'error');
}

export function connectEvents() {
  const events = new EventSource(`${PREFIX}/api/events`, { withCredentials: true });
  events.onopen = () => {
    setConnection(true, 'Codex conectado');
    refreshThreadList().then(() => syncExecutionState()).catch(() => {});
  };
  events.onerror = () => setConnection(false, 'Reconectando ao Codex…');
  events.onmessage = (raw) => {
    let event; try { event = JSON.parse(raw.data); } catch { return; }
    if (event.type === 'server-state') setConnection(Boolean(event.data.online), event.data.message);
    else if (event.type === 'codex-event') handleCodexNotification(event.data);
    else if (event.type === 'server-request') addApproval(event.data);
    else if (event.type === 'request-resolved') state.pendingApprovals.delete(event.data.requestId);
    else if (event.type === 'account-data') {
      if (Array.isArray(event.data?.models)) { state.models = event.data.models; populateModels(); }
      applyAccountData(event.data);
    }
    else if (event.type === 'accounts-changed') refreshAccountsSoon();
    else if (event.type === 'login-output') onLoginOutput(event.data);
    else if (event.type === 'login-state') onLoginState(event.data);
    else if (event.type === 'task-updated') onTaskUpdated(event.data);
    else if (event.type === 'task-event') onTaskEvent(event.data);
    else if (event.type === 'thread-updated') {
      const { threadId, thread } = event.data || {};
      if (threadId && thread) {
        const index = state.threads.findIndex((item) => item.id === threadId);
        if (index >= 0) state.threads[index] = { ...state.threads[index], ...thread };
        if (state.selectedThreadId === threadId) {
          state.selectedThread = { ...(state.selectedThread || {}), ...thread };
          setChatAccount(thread.accountId || 'codex');
          updateThreadHeader(thread);
          updateComposerControls();
        }
        renderThreads(state.threads, $('#threadSearch').value.trim());
        refreshThreadList().catch(() => {});
      }
    }
    else if (event.type === 'handoff-steered') toast(`Conta perto do limite (${Math.round(event.data.percent)}%): pedi ao Codex para salvar o registro de retomada.`);
    else if (event.type === 'handoff-started') {
      toast(`Limite do Codex: “${event.data.title}” continua em outra conta.`);
      refreshTasks().catch(() => {});
    }
    else if (event.type === 'thread-usage') {
      const usage = event.data.tokenUsage || event.data;
      const tokenText = usage.total?.totalTokens ?? usage.totalTokens ?? usage.total?.inputTokens;
      if (tokenText != null) $('#threadMeta').dataset.tokens = String(tokenText);
      if (event.data.threadId === state.selectedThreadId) {
        state.contextUsage = { tokenUsage: usage, updatedAt: event.at || new Date().toISOString() };
        renderContextUsage(state.contextUsage);
      }
    }
    else if (event.type === 'thread-queue-changed') {
      if (event.data.threadId === state.selectedThreadId) refreshQueue(state.selectedThreadId).catch((error) => toast(error.message, 'error'));
    }
    else if (event.type === 'turn-accepted') {
      if (event.data.turnId && state.completedTurnIds.has(event.data.turnId)) return;
      state.activeThreadIds.add(event.data.threadId);
      const isNew = !state.selectedThreadId && state.sending;
      if (!isNew && state.selectedThreadId !== event.data.threadId) return;
      state.executionRevision += 1; state.lastExecutionEventAt = Date.now();
      state.selectedThreadId = event.data.threadId;
      state.activeTurnId = event.data.turnId || state.activeTurnId;
      if (isNew) state.activeThreadProjectId = state.selectedProjectId;
      setBusy(true);
      if (isNew) updateThreadHeader({ id: event.data.threadId, name: 'Nova conversa', model: event.data.model, status: { type: 'active' } });
    }
    else if (event.type === 'thread-created') {
      if (state.selectedThreadId || !state.sending) return;
      const thread = event.data.thread;
      state.selectedThreadId = thread.id;
      state.activeThreadProjectId = state.selectedProjectId;
      state.threads = [thread, ...state.threads.filter((item) => item.id !== thread.id)];
      associateThreadWithSelectedProject(thread.id);
      updateThreadHeader({ id: thread.id, name: 'Nova conversa', model: getSelectedModel()?.displayName || state.modelId });
      renderConversationContext();
      renderThreads(state.threads, $('#threadSearch').value.trim());
    }
    else if (event.type === 'turn-completed') {
      const turnId = event.data.turn?.id;
      const turnError = event.data.turn?.error?.message || event.data.turn?.error || event.data.turn?.failureReason || event.data.turn?.status?.message || '';
      if (isRateLimitError(turnError) && !String(event.data.threadId || '').startsWith('ext-')) recordRateLimitFailure(turnError);
      const isSelected = event.data.threadId === state.selectedThreadId;
      const superseded = isSelected && state.activeTurnId && turnId && state.activeTurnId !== turnId;
      if (!superseded && !['interrupted', 'failed', 'error'].includes(turnStatus(event.data.turn))) playCompletionSound(turnId);
      rememberCompletedTurn(turnId);
      if (event.data.threadId && !superseded) {
        state.activeThreadIds.delete(event.data.threadId);
        renderThreads(state.threads, $('#threadSearch').value.trim());
      }
      if (isSelected) {
        state.executionRevision += 1; state.lastExecutionEventAt = Date.now();
        const groups = [...state.turnIntermediates.values()].filter((group) => group.turnId === turnId);
        groups.forEach((group) => { group.durationMs = Number(event.data.turn?.durationMs) || (state.turnStartedAtMs ? Date.now() - state.turnStartedAtMs : 0); group.card.open = false; updateTurnIntermediateTitle(group); });
        if (!superseded) {
          setBusy(false); state.activeTurnId = null;
          loadThreadHistory(state.selectedThreadId, { background: true }).catch(() => {});
        }
      }
      refreshThreadList().catch(() => {});
      refreshUsage().catch(() => {});
    }
  };
}
