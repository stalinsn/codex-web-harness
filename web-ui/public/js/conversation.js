// Opening threads, loading history and tracking the running turn.
import { updateReasoningGroup, updateTurnIntermediateTitle } from './activity.js';
import { api } from './api.js';
import { updateComposerControls } from './composer.js';
import { $, randomKey, toast } from './dom.js';
import { formatDuration } from './format.js';
import { loadContextUsage, updateThreadHeader } from './inspector.js';
import { closeSidebar } from './layout.js';
import { addApproval, renderTurnHistory } from './messages.js';
import { setChatAccount } from './models.js';
import { projectForThread, revealProjectThread, selectProject, updateWorkingDirectory } from './projects.js';
import { refreshQueue, renderQueue } from './queue.js';
import { responderFor, setProviderClass } from './responders.js';
import { runtime, state } from './state.js';
import { renderThreads } from './thread-list.js';

function updateRunningClock() {
  if (!state.busy) return;
  const elapsed = state.turnStartedAtMs ? Date.now() - state.turnStartedAtMs : 0;
  const who = responderFor(state.activeTurnId);
  setProviderClass($('#runningIndicator'), who.provider);
  $('#runningText').textContent = elapsed > 0 ? `${who.label} trabalhando há ${formatDuration(elapsed)}` : `${who.label} está trabalhando…`;
  for (const group of state.turnIntermediates.values()) {
    if (group.turnId === (state.activeTurnId || 'active') && group.durationMs == null) updateTurnIntermediateTitle(group);
  }
}

export function setBusy(busy, detail = '') {
  const changed = state.busy !== Boolean(busy);
  state.busy = Boolean(busy);
  const statusLabel = $('#threadExecutionState');
  if (statusLabel) statusLabel.textContent = state.busy ? 'Em execução' : 'Pronta para continuar';
  if (changed) { renderThreads(state.threads, $('#threadSearch').value.trim()); renderQueue(); }
  $('#runningIndicator').classList.toggle('hidden', !state.busy);
  if (detail) $('#runningText').textContent = detail;
  if (state.busy) {
    if (!state.turnStartedAtMs) state.turnStartedAtMs = Date.now();
    updateRunningClock();
    if (!state.turnTimer) state.turnTimer = setInterval(updateRunningClock, 1000);
  } else {
    state.turnStartedAtMs = null;
    clearInterval(state.turnTimer);
    state.turnTimer = null;
  }
  for (const group of state.turnIntermediates.values()) {
    const isActiveGroup = group.turnId === (state.activeTurnId || 'active');
    group.card.open = state.busy && isActiveGroup;
    updateTurnIntermediateTitle(group);
  }
  for (const group of state.reasoningGroups.values()) updateReasoningGroup(group);
  updateComposerControls();
}

export function turnStatus(turn) { return typeof turn?.status === 'string' ? turn.status : turn?.status?.type; }

export function rememberCompletedTurn(turnId) {
  if (!turnId) return;
  state.completedTurnIds.add(turnId);
  if (state.completedTurnIds.size > 200) state.completedTurnIds.delete(state.completedTurnIds.values().next().value);
}

function mergeLatestHistoryTurns(existing, incoming) {
  const updates = new Map((incoming || []).filter((turn) => turn.id).map((turn) => [turn.id, turn]));
  const merged = (existing || []).map((turn) => updates.get(turn.id) || turn);
  const known = new Set(merged.map((turn) => turn.id).filter(Boolean));
  for (const turn of incoming || []) {
    if (!turn.id || !known.has(turn.id)) {
      merged.push(turn);
      if (turn.id) known.add(turn.id);
    }
  }
  return merged;
}

function executionFromHistory(data) {
  const latest = (data.turns || []).at(-1);
  const status = turnStatus(latest);
  if (['completed', 'failed', 'interrupted'].includes(status)) return { active: false, turn: null };
  const active = ['inProgress', 'active'].includes(status) || data.thread?.status?.type === 'active';
  return { active, turn: active ? latest : null };
}

export async function syncExecutionState() {
  const threadId = state.selectedThreadId;
  if (!threadId || state.loadingThreadId || runtime.executionSyncRequest) return;
  runtime.executionSyncRequest = loadThreadHistory(threadId, { background: true });
  try { await runtime.executionSyncRequest; } finally { runtime.executionSyncRequest = null; }
}

export async function loadThreadHistory(threadId, { background = false } = {}) {
  const revision = state.executionRevision;
  const data = await api(`/api/threads/${encodeURIComponent(threadId)}/history`);
  if (state.selectedThreadId !== threadId || (background && revision !== state.executionRevision)) return null;
  const incomingTurns = data.turns || [];
  if (state.historyThreadId === threadId) {
    state.historyTurns = mergeLatestHistoryTurns(state.historyTurns, incomingTurns);
    if (!state.historyLoadedOlder) state.historyNextCursor = data.nextCursor || null;
  } else {
    state.historyThreadId = threadId;
    state.historyTurns = incomingTurns;
    state.historyNextCursor = data.nextCursor || null;
    state.historyLoadedOlder = false;
    state.historyLoadingOlder = false;
    state.agentThreads.clear();
  }
  state.selectedThreadId = threadId;
  if (!state.accessModeUpdating || state.accessModeUpdatingThreadId !== threadId) state.accessMode = data.accessMode || state.defaultAccessMode;
  const row = state.threads.find((item) => item.id === threadId);
  const thread = data.thread || { id: threadId };
  if (!thread.name && !thread.preview && row) Object.assign(thread, { name: row.name, preview: row.preview });
  updateThreadHeader(thread);
  loadContextUsage(threadId).catch(() => {});
  const execution = executionFromHistory(data);
  const active = execution.active;
  state.activeTurnId = execution.turn?.id || null;
  for (const turn of incomingTurns) if (['completed', 'failed', 'interrupted'].includes(turnStatus(turn))) rememberCompletedTurn(turn.id);
  // Background syncs usually return what is already on screen; rebuilding the whole
  // conversation then only costs layout and collapses details the user opened.
  const snapshot = JSON.stringify(state.historyTurns);
  const unchanged = background && $('#messages').dataset.threadId === threadId && state.renderedHistorySnapshot === snapshot;
  if (!unchanged) {
    renderTurnHistory(state.historyTurns, threadId);
    state.renderedHistorySnapshot = snapshot;
  }
  if (active) state.activeThreadIds.add(threadId);
  else state.activeThreadIds.delete(threadId);
  renderThreads(state.threads, $('#threadSearch').value.trim());
  const activeTurn = execution.turn;
  state.turnStartedAtMs = activeTurn?.startedAt ? Number(activeTurn.startedAt) * 1000 : (active ? state.turnStartedAtMs || Date.now() : null);
  setBusy(active);
  refreshQueue(threadId).catch((error) => toast(error.message, 'error'));
  if (!unchanged) state.pendingApprovals.forEach((request) => { if (request.params?.threadId === threadId) addApproval(request); });
  if (!background && window.innerWidth <= 680) closeSidebar();
  return data;
}

export async function loadOlderHistory() {
  const threadId = state.selectedThreadId;
  const cursor = state.historyNextCursor;
  if (!threadId || !cursor || state.historyLoadingOlder) return;
  const messages = $('#messages');
  const previousHeight = messages.scrollHeight;
  const previousTop = messages.scrollTop;
  state.historyLoadingOlder = true;
  const button = $('#loadOlderHistory');
  if (button) { button.disabled = true; button.textContent = 'Carregando mensagens anteriores…'; }
  const params = new URLSearchParams({ cursor });
  try {
    const data = await api(`/api/threads/${encodeURIComponent(threadId)}/history?${params}`);
    if (state.selectedThreadId !== threadId || state.historyNextCursor !== cursor) return;
    const olderTurns = data.turns || [];
    const known = new Set(state.historyTurns.map((turn) => turn.id).filter(Boolean));
    const newOlderTurns = olderTurns.filter((turn) => !turn.id || !known.has(turn.id));
    state.historyTurns = [...newOlderTurns, ...state.historyTurns];
    state.historyNextCursor = data.nextCursor && data.nextCursor !== cursor ? data.nextCursor : null;
    state.historyLoadedOlder = true;
    state.historyLoadingOlder = false;
    state.followLatest = false;
    for (const turn of olderTurns) if (['completed', 'failed', 'interrupted'].includes(turnStatus(turn))) rememberCompletedTurn(turn.id);
    renderTurnHistory(state.historyTurns, threadId);
    state.renderedHistorySnapshot = '';
    messages.scrollTop = previousTop + Math.max(0, messages.scrollHeight - previousHeight);
  } catch (error) {
    if (state.selectedThreadId === threadId) toast(error.message || 'Não consegui carregar as mensagens anteriores.', 'error');
  } finally {
    state.historyLoadingOlder = false;
    const currentButton = $('#loadOlderHistory');
    if (currentButton) {
      currentButton.disabled = false;
      currentButton.textContent = 'Carregar mensagens anteriores';
    }
  }
}

function showThreadLoading() {
  $('#welcome').classList.add('hidden');
  $('#messages').replaceChildren();
  const status = document.createElement('div');
  status.className = 'thread-load-state';
  status.setAttribute('role', 'status');
  status.innerHTML = '<span class="thread-load-spinner" aria-hidden="true"></span><span>Carregando o histórico da conversa…</span>';
  $('#messages').append(status);
}

function showThreadLoadError(threadId, error) {
  $('#welcome').classList.add('hidden');
  $('#messages').replaceChildren();
  const card = document.createElement('section');
  card.className = 'thread-load-error';
  const title = document.createElement('strong');
  title.textContent = 'Não foi possível abrir esta conversa.';
  const detail = document.createElement('p');
  detail.textContent = error?.message || 'Tente novamente em alguns instantes.';
  const retry = document.createElement('button');
  retry.type = 'button';
  retry.textContent = 'Tentar novamente';
  retry.addEventListener('click', () => openThread(threadId));
  card.append(title, detail, retry);
  $('#messages').append(card);
}

export async function openThread(threadId) {
  const ownerThread = state.threads.find((thread) => thread.id.startsWith('ext-') && (thread.internalCodexThreadIds || []).includes(threadId));
  if (ownerThread) threadId = ownerThread.id;
  if (!threadId || state.loadingThreadId === threadId) return;
  if (state.historyThreadId && state.historyThreadId !== threadId) {
    state.historyThreadId = '';
    state.historyTurns = [];
    state.historyNextCursor = null;
    state.historyLoadedOlder = false;
    state.historyLoadingOlder = false;
    state.agentThreads.clear();
    state.streamedMessages.clear(); state.activityCards.clear(); state.commandGroups.clear(); state.reasoningGroups.clear(); state.turnIntermediates.clear(); state.progressSegments.clear(); state.userMessageIds.clear();
  }
  state.selectedThreadId = threadId;
  state.loadingThreadId = threadId;
  const summary = state.threads.find((item) => item.id === threadId);
  setChatAccount(threadId.startsWith('ext-') ? summary?.accountId || state.chatAccountId : 'codex');
  state.activeThreadProjectId = projectForThread(summary)?.id || '';
  state.queueItems = [];
  renderQueue();
  updateThreadHeader(summary || { id: threadId });
  renderThreads(state.threads, $('#threadSearch').value.trim());
  setBusy(false);
  showThreadLoading();
  try {
    await loadThreadHistory(threadId);
    if (state.selectedThreadId !== threadId) return;
    const thread = state.selectedThread || state.threads.find((item) => item.id === threadId);
    const summary = state.threads.find((item) => item.id === threadId);
    if (summary && thread?.cwd) summary.cwd = thread.cwd;
    let project = projectForThread(thread);
    if (project && thread?.cwd && !(project.threadIds || []).includes(threadId)) {
      try {
        const association = await api(`/api/threads/${encodeURIComponent(threadId)}/project-association`, { method: 'POST', body: '{}' });
        if (Array.isArray(association.projects)) state.projects = association.projects;
        project = projectForThread(thread) || state.projects.find((item) => item.id === association.projectId) || null;
      } catch (error) {
        console.warn('Não foi possível persistir o vínculo da conversa com o projeto.', error);
      }
    }
    state.activeThreadProjectId = project?.id || '';
    if (!project) {
      state.unassignedExpanded = true;
      localStorage.setItem('codex-unassigned-expanded', 'true');
    }
    revealProjectThread(threadId);
    const cwd = project?.cwd || thread?.cwd || thread?.workingDirectory || thread?.workspace?.cwd || state.defaultCwd;
    selectProject(project?.id || '', { folderPath: cwd, updateActiveThread: true });
  } catch (error) {
    if (state.selectedThreadId === threadId) {
      setBusy(false);
      showThreadLoadError(threadId, error);
      toast(error.message, 'error');
    }
  } finally {
    if (state.loadingThreadId === threadId) state.loadingThreadId = null;
  }
}

export function newChat() {
  state.followLatest = true;
  state.draftQueueGroupId = randomKey();
  localStorage.setItem('codex-draft-queue-group', state.draftQueueGroupId);
  state.selectedThreadId = null;
  state.accessMode = state.defaultAccessMode;
  state.selectedThread = null;
  state.activeThreadProjectId = '';
  state.loadingThreadId = null;
  state.historyThreadId = ''; state.historyTurns = []; state.historyNextCursor = null; state.historyLoadedOlder = false; state.historyLoadingOlder = false; state.agentThreads.clear();
  state.streamedMessages.clear(); state.activityCards.clear(); state.commandGroups.clear(); state.reasoningGroups.clear(); state.turnIntermediates.clear(); state.userMessageIds.clear();
  state.activeTurnId = null; state.progressSegments.clear();
  state.queueItems = []; renderQueue();
  const project = state.projects.find((item) => item.id === state.selectedProjectId);
  updateWorkingDirectory(project?.cwd || state.defaultCwd || state.cwd || '/');
  $('#messages').replaceChildren(); $('#welcome').classList.remove('hidden');
  setBusy(false); updateThreadHeader(null);
  if (window.innerWidth <= 680) closeSidebar();
  $('#messageInput').focus();
}
