// Collapsible inspector cards plus an always-visible summary of what matters most:
// Codex usage, account availability and the conversation's context window.
import { $, $$, debounce } from './dom.js';
import { formatCountdown, formatNumber } from './format.js';
import { state } from './state.js';

const STORAGE_KEY = 'codex-inspector-collapsed';
const DEFAULT_OPEN = new Set(['tasks']);

function loadCollapsed() {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    return value && typeof value === 'object' ? value : null;
  } catch { return null; }
}

function saveCollapsed() {
  const value = Object.fromEntries($$('.inspector-card[data-card]').map((card) => [card.dataset.card, card.classList.contains('collapsed')]));
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(value)); } catch { /* per-browser convenience only */ }
}

export function setCardCollapsed(key, collapsed) {
  const card = $(`.inspector-card[data-card="${key}"]`);
  if (!card) return;
  card.classList.toggle('collapsed', collapsed);
  $('.card-toggle', card)?.setAttribute('aria-expanded', String(!collapsed));
  saveCollapsed();
}

/** Short text shown next to a card title (visible mainly when the card is collapsed). */
export function setCardSummary(key, text) {
  const node = $(`.inspector-card[data-card="${key}"] .card-summary`);
  if (node) node.textContent = text || '';
}

function tone(percent) {
  return percent >= 90 ? 'critical' : percent >= 75 ? 'high' : '';
}

function setMeter(fill, percent) {
  if (!fill) return;
  const value = Number.isFinite(percent) ? Math.min(100, Math.max(0, percent)) : 0;
  fill.style.width = `${value}%`;
  fill.className = `meter-fill ${tone(value)}`;
}

function usageWindows() {
  const data = state.rateLimits;
  const buckets = data ? (Array.isArray(data) ? data : Object.values(data)) : [];
  const bucket = buckets[0];
  return bucket ? [bucket.primary, bucket.secondary].filter(Boolean) : [];
}

function renderSummaryNow() {
  const [short, long] = usageWindows();
  if (short) {
    const used = Number(short.usedPercent) || 0;
    $('#summaryUsage').textContent = `${Math.round(used)}%`;
    setMeter($('#summaryUsageFill'), used);
    const longText = long ? `longa ${Math.round(Number(long.usedPercent) || 0)}%` : '';
    const reset = used >= 100 && short.resetsAt ? `libera ${formatCountdown(short.resetsAt)}` : 'janela curta';
    $('#summaryUsageDetail').textContent = [reset, longText].filter(Boolean).join(' · ');
    setCardSummary('usage', `${Math.round(used)}%${long ? ` · ${Math.round(Number(long.usedPercent) || 0)}%` : ''}`);
  } else {
    $('#summaryUsage').textContent = '—';
    $('#summaryUsageDetail').textContent = 'sem dados de uso';
    setMeter($('#summaryUsageFill'), 0);
  }

  const accounts = state.accounts.filter((account) => account.enabled);
  if (accounts.length) {
    const available = accounts.filter((account) => account.available);
    $('#summaryAccounts').textContent = `${available.length}/${accounts.length}`;
    const next = available[0];
    const waiting = accounts.filter((account) => account.cooldownUntil).sort((a, b) => a.cooldownUntil - b.cooldownUntil)[0];
    $('#summaryAccountsDetail').textContent = next ? `próxima: ${next.label}` : waiting ? `libera ${formatCountdown(waiting.cooldownUntil / 1000)}` : 'nenhuma disponível';
    $('#summaryAccounts').closest('.summary-tile').classList.toggle('alert', !available.length);
    setCardSummary('accounts', `${available.length} de ${accounts.length} disponíveis`);
  }

  const usage = state.contextUsage?.tokenUsage || state.contextUsage || null;
  const used = Number(usage?.last?.totalTokens ?? usage?.last?.inputTokens ?? usage?.lastTokenUsage?.totalTokens);
  const capacity = Number(usage?.modelContextWindow ?? usage?.model_context_window);
  if (state.selectedThreadId && Number.isFinite(used) && Number.isFinite(capacity) && capacity > 0) {
    const percent = used / capacity * 100;
    $('#summaryContext').textContent = `${percent.toLocaleString('pt-BR', { maximumFractionDigits: 0 })}%`;
    setMeter($('#summaryContextFill'), percent);
    $('#summaryContextDetail').textContent = `${formatNumber(used)} de ${formatNumber(capacity)}`;
    setCardSummary('context', `${Math.round(percent)}%`);
  } else {
    $('#summaryContext').textContent = '—';
    setMeter($('#summaryContextFill'), 0);
    $('#summaryContextDetail').textContent = state.selectedThreadId ? 'aguardando leitura' : 'abra uma conversa';
    setCardSummary('context', '');
  }

  const active = state.tasks.filter((task) => ['running', 'queued', 'waiting'].includes(task.status)).length;
  const blocked = state.tasks.filter((task) => task.status === 'blocked').length;
  setCardSummary('tasks', [active ? `${active} ativa${active > 1 ? 's' : ''}` : '', blocked ? `${blocked} precisa${blocked > 1 ? 'm' : ''} de você` : ''].filter(Boolean).join(' · '));
}

export const renderInspectorSummary = debounce(renderSummaryNow, 50);

export function bindInspectorLayout() {
  const stored = loadCollapsed();
  for (const card of $$('.inspector-card[data-card]')) {
    const key = card.dataset.card;
    const row = $('.card-title-row', card);
    if (!row) continue;
    const summary = document.createElement('span');
    summary.className = 'card-summary';
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'card-toggle';
    toggle.setAttribute('aria-label', 'Recolher ou expandir');
    toggle.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 10 5 5 5-5"/></svg>';
    row.firstElementChild?.append(summary);
    row.append(toggle);
    row.addEventListener('click', (event) => {
      if (event.target.closest('button') && event.target.closest('button') !== toggle) return;
      setCardCollapsed(key, !card.classList.contains('collapsed'));
    });
    const collapsed = stored && key in stored ? stored[key] : !DEFAULT_OPEN.has(key);
    card.classList.toggle('collapsed', collapsed);
    toggle.setAttribute('aria-expanded', String(!collapsed));
  }
  $('#inspectorSummary').addEventListener('click', (event) => {
    const key = event.target.closest('[data-open-card]')?.dataset.openCard;
    if (!key) return;
    setCardCollapsed(key, false);
    $(`.inspector-card[data-card="${key}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  renderSummaryNow();
}
