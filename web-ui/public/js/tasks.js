// Continuous tasks: list, creation, live detail and the "continue elsewhere" action.
import { hasAlternativeAccount } from './accounts.js';
import { api } from './api.js';
import { $, debounce, escapeHtml, installIcons, toast } from './dom.js';
import { formatCountdown } from './format.js';
import { state } from './state.js';

const STATUS = {
  queued: 'Na fila', running: 'Executando', waiting: 'Aguardando conta', completed: 'Concluída',
  failed: 'Falhou', blocked: 'Precisa de você', stopped: 'Parada',
};
const OUTCOME = { completed: 'concluiu a etapa', 'rate-limited': 'limite atingido', failed: 'falhou', stopped: 'interrompida' };
const ACTIVE = new Set(['queued', 'running', 'waiting']);
const MAX_LOG_ROWS = 300;

export async function refreshTasks() {
  const data = await api('/api/tasks');
  state.tasks = data.tasks || [];
  renderTasks();
}

function taskLine(task) {
  if (task.status === 'running') return `${escapeHtml(task.currentAccountLabel || 'Conta')} · etapa ${task.segmentCount}`;
  if (task.status === 'waiting') return task.nextAttemptAt ? `Próxima tentativa ${formatCountdown(task.nextAttemptAt / 1000)}` : 'Esperando uma conta liberar';
  if (task.error && task.status === 'failed') return escapeHtml(task.error.slice(0, 120));
  return `${task.segmentCount} ${task.segmentCount === 1 ? 'etapa' : 'etapas'}${task.note ? ` · ${escapeHtml(task.note.slice(0, 90))}` : ''}`;
}

export function renderTasks() {
  const list = $('#taskList');
  if (!list) return;
  if (!state.tasks.length) {
    list.innerHTML = '<p class="muted-note">Uma execução contínua passa de conta em conta quando o limite de uso acaba, usando o registro de retomada em <code>.harness/HANDOFF.md</code>.</p>';
    return;
  }
  list.innerHTML = state.tasks.slice(0, 12).map((task) => `<button type="button" class="task-row status-${escapeHtml(task.status)}" data-task-id="${escapeHtml(task.id)}">
    <span class="task-row-title"><strong>${escapeHtml(task.title)}</strong><span class="task-chip">${STATUS[task.status] || escapeHtml(task.status)}</span></span>
    <small>${taskLine(task)}</small>
  </button>`).join('');
}

function logRow(event) {
  const time = new Date(event.at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  const text = {
    'segment-start': () => `Etapa ${event.segment} começou em ${event.accountLabel || 'uma conta'}${event.mode === 'handoff' ? ' (retomada)' : event.mode === 'nudge' ? ' (continuação)' : ''}`,
    'segment-end': () => `Etapa ${event.segment}: ${OUTCOME[event.outcome] || event.outcome}${event.error ? ` — ${event.error}` : ''}`,
    'rate-limit': () => `Limite de uso atingido${event.resetsAt ? ` · libera ${formatCountdown(event.resetsAt)}` : ''}`,
    usage: () => `Uso da conta em ${Math.round(event.percent)}%`,
    tool: () => `${event.name}: ${event.detail || ''}`,
    text: () => event.text,
    result: () => (event.ok ? 'Resposta final recebida' : `Terminou com erro${event.text ? `: ${event.text}` : ''}`),
    error: () => `Erro: ${event.message}`,
  }[event.type]?.() || event.type;
  const li = document.createElement('li');
  li.className = `task-log-${event.type}`;
  const stamp = document.createElement('time');
  stamp.textContent = time;
  const body = document.createElement('span');
  body.textContent = String(text).slice(0, 2000);
  li.append(stamp, body);
  return li;
}

function renderTaskDetail(task) {
  $('#taskDetailTitle').textContent = task.title;
  $('#taskDetailStatus').textContent = (STATUS[task.status] || task.status).toUpperCase();
  $('#taskDetailCwd').textContent = task.cwd;
  const waiting = task.status === 'waiting' && task.nextAttemptAt ? ` Próxima tentativa ${formatCountdown(task.nextAttemptAt / 1000)}.` : '';
  $('#taskDetailNote').textContent = [task.note, task.error && task.status === 'failed' ? task.error : ''].filter(Boolean).join(' ') + waiting;
  $('#taskSegments').innerHTML = (task.segments || []).map((segment) => `<li class="segment-${escapeHtml(segment.outcome || 'running')}"><strong>${escapeHtml(segment.accountLabel)}</strong><span>${segment.outcome ? escapeHtml(OUTCOME[segment.outcome] || segment.outcome) : 'em andamento'}</span></li>`).join('') || '<li><span>Nenhuma etapa ainda.</span></li>';
  const log = $('#taskLog');
  log.replaceChildren(...(task.events || []).slice(-MAX_LOG_ROWS).map(logRow));
  log.scrollTop = log.scrollHeight;
  $('#taskHandoff').textContent = task.handoff || 'O registro ainda não foi criado.';
  const active = ACTIVE.has(task.status);
  $('#stopTask').hidden = !active;
  $('#resumeTask').hidden = active;
  $('#taskNoteField').hidden = active;
  $('#resumeTask').textContent = task.status === 'completed' ? 'Continuar com nova orientação' : 'Retomar';
}

export async function openTaskDetail(id) {
  state.openTaskId = id;
  const { task } = await api(`/api/tasks/${encodeURIComponent(id)}`);
  if (state.openTaskId !== id) return;
  renderTaskDetail(task);
  if (!$('#taskDetailDialog').open) $('#taskDetailDialog').showModal();
}

const refreshOpenTask = debounce(() => { if (state.openTaskId && $('#taskDetailDialog').open) openTaskDetail(state.openTaskId).catch(() => {}); }, 600);

export function onTaskUpdated(summary) {
  const index = state.tasks.findIndex((task) => task.id === summary.id);
  if (index >= 0) state.tasks[index] = summary; else state.tasks.unshift(summary);
  renderTasks();
  if (summary.id === state.openTaskId) refreshOpenTask();
}

export function onTaskEvent({ taskId, event }) {
  if (taskId !== state.openTaskId || !$('#taskDetailDialog').open) return;
  const log = $('#taskLog');
  const atBottom = log.scrollHeight - log.clientHeight - log.scrollTop < 40;
  log.append(logRow(event));
  while (log.children.length > MAX_LOG_ROWS) log.firstElementChild.remove();
  if (atBottom) log.scrollTop = log.scrollHeight;
}

/** Show "continue elsewhere" on the rate-limit notice when it can actually help. */
export function updateContinueElsewhere(visible) {
  $('#continueElsewhere')?.classList.toggle('hidden', !(visible && state.selectedThreadId && hasAlternativeAccount()));
}

async function continueElsewhere() {
  const threadId = state.selectedThreadId;
  if (!threadId) return;
  const button = $('#continueElsewhere');
  button.disabled = true;
  try {
    const { task } = await api('/api/tasks', { method: 'POST', body: JSON.stringify({ fromThreadId: threadId }) });
    toast('Continuando em outra conta. Acompanhe em Execuções contínuas.');
    await openTaskDetail(task.id);
  } catch (error) { toast(error.message, 'error'); }
  finally { button.disabled = false; }
}

function openNewTask() {
  $('#taskGoal').value = '';
  $('#taskCwd').value = state.cwd || state.defaultCwd || '';
  $('#taskDialog').showModal();
  $('#taskGoal').focus();
}

async function submitTask(event) {
  event.preventDefault();
  const button = $('#submitTask');
  button.disabled = true;
  try {
    const { task } = await api('/api/tasks', { method: 'POST', body: JSON.stringify({ goal: $('#taskGoal').value, cwd: $('#taskCwd').value.trim() }) });
    $('#taskDialog').close();
    onTaskUpdated(task);
    await openTaskDetail(task.id);
  } catch (error) { toast(error.message, 'error'); }
  finally { button.disabled = false; }
}

async function taskCommand(action) {
  const id = state.openTaskId;
  if (!id) return;
  try {
    const body = action === 'resume' ? JSON.stringify({ note: $('#taskResumeNote').value.trim() }) : '{}';
    const { task } = await api(`/api/tasks/${encodeURIComponent(id)}/${action}`, { method: 'POST', body });
    $('#taskResumeNote').value = '';
    onTaskUpdated(task);
    await openTaskDetail(id);
  } catch (error) { toast(error.message, 'error'); }
}

export function bindTaskEvents() {
  $('#newTask').addEventListener('click', openNewTask);
  $('#cancelTask').addEventListener('click', () => $('#taskDialog').close());
  $('#taskForm').addEventListener('submit', submitTask);
  $('#taskList').addEventListener('click', (event) => {
    const row = event.target.closest('[data-task-id]');
    if (row) openTaskDetail(row.dataset.taskId).catch((error) => toast(error.message, 'error'));
  });
  $('#closeTaskDetail').addEventListener('click', () => $('#taskDetailDialog').close());
  $('#taskDetailDialog').addEventListener('close', () => { state.openTaskId = ''; });
  $('#stopTask').addEventListener('click', () => taskCommand('stop'));
  $('#resumeTask').addEventListener('click', () => taskCommand('resume'));
  $('#continueElsewhere').addEventListener('click', continueElsewhere);
  installIcons($('.tasks-card'));
  installIcons($('#taskDetailDialog'));
}
