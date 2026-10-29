// Entry point: bootstraps data, binds UI events and starts authentication.
import { bindAccountEvents, refreshAccounts } from './accounts.js';
import { api } from './api.js';
import { bindAttachmentEvents } from './attachments.js';
import { initializeAuthentication } from './auth.js';
import { addFiles, steerMessage, submitMessage, updateComposerControls } from './composer.js';
import { PREFIX } from './config.js';
import { newChat, openThread } from './conversation.js';
import { loadDeferredQueue, maybeDrainDeferredQueue } from './deferred-queue.js';
import { $, $$, debounce, randomKey, toast } from './dom.js';
import { bindInspectorLayout } from './inspector-layout.js';
import { refreshUsage, refreshVpsHealth, renderUsage } from './inspector.js';
import { closeSidebar, openSidebar, setConnection, setupComposerViewport, setupInspectorResize, showInspector } from './layout.js';
import { scrollConversation } from './messages.js';
import { populateModels, setChatAccount, setComposerEffort, setComposerModel } from './models.js';
import { createProject, openProjectDialog, pathIsWithin, renderProjects, selectProject, syncLabelColors, updateProjectDirectoryField, updateWorkingDirectory } from './projects.js';
import { clearResolvedRateLimitFailure } from './rate-limit.js';
import { enhanceComposerSelects } from './custom-selects.js';
import { prepareCompletionSound } from './sound.js';
import { state, voice } from './state.js';
import { bindTaskEvents, refreshTasks } from './tasks.js';
import { closeThreadMenus, refreshThreadList, renderThreads } from './thread-list.js';
import { clearRecordedAudio, prepareVoicePreview, renderVoice, startVoiceRecording, touchComposer, transcribeRecordedAudio, voiceTime } from './voice.js';
import { bindWizardEvents } from './wizard.js';

function closeComposerOptions() {
  const options = $('#composerOptions');
  const toggle = $('#composerOptionsToggle');
  if (!options || !toggle) return;
  options.open = false;
  toggle.classList.remove('is-open');
  toggle.setAttribute('aria-expanded', 'false');
}

function positionComposerOptions() {
  const options = $('#composerOptions');
  const panel = $('#composerOptionsPanel');
  const toggle = $('#composerOptionsToggle');
  if (!options?.open || !panel || !toggle) return;
  const anchor = toggle.getBoundingClientRect();
  const visible = window.visualViewport;
  const viewportLeft = visible?.offsetLeft || 0;
  const viewportTop = visible?.offsetTop || 0;
  const viewportWidth = visible?.width || document.documentElement.clientWidth || window.innerWidth;
  const viewportHeight = visible?.height || document.documentElement.clientHeight || window.innerHeight;
  if (window.innerWidth <= 680) {
    const layoutBottom = window.innerHeight;
    const visibleBottom = viewportTop + viewportHeight;
    const keyboardInset = Math.max(0, layoutBottom - visibleBottom);
    const width = Math.max(1, Math.min(460, viewportWidth - 24));
    panel.style.width = `${width}px`;
    panel.style.left = `${Math.max(viewportLeft + 12, viewportLeft + (viewportWidth - width) / 2)}px`;
    panel.style.right = 'auto';
    panel.style.top = 'auto';
    panel.style.bottom = `${keyboardInset + 12}px`;
    panel.style.maxHeight = `${Math.max(120, Math.min(470, viewportHeight - 24))}px`;
    return;
  }
  const width = Math.min(window.innerWidth <= 680 ? 460 : 470, viewportWidth - 24);
  panel.style.width = `${width}px`;
  panel.style.maxHeight = `${Math.max(120, Math.min(520, viewportHeight * .66, viewportHeight - 24))}px`;
  const left = Math.max(viewportLeft + 12, Math.min(anchor.right - width, viewportLeft + viewportWidth - width - 12));
  const height = panel.getBoundingClientRect().height;
  const minTop = viewportTop + 12;
  const maxTop = Math.max(minTop, viewportTop + viewportHeight - height - 12);
  const above = anchor.top - height - 8;
  const below = anchor.bottom + 8;
  const preferredTop = above >= minTop ? above : below;
  const top = Math.max(minTop, Math.min(preferredTop, maxTop));
  panel.style.left = `${left}px`;
  panel.style.right = 'auto';
  panel.style.top = `${top}px`;
  panel.style.bottom = 'auto';
}

export async function bootstrap() {
  try {
    const data = await loadBootstrap();
    state.models = data.models || [];
    state.account = data.account;
    state.rateLimits = data.rateLimits;
    state.usage = data.usage;
    clearResolvedRateLimitFailure();
    state.threads = data.threads || [];
    state.activeThreadIds = new Set(state.threads.filter((thread) => thread.status?.type === 'active').map((thread) => thread.id));
    state.projects = data.projects || [];
    state.defaultCwd = data.defaultCwd || '/';
    state.projectsRoot = data.projectsRoot || `${state.defaultCwd}/projects`;
    if (!state.projects.some((project) => project.id === state.selectedProjectId)) state.selectedProjectId = '';
    if (state.expandedProjectId && !state.projects.some((project) => project.id === state.expandedProjectId)) state.expandedProjectId = '';
    if (state.selectedProjectId && !state.expandedProjectId) {
      state.expandedProjectId = state.selectedProjectId;
      localStorage.setItem('codex-expanded-project', state.expandedProjectId);
    }
    const startupProject = state.projects.find((project) => project.id === state.selectedProjectId);
    if (startupProject) updateWorkingDirectory(startupProject.cwd);
    else if (!state.cwd) updateWorkingDirectory(state.defaultCwd);
    (data.pending || []).forEach((request) => state.pendingApprovals.set(String(request.id), request));
    populateModels(); renderUsage(); renderProjects(); renderThreads(); setConnection(true, 'Codex conectado');
    syncLabelColors().catch((error) => toast(`Não foi possível sincronizar as cores das etiquetas com a VPS: ${error.message}`, 'error'));
    loadDeferredQueue().then(() => {
      if (state.deferredQueueItems.length) maybeDrainDeferredQueue().catch(() => {});
    }).catch((error) => toast(error.message, 'error'));
    setTimeout(() => refreshVpsHealth(), 1500);
    refreshAccounts().catch(() => {});
    refreshTasks().catch(() => {});
    if ($('#planBadge') && data.account?.planType) $('#planBadge').textContent = String(data.account.planType).replace(/^./, (char) => char.toUpperCase());
    const threadId = new URLSearchParams(location.hash.slice(1)).get('thread');
    if (threadId) openThread(threadId);
  } catch (error) {
    setConnection(false, 'Codex indisponível');
    toast(error.message, 'error');
  }
}

async function loadBootstrap() {
  const retryDelays = [250, 500, 1000, 1800, 3000, 5000, 5000, 5000];
  for (let attempt = 0; ; attempt += 1) {
    try { return await api('/api/bootstrap'); }
    catch (error) {
      if (error.status !== 503 || attempt >= retryDelays.length) throw error;
      setConnection(false, 'Codex iniciando…');
      await new Promise((resolvePromise) => setTimeout(resolvePromise, retryDelays[attempt]));
    }
  }
}

export function bindEvents() {
  bindAttachmentEvents();
  enhanceComposerSelects();
  bindAccountEvents();
  bindTaskEvents();
  bindWizardEvents();
  bindInspectorLayout();
  setupInspectorResize();
  setupComposerViewport();
  $('#closeImagePreview').addEventListener('click', () => $('#imagePreviewDialog').close());
  $('#imagePreviewDialog').addEventListener('click', (event) => {
    if (event.target === $('#imagePreviewDialog')) $('#imagePreviewDialog').close();
  });
  $('#messages').addEventListener('scroll', () => {
    const area = $('#messages');
    state.followLatest = area.scrollHeight - area.clientHeight - area.scrollTop < 80;
    $('#scrollToLatest').classList.toggle('hidden', state.followLatest);
  }, { passive: true });
  $('#scrollToLatest').addEventListener('click', () => scrollConversation(true));
  $('#newChat').addEventListener('click', newChat);
  $('#logoutButton').addEventListener('click', async () => {
    const button = $('#logoutButton'); button.disabled = true;
    try { await api('/api/auth/logout', { method: 'POST', body: '{}' }); location.reload(); }
    catch (error) { button.disabled = false; toast(error.message, 'error'); }
  });
  $('#composerForm').addEventListener('submit', (event) => { closeComposerOptions(); submitMessage(event); });
  $('#composerOptions').addEventListener('toggle', () => {
    const options = $('#composerOptions');
    const toggle = $('#composerOptionsToggle');
    toggle.classList.toggle('is-open', options.open);
    toggle.setAttribute('aria-expanded', String(options.open));
    if (options.open) requestAnimationFrame(positionComposerOptions);
  });
  document.addEventListener('pointerdown', (event) => {
    const options = $('#composerOptions');
    if (options.open && !options.contains(event.target)) closeComposerOptions();
  }, true);
  $('#accessModeSelect').addEventListener('change', async (event) => {
    const mode = event.target.value;
    if (!['manual', 'automatic'].includes(mode) || mode === state.accessMode) return;
    const threadId = state.selectedThreadId;
    state.accessModeUpdating = true;
    state.accessModeUpdatingThreadId = threadId || '';
    updateComposerControls();
    try {
      const result = threadId
        ? await api(`/api/threads/${encodeURIComponent(threadId)}/access-mode`, { method: 'POST', body: JSON.stringify({ mode }) })
        : { mode, active: false };
      state.defaultAccessMode = result.mode;
      localStorage.setItem('codex-access-mode', result.mode);
      if (state.selectedThreadId === threadId || !state.selectedThreadId) state.accessMode = result.mode;
      toast(result.active
        ? result.mode === 'automatic' ? 'Automático ativado. Aprovações de comandos pendentes serão liberadas; acesso completo no próximo turno.' : 'Aprovações manuais ativadas para os próximos pedidos. O turno atual conserva suas permissões.'
        : result.mode === 'automatic' ? 'Desenvolvimento automático ativado para esta conversa.' : 'Aprovações manuais ativadas para esta conversa.');
    } catch (error) { toast(error.message || 'Não consegui alterar o modo de desenvolvimento.', 'error'); }
    finally {
      state.accessModeUpdating = false;
      state.accessModeUpdatingThreadId = '';
      updateComposerControls();
    }
  });
  $('#voiceInput').addEventListener('click', startVoiceRecording);
  $('#discardAudio').addEventListener('click', clearRecordedAudio);
  $('#transcribeAudio').addEventListener('click', () => transcribeRecordedAudio());
  $('#voicePlayer').addEventListener('error', () => { if (voice.blob) renderVoice('A prévia não é compatível com este navegador. Você ainda pode enviar o arquivo ou tentar transcrevê-lo.'); });
  $('#audioInput').addEventListener('change', (event) => {
    const file = event.target.files?.[0]; event.target.value = '';
    if (!file || voice.phase !== 'idle') return;
    const extension = file.name.split('.').pop().toLowerCase();
    const types = { m4a: 'audio/mp4', mp3: 'audio/mpeg', wav: 'audio/wav', webm: 'audio/webm', ogg: 'audio/ogg', aac: 'audio/aac' };
    if (!types[extension] && !file.type.startsWith('audio/')) { toast('Escolha um arquivo de áudio.', 'error'); return; }
    voice.cancelled = false; voice.generation += 1;
    prepareVoicePreview(new Blob([file], { type: types[extension] || file.type }));
  });
  $('#voicePlayer').addEventListener('loadedmetadata', () => { const duration = $('#voicePlayer').duration; if (Number.isFinite(duration)) { voice.seconds = Math.round(duration); $('#voiceTimer').textContent = voiceTime(voice.seconds); } });
  $('#messageInput').addEventListener('input', (event) => { event.target.style.height = 'auto'; event.target.style.height = `${Math.min(event.target.scrollHeight, 180)}px`; updateComposerControls(); });
  $('#messageInput').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && (!touchComposer() || event.ctrlKey || event.metaKey)) { event.preventDefault(); submitMessage(event); }
  });
  $('#messageInput').addEventListener('paste', async (event) => {
    let files = [...(event.clipboardData?.items || [])]
      .filter((item) => item.kind === 'file')
      .map((item) => item.getAsFile()).filter(Boolean);
    if (!files.length) files = [...(event.clipboardData?.files || [])];
    if (!files.length) return;
    event.preventDefault();
    const text = event.clipboardData?.getData('text/plain');
    if (text) {
      const input = event.currentTarget;
      input.setRangeText(text, input.selectionStart, input.selectionEnd, 'end');
      input.dispatchEvent(new Event('input'));
    }
    await addFiles(files);
  });
  $('#steerButton').addEventListener('click', steerMessage);
  $('#modelSelect').addEventListener('change', () => setComposerModel($('#modelSelect').value));
  $('#accountSelect').addEventListener('change', () => { setChatAccount($('#accountSelect').value); updateComposerControls(); });
  $('#effortSelect').addEventListener('change', () => setComposerEffort($('#effortSelect').value));
  $('#cwdControl').addEventListener('click', () => { closeComposerOptions(); $('#cwdInput').value = state.cwd; $('#pathDialog').showModal(); });
  $('#pathForm').addEventListener('submit', (event) => {
    if (event.submitter?.value === 'cancel') return;
    event.preventDefault();
    const next = $('#cwdInput').value.trim();
    if (!next.startsWith('/')) return toast('Informe um caminho absoluto da VPS.', 'error');
    updateWorkingDirectory(next);
    const project = state.projects.find((item) => pathIsWithin(next, item.cwd));
    selectProject(project?.id || '', { folderPath: next, updateActiveThread: true });
    $('#pathDialog').close();
  });
  $$('.quick-paths button').forEach((button) => button.addEventListener('click', () => { $('#cwdInput').value = button.dataset.path; }));
  $('#refreshThreads').addEventListener('click', () => refreshThreadList($('#threadSearch').value.trim()).catch((error) => toast(error.message, 'error')));
  $('#toggleArchived').addEventListener('click', async () => {
    if (state.archivedView) return;
    state.archivedView = true;
    try { await refreshThreadList($('#threadSearch').value.trim()); }
    catch (error) { state.archivedView = false; renderThreads(state.threads); toast(error.message, 'error'); }
  });
  $('#showRecentThreads').addEventListener('click', async () => {
    if (!state.archivedView) return;
    state.archivedView = false;
    try { await refreshThreadList(); }
    catch (error) { state.archivedView = true; renderThreads(state.threads); toast(error.message, 'error'); }
  });
  $('#clearThreadSearch').addEventListener('click', () => {
    $('#threadSearch').value = ''; $('#threadSearch').focus();
    refreshThreadList('').catch((error) => toast(error.message, 'error'));
  });
  $('#threadSearchScope').addEventListener('change', () => renderThreads());
  $('#sidebarNavigation').addEventListener('scroll', closeThreadMenus, { passive: true });
  window.addEventListener('resize', () => {
    closeThreadMenus();
    if ($('#composerOptions').open) requestAnimationFrame(positionComposerOptions);
  });
  window.visualViewport?.addEventListener('resize', () => {
    if ($('#composerOptions').open) requestAnimationFrame(positionComposerOptions);
  });
  window.visualViewport?.addEventListener('scroll', () => {
    if ($('#composerOptions').open) requestAnimationFrame(positionComposerOptions);
  }, { passive: true });
  $('#threadSearch').addEventListener('input', debounce(() => refreshThreadList($('#threadSearch').value.trim()).catch((error) => toast(error.message, 'error')), 250));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') syncLabelColors().catch(() => {});
  });
  $('#refreshUsage').addEventListener('click', () => refreshUsage(true).then(() => toast('Uso atualizado.')).catch((error) => toast(error.message, 'error')));
  $('#refreshVpsHealth').addEventListener('click', () => refreshVpsHealth(true));
  $('#toggleUsage').addEventListener('click', () => showInspector(true));
  $('#closeUsage').addEventListener('click', () => showInspector(false));
  $('#openSidebar').addEventListener('click', openSidebar);
  $('#closeSidebar').addEventListener('click', closeSidebar);
  $('#addProject').addEventListener('click', () => openProjectDialog(false));
  $('#newProjectChat').addEventListener('click', () => openProjectDialog(true));
  $('#chatContextSelect').addEventListener('change', () => selectProject($('#chatContextSelect').value));
  $('#projectName').addEventListener('input', updateProjectDirectoryField);
  $('#projectCreateDirectory').addEventListener('change', updateProjectDirectoryField);
  $('#cancelProject').addEventListener('click', () => $('#projectDialog').close());
  $('#projectForm').addEventListener('submit', createProject);
  window.addEventListener('hashchange', () => {
    const threadId = new URLSearchParams(location.hash.slice(1)).get('thread');
    if (threadId && threadId !== state.selectedThreadId) openThread(threadId);
    else if (!threadId && state.selectedThreadId) newChat();
  });
  $('#mobileScrim').addEventListener('click', () => { closeSidebar(); showInspector(false); });
  $('#stopTurn').addEventListener('click', async () => {
    if (!state.selectedThreadId || state.interrupting) return;
    const threadId = state.selectedThreadId;
    state.interrupting = true; updateComposerControls();
    try {
      const result = await api(`/api/threads/${encodeURIComponent(threadId)}/interrupt`, { method: 'POST', body: '{}' });
      if (!result.interrupted) toast('A execução já terminou.');
    } catch (error) { toast(error.message, 'error'); }
    finally { state.interrupting = false; updateComposerControls(); }
  });
  $$('.suggestion').forEach((button) => button.addEventListener('click', () => { $('#messageInput').value = button.dataset.prompt; $('#messageInput').focus(); $('#messageInput').dispatchEvent(new Event('input')); }));
  document.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); newChat(); }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') { event.preventDefault(); openSidebar(); $('#threadSearch').focus(); }
    if (event.key === 'Escape') { closeComposerOptions(); closeSidebar(); showInspector(false); }
  });
  $('#cwdLabel').textContent = state.cwd; $('#inspectorCwd').textContent = state.cwd;
  updateComposerControls();
}

// Start-up (same order as the former classic script).
if (!state.draftQueueGroupId) {
  state.draftQueueGroupId = randomKey();
  localStorage.setItem('codex-draft-queue-group', state.draftQueueGroupId);
}

document.addEventListener('pointerdown', prepareCompletionSound, { capture: true });
document.addEventListener('keydown', prepareCompletionSound, { capture: true });

initializeAuthentication();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register(`${PREFIX}/service-worker.js`).catch(() => {});
}
