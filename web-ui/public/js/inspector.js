// Usage, context window and VPS health panels.
import { api } from './api.js';
import { maybeDrainDeferredQueue } from './deferred-queue.js';
import { $, escapeHtml } from './dom.js';
import { formatBytes, formatCountdown, formatDuration, formatNumber, formatReset } from './format.js';
import { renderInspectorSummary, setCardSummary } from './inspector-layout.js';
import { renderConversationContext, threadDisplayTitle } from './projects.js';
import { renderQueue } from './queue.js';
import { clearResolvedRateLimitFailure, getEffectiveRateLimitBlock, renderRateLimitNotice, updateResetCountdowns } from './rate-limit.js';
import { renderErrorHistory } from './error-history.js';
import { runtime, state } from './state.js';
import { renderThreads } from './thread-list.js';

export function renderUsage() {
  renderInspectorSummary();
  const meters = $('#rateLimitMeters');
  const data = state.rateLimits;
  const buckets = data ? (Array.isArray(data) ? data : Object.values(data)) : [];
  if (!buckets.length) {
    meters.innerHTML = '<div class="meter-heading"><span>Limites da conta</span><span>indisponíveis</span></div>';
  } else {
    meters.innerHTML = buckets.map((bucket, index) => {
      const primaries = [bucket.primary, bucket.secondary].filter(Boolean);
      return primaries.map((window, windowIndex) => {
        const used = Math.min(100, Math.max(0, Number(window.usedPercent) || 0));
        const label = bucket.limitName || (index === 0 ? 'Codex' : bucket.limitId || 'Outro limite');
        const windowLabel = windowIndex === 0 ? 'janela curta' : 'janela longa';
        const reset = formatReset(window.resetsAt);
        const resetAt = Number(window.resetsAt);
        const countdown = Number.isFinite(resetAt) && resetAt > 0 ? `<strong class="meter-countdown" data-reset-at="${Math.floor(resetAt)}">${formatCountdown(resetAt)}</strong>` : '';
        return `<div class="meter"><div class="meter-heading"><span>${escapeHtml(label)} · ${windowLabel}</span><span>${Math.round(used)}% usado</span></div><div class="meter-track"><div class="meter-fill ${used >= 90 ? 'critical' : used >= 75 ? 'high' : ''}" style="width:${used}%"></div></div><div class="meter-reset-row"><span class="meter-reset">${escapeHtml(reset)}</span>${countdown}</div></div>`;
      }).join('');
    }).join('');
  }
  const summary = state.usage?.summary || {};
  const daily = state.usage?.dailyUsageBuckets;
  const recent = Array.isArray(daily) && daily.length ? daily[daily.length - 1].tokens : null;
  const metrics = [
    { label: 'Tokens acumulados', value: summary.lifetimeTokens, format: formatNumber },
    { label: 'Último dia disponível', value: recent, format: formatNumber },
    { label: 'Maior uso diário', value: summary.peakDailyTokens, format: formatNumber },
    { label: 'Sequência atual', value: summary.currentStreakDays, format: (value) => `${formatNumber(value)} ${Number(value) === 1 ? 'dia' : 'dias'}` },
    { label: 'Maior sequência', value: summary.longestStreakDays, format: (value) => `${formatNumber(value)} ${Number(value) === 1 ? 'dia' : 'dias'}` },
    { label: 'Turno mais longo', value: summary.longestRunningTurnSec, format: (value) => formatDuration(Number(value) * 1000) },
  ].filter((metric) => metric.value != null && Number.isFinite(Number(metric.value)));
  $('#tokenSummary').innerHTML = metrics.map((metric) => `<div class="token-stat"><strong>${escapeHtml(metric.format(metric.value))}</strong><span>${escapeHtml(metric.label)}</span></div>`).join('');
  updateResetCountdowns();
  renderRateLimitNotice();
  const plan = state.account?.planType;
  if (plan && $('#planBadge')) $('#planBadge').textContent = String(plan).replace(/^./, (char) => char.toUpperCase());
}

export function updateThreadHeader(thread) {
  state.selectedThread = thread || null;
  renderErrorHistory();
  const title = thread?.id ? threadDisplayTitle(thread) : 'Novo chat';
  $('#activeTitle').textContent = title;
  $('#threadInfo').classList.toggle('hidden', !thread?.id);
  if (thread?.id) {
    const updated = thread.updatedAt ? new Date(Number(thread.updatedAt) * (Number(thread.updatedAt) < 1e12 ? 1000 : 1)) : null;
    const status = thread.status?.type === 'active' ? 'Em execução' : 'Pronta para continuar';
    setCardSummary('thread', status);
    $('#threadMeta').innerHTML = `<div class="thread-meta-row"><span>Estado</span><strong id="threadExecutionState">${escapeHtml(status)}</strong></div><div class="thread-meta-row"><span>Modelo</span><strong>${escapeHtml(thread.model || thread.modelProvider || 'Codex')}</strong></div><div class="thread-meta-row"><span>Atualizada</span><strong>${updated && !Number.isNaN(updated.getTime()) ? escapeHtml(new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' }).format(updated)) : '—'}</strong></div>`;
    location.hash = `thread=${encodeURIComponent(thread.id)}`;
    renderContextUsage(state.contextUsage);
  } else {
    $('#threadMeta').replaceChildren();
    state.contextUsage = null;
    renderContextUsage(null);
    history.replaceState(null, '', location.pathname);
  }
  renderConversationContext();
  renderThreads(state.threads);
}

export function renderContextUsage(snapshot) {
  renderInspectorSummary();
  const root = $('#contextUsageMeter');
  if (!root) return;
  const usage = snapshot?.tokenUsage || snapshot || null;
  const used = Number(usage?.last?.totalTokens ?? usage?.last?.inputTokens ?? usage?.lastTokenUsage?.totalTokens);
  const capacity = Number(usage?.modelContextWindow ?? usage?.model_context_window);
  if (!state.selectedThreadId) {
    root.innerHTML = '<p class="muted-note">Abra uma conversa para ver o contexto usado e o limite do modelo.</p>';
    return;
  }
  if (!Number.isFinite(used) || !Number.isFinite(capacity) || capacity <= 0) {
    root.innerHTML = '<p class="muted-note">Aguardando a próxima leitura de tokens desta conversa.</p>';
    return;
  }
  const percent = Math.min(100, Math.max(0, used / capacity * 100));
  const remaining = Math.max(0, capacity - used);
  const tone = percent >= 90 ? 'critical' : percent >= 75 ? 'high' : '';
  const updated = snapshot?.updatedAt ? new Date(snapshot.updatedAt) : null;
  const updatedText = updated && !Number.isNaN(updated.getTime()) ? new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' }).format(updated) : '';
  root.innerHTML = `<div class="context-usage-heading"><strong>${escapeHtml(formatNumber(used))} usados</strong><span>${escapeHtml(formatNumber(capacity))} tokens</span></div><div class="meter-track context-usage-track"><div class="meter-fill ${tone}" style="width:${percent.toFixed(1)}%"></div></div><div class="context-usage-foot"><span>${percent.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}% · ${escapeHtml(formatNumber(remaining))} restantes</span><span>${updatedText ? `Atualizado ${escapeHtml(updatedText)}` : 'Último turno'}</span></div><p class="muted-note">Estimativa do último turno em relação à janela do modelo. A janela pode incluir instruções e ferramentas, não só o texto visível.</p>`;
}

export async function loadContextUsage(threadId) {
  state.contextUsage = null;
  renderContextUsage(null);
  if (!threadId) return;
  try {
    const data = await api(`/api/threads/${encodeURIComponent(threadId)}/context-usage`);
    if (state.selectedThreadId !== threadId) return;
    state.contextUsage = data.contextUsage || null;
    renderContextUsage(state.contextUsage);
  } catch { /* Live app-server notifications will update the meter when available. */ }
}

function renderVpsHealth(data) {
  const hostMetrics = $('#vpsHostMetrics');
  const projectList = $('#vpsProjectList');
  const storageList = $('#vpsStorageList');
  if (!data?.host) {
    hostMetrics.innerHTML = '<p class="vps-health-error">Métricas indisponíveis.</p>';
    projectList.innerHTML = data?.docker?.error ? `<p class="vps-health-error">${escapeHtml(data.docker.error)}</p>` : '';
    return;
  }

  const { host, docker } = data;
  const memoryPercent = host.memory.totalBytes ? Math.round((host.memory.usedBytes / host.memory.totalBytes) * 100) : 0;
  const diskPercent = host.disk?.usedPercent ?? 0;
  setCardSummary('health', `CPU ${Math.round(Number(host.cpu.percent) || 0)}% · RAM ${memoryPercent}% · Disco ${diskPercent}%`);
  const percentClass = (value) => value >= 90 ? 'critical' : value >= 75 ? 'high' : '';
  hostMetrics.innerHTML = `
    <div class="vps-metric"><div class="vps-metric-heading"><span>CPU</span><strong>${Number(host.cpu.percent).toFixed(1)}%</strong></div><div class="vps-meter"><i class="${percentClass(host.cpu.percent)}" style="width:${Math.min(100, host.cpu.percent)}%"></i></div><small>${host.cpu.cores} vCPU · carga ${Number(host.load1m).toFixed(2)}</small></div>
    <div class="vps-metric"><div class="vps-metric-heading"><span>Memória</span><strong>${escapeHtml(formatBytes(host.memory.availableBytes))} livres</strong></div><div class="vps-meter"><i class="${percentClass(memoryPercent)}" style="width:${memoryPercent}%"></i></div><small>${escapeHtml(formatBytes(host.memory.usedBytes))} / ${escapeHtml(formatBytes(host.memory.totalBytes))} · ${memoryPercent}% usado</small></div>
    <div class="vps-metric"><div class="vps-metric-heading"><span>Disco raiz</span><strong>${escapeHtml(formatBytes(host.disk?.availableBytes))} livres</strong></div><div class="vps-meter"><i class="${percentClass(diskPercent)}" style="width:${diskPercent}%"></i></div><small>${escapeHtml(formatBytes(host.disk?.usedBytes))} / ${escapeHtml(formatBytes(host.disk?.totalBytes))} · ${diskPercent}% usado</small></div>
    <div class="vps-metric vps-container-count"><div class="vps-metric-heading"><span>Containers</span><strong>${docker.runningCount} ativos</strong></div><small>${docker.stoppedCount} parados · amostra ao vivo</small></div>`;

  if (!docker.available) {
    projectList.innerHTML = `<p class="vps-health-error">${escapeHtml(docker.error || 'Docker indisponível.')}</p>`;
  } else {
    const projects = docker.projects || [];
    const hostServices = (host.services || []).map((service) => `<div class="vps-project-row host-service-row"><span class="vps-state-dot healthy"></span><span class="vps-project-name"><strong>${escapeHtml(service.name)}</strong><small>${escapeHtml(service.status)} · CPU ${Number(service.cpuPercent).toFixed(1)}%</small></span><span class="vps-project-memory">${escapeHtml(formatBytes(service.memoryBytes))}</span></div>`).join('');
    const projectRows = projects.map((project) => {
      const stateClass = project.unhealthy ? 'unhealthy' : project.stopped ? 'partial' : 'healthy';
      const stateText = project.unhealthy ? 'Com falha' : project.stopped ? `${project.running}/${project.containers} ativos` : 'Em execução';
      const children = (docker.containers || []).filter((container) => container.project === project.name).map((container) => `<div class="vps-container-row"><span>${escapeHtml(container.name)}</span><span>${container.running ? `${Number(container.cpuPercent).toFixed(1)}% CPU · ${escapeHtml(formatBytes(container.memoryBytes))} RAM` : escapeHtml(container.status)} · disco ${escapeHtml(formatBytes(container.storageBytes))}</span></div>`).join('');
      const projectPath = project.sourcePath ? `<div class="vps-storage-breakdown"><span>Código · ${escapeHtml(project.sourcePath)}</span><strong>${escapeHtml(formatBytes(project.sourceBytes))}</strong></div>` : '';
      const projectVolumes = (data.dockerVolumes || []).filter((volume) => volume.project === project.name).map((volume) => `<div class="vps-storage-breakdown"><span>Volume · ${escapeHtml(volume.name)}</span><strong>${escapeHtml(volume.size)}</strong></div>`).join('');
      return `<details class="vps-project-details"><summary class="vps-project-row"><span class="vps-state-dot ${stateClass}"></span><span class="vps-project-name"><strong>${escapeHtml(project.name)}</strong><small>${project.containers} ${project.containers === 1 ? 'container' : 'containers'} · CPU ${Number(project.cpuPercent).toFixed(1)}% · ${escapeHtml(stateText)}</small></span><span class="vps-project-resources"><strong>${escapeHtml(formatBytes(project.memoryBytes))}</strong><small>${escapeHtml(formatBytes(project.storageBytes))} disco</small></span></summary><div class="vps-container-list">${children}${projectPath}${projectVolumes}</div></details>`;
    }).join('');
    const stopped = (docker.containers || []).filter((container) => !container.running);
    const stoppedDetails = stopped.length ? `<details class="vps-stopped-details"><summary>${stopped.length} ${stopped.length === 1 ? 'container parado' : 'containers parados'}</summary><div>${stopped.map((container) => `<p><strong>${escapeHtml(container.name)}</strong><small>${escapeHtml(container.status)}</small></p>`).join('')}</div></details>` : '';
    projectList.innerHTML = `<div class="vps-project-heading"><span>INSTÂNCIA</span><span>MEMÓRIA / DISCO</span></div>${hostServices}${projectRows || '<p class="vps-health-muted">Nenhum container em execução.</p>'}${stoppedDetails}`;
  }

  const storageLabels = { Images: 'Imagens', Containers: 'Containers', 'Local Volumes': 'Volumes', 'Build Cache': 'Cache de build' };
  storageList.innerHTML = (data.dockerStorage || []).map((item) => `<div><span>${escapeHtml(storageLabels[item.type] || item.type)}</span><strong>${escapeHtml(item.size)}${item.reclaimable ? `<small>${escapeHtml(item.reclaimable)} reclamável</small>` : ''}</strong></div>`).join('') || '<small>Resumo Docker indisponível.</small>';
  $('#vpsVolumeStorage').innerHTML = (data.dockerVolumes || []).map((volume) => `<div><span>${escapeHtml(volume.name)}${volume.project ? `<small>${escapeHtml(volume.project)}</small>` : '<small>sem instância atribuída</small>'}</span><strong>${escapeHtml(volume.size)}</strong></div>`).join('') || '<small>Nenhum volume local.</small>';
  const storageLocations = [...(data.storageLocations || []), ...(data.projectDirectories || []).map((location) => ({ ...location, name: `Código · ${location.project}` }))];
  $('#vpsStorageLocations').innerHTML = storageLocations.map((location) => `<div><span>${escapeHtml(location.name)}<small>${escapeHtml(location.path)}</small></span><strong>${escapeHtml(formatBytes(location.bytes))}</strong></div>`).join('') || '<small>Pastas principais indisponíveis.</small>';
  const checked = new Date(data.checkedAt);
  $('#vpsHealthUpdated').textContent = `Atualizado ${checked.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })} · atualiza a cada minuto`;
}

export async function refreshVpsHealth(force = false) {
  if (runtime.vpsHealthRequest) return runtime.vpsHealthRequest;
  const button = $('#refreshVpsHealth');
  button?.classList.add('spinning');
  runtime.vpsHealthRequest = api(`/api/server-health${force ? '?refresh=true' : ''}`)
    .then(renderVpsHealth)
    .catch((error) => {
      $('#vpsHostMetrics').innerHTML = '<p class="vps-health-error">Não foi possível ler as métricas.</p>';
      $('#vpsProjectList').innerHTML = `<p class="vps-health-error">${escapeHtml(error.message)}</p>`;
      $('#vpsHealthUpdated').textContent = 'Atualização indisponível';
    })
    .finally(() => { button?.classList.remove('spinning'); runtime.vpsHealthRequest = null; });
  return runtime.vpsHealthRequest;
}

export async function refreshUsage(force = true) {
  if (runtime.quotaRefreshPromise) return runtime.quotaRefreshPromise;
  const request = (async () => {
    const data = await api(`/api/account-data${force ? '?refresh=true' : ''}`);
    state.account = data.account;
    state.rateLimits = data.rateLimits;
    state.usage = data.usage;
    clearResolvedRateLimitFailure();
    renderUsage();
    renderQueue();
    if (state.deferredQueueItems.length && !getEffectiveRateLimitBlock()) maybeDrainDeferredQueue().catch(() => {});
  })();
  runtime.quotaRefreshPromise = request;
  try { await request; }
  finally { if (runtime.quotaRefreshPromise === request) runtime.quotaRefreshPromise = null; }
}

export function applyAccountData(data = {}) {
  state.account = data.account;
  state.rateLimits = data.rateLimits;
  state.usage = data.usage;
  clearResolvedRateLimitFailure();
  renderUsage();
  renderQueue();
  if (state.deferredQueueItems.length && !getEffectiveRateLimitBlock()) maybeDrainDeferredQueue().catch(() => {});
}
