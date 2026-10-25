// Account rate-limit detection, notice and quota polling.
import { updateComposerControls } from './composer.js';
import { $, $$ } from './dom.js';
import { formatCountdown, formatReset } from './format.js';
import { refreshUsage } from './inspector.js';
import { renderQueue } from './queue.js';
import { runtime, state } from './state.js';
import { updateContinueElsewhere } from './tasks.js';

export function updateResetCountdowns() {
  $$('.meter-countdown').forEach((node) => { node.textContent = formatCountdown(node.dataset.resetAt); });
}

export function getRateLimitBlock() {
  const data = state.rateLimits;
  const buckets = data ? (Array.isArray(data) ? data : Object.values(data)) : [];
  const now = Date.now() / 1000;
  const exhausted = [];
  buckets.forEach((bucket, index) => {
    const label = bucket.limitName || (index === 0 ? 'Codex' : bucket.limitId || 'Outro limite');
    [bucket.primary, bucket.secondary].filter(Boolean).forEach((window, windowIndex) => {
      const usedPercent = Number(window.usedPercent);
      if (!Number.isFinite(usedPercent) || usedPercent < 100) return;
      const resetAt = Number(window.resetsAt) || 0;
      if (!resetAt || resetAt > now) exhausted.push({ label: label + ' · janela ' + (windowIndex === 0 ? 'curta' : 'longa'), resetAt });
    });
  });
  if (!exhausted.length) return null;
  const hasUnknownReset = exhausted.some((window) => !window.resetAt);
  const resetAt = hasUnknownReset ? 0 : Math.max(...exhausted.map((window) => window.resetAt));
  const labels = exhausted.filter((window) => !resetAt || window.resetAt === resetAt).map((window) => window.label);
  return { resetAt, labels: [...new Set(labels)] };
}

export function isRateLimitError(message) {
  return /rate[ -]?limit|usage limit|quota|too many requests|reached.{0,30}limit|limit.{0,30}reached|limit.{0,30}exceed|exceed.{0,30}limit|hit.{0,20}limit|limite.{0,30}atingid|atingid.{0,30}limite/i.test(String(message || ''));
}

function hasRateLimitData() {
  const data = state.rateLimits;
  const buckets = data ? (Array.isArray(data) ? data : Object.values(data)) : [];
  return buckets.some((bucket) => bucket && (bucket.primary || bucket.secondary));
}

export function getEffectiveRateLimitBlock() {
  const block = getRateLimitBlock();
  if (block) return block;
  const failure = state.rateLimitFailure;
  if (!failure) return null;
  const resetAt = Number(failure.resetAt) || 0;
  if (resetAt && resetAt <= Date.now() / 1000) return null;
  return { resetAt, labels: failure.labels?.length ? failure.labels : ['limite de uso'] };
}

export function clearResolvedRateLimitFailure() {
  const failure = state.rateLimitFailure;
  if (!failure) return;
  const reported = getRateLimitBlock();
  if (reported) {
    if (!failure.resetAt || reported.resetAt > failure.resetAt) failure.resetAt = reported.resetAt;
    if (reported.labels?.length) failure.labels = reported.labels;
    return;
  }
  if (!hasRateLimitData()) return;
  const resetAt = Number(failure.resetAt) || 0;
  const retryAfter = resetAt ? resetAt * 1000 : (Number(failure.createdAt) || Date.now()) + 60_000;
  if (Date.now() >= retryAfter) state.rateLimitFailure = null;
}

export function recordRateLimitFailure(message) {
  const block = getRateLimitBlock();
  const alreadyRecorded = state.rateLimitFailure && Date.now() - (Number(state.rateLimitFailure.createdAt) || 0) < 10_000;
  state.rateLimitFailure = {
    message: String(message || 'O Codex interrompeu o turno por limite de uso.'),
    resetAt: block?.resetAt || 0,
    labels: block?.labels || [],
    createdAt: alreadyRecorded ? state.rateLimitFailure.createdAt : Date.now(),
  };
  renderRateLimitNotice();
  renderQueue();
  updateComposerControls();
  if (!alreadyRecorded) refreshUsage(true).catch(() => {});
}

export function renderRateLimitNotice() {
  const notice = $('#rateLimitNotice');
  if (!notice) return;
  const block = getEffectiveRateLimitBlock();
  const failure = state.rateLimitFailure;
  notice.classList.toggle('hidden', !block && !failure);
  updateContinueElsewhere(Boolean(block || failure));
  if (!block && !failure) { scheduleQuotaRefresh(); updateComposerControls(); return; }
  const title = $('#rateLimitNoticeTitle');
  const detail = $('#rateLimitNoticeDetail');
  if (title) title.textContent = failure && !getRateLimitBlock() ? 'A solicitação parou por limite de uso' : 'Limite de uso atingido';
  const resetAt = block?.resetAt || 0;
  const reset = resetAt ? 'A janela libera ' + formatCountdown(resetAt) + ' (' + formatReset(resetAt) + ').' : 'O horário de reinício ainda não foi informado.';
  const windows = block?.labels?.length ? ' (' + block.labels.join(', ') + ')' : '';
  const queuedCount = state.deferredQueueItems.length;
  const automaticCount = state.deferredQueueItems.filter((item) => !item.needsReview).length;
  const reviewCount = queuedCount - automaticCount;
  const queued = queuedCount
    ? ` ${queuedCount} ${queuedCount === 1 ? 'mensagem está guardada' : 'mensagens estão guardadas'} na fila local deste navegador.`
      + (automaticCount ? ` ${automaticCount === 1 ? 'Ela será enviada' : 'Elas serão enviadas'} automaticamente quando liberar.` : '')
      + (reviewCount ? ` ${reviewCount === 1 ? 'Uma mensagem precisa' : `${reviewCount} mensagens precisam`} de revisão antes de reenviar.` : '')
      + ' Você também pode devolver uma mensagem ao rascunho ou cancelar.'
    : ' Novas mensagens serão guardadas na fila local deste navegador até liberar.';
  if (detail) detail.textContent = (getRateLimitBlock() ? 'O processamento foi limitado' + windows + '. ' : '') + reset + queued;
  scheduleQuotaRefresh(block);
  updateComposerControls();
}

function scheduleQuotaRefresh(block = getEffectiveRateLimitBlock()) {
  const hasQueue = state.deferredQueueItems.length > 0;
  if (block && block.resetAt) {
    if (runtime.scheduledQuotaResetAt !== block.resetAt) {
      clearTimeout(runtime.quotaResetTimer);
      runtime.scheduledQuotaResetAt = block.resetAt;
      runtime.quotaResetTimer = setTimeout(() => {
        runtime.scheduledQuotaResetAt = 0;
        refreshUsage(true).catch(() => {});
      }, Math.max(1000, block.resetAt * 1000 - Date.now() + 1000));
    }
  } else {
    clearTimeout(runtime.quotaResetTimer);
    runtime.scheduledQuotaResetAt = 0;
  }
  if ((hasQueue || state.rateLimitFailure) && !runtime.quotaPollTimer) {
    runtime.quotaPollTimer = setInterval(() => { refreshUsage(true).catch(() => {}); }, block && block.resetAt ? 5 * 60_000 : 60_000);
  } else if (!hasQueue && !state.rateLimitFailure && runtime.quotaPollTimer) {
    clearInterval(runtime.quotaPollTimer);
    runtime.quotaPollTimer = null;
  }
}
