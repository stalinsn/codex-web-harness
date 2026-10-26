// Entry point: bootstraps data, binds UI events and starts authentication.
import { bindAccountEvents, refreshAccounts } from './accounts.js';
import { api } from './api.js';
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
import { populateModels, setChatAccount, updateEfforts } from './models.js';
import { createProject, openProjectDialog, pathIsWithin, renderProjects, selectProject, updateProjectDirectoryField, updateWorkingDirectory } from './projects.js';
import { clearResolvedRateLimitFailure } from './rate-limit.js';
import { enhanceComposerSelects } from './custom-selects.js';
import { prepareCompletionSound } from './sound.js';
import { state, voice } from './state.js';
import { bindTaskEvents, refreshTasks } from './tasks.js';
import { closeThreadMenus, refreshThreadList, renderThreads } from './thread-list.js';
import { clearRecordedAudio, prepareVoicePreview, renderVoice, startVoiceRecording, touchComposer, transcribeRecordedAudio, voiceTime } from './voice.js';
import { bindWizardEvents } from './wizard.js';

export async function bootstrap() {
  try {
    const data = await api('/api/bootstrap');
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
    await loadDeferredQueue().catch((error) => toast(error.message, 'error'));
    populateModels(); renderUsage(); renderProjects(); renderThreads(); setConnection(true, 'Codex conectado');
    refreshAccounts().catch(() => {});
    refreshTasks().catch(() => {});
    if ($('#planBadge') && data.account?.planType) $('#planBadge').textContent = String(data.account.planType).replace(/^./, (char) => char.toUpperCase());
    const threadId = new URLSearchParams(location.hash.slice(1)).get('thread');
    if (threadId) await openThread(threadId);
    if (state.deferredQueueItems.length) maybeDrainDeferredQueue().catch(() => {});
  } catch (error) {
    setConnection(false, 'Codex indisponível');
    toast(error.message, 'error');
  }
}

export function bindEvents() {
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
  $('#composerForm').addEventListener('submit', submitMessage);
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
  $('#modelSelect').addEventListener('change', () => { state.modelId = $('#modelSelect').value; localStorage.setItem('codex-model', state.modelId); updateEfforts(); localStorage.setItem('codex-effort', state.effort); updateComposerControls(); });
  $('#accountSelect').addEventListener('change', () => { setChatAccount($('#accountSelect').value); updateComposerControls(); });
  $('#effortSelect').addEventListener('change', () => { state.effort = $('#effortSelect').value; localStorage.setItem('codex-effort', state.effort); });
  $('#cwdControl').addEventListener('click', () => { $('#cwdInput').value = state.cwd; $('#pathDialog').showModal(); });
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
  $('#attachImage').addEventListener('click', () => $('#imageInput').click());
  $('#imageInput').addEventListener('change', async (event) => { await addFiles(event.target.files); event.target.value = ''; });
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
  $('#threadList').addEventListener('scroll', closeThreadMenus, { passive: true });
  window.addEventListener('resize', closeThreadMenus);
  $('#threadSearch').addEventListener('input', debounce(() => refreshThreadList($('#threadSearch').value.trim()).catch((error) => toast(error.message, 'error')), 250));
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
    if (event.key === 'Escape') { closeSidebar(); showInspector(false); }
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
