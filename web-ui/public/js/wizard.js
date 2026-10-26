// Step-by-step account connection: provider → identification → login terminal → done.
// The login runs on the VPS inside a pseudo-terminal; this view mirrors it with
// xterm.js (loaded on demand), surfaces links/codes and sends keystrokes back.
import { applyAccounts, refreshAccounts } from './accounts.js';
import { api } from './api.js';
import { PREFIX } from './config.js';
import { $, $$, escapeHtml, installIcons, toast } from './dom.js';
import { state } from './state.js';

const BLURBS = {
  codex: 'Outra conta ChatGPT/Codex. Login por código de dispositivo; usa a mesma configuração da conta principal.',
  'claude-code': 'Assinatura Claude Pro/Max. Gera um token de longa duração guardado só nesta conta.',
  antigravity: 'Conta Google no Antigravity CLI (agy). Login por link + código, ou chave de API.',
  'gemini-cli': 'Gemini CLI com login Google ou chave de API.',
};
const KEYS = { enter: '\r', up: '\x1b[A', down: '\x1b[B', tab: '\t', esc: '\x1b', ctrlc: '\x03' };
const wizard = { step: 'provider', provider: '', accountId: '', setup: null, flowId: '', session: null, term: null };
let xtermLoading = null;

function loadXterm() {
  if (window.Terminal) return Promise.resolve();
  xtermLoading ||= new Promise((resolvePromise, rejectPromise) => {
    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = `${PREFIX}/vendor/xterm/xterm.css`;
    document.head.append(css);
    const load = (src) => new Promise((done, fail) => {
      const script = document.createElement('script');
      script.src = src;
      script.onload = done;
      script.onerror = () => fail(new Error('Não consegui carregar o terminal.'));
      document.head.append(script);
    });
    load(`${PREFIX}/vendor/xterm/xterm.js`).then(() => load(`${PREFIX}/vendor/xterm/addon-web-links.js`)).then(resolvePromise, rejectPromise);
  });
  return xtermLoading;
}

function showStep(step) {
  wizard.step = step;
  $$('#accountWizard .wizard-step').forEach((section) => { section.hidden = section.dataset.step !== step; });
  const order = ['provider', 'details', 'connect', 'done'];
  $$('#wizardSteps li').forEach((item) => {
    const index = order.indexOf(item.dataset.step);
    item.classList.toggle('current', item.dataset.step === step);
    item.classList.toggle('complete', index < order.indexOf(step));
  });
}

function renderProviders() {
  $('#providerGrid').innerHTML = state.providers.filter((provider) => provider.id !== 'custom').map((provider) => `
    <button type="button" class="provider-card" data-provider="${escapeHtml(provider.id)}">
      <strong>${escapeHtml(provider.label)}</strong>
      <span>${escapeHtml(BLURBS[provider.id] || '')}</span>
      <small>${provider.usage === 'reported' || provider.usage === 'events' ? 'Mostra o % de uso' : 'Troca quando o limite acaba'}</small>
    </button>`).join('');
}

function suggestId(provider) {
  const base = { codex: 'codex', 'claude-code': 'claude', antigravity: 'google', 'gemini-cli': 'gemini' }[provider] || provider;
  for (let index = 1; index < 100; index += 1) {
    const id = `${base}-${index}`;
    if (!state.accounts.some((account) => account.id === id)) return id;
  }
  return `${base}-${Date.now() % 1000}`;
}

function chooseProvider(provider) {
  wizard.provider = provider;
  const label = state.providers.find((item) => item.id === provider)?.label || provider;
  $('#wizardTitle').textContent = `Nova conta · ${label}`;
  $('#wizardId').value = suggestId(provider);
  $('#wizardLabel').value = '';
  $('#wizardModel').value = '';
  $('#wizardEffort').value = '';
  showStep('details');
  $('#wizardLabel').focus();
}

async function createAccount(event) {
  event.preventDefault();
  const button = $('#wizardCreate');
  button.disabled = true;
  try {
    const data = await api('/api/accounts', { method: 'POST', body: JSON.stringify({
      provider: wizard.provider,
      id: $('#wizardId').value.trim().toLowerCase(),
      label: $('#wizardLabel').value.trim(),
      model: $('#wizardModel').value.trim(),
      effort: $('#wizardEffort').value.trim(),
    }) });
    applyAccounts(data);
    await openConnect(data.account.id);
  } catch (error) { toast(error.message, 'error'); }
  finally { button.disabled = false; }
}

function renderFlowSteps() {
  const flow = wizard.setup?.flows.find((item) => item.id === wizard.flowId);
  $('#wizardFlowSteps').innerHTML = (flow?.steps || []).map((step) => `<li>${escapeHtml(step)}</li>`).join('');
}

function renderConnect() {
  const setup = wizard.setup;
  const account = state.accounts.find((item) => item.id === wizard.accountId);
  $('#wizardTitle').textContent = `Conectar · ${account?.label || setup.providerLabel}`;
  const installed = Boolean(setup.binPath);
  $('#wizardCli').innerHTML = installed
    ? `<span class="wizard-pill ok">CLI instalada</span><code>${escapeHtml(setup.binPath)}</code>${setup.version ? `<small>${escapeHtml(setup.version)}</small>` : ''}${account?.loggedIn ? '<span class="wizard-pill ok">Conectada</span>' : ''}`
    : `<span class="wizard-pill warn">CLI não encontrada</span><code>${escapeHtml(setup.bin)}</code>${setup.install ? `<button type="button" class="secondary-button" id="wizardInstall">Instalar agora</button><small>Executa na VPS: <code>${escapeHtml(setup.install)}</code></small>` : '<small>Instale a CLI na VPS e informe o caminho em web-accounts.json.</small>'}`;
  $('#wizardInstall')?.addEventListener('click', () => startSession('install'));
  $('#wizardNotes').textContent = setup.notes || '';
  $('#wizardFlows').innerHTML = setup.flows.map((flow) => `<label class="wizard-flow"><input type="radio" name="wizardFlow" value="${escapeHtml(flow.id)}" ${flow.id === wizard.flowId ? 'checked' : ''} /> <span>${escapeHtml(flow.label)}</span></label>`).join('');
  $('#wizardFlows').hidden = setup.flows.length < 2;
  renderFlowSteps();
  $('#wizardStart').disabled = !installed || !setup.flows.length;
  $('#wizardStart').hidden = false;
  $('#wizardStart').textContent = account?.loggedIn ? 'Reconectar' : 'Iniciar conexão';
  $('#wizardSecret').hidden = !setup.secret;
  if (setup.secret) {
    $('#wizardSecretLabel').textContent = setup.secret.label;
    $('#wizardSecretValue').placeholder = setup.secret.placeholder;
    $('#wizardSecretValue').value = '';
  }
}

async function openConnect(accountId) {
  wizard.accountId = accountId;
  wizard.session = null;
  $('#wizardSession').hidden = true;
  const { setup } = await api(`/api/accounts/${encodeURIComponent(accountId)}/setup`);
  wizard.setup = setup;
  wizard.flowId = setup.flows[0]?.id || '';
  showStep('connect');
  renderConnect();
}

async function startSession(kind) {
  const button = kind === 'install' ? $('#wizardInstall') : $('#wizardStart');
  const account = state.accounts.find((item) => item.id === wizard.accountId);
  if (kind === 'login' && account?.loggedIn) {
    if (!window.confirm('Esta conta já está conectada. Reconectar apaga o login atual dela e inicia um novo. Continuar?')) return;
  }
  if (button) button.disabled = true;
  try {
    if (kind === 'login' && account?.loggedIn) applyAccounts(await api(`/api/accounts/${encodeURIComponent(wizard.accountId)}/logout`, { method: 'POST', body: '{}' }));
    await loadXterm();
    const path = kind === 'install' ? 'install' : 'login';
    const { session } = await api(`/api/accounts/${encodeURIComponent(wizard.accountId)}/${path}`, { method: 'POST', body: JSON.stringify({ flowId: wizard.flowId }) });
    attachSession(session);
    // A state change may have arrived over SSE before this response: read it once.
    const { session: current } = await api(`/api/login-sessions/${session.id}`);
    if (wizard.session?.id === current.id && current.status !== 'running') onLoginState({ sessionId: current.id, ...current });
  } catch (error) { toast(error.message, 'error'); }
  finally { if (button) button.disabled = false; }
}

function attachSession(session) {
  wizard.session = session;
  $('#wizardSession').hidden = false;
  wizard.term?.dispose();
  const term = new window.Terminal({
    cols: session.cols, rows: session.rows, fontSize: 12, scrollback: 2000, cursorBlink: true, convertEol: false,
    fontFamily: "'IBM Plex Mono', ui-monospace, monospace",
    theme: { background: '#121317', foreground: '#e3e4ea', cursor: '#b8c1ff', selectionBackground: '#3c4370' },
  });
  if (window.WebLinksAddon) term.loadAddon(new window.WebLinksAddon.WebLinksAddon((event, uri) => window.open(uri, '_blank', 'noopener')));
  term.open($('#wizardTerminal'));
  term.write(session.output || '');
  term.onData((data) => sendInput(data));
  wizard.term = term;
  renderSessionState(session);
  $('#wizardSession').scrollIntoView({ block: 'nearest' });
}

function renderHints(hints = { links: [], codes: [] }) {
  const links = hints.links.map((url, index) => `<a class="primary-button wizard-link" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${index === hints.links.length - 1 ? 'Abrir link de autorização' : 'Abrir link anterior'}</a><button type="button" class="secondary-button" data-copy="${escapeHtml(url)}">Copiar link</button>`).slice(-1).join('');
  const codes = hints.codes.map((code) => `<button type="button" class="wizard-code" data-copy="${escapeHtml(code)}" title="Copiar código">${escapeHtml(code)}</button>`).join('');
  $('#wizardHints').innerHTML = links + codes;
  $('#wizardHints').hidden = !links && !codes;
}

function renderSessionState(session) {
  const messages = {
    running: session.kind === 'install' ? 'Instalando na VPS…' : 'Aguardando você concluir o login. O harness detecta sozinho quando terminar.',
    success: session.detail || 'Concluído.',
    failed: session.detail || 'Não deu certo.',
    stopped: session.detail || 'Encerrada.',
  };
  const status = $('#wizardSessionStatus');
  status.textContent = messages[session.status] || session.detail || '';
  status.className = `wizard-session-status ${session.status}`;
  renderHints(session.hints);
  const running = session.status === 'running';
  $('#wizardInputForm').hidden = !running;
  $('#wizardStart').hidden = running;
  $('#wizardFlows').classList.toggle('locked', running);
  $('#wizardKeys').hidden = !running;
}

async function sendInput(data) {
  if (!wizard.session || wizard.session.status !== 'running') return;
  try { await api(`/api/login-sessions/${wizard.session.id}/input`, { method: 'POST', body: JSON.stringify({ data }) }); }
  catch (error) { toast(error.message, 'error'); }
}

async function finishConnected() {
  await refreshAccounts().catch(() => {});
  const index = state.accounts.findIndex((account) => account.id === wizard.accountId);
  const account = state.accounts[index];
  $('#wizardDoneTitle').textContent = `${account?.label || 'Conta'} conectada`;
  $('#wizardDoneText').textContent = index >= 0 ? `Ela está na posição ${index + 1} da fila de uso. Você pode mudar a ordem no painel Contas e fila.` : '';
  showStep('done');
}

export function onLoginOutput({ sessionId, data }) {
  if (wizard.session?.id === sessionId) wizard.term?.write(data);
}

export function onLoginState(update) {
  if (wizard.session?.id !== update.sessionId) return;
  Object.assign(wizard.session, update);
  renderSessionState(wizard.session);
  if (update.status === 'success' && update.kind === 'login') finishConnected();
  if (update.status === 'success' && update.kind === 'install') {
    toast('CLI instalada.');
    openConnect(wizard.accountId).catch((error) => toast(error.message, 'error'));
  }
}

async function stopSession() {
  const session = wizard.session;
  if (session?.status === 'running') await api(`/api/login-sessions/${session.id}`, { method: 'DELETE' }).catch(() => {});
}

async function saveSecret(event) {
  event.preventDefault();
  const value = $('#wizardSecretValue').value.trim();
  if (!value) return;
  try {
    applyAccounts(await api(`/api/accounts/${encodeURIComponent(wizard.accountId)}/secret`, { method: 'POST', body: JSON.stringify({ value }) }));
    $('#wizardSecretValue').value = '';
    await stopSession();
    await finishConnected();
  } catch (error) { toast(error.message, 'error'); }
}

/** Open the wizard: from the start, or straight at the connection step of an account. */
export async function openWizard({ accountId = '' } = {}) {
  renderProviders();
  $('#accountWizard').showModal();
  if (accountId) {
    try { await openConnect(accountId); }
    catch (error) { toast(error.message, 'error'); $('#accountWizard').close(); }
    return;
  }
  wizard.accountId = '';
  $('#wizardTitle').textContent = 'Conectar uma conta';
  showStep('provider');
}

export function bindWizardEvents() {
  $('#providerGrid').addEventListener('click', (event) => {
    const card = event.target.closest('[data-provider]');
    if (card) chooseProvider(card.dataset.provider);
  });
  $('#wizardDetails').addEventListener('submit', createAccount);
  $('[data-wizard-back]').addEventListener('click', () => showStep('provider'));
  $('#wizardFlows').addEventListener('change', (event) => { wizard.flowId = event.target.value; renderFlowSteps(); });
  $('#wizardStart').addEventListener('click', () => startSession('login'));
  $('#wizardInputForm').addEventListener('submit', (event) => {
    event.preventDefault();
    const input = $('#wizardInput');
    sendInput(`${input.value}\r`);
    input.value = '';
  });
  $('#wizardKeys').addEventListener('click', (event) => {
    const key = event.target.closest('[data-key]')?.dataset.key;
    if (key) sendInput(KEYS[key]);
  });
  $('#wizardStop').addEventListener('click', stopSession);
  $('#wizardHints').addEventListener('click', async (event) => {
    const value = event.target.closest('[data-copy]')?.dataset.copy;
    if (!value) return;
    try { await navigator.clipboard.writeText(value); toast('Copiado.'); } catch { window.prompt('Copie:', value); }
  });
  $('#wizardSecretForm').addEventListener('submit', saveSecret);
  $('#wizardAnother').addEventListener('click', () => openWizard());
  $('#wizardFinish').addEventListener('click', () => $('#accountWizard').close());
  $('#closeWizard').addEventListener('click', () => $('#accountWizard').close());
  $('#accountWizard').addEventListener('close', () => {
    stopSession();
    wizard.term?.dispose();
    wizard.term = null;
    wizard.session = null;
    $('#wizardTerminal').replaceChildren();
  });
  installIcons($('#accountWizard'));
}
