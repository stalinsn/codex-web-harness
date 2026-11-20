// Agent accounts (Codex, Claude Code, Antigravity, Gemini CLI, custom), their usage and the rotation queue.
import { api } from './api.js';
import { $, debounce, escapeHtml, installIcons, toast } from './dom.js';
import { formatCountdown } from './format.js';
import { renderInspectorSummary, usageWindows } from './inspector-layout.js';
import { populateAccountSelect } from './models.js';
import { renderRateLimitNotice } from './rate-limit.js';
import { providerClass } from './responders.js';
import { state } from './state.js';
import { openWizard } from './wizard.js';

let accountsRequest = null;
let renderPending = false;
const expandedAccess = new Set();

export function refreshAccounts() {
  accountsRequest ||= api('/api/accounts').then(applyAccounts).finally(() => { accountsRequest = null; });
  return accountsRequest;
}

export const refreshAccountsSoon = debounce(() => refreshAccounts().catch(() => {}), 400);

export function applyAccounts(data) {
  state.accounts = data.accounts || [];
  state.rotation = data.rotation || null;
  state.providers = data.providers || [];
  renderAccounts();
  renderRateLimitNotice();
}

/** Another enabled, signed-in account that could take over right now. */
export function hasAlternativeAccount() {
  return state.accounts.some((account) => !account.primary && account.available);
}

function statusOf(account) {
  if (!account.enabled) return { tone: 'off', text: 'Desativada' };
  if (account.busyWith) return { tone: 'busy', text: 'Executando uma tarefa' };
  if (account.cooldownUntil) return { tone: 'wait', text: `Limite atingido · libera ${formatCountdown(account.cooldownUntil / 1000)}` };
  if (account.loggedIn === false) return { tone: 'error', text: 'Não conectada', title: account.statusDetail };
  if (!account.available) return { tone: 'wait', text: account.unavailableReason || 'Indisponível' };
  if (account.loggedIn == null) return { tone: 'unknown', text: 'Login ainda não verificado' };
  return { tone: 'ok', text: 'Disponível' };
}

function usageMeter(account) {
  if (account.provider === 'claude-code') {
    const readings = usageWindows(account);
    return ['5 horas', '7 dias'].map((label) => {
      const reading = readings.find((item) => item.label === label);
      if (!reading) return `<div><small class="account-usage-note">${label} · aguardando leitura</small><div class="meter-track account-meter" aria-hidden="true"></div></div>`;
      const used = Math.min(100, Math.max(0, reading.usedPercent));
      const tone = used >= 90 ? 'critical' : used >= 75 ? 'high' : '';
      return `<div><small class="account-usage-note">${label} · ${Math.round(used)}% usado</small><div class="meter-track account-meter" aria-hidden="true"><div class="meter-fill ${tone}" style="width:${used}%"></div></div></div>`;
    }).join('');
  }
  if (account.percent == null) return account.usageSource === 'reported' || account.usageSource === 'events' ? '' : '<small class="account-usage-note">uso não informado pela CLI</small>';
  const percent = Math.min(100, Math.max(0, Number(account.percent)));
  const tone = percent >= (state.rotation?.switchAtPercent ?? 95) ? 'critical' : percent >= 75 ? 'high' : '';
  return `<div class="meter-track account-meter" title="${Math.round(percent)}% usado"><div class="meter-fill ${tone}" style="width:${percent}%"></div></div>`;
}

export function renderAccounts() {
  renderInspectorSummary();
  populateAccountSelect();
  const list = $('#accountList');
  if (!list) return;
  // Live updates must not close a menu the user is reading; render when it closes.
  if (list.querySelector('.account-menu[open]')) { renderPending = true; return; }
  renderPending = false;
  const total = state.accounts.length;
  list.innerHTML = state.accounts.map((account, index) => {
    const status = statusOf(account);
    const details = [account.providerLabel, account.model, account.effort ? `esforço ${account.effort}` : ''].filter(Boolean).map(escapeHtml).join(' · ');
    const claude = account.provider === 'claude-code';
    const antigravity = account.provider === 'antigravity';
    const full = claude ? 'bypassPermissions' : 'always-proceed';
    const manual = claude ? 'acceptEdits' : 'request-review';
    const accessMode = account.permissionMode || manual;
    const modeLabel = accessMode === full ? 'Acesso completo' : accessMode === manual ? 'Com autorização' : `Outro modo da CLI: ${accessMode}`;
    const accessButton = (mode, label) => `<button type="button" class="account-access-button ${accessMode === mode ? 'active' : ''}" data-action="access-mode" data-mode="${mode}" aria-pressed="${accessMode === mode}" ${account.busyWith ? 'disabled' : ''}>${label}</button>`;
    const accessHint = claude ? 'Com autorização permite edições de arquivos. Ações que exigem confirmação podem ser bloqueadas em execução sem interação.' : 'Em execução sem interação, pedidos de aprovação são bloqueados. Regras de outros escopos continuam valendo.';
    const expanded = expandedAccess.has(account.id) ? 'open' : '';
    const accessControls = claude || antigravity
      ? `<details class="account-access-panel" ${expanded}><summary>Acesso do agente · ${escapeHtml(modeLabel)}</summary><div class="account-access-controls"><div role="group" aria-label="Modo de acesso de ${escapeHtml(account.label)}">${accessButton(full, 'Acesso completo')}${accessButton(manual, 'Com autorização')}</div><small>${accessHint}</small></div></details>`
      : account.primary ? `<details class="account-access-panel" ${expanded}><summary>Acesso por conversa</summary><div class="account-access-controls"><small>Com o Codex selecionado, abra Ajustes → Permissões e escolha Pedir aprovação ou Automático.</small></div></details>` : '';
    return `<li class="account-row tone-${status.tone} ${providerClass(account.provider)}" data-account-id="${escapeHtml(account.id)}">
      <span class="account-position">${index + 1}</span>
      <div class="account-main">
        <div class="account-title">
          <strong>${escapeHtml(account.label)}</strong>${account.primary ? '<span class="account-badge">chat</span>' : ''}
          <div class="account-actions">
            <button type="button" class="account-move" data-action="up" aria-label="Subir na fila" title="Subir na fila" ${index === 0 ? 'disabled' : ''}>↑</button>
            <button type="button" class="account-move" data-action="down" aria-label="Descer na fila" title="Descer na fila" ${index === total - 1 ? 'disabled' : ''}>↓</button>
            <details class="account-menu"><summary aria-label="Ações da conta" title="Ações da conta">⋯</summary><div class="account-menu-items">
              ${account.primary ? '' : `<button type="button" data-action="connect">${account.loggedIn ? 'Reconectar' : 'Conectar'}</button>`}
              ${!account.primary && account.loggedIn ? '<button type="button" data-action="models">Modelos e esforço desta conta</button>' : ''}
              <button type="button" data-action="check">Verificar login</button>
              ${account.loginCommand ? '<button type="button" data-action="copy-login">Copiar comando de login (terminal)</button>' : ''}
              ${account.cooldownUntil || account.percent != null ? '<button type="button" data-action="reset">Liberar agora</button>' : ''}
              <button type="button" data-action="toggle">${account.enabled ? 'Desativar' : 'Ativar'}</button>
              ${account.primary || !account.loggedIn ? '' : '<button type="button" data-action="logout">Sair da conta</button>'}
              ${account.primary ? '' : '<button type="button" data-action="remove" class="danger">Remover</button>'}
            </div></details>
          </div>
        </div>
        <small>${details}</small>
        ${usageMeter(account)}
        ${accessControls}
        <small class="account-status"><span class="account-dot"></span>${status.tone === 'error' && !account.primary ? `<button type="button" class="account-connect-link" data-action="connect" title="${escapeHtml(status.title || '')}">${escapeHtml(status.text)} · Conectar</button>` : escapeHtml(status.text)}${account.provider !== 'claude-code' && account.percent != null ? ` · ${Math.round(account.percent)}% usado` : ''}</small>
      </div>
    </li>`;
  }).join('') || '<li class="muted-note">Nenhuma conta cadastrada.</li>';

  const rotation = state.rotation;
  if (rotation) {
    if (document.activeElement !== $('#switchAtPercent')) $('#switchAtPercent').value = rotation.switchAtPercent;
    $('#proactiveHandoff').checked = rotation.proactiveHandoff;
    $('#autoContinue').checked = rotation.autoContinue;
  }
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); toast('Comando copiado.'); }
  catch { window.prompt('Copie o comando:', text); }
}

async function accountAction(account, action, mode = '') {
  const id = encodeURIComponent(account.id);
  if (action === 'access-mode') {
    const full = ['always-proceed', 'bypassPermissions'].includes(mode);
    if (full && !window.confirm(`Ativar acesso completo para ${account.label}? As próximas execuções poderão usar ferramentas sem pedir confirmação.`)) return;
    const data = await api(`/api/accounts/${id}/access`, { method: 'POST', body: JSON.stringify({ mode }) });
    applyAccounts(data);
    return toast(full ? `${account.label}: acesso automático ativado.` : `${account.label}: ações sem autorização serão bloqueadas.`);
  }
  if (action === 'up' || action === 'down') {
    const order = state.accounts.map((item) => item.id);
    const index = order.indexOf(account.id);
    const target = action === 'up' ? index - 1 : index + 1;
    if (target < 0 || target >= order.length) return;
    [order[index], order[target]] = [order[target], order[index]];
    return applyAccounts(await api('/api/accounts/rotation', { method: 'POST', body: JSON.stringify({ order }) }));
  }
  if (action === 'check') {
    const data = await api(`/api/accounts/${id}/check`, { method: 'POST', body: '{}' });
    applyAccounts(data);
    const checked = data.accounts.find((item) => item.id === account.id);
    return toast(checked?.loggedIn ? `${account.label}: login ativo.` : `${account.label}: ${checked?.statusDetail || 'sem login'}.`, checked?.loggedIn ? '' : 'error');
  }
  if (action === 'copy-login') return copyText(account.loginCommand);
  if (action === 'connect') return openWizard({ accountId: account.id });
  if (action === 'models') return openWizard({ accountId: account.id, configureModels: true });
  if (action === 'logout') {
    if (!window.confirm(`Sair de “${account.label}”? O login salvo desta conta na VPS será apagado; a conta continua na fila, desconectada.`)) return;
    applyAccounts(await api(`/api/accounts/${id}/logout`, { method: 'POST', body: '{}' }));
    return toast('Conta desconectada.');
  }
  if (action === 'reset') return applyAccounts(await api(`/api/accounts/${id}/reset-cooldown`, { method: 'POST', body: '{}' }));
  if (action === 'toggle') return applyAccounts(await api(`/api/accounts/${id}`, { method: 'POST', body: JSON.stringify({ enabled: !account.enabled }) }));
  if (action === 'remove') {
    if (!window.confirm(`Remover “${account.label}” da fila?`)) return;
    const forget = window.confirm('Apagar também o login salvo desta conta na VPS? (Cancelar mantém a pasta da conta.)');
    applyAccounts(await api(`/api/accounts/${id}${forget ? '?forget=true' : ''}`, { method: 'DELETE' }));
    return toast('Conta removida.');
  }
}

const saveRotation = debounce(async (changes) => {
  try { applyAccounts(await api('/api/accounts/rotation', { method: 'POST', body: JSON.stringify(changes) })); }
  catch (error) { toast(error.message, 'error'); }
}, 500);

export function bindAccountEvents() {
  $('#accountList').addEventListener('toggle', (event) => {
    const panel = event.target;
    if (!panel.matches?.('.account-access-panel') || !panel.isConnected) return;
    const id = panel.closest('[data-account-id]')?.dataset.accountId;
    if (!id) return;
    if (panel.open) expandedAccess.add(id);
    else expandedAccess.delete(id);
  }, true);
  document.addEventListener('click', (event) => {
    for (const menu of document.querySelectorAll('.account-menu[open]')) {
      if (!menu.contains(event.target)) menu.open = false;
    }
  }, true);
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    for (const menu of document.querySelectorAll('.account-menu[open]')) {
      if (menu.contains(document.activeElement)) menu.querySelector('summary')?.focus();
      menu.open = false;
    }
  });
  $('#accountList').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-action]');
    if (!button) return;
    const account = state.accounts.find((item) => item.id === button.closest('[data-account-id]')?.dataset.accountId);
    if (!account) return;
    button.closest('details')?.removeAttribute('open');
    button.disabled = true;
    accountAction(account, button.dataset.action, button.dataset.mode).catch((error) => toast(error.message, 'error')).finally(() => { button.disabled = false; });
  });
  $('#accountList').addEventListener('toggle', (event) => {
    if (event.target.matches?.('.account-menu') && !event.target.open && renderPending) renderAccounts();
  }, true);
  $('#refreshAccounts').addEventListener('click', async () => {
    const button = $('#refreshAccounts');
    button.classList.add('spinning');
    try {
      for (const account of state.accounts) await api(`/api/accounts/${encodeURIComponent(account.id)}/check`, { method: 'POST', body: '{}' }).catch(() => {});
      await refreshAccounts();
    } finally { button.classList.remove('spinning'); }
  });
  $('#switchAtPercent').addEventListener('change', () => saveRotation({ switchAtPercent: Number($('#switchAtPercent').value) }));
  $('#proactiveHandoff').addEventListener('change', () => saveRotation({ proactiveHandoff: $('#proactiveHandoff').checked }));
  $('#autoContinue').addEventListener('change', () => saveRotation({ autoContinue: $('#autoContinue').checked }));
  $('#addAccount').addEventListener('click', () => openWizard());
  installIcons($('.accounts-card'));
  setInterval(() => { if (!document.hidden && state.accounts.some((account) => account.cooldownUntil)) renderAccounts(); }, 60_000);
}
