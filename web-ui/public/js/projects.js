// Projects, working directory and colour tagging in the sidebar tree.
import { api } from './api.js';
import { PINNED_THREAD_SECTION_ID, PROJECT_COLOR_OPTIONS } from './config.js';
import { newChat } from './conversation.js';
import { $, $$, installIcons, toast } from './dom.js';
import { setCardSummary } from './inspector-layout.js';
import { state } from './state.js';
import { createThreadRow, renderThreads } from './thread-list.js';

export function pathIsWithin(path, root) {
  const base = String(root || '').replace(/\/+$/, '');
  const target = String(path || '');
  return Boolean(base && target && (target === base || target.startsWith(base + '/')));
}

export function projectForThread(thread) {
  if (!thread) return null;
  const cwd = thread.cwd || thread.workingDirectory || thread.workspace?.cwd || '';
  const cwdProject = state.projects
    .filter((project) => pathIsWithin(cwd, project.cwd))
    .sort((left, right) => right.cwd.length - left.cwd.length)[0];
  return cwdProject || state.projects.find((project) => (project.threadIds || []).includes(thread.id)) || null;
}

export function threadBelongsToProject(thread, project) {
  return projectForThread(thread)?.id === project.id;
}

export function threadDisplayTitle(thread) {
  const name = String(thread?.name || '').trim();
  if (name && !/^#\s*Files mentioned by the user\s*:/i.test(name)) return name.split(/\r?\n/, 1)[0].trim().slice(0, 100) || 'Nova conversa';
  const preview = String(thread?.preview || '').trim();
  if (/^#\s*Files mentioned by the user\s*:/i.test(preview)) return 'Conversa com arquivo anexado';
  return preview.split(/\r?\n/, 1)[0].trim().slice(0, 100) || 'Nova conversa';
}

export function updateWorkingDirectory(path) {
  state.cwd = path;
  localStorage.setItem('codex-cwd', path);
  $('#cwdLabel').textContent = path;
  $('#inspectorCwd').textContent = path;
  setCardSummary('environment', path.split('/').filter(Boolean).pop() || '/');
  renderConversationContext();
}

export function renderConversationContext() {
  const badge = $('#conversationContext');
  const activeProjectId = state.selectedThreadId ? state.activeThreadProjectId : state.selectedProjectId;
  const project = state.projects.find((item) => item.id === activeProjectId) || null;
  if (badge) {
    badge.textContent = project ? `Projeto · ${project.name}` : 'Geral · sem projeto';
    badge.title = project ? `Esta conversa usa o projeto ${project.name} (${project.cwd})` : 'Esta conversa não está vinculada a um projeto.';
  }
  const select = $('#chatContextSelect');
  if (!select) return;
  const current = state.selectedProjectId;
  select.replaceChildren(new Option('Dúvida geral · sem projeto', ''));
  state.projects.forEach((item) => select.add(new Option(`Desenvolver em · ${item.name}`, item.id)));
  select.value = state.projects.some((item) => item.id === current) ? current : '';
}

export function associateThreadWithSelectedProject(threadId) {
  const project = state.projects.find((item) => item.id === state.selectedProjectId);
  if (!project || !threadId) return;
  if (!Array.isArray(project.threadIds)) project.threadIds = [];
  if (!project.threadIds.includes(threadId)) project.threadIds.push(threadId);
  renderProjects();
}

export function projectColor(project) {
  const color = state.projectColors[project?.id];
  return PROJECT_COLOR_OPTIONS.some((option) => option.color === color) ? color : '';
}

export function threadColor(thread) {
  const color = state.threadColors[thread?.id];
  return PROJECT_COLOR_OPTIONS.some((option) => option.color === color) ? color : '';
}

function cacheLabelColors() {
  try {
    localStorage.setItem('codex-project-colors', JSON.stringify(state.projectColors));
    localStorage.setItem('codex-thread-colors', JSON.stringify(state.threadColors));
  } catch { /* server storage remains authoritative if this browser cannot cache */ }
}

function closeProjectColorMenus() {
  $$('.project-color-popover').forEach((popover) => {
    if (popover.matches(':popover-open')) popover.hidePopover();
    popover.remove();
  });
}

function setProjectColor(projectId, color) {
  if (color) state.projectColors[projectId] = color;
  else delete state.projectColors[projectId];
  cacheLabelColors();
  renderThreads(state.threads, $('#threadSearch').value.trim());
  persistLabelColor('project', projectId, color);
}

function setThreadColor(threadId, color) {
  if (color) state.threadColors[threadId] = color;
  else delete state.threadColors[threadId];
  cacheLabelColors();
  renderThreads(state.threads, $('#threadSearch').value.trim());
  persistLabelColor('thread', threadId, color);
}

function persistLabelColor(scope, id, color) {
  api(`/api/labels/${scope}/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify({ color }),
  }).catch((error) => toast(`A cor foi aplicada neste navegador, mas não foi sincronizada com a VPS: ${error.message}`, 'error'));
}

export async function syncLabelColors() {
  const labels = await api('/api/labels/migrate', {
    method: 'POST',
    body: JSON.stringify({ projectColors: state.projectColors, threadColors: state.threadColors }),
  });
  const projectColors = labels.projectColors || {};
  const threadColors = labels.threadColors || {};
  const changed = JSON.stringify(state.projectColors) !== JSON.stringify(projectColors)
    || JSON.stringify(state.threadColors) !== JSON.stringify(threadColors);
  state.projectColors = projectColors;
  state.threadColors = threadColors;
  cacheLabelColors();
  if (changed) renderThreads(state.threads, $('#threadSearch')?.value.trim() || '');
}

function openProjectColorMenu(project, trigger) {
  closeProjectColorMenus();
  const popover = document.createElement('div');
  popover.className = 'project-color-popover';
  popover.setAttribute('popover', 'auto');
  popover.setAttribute('role', 'menu');
  popover.setAttribute('aria-label', `Cor das conversas de ${project.name}`);
  const title = document.createElement('strong');
  title.textContent = 'Etiqueta do projeto';
  popover.append(title);
  const choices = [{ color: '', label: 'Cor padrão' }, ...PROJECT_COLOR_OPTIONS];
  choices.forEach((option) => {
    const choice = document.createElement('button');
    choice.type = 'button';
    choice.className = 'project-color-choice';
    choice.setAttribute('role', 'menuitemradio');
    choice.setAttribute('aria-checked', String(projectColor(project) === option.color));
    const swatch = document.createElement('span');
    swatch.className = `project-color-swatch${option.color ? '' : ' default'}`;
    if (option.color) swatch.style.setProperty('--project-color', option.color);
    const label = document.createElement('span');
    label.textContent = option.label;
    choice.append(swatch, label);
    choice.addEventListener('click', () => { popover.hidePopover(); setProjectColor(project.id, option.color); });
    popover.append(choice);
  });
  document.body.append(popover);
  popover.showPopover();
  const rect = trigger.getBoundingClientRect();
  const height = popover.getBoundingClientRect().height;
  popover.style.left = `${Math.max(8, Math.min(innerWidth - 208, rect.right - 204))}px`;
  popover.style.top = `${Math.max(8, Math.min(innerHeight - height - 8, rect.bottom + 5))}px`;
  popover.querySelector('button')?.focus();
}

export function openThreadColorMenu(thread, trigger) {
  closeProjectColorMenus();
  const color = threadColor(thread);
  const popover = document.createElement('div');
  popover.className = 'project-color-popover thread-color-popover';
  popover.setAttribute('popover', 'auto');
  popover.setAttribute('role', 'menu');
  popover.setAttribute('aria-label', `Cor da conversa ${threadDisplayTitle(thread)}`);
  const title = document.createElement('strong');
  title.textContent = 'Cor da conversa';
  popover.append(title);
  const choices = [{ color: '', label: 'Cor padrão' }, ...PROJECT_COLOR_OPTIONS];
  choices.forEach((option) => {
    const choice = document.createElement('button');
    choice.type = 'button';
    choice.className = 'project-color-choice';
    choice.setAttribute('role', 'menuitemradio');
    choice.setAttribute('aria-checked', String(color === option.color));
    const swatch = document.createElement('span');
    swatch.className = `project-color-swatch${option.color ? '' : ' default'}`;
    if (option.color) swatch.style.setProperty('--project-color', option.color);
    const label = document.createElement('span');
    label.textContent = option.label;
    choice.append(swatch, label);
    choice.addEventListener('click', () => { popover.hidePopover(); setThreadColor(thread.id, option.color); });
    popover.append(choice);
  });
  document.body.append(popover);
  popover.showPopover();
  const rect = trigger.getBoundingClientRect();
  const height = popover.getBoundingClientRect().height;
  popover.style.left = `${Math.max(8, Math.min(innerWidth - 208, rect.right - 204))}px`;
  popover.style.top = `${Math.max(8, Math.min(innerHeight - height - 8, rect.bottom + 5))}px`;
  popover.querySelector('button')?.focus();
}

export function renderProjects() {
  const list = $('#projectList');
  if (!list) return;
  closeProjectColorMenus();
  $$('.project-tree-thread-actions-popover').forEach((popover) => popover.remove());
  list.replaceChildren();

  const all = document.createElement('button');
  all.type = 'button';
  all.className = 'project-item' + (state.selectedProjectId ? '' : ' active');
  all.innerHTML = '<span class="icon" data-icon="folder"></span>';
  const allLabel = document.createElement('span');
  allLabel.className = 'project-item-label';
  allLabel.textContent = 'Todas as conversas';
  all.append(allLabel);
  all.addEventListener('click', () => selectProject(''));
  list.append(all);

  const query = $('#threadSearch')?.value.trim() || '';
  if (!state.archivedView) {
    const unassignedThreads = state.threads.filter((thread) => !projectForThread(thread));
    const unassignedNode = document.createElement('div');
    unassignedNode.className = 'project-tree-node unassigned-tree-node';
    const unassignedRow = document.createElement('div');
    unassignedRow.className = 'project-tree-row';
    const unassignedToggle = document.createElement('button');
    unassignedToggle.type = 'button';
    unassignedToggle.className = 'project-tree-toggle';
    const isUnassignedExpanded = state.unassignedExpanded && !query;
    unassignedToggle.setAttribute('aria-expanded', String(isUnassignedExpanded));
    unassignedToggle.setAttribute('aria-label', `${isUnassignedExpanded ? 'Recolher' : 'Expandir'} conversas sem projeto`);
    unassignedToggle.innerHTML = '<span class="icon" data-icon="chevron"></span>';
    unassignedToggle.addEventListener('click', () => {
      state.unassignedExpanded = !state.unassignedExpanded;
      localStorage.setItem('codex-unassigned-expanded', String(state.unassignedExpanded));
      renderThreads(state.threads, $('#threadSearch').value.trim());
    });
    const unassignedButton = document.createElement('button');
    unassignedButton.type = 'button';
    unassignedButton.className = 'project-item';
    unassignedButton.title = 'Conversas que não pertencem a nenhum projeto';
    unassignedButton.innerHTML = '<span class="icon" data-icon="folder"></span>';
    const unassignedLabel = document.createElement('span');
    unassignedLabel.className = 'project-item-label';
    unassignedLabel.textContent = 'Sem projeto';
    const unassignedCount = document.createElement('span');
    unassignedCount.className = 'project-count';
    unassignedCount.textContent = String(unassignedThreads.length);
    unassignedButton.append(unassignedLabel, unassignedCount);
    unassignedButton.addEventListener('click', () => {
      state.unassignedExpanded = true;
      localStorage.setItem('codex-unassigned-expanded', 'true');
      selectProject('');
    });
    unassignedRow.append(unassignedToggle, unassignedButton);
    unassignedNode.append(unassignedRow);
    const unassignedChildren = document.createElement('div');
    unassignedChildren.className = 'project-tree-children';
    unassignedChildren.hidden = !isUnassignedExpanded;
    if (isUnassignedExpanded) {
      const rows = unassignedThreads.filter((thread) => thread.section?.id !== PINNED_THREAD_SECTION_ID);
      if (!rows.length) {
        const empty = document.createElement('div');
        empty.className = 'project-tree-empty';
        empty.textContent = unassignedThreads.length ? 'As conversas fixadas aparecem na lista abaixo.' : 'Nenhuma conversa sem projeto.';
        unassignedChildren.append(empty);
      } else {
        rows.forEach((thread) => unassignedChildren.append(createThreadRow(thread, { nested: true, showUnassigned: true })));
      }
    }
    unassignedNode.append(unassignedChildren);
    list.append(unassignedNode);
  }

  state.projects.forEach((project) => {
    const node = document.createElement('div');
    node.className = 'project-tree-node';
    const row = document.createElement('div');
    row.className = 'project-tree-row';
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'project-tree-toggle';
    const isExpanded = project.id === state.selectedProjectId && project.id === state.expandedProjectId && !query && !state.archivedView;
    toggle.setAttribute('aria-expanded', String(isExpanded));
    toggle.setAttribute('aria-label', `${isExpanded ? 'Recolher' : 'Expandir'} conversas de ${project.name}`);
    toggle.innerHTML = '<span class="icon" data-icon="chevron"></span>';
    toggle.addEventListener('click', () => {
      if (isExpanded) {
        state.expandedProjectId = '';
        localStorage.removeItem('codex-expanded-project');
        renderThreads(state.threads, $('#threadSearch').value.trim());
      } else selectProject(project.id);
    });
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'project-item' + (project.id === state.selectedProjectId ? ' active' : '');
    button.title = project.cwd;
    if (projectColor(project)) button.style.setProperty('--project-color', projectColor(project));
    button.innerHTML = '<span class="icon" data-icon="folder"></span>';
    const label = document.createElement('span');
    label.className = 'project-item-label';
    label.textContent = project.name;
    const count = document.createElement('span');
    count.className = 'project-count';
    count.textContent = String(state.threads.filter((thread) => threadBelongsToProject(thread, project)).length);
    button.append(label, count);
    button.addEventListener('click', () => selectProject(project.id));
    const colorButton = document.createElement('button');
    colorButton.type = 'button';
    colorButton.className = `project-color-trigger${projectColor(project) ? ' has-color' : ''}`;
    colorButton.setAttribute('aria-label', `Escolher cor das conversas de ${project.name}`);
    colorButton.title = 'Escolher cor das conversas deste projeto';
    const colorSwatch = document.createElement('span');
    colorSwatch.className = `project-color-swatch${projectColor(project) ? '' : ' default'}`;
    if (projectColor(project)) colorSwatch.style.setProperty('--project-color', projectColor(project));
    colorButton.append(colorSwatch);
    colorButton.addEventListener('click', () => openProjectColorMenu(project, colorButton));
    row.append(toggle, button, colorButton);
    node.append(row);

    const children = document.createElement('div');
    children.className = 'project-tree-children';
    children.hidden = !isExpanded;
    if (isExpanded) {
      const allProjectThreads = state.threads.filter((thread) => threadBelongsToProject(thread, project));
      const projectThreads = allProjectThreads.filter((thread) => thread.section?.id !== PINNED_THREAD_SECTION_ID);
      if (!projectThreads.length) {
        const empty = document.createElement('div');
        empty.className = 'project-tree-empty';
        empty.textContent = allProjectThreads.length ? 'As conversas fixadas aparecem na lista abaixo.' : 'Este projeto ainda não tem conversas.';
        children.append(empty);
      } else {
        const groupHeading = document.createElement('div');
        groupHeading.className = 'thread-group-heading project-tree-group-heading';
        groupHeading.textContent = 'Recentes';
        children.append(groupHeading);
        projectThreads.forEach((thread) => {
          children.append(createThreadRow(thread, { nested: true }));
        });
      }
    }
    node.append(children);
    list.append(node);
  });
  installIcons();
  renderConversationContext();
}

export function selectProject(id, { folderPath = null, updateActiveThread = false } = {}) {
  const project = state.projects.find((item) => item.id === id) || null;
  state.selectedProjectId = project?.id || '';
  if (state.selectedProjectId) localStorage.setItem('codex-project', state.selectedProjectId);
  else {
    localStorage.removeItem('codex-project');
    state.expandedProjectId = '';
    localStorage.removeItem('codex-expanded-project');
  }
  if (project) {
    state.expandedProjectId = project.id;
    localStorage.setItem('codex-expanded-project', project.id);
  }
  if (folderPath) updateWorkingDirectory(folderPath);
  else if (!state.selectedThreadId) updateWorkingDirectory(project?.cwd || state.defaultCwd || state.cwd);
  if (updateActiveThread && state.selectedThreadId) state.activeThreadProjectId = project?.id || '';
  renderConversationContext();
  renderThreads(state.threads, $('#threadSearch').value.trim());
}

function projectSlug(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63) || 'novo-projeto';
}

export function updateProjectDirectoryField() {
  const createDirectory = $('#projectCreateDirectory').checked;
  const path = $('#projectPath');
  path.readOnly = createDirectory;
  $('#projectDialogCopy').textContent = createDirectory
    ? 'A pasta será criada dentro da área de projetos da VPS. O Codex começará uma conversa já vinculada a ela.'
    : 'Converse com o Codex dentro de uma pasta existente. As conversas iniciadas nela aparecem agrupadas no projeto.';
  $('#projectsRootLabel').textContent = state.projectsRoot || `${state.defaultCwd}/projects`;
  if (createDirectory) {
    const name = $('#projectName').value.trim();
    path.value = `${state.projectsRoot || `${state.defaultCwd}/projects`}/${projectSlug(name)}`;
  }
}

export function openProjectDialog(createDirectory = false) {
  $('#projectForm').reset();
  $('#projectName').value = '';
  $('#projectCreateDirectory').checked = createDirectory;
  $('#projectPath').value = createDirectory ? '' : state.cwd;
  updateProjectDirectoryField();
  $('#projectDialog').showModal();
  $('#projectName').focus();
}

export async function createProject(event) {
  event.preventDefault();
  const name = $('#projectName').value.trim();
  const cwd = $('#projectPath').value.trim();
  const createDirectory = $('#projectCreateDirectory').checked;
  try {
    const data = await api('/api/projects', { method: 'POST', body: JSON.stringify({ name, cwd, createDirectory }) });
    state.projects = data.projects || [];
    $('#projectDialog').close();
    $('#projectForm').reset();
    selectProject(data.project.id);
    if (createDirectory) newChat();
    toast('Projeto criado.');
  } catch (error) {
    toast(error.message, 'error');
  }
}
