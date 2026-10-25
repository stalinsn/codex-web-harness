// Conversation list, per-thread action menus and search.
import { api } from './api.js';
import { PINNED_THREAD_SECTION_ID } from './config.js';
import { newChat, openThread } from './conversation.js';
import { $, $$, escapeHtml, installIcons, toast } from './dom.js';
import { updateThreadHeader } from './inspector.js';
import { openThreadColorMenu, projectColor, projectForThread, renderProjects, threadBelongsToProject, threadColor, threadDisplayTitle } from './projects.js';
import { state } from './state.js';

export function closeThreadMenus() {
  $$('.thread-actions-popover').forEach((menu) => {
    if (menu.matches(':popover-open')) menu.hidePopover();
  });
}

export function createThreadRow(thread, { nested = false, showUnassigned = false } = {}) {
  const pinned = thread.section?.id === PINNED_THREAD_SECTION_ID;
  const project = projectForThread(thread);
  const color = project ? '' : threadColor(thread);
  const row = document.createElement('div');
  row.className = `thread-row${pinned ? ' pinned' : ''}${nested ? ' project-thread-row' : ''}${color ? ' has-thread-color' : ''}`;
  if (color) row.style.setProperty('--thread-color', color);
  const button = document.createElement('button');
  const isRunning = thread.id === state.selectedThreadId ? state.busy : state.activeThreadIds.has(thread.id) || thread.status?.type === 'active';
  button.className = `thread-item ${thread.id === state.selectedThreadId ? 'active' : ''}${isRunning ? ' running' : ''}`;
  button.type = 'button';
  button.title = threadDisplayTitle(thread);
  button.innerHTML = '<span class="icon" data-icon="chat"></span><span class="thread-item-title"></span>';
  $('.thread-item-title', button).textContent = threadDisplayTitle(thread);
  const projectTagColor = projectColor(project);
  if (!nested && project) {
    const badge = document.createElement('span');
    badge.className = 'thread-project-tag';
    badge.style.setProperty('--project-color', projectTagColor || '#9ca7dc');
    badge.textContent = project.name;
    button.append(badge);
  } else if (!project && showUnassigned) {
    const badge = document.createElement('span');
    badge.className = `thread-project-tag thread-unassigned-tag${color ? ' has-thread-color' : ''}`;
    if (color) badge.style.setProperty('--thread-color', color);
    badge.textContent = 'Sem projeto';
    button.append(badge);
  }
  if (pinned) {
    const badge = document.createElement('span');
    badge.className = 'thread-pin-badge';
    badge.textContent = 'Fixada';
    button.append(badge);
  }
  if (isRunning) {
    const indicator = document.createElement('span');
    indicator.className = 'thread-running-indicator';
    indicator.setAttribute('role', 'status');
    indicator.setAttribute('aria-label', 'Codex trabalhando');
    indicator.title = 'Codex trabalhando';
    button.append(indicator);
  }
  button.addEventListener('click', () => openThread(thread.id));

  const menu = document.createElement('div');
  menu.className = 'thread-actions';
  const trigger = document.createElement('button');
  trigger.type = 'button'; trigger.className = 'thread-actions-trigger';
  trigger.textContent = '⋯';
  trigger.title = 'Ações da conversa';
  trigger.setAttribute('aria-label', `Ações: ${threadDisplayTitle(thread)}`);
  trigger.setAttribute('aria-haspopup', 'menu'); trigger.setAttribute('aria-expanded', 'false');
  menu.append(trigger);
  const popover = document.createElement('div');
  popover.className = `thread-actions-popover ${nested ? 'project-tree-thread-actions-popover' : 'thread-list-actions-popover'}`;
  popover.id = `thread-menu-${nested ? 'project-' : 'list-'}${thread.id}`;
  popover.setAttribute('popover', 'auto'); popover.setAttribute('role', 'menu');
  popover.setAttribute('aria-label', `Ações: ${threadDisplayTitle(thread)}`); trigger.setAttribute('aria-controls', popover.id);
  const action = (label, handler, { danger = false, disabled = false, icon = 'chat' } = {}) => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = danger ? 'thread-action danger' : 'thread-action';
    item.setAttribute('role', 'menuitem');
    item.innerHTML = `<span class="icon" data-icon="${icon}"></span><span>${escapeHtml(label)}</span>`;
    item.disabled = disabled;
    if (disabled) item.title = 'Disponível quando a execução terminar.';
    item.addEventListener('click', (event) => {
      event.stopPropagation();
      popover.hidePopover();
      handler();
    });
    popover.append(item);
  };
  const running = isRunning;
  action('Renomear', () => performThreadAction(thread, 'rename'), { icon: 'rename' });
  if (!project) action(color ? 'Alterar cor da conversa' : 'Colorir conversa', () => openThreadColorMenu(thread, trigger), { icon: 'tag' });
  if (!state.archivedView) action(pinned ? 'Desafixar' : 'Fixar no topo', () => performThreadAction(thread, 'pin'), { icon: 'pin' });
  action(state.archivedView ? 'Restaurar conversa' : 'Arquivar conversa', () => performThreadAction(thread, state.archivedView ? 'unarchive' : 'archive'), { disabled: running, icon: 'archive' });
  action('Excluir conversa', () => performThreadAction(thread, 'delete'), { danger: true, disabled: running, icon: 'trash' });
  document.body.append(popover);
  trigger.addEventListener('click', () => {
    if (popover.matches(':popover-open')) return popover.hidePopover();
    closeThreadMenus(); popover.showPopover();
    const rect = trigger.getBoundingClientRect();
    const height = popover.getBoundingClientRect().height;
    popover.style.left = `${Math.max(8, Math.min(innerWidth - 212, rect.right - 204))}px`;
    popover.style.top = `${Math.max(8, Math.min(innerHeight - height - 8, rect.bottom + 5))}px`;
  });
  popover.addEventListener('toggle', () => trigger.setAttribute('aria-expanded', String(popover.matches(':popover-open'))));
  trigger.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') { event.preventDefault(); if (!popover.matches(':popover-open')) trigger.click(); $('button:not(:disabled)', popover)?.focus(); }
  });
  popover.addEventListener('keydown', (event) => {
    const buttons = $$('button:not(:disabled)', popover); const index = buttons.indexOf(document.activeElement);
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); popover.hidePopover(); trigger.focus(); }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); buttons[(index + (event.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length]?.focus(); }
  });
  row.append(button, menu);
  return row;
}

export function renderThreads(threads = state.threads, query = $('#threadSearch')?.value.trim() || '') {
  state.threads = threads;
  closeThreadMenus();
  $$('.thread-list-actions-popover').forEach((popover) => popover.remove());
  renderProjects();
  const list = $('#threadList');
  const heading = $('#threadListTitle');
  if (heading) heading.textContent = query ? 'Resultados da busca' : state.archivedView ? 'Arquivadas' : 'Fixadas';
  const archivedToggle = $('#toggleArchived');
  if (archivedToggle) {
    archivedToggle.setAttribute('aria-pressed', String(state.archivedView));
    archivedToggle.setAttribute('aria-label', 'Mostrar conversas arquivadas');
  }
  $('#showRecentThreads')?.setAttribute('aria-pressed', String(!state.archivedView));
  list.replaceChildren();
  const project = state.projects.find((item) => item.id === state.selectedProjectId);
  $('#clearThreadSearch')?.classList.toggle('hidden', !query);
  if ($('#threadSearchHint') && !query) $('#threadSearchHint').textContent = '';
  list.classList.remove('hidden');
  heading?.classList.remove('hidden');
  if (!query && !state.archivedView) {
    const pinnedThreads = threads.filter((thread) => thread.section?.id === PINNED_THREAD_SECTION_ID);
    list.setAttribute('aria-label', 'Conversas fixadas');
    if (pinnedThreads.length) pinnedThreads.forEach((thread) => list.append(createThreadRow(thread, { showUnassigned: true })));
    else {
      const empty = document.createElement('div');
      empty.className = 'thread-empty';
      empty.textContent = 'Nenhuma conversa fixada.';
      list.append(empty);
    }
    installIcons();
    return;
  }
  const allProjects = Boolean(query && $('#threadSearchScope')?.value === 'all');
  const visibleThreads = [...(project && !allProjects ? threads.filter((thread) => threadBelongsToProject(thread, project)) : threads)]
    .sort((left, right) => Number(right.section?.id === PINNED_THREAD_SECTION_ID) - Number(left.section?.id === PINNED_THREAD_SECTION_ID));
  $('#clearThreadSearch')?.classList.toggle('hidden', !query);
  if ($('#threadSearchHint')) $('#threadSearchHint').textContent = query ? `${visibleThreads.length} resultado${visibleThreads.length === 1 ? '' : 's'}` : '';
  list.setAttribute('aria-label', state.archivedView ? 'Conversas arquivadas' : 'Conversas recentes e fixadas');
  if (!visibleThreads.length) {
    const empty = document.createElement('div');
    empty.className = 'thread-empty';
    empty.textContent = query ? 'Nenhuma conversa encontrada.' : state.archivedView ? 'Nenhuma conversa arquivada.' : project ? 'Este projeto ainda não tem conversas.' : 'Suas conversas recentes aparecerão aqui.';
    list.append(empty);
    return;
  }
  visibleThreads.forEach((thread) => list.append(createThreadRow(thread, { showUnassigned: !project || allProjects })));
  installIcons();
}

async function performThreadAction(thread, action) {
  const id = encodeURIComponent(thread.id);
  try {
    if (action === 'rename') {
      const name = window.prompt('Nome da conversa', thread.name || threadDisplayTitle(thread));
      if (name === null) return;
      const trimmed = name.trim();
      if (!trimmed) return toast('O nome não pode ficar vazio.', 'error');
      await api(`/api/threads/${id}/rename`, { method: 'POST', body: JSON.stringify({ name: trimmed }) });
      if (state.selectedThreadId === thread.id) updateThreadHeader({ ...state.selectedThread, name: trimmed });
      toast('Conversa renomeada.');
    } else if (action === 'pin') {
      const pinned = thread.section?.id !== PINNED_THREAD_SECTION_ID;
      await api(`/api/threads/${id}/pin`, { method: 'POST', body: JSON.stringify({ pinned }) });
      toast(pinned ? 'Conversa fixada no topo.' : 'Conversa desafixada.');
    } else if (action === 'archive' || action === 'unarchive') {
      await api(`/api/threads/${id}/${action}`, { method: 'POST', body: '{}' });
      if (state.selectedThreadId === thread.id) newChat();
      toast(action === 'archive' ? 'Conversa arquivada.' : 'Conversa restaurada.');
    } else if (action === 'delete') {
      const title = threadDisplayTitle(thread);
      if (!window.confirm(`Excluir permanentemente “${title}”? Esta ação não pode ser desfeita.`)) return;
      await api(`/api/threads/${id}/delete`, { method: 'DELETE' });
      if (state.selectedThreadId === thread.id) newChat();
      toast('Conversa excluída.');
    }
    await refreshThreadList($('#threadSearch').value.trim());
  } catch (error) {
    toast(error.message, 'error');
  }
}

export async function refreshThreadList(query = $('#threadSearch')?.value.trim() || '') {
  const requestId = ++state.threadListRequest;
  const params = new URLSearchParams();
  if (query) params.set('search', query);
  if (state.archivedView) params.set('archived', 'true');
  const data = await api(`/api/threads${params.size ? `?${params}` : ''}`);
  if (requestId !== state.threadListRequest) return;
  renderThreads(data.threads || [], query);
}
