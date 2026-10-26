// Keep short-lived UI/provider errors visible in the inspector after their toast fades.
import { state } from './state.js';

const STORAGE_KEY = 'codex-error-history-v1';
const MAX_ENTRIES = 120;
const MAX_MESSAGE = 1600;

function readEntries() {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    return Array.isArray(value) ? value.filter((entry) => entry && typeof entry.message === 'string') : [];
  } catch { return []; }
}

function redact(value) {
  return String(value ?? '')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/giu, 'Bearer [oculto]')
    .replace(/\bAIza[0-9A-Za-z_-]{20,}\b/gu, '[chave ocultada]')
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/gu, '[chave ocultada]')
    .replace(/((?:password|senha|token|secret|api[_-]?key)\s*[:=]\s*)[^\s,;]+/giu, '$1[oculto]')
    .slice(0, MAX_MESSAGE);
}

export function rememberError(message, { threadId = state.selectedThreadId, turnId = '', source = 'Interface', provider = '', tool = '' } = {}) {
  const text = redact(message).trim();
  if (!threadId || !text) return;
  const entries = readEntries();
  const now = Date.now();
  const duplicate = entries.find((entry) => entry.threadId === threadId && entry.message === text && (
    (turnId && entry.turnId === turnId) || (!turnId && now - Number(entry.createdAt || 0) < 5000)
  ));
  if (!duplicate) {
    entries.push({ id: `${now}-${Math.random().toString(36).slice(2, 8)}`, threadId, turnId, source, provider: provider || state.selectedThread?.provider || '', tool, message: text, createdAt: now });
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(entries.slice(-MAX_ENTRIES))); } catch { /* the panel can still show errors persisted in conversation history */ }
  }
  renderErrorHistory();
}

function messageOf(value) {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') return String(value.message || value.error || '');
  return '';
}

function historyFailures(threadId) {
  const rows = [];
  for (const turn of state.historyThreadId === threadId ? state.historyTurns : []) {
    const turnId = String(turn.id || '');
    const rawTimestamp = Number(turn.completedAt || turn.startedAt || 0);
    const timestamp = rawTimestamp && rawTimestamp < 1e12 ? rawTimestamp * 1000 : rawTimestamp;
    const provider = turn.account?.label || turn.account?.provider || '';
    const turnError = messageOf(turn.error);
    if (turnError) rows.push({ threadId, turnId, message: turnError, source: 'Turno', provider, createdAt: timestamp });

    for (const item of turn.items || []) {
      if (item.status !== 'failed' && !item.error) continue;
      const tool = item.tool || (item.type === 'commandExecution' ? 'Comando' : item.type === 'fileChange' ? 'Alteração de arquivo' : item.type || 'Ferramenta');
      const output = item.error || (item.type === 'commandExecution' ? item.aggregatedOutput : '') || '';
      const detail = redact(messageOf(output) || (typeof output === 'string' ? output : '')).trim();
      rows.push({ threadId, turnId, itemId: item.id || '', message: detail || 'A ferramenta falhou sem devolver detalhes.', source: 'Ferramenta', provider, tool, createdAt: timestamp });
    }
    if (!turnError && turn.status === 'failed') rows.push({ threadId, turnId, message: 'O turno terminou com falha, sem uma mensagem de erro detalhada.', source: 'Turno', provider, createdAt: timestamp });
  }
  return rows;
}

function displayTime(value) {
  const date = new Date(Number(value) || 0);
  return Number.isNaN(date.getTime()) || !Number(value) ? 'Horário indisponível' : new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' }).format(date);
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/gu, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

export function renderErrorHistory() {
  const card = document.querySelector('#errorHistoryCard');
  const list = document.querySelector('#errorHistoryList');
  if (!card || !list) return;
  const threadId = state.selectedThreadId;
  if (!threadId) { card.classList.add('hidden'); return; }

  const saved = readEntries().filter((entry) => entry.threadId === threadId);
  const combined = [...historyFailures(threadId), ...saved];
  const seen = new Set();
  const unique = combined.filter((entry) => {
    const fingerprint = entry.turnId ? `${entry.turnId}\u0000${entry.message}` : `${entry.id || ''}\u0000${entry.message}`;
    if (seen.has(fingerprint)) return false;
    seen.add(fingerprint);
    return true;
  }).sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0)).slice(0, 12);

  card.classList.toggle('hidden', unique.length === 0);
  const summary = card.querySelector('.card-summary');
  if (summary) summary.textContent = `${unique.length} ${unique.length === 1 ? 'registro' : 'registros'}`;
  if (!unique.length) { list.replaceChildren(); return; }
  list.innerHTML = unique.map((entry, index) => {
    const title = [entry.source, entry.tool].filter(Boolean).join(' · ') || 'Erro';
    const details = [entry.provider, entry.turnId ? `Turno ${entry.turnId.slice(-8)}` : ''].filter(Boolean).join(' · ');
    return `<details class="error-history-entry" ${index === 0 ? 'open' : ''}><summary><span class="error-history-dot" aria-hidden="true"></span><span class="error-history-title">${escapeHtml(title)}</span><time>${escapeHtml(displayTime(entry.createdAt))}</time></summary><div class="error-history-body">${details ? `<small>${escapeHtml(details)}</small>` : ''}<p>${escapeHtml(entry.message)}</p></div></details>`;
  }).join('');
}
