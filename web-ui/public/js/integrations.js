// Integration tokens (other systems, text-only): list and revoke from the accounts card.
import { api } from './api.js';
import { $, escapeHtml, toast } from './dom.js';

const dateTime = (ms) => (ms ? new Date(ms).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '—');

function render(sessions) {
  const list = $('#integrationList');
  if (!list) return;
  if (!sessions.length) { list.innerHTML = '<li class="integration-empty">Nenhuma integração autorizada.</li>'; return; }
  list.innerHTML = sessions.map((session) => {
    const state = session.active ? `expira ${dateTime(session.expiresAt)}` : session.revoked ? 'revogada' : 'expirada';
    return `<li class="integration-row${session.active ? '' : ' inactive'}" data-integration-id="${escapeHtml(session.id)}">
      <div><strong>${escapeHtml(session.label)}</strong><small>${escapeHtml(session.client)} · criada ${escapeHtml(dateTime(session.createdAt))} · último uso ${escapeHtml(dateTime(session.lastUsedAt))} · ${escapeHtml(state)}</small></div>
      ${session.active ? '<button type="button" class="secondary-button" data-action="revoke">Revogar</button>' : ''}
    </li>`;
  }).join('');
}

export async function refreshIntegrations() {
  const data = await api('/api/integrations/sessions');
  render(data.sessions || []);
}

export function bindIntegrationEvents() {
  const details = $('#integrationSettings');
  if (!details) return;
  details.addEventListener('toggle', () => { if (details.open) refreshIntegrations().catch((error) => toast(error.message, 'error')); });
  $('#integrationList').addEventListener('click', async (event) => {
    const button = event.target.closest('button[data-action="revoke"]');
    const id = button?.closest('[data-integration-id]')?.dataset.integrationId;
    if (!id) return;
    if (!window.confirm('Revogar este token? O sistema integrado precisará entrar de novo com senha e código.')) return;
    button.disabled = true;
    try { render((await api(`/api/integrations/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' })).sessions || []); toast('Integração revogada.'); }
    catch (error) { toast(error.message, 'error'); button.disabled = false; }
  });
}
