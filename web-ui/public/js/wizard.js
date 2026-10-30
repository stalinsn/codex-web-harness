// Quick account connection: choose a provider → authenticate → optionally tune model.
// The login runs on the VPS inside a pseudo-terminal; this view mirrors it with
// xterm.js (loaded on demand), surfaces links/codes and sends keystrokes back.
import { applyAccounts, refreshAccounts } from './accounts.js';
import { api } from './api.js';
import { PREFIX } from './config.js';
import { $, $$, escapeHtml, installIcons, toast } from './dom.js';
import { state } from './state.js';

const BLURBS = {
  codex: 'Outra conta ChatGPT/Codex. Login oficial por código de dispositivo; os modelos são lidos da CLI.',
  'claude-code': 'Entre com sua conta Claude pelo fluxo oficial. Modelos e esforços seguem as opções da CLI.',
  antigravity: 'Entre com sua conta Google por autorização oficial. O agy informa os modelos disponíveis.',
  'gemini-cli': 'Gemini CLI com login Google ou chave de API.',
};
const KEYS = { enter: '\r', up: '\x1b[A', down: '\x1b[B', tab: '\t', esc: '\x1b', ctrlc: '\x03' };
const wizard = { step: 'provider', provider: '', accountId: '', setup: null, flowId: '', session: null, term: null, catalog: null, finishing: false, starting: false };
let xtermLoading = null;
let accountCreationPending = false;
let installProgressTimer = null;

export function loadXterm() {
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
  const order = ['provider', 'connect', 'models', 'done'];
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

async function chooseProvider(provider) {
  if (accountCreationPending) return;
  accountCreationPending = true;
  wizard.provider = provider;
  const label = state.providers.find((item) => item.id === provider)?.label || provider;
  const id = suggestId(provider);
  const number = id.match(/-(\d+)$/)?.[1] || '1';
  const displayName = { codex: 'Codex', 'claude-code': 'Claude', antigravity: 'Antigravity', 'gemini-cli': 'Gemini' }[provider] || label;
  $$('#providerGrid [data-provider]').forEach((button) => { button.disabled = true; });
  try {
    const data = await api('/api/accounts', { method: 'POST', body: JSON.stringify({
      provider: wizard.provider,
      id,
      label: `${displayName} ${number}`,
    }) });
    applyAccounts(data);
    await openConnect(data.account.id);
  } catch (error) { toast(error.message, 'error'); }
  finally {
    accountCreationPending = false;
    $$('#providerGrid [data-provider]').forEach((button) => { button.disabled = false; });
  }
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
    : `<span class="wizard-pill warn">CLI não encontrada</span><code>${escapeHtml(setup.bin)}</code>${setup.install ? `<button type="button" class="secondary-button" id="wizardInstall">Instalar agora</button><small>O harness executa a instalação automaticamente na VPS.</small>` : '<small>Instale a CLI na VPS e informe o caminho em web-accounts.json.</small>'}`;
  $('#wizardInstall')?.addEventListener('click', () => startSession('install'));
  $('#wizardNotes').textContent = setup.notes || '';
  $('#wizardFlows').innerHTML = setup.flows.map((flow) => `<label class="wizard-flow"><input type="radio" name="wizardFlow" value="${escapeHtml(flow.id)}" ${flow.id === wizard.flowId ? 'checked' : ''} /> <span>${escapeHtml(flow.label)}</span></label>`).join('');
  $('#wizardFlows').hidden = setup.flows.length < 2;
  renderFlowSteps();
  $('#wizardStart').disabled = !installed || !setup.flows.length;
  $('#wizardStart').hidden = false;
  $('#wizardConfigure').hidden = !account?.loggedIn;
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
  wizard.catalog = null;
  $('#wizardModelSelect').replaceChildren(new Option('Padrão da CLI', ''));
  $('#wizardEffortSelect').replaceChildren(new Option('Padrão da CLI', ''));
  $('#wizardEffortSelect').disabled = true;
  $('#wizardSession').hidden = true;
  const { setup } = await api(`/api/accounts/${encodeURIComponent(accountId)}/setup`);
  wizard.setup = setup;
  wizard.flowId = setup.flows[0]?.id || '';
  showStep('connect');
  renderConnect();
}

async function startSession(kind) {
  const button = kind === 'install' ? $('#wizardInstall') : $('#wizardStart');
  if (wizard.starting) return;
  const account = state.accounts.find((item) => item.id === wizard.accountId);
  if (kind === 'login' && account?.loggedIn) {
    if (!window.confirm('Esta conta já está conectada. Reconectar apaga o login atual dela e inicia um novo. Continuar?')) return;
  }
  wizard.starting = true;
  if (button) button.disabled = true;
  if (kind === 'install') {
    wizard.session = { id: '', kind, status: 'running', startedAt: Date.now(), hints: { links: [], codes: [] }, output: '' };
    $('#wizardTerminal').replaceChildren();
    renderSessionState(wizard.session);
  }
  try {
    if (kind === 'login' && account?.loggedIn) applyAccounts(await api(`/api/accounts/${encodeURIComponent(wizard.accountId)}/logout`, { method: 'POST', body: '{}' }));
    await loadXterm();
    const path = kind === 'install' ? 'install' : 'login';
    const { session } = await api(`/api/accounts/${encodeURIComponent(wizard.accountId)}/${path}`, { method: 'POST', body: JSON.stringify({ flowId: wizard.flowId }) });
    attachSession(session);
    // A state change may have arrived over SSE before this response: read it once.
    const { session: current } = await api(`/api/login-sessions/${session.id}`);
    if (wizard.session?.id === current.id && current.status !== 'running') onLoginState({ sessionId: current.id, ...current });
  } catch (error) {
    if (kind === 'install') {
      wizard.session = { id: '', kind, status: 'failed', startedAt: Date.now(), hints: { links: [], codes: [] }, detail: error.message };
      renderSessionState(wizard.session);
    }
    toast(error.message, 'error');
  }
  finally {
    wizard.starting = false;
    if (button) button.disabled = kind === 'install' && wizard.session?.status === 'running';
  }
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
  const installRunning = session.kind === 'install' && session.status === 'running';
  const messages = {
    running: session.kind === 'install'
      ? `Instalando automaticamente na VPS · ${formatElapsed(session.startedAt)}`
      : 'Aguardando você concluir o login. O harness detecta sozinho quando terminar.',
    success: session.detail || 'Concluído.',
    failed: session.detail || 'Não deu certo.',
    stopped: session.detail || 'Encerrada.',
  };
  const status = $('#wizardSessionStatus');
  status.textContent = messages[session.status] || session.detail || '';
  status.className = `wizard-session-status ${session.status}`;
  renderHints(session.hints);
  const running = session.status === 'running';
  $('#wizardInstallNote').hidden = !installRunning;
  $('#wizardInputForm').hidden = !running || session.kind === 'install';
  $('#wizardStart').hidden = running;
  $('#wizardFlows').classList.toggle('locked', running);
  $('#wizardKeys').hidden = !running || session.kind === 'install';
  const installButton = $('#wizardInstall');
  if (installButton) {
    installButton.disabled = installRunning || wizard.starting;
    if (session.kind === 'install') installButton.textContent = installRunning ? 'Instalação em andamento…' : session.status === 'failed' ? 'Tentar novamente' : 'Instalar agora';
  }
  clearInterval(installProgressTimer);
  installProgressTimer = null;
  if (installRunning) {
    const sessionId = session.id;
    installProgressTimer = setInterval(() => {
      if (wizard.session?.kind !== 'install' || wizard.session.status !== 'running' || wizard.session.id !== sessionId) {
        clearInterval(installProgressTimer);
        installProgressTimer = null;
        return;
      }
      status.textContent = `Instalando automaticamente na VPS · ${formatElapsed(session.startedAt)}`;
    }, 1000);
  }
}

function formatElapsed(startedAt) {
  const total = Math.max(0, Math.floor((Date.now() - (Number(startedAt) || Date.now())) / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = String(total % 60).padStart(2, '0');
  return `${minutes}:${seconds}`;
}

async function sendInput(data) {
  if (!wizard.session || wizard.session.status !== 'running') return;
  try { await api(`/api/login-sessions/${wizard.session.id}/input`, { method: 'POST', body: JSON.stringify({ data }) }); }
  catch (error) { toast(error.message, 'error'); }
}

async function finishConnected() {
  if (wizard.finishing) return;
  wizard.finishing = true;
  try {
    await refreshAccounts().catch(() => {});
    const account = state.accounts.find((item) => item.id === wizard.accountId);
    await loadModelSettings(account);
  } finally { wizard.finishing = false; }
}

function modelForSelection(modelId) {
  return wizard.catalog?.models?.find((item) => item.id === modelId) || null;
}

function renderEffortOptions(model, currentEffort = '') {
  const select = $('#wizardEffortSelect');
  const efforts = model?.efforts || [];
  select.replaceChildren(new Option(model?.effortEncoded ? 'Incluído no modelo' : 'Padrão da CLI', ''));
  if (model?.effortEncoded) {
    select.value = '';
    select.disabled = true;
    return;
  }
  for (const effort of efforts) select.add(new Option(effort, effort));
  if (currentEffort && !efforts.includes(currentEffort)) select.add(new Option(`${currentEffort} · configuração atual`, currentEffort));
  select.value = currentEffort || '';
  select.disabled = !model || efforts.length === 0;
}

function renderModelOptions(catalog, account) {
  const select = $('#wizardModelSelect');
  const models = [...(catalog.models || [])];
  if (account?.model && !models.some((item) => item.id === account.model)) {
    models.unshift({ id: account.model, label: `${account.model} · configuração atual`, efforts: [] });
  }
  select.replaceChildren(new Option('Padrão da CLI', ''));
  for (const model of models) select.add(new Option(`${model.label || model.id}${model.isDefault ? ' · padrão' : ''}`, model.id));
  select.value = account?.model && models.some((item) => item.id === account.model) ? account.model : '';
  const selectedModel = modelForSelection(select.value);
  renderEffortOptions(selectedModel, account?.effort || selectedModel?.defaultEffort || '');
  $('#wizardModelsNote').textContent = catalog.note || 'Sem catálogo disponível; deixe no padrão da CLI.';
  $('#wizardModelsSource').textContent = catalog.source ? `Origem: ${catalog.source}` : '';
}

async function loadModelSettings(account = state.accounts.find((item) => item.id === wizard.accountId), { refresh = false } = {}) {
  const previousModel = $('#wizardModelSelect').value;
  const previousEffort = $('#wizardEffortSelect').value;
  showStep('models');
  $('#wizardModelsNote').textContent = 'Consultando os modelos disponíveis…';
  $('#wizardModelsSource').textContent = '';
  $('#wizardSaveModels').disabled = true;
  try {
    wizard.catalog = await api(`/api/accounts/${encodeURIComponent(wizard.accountId)}/models${refresh ? '?refresh=1' : ''}`);
  } catch (error) {
    wizard.catalog = { models: [], source: '', note: `${error.message} Você ainda pode manter o padrão da CLI.` };
  }
  renderModelOptions(wizard.catalog, account);
  const selectedModel = modelForSelection(previousModel || account?.model) ? (previousModel || account?.model) : '';
  $('#wizardModelSelect').value = selectedModel;
  const selected = modelForSelection(selectedModel);
  renderEffortOptions(selected, previousEffort || account?.effort || selected?.defaultEffort || '');
  $('#wizardSaveModels').disabled = false;
}

function updateEffortChoices(modelId) {
  const account = state.accounts.find((item) => item.id === wizard.accountId);
  const currentEffort = $('#wizardEffortSelect').value || account?.effort || '';
  const model = modelForSelection(modelId);
  const selected = model;
  const keepEffort = selected?.effortEncoded ? '' : selected?.efforts?.includes(currentEffort) ? currentEffort : selected?.defaultEffort || (account?.model === modelId ? currentEffort : '');
  renderEffortOptions(selected, keepEffort);
}

async function saveModelSettings(event) {
  event.preventDefault();
  const button = $('#wizardSaveModels');
  button.disabled = true;
  try {
    const data = await api(`/api/accounts/${encodeURIComponent(wizard.accountId)}`, {
      method: 'POST',
      body: JSON.stringify({ model: $('#wizardModelSelect').value, effort: $('#wizardEffortSelect').value }),
    });
    applyAccounts(data);
    const index = state.accounts.findIndex((account) => account.id === wizard.accountId);
    const account = state.accounts[index];
    $('#wizardDoneTitle').textContent = `${account?.label || 'Conta'} conectada`;
    $('#wizardDoneText').textContent = index >= 0 ? `Configuração salva. A conta está na posição ${index + 1} da fila. Você pode mudar a ordem no painel Contas e fila.` : 'Configuração salva.';
    showStep('done');
  } catch (error) { toast(error.message, 'error'); }
  finally { button.disabled = false; }
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
export async function openWizard({ accountId = '', configureModels = false } = {}) {
  wizard.finishing = false;
  renderProviders();
  $('#accountWizard').showModal();
  if (accountId) {
    try {
      await openConnect(accountId);
      if (configureModels) await loadModelSettings();
    }
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
  $('#wizardFlows').addEventListener('change', (event) => { wizard.flowId = event.target.value; renderFlowSteps(); });
  $('#wizardStart').addEventListener('click', () => startSession('login'));
  $('#wizardConfigure').addEventListener('click', () => loadModelSettings());
  $('#wizardModelSelect').addEventListener('change', (event) => updateEffortChoices(event.target.value));
  $('#wizardModelsRefresh').addEventListener('click', () => loadModelSettings(undefined, { refresh: true }));
  $('#wizardModelsForm').addEventListener('submit', saveModelSettings);
  $('#wizardModelsSkip').addEventListener('click', () => {
    const account = state.accounts.find((item) => item.id === wizard.accountId);
    $('#wizardDoneTitle').textContent = `${account?.label || 'Conta'} conectada`;
    $('#wizardDoneText').textContent = 'A configuração atual da conta foi mantida.';
    showStep('done');
  });
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
    clearInterval(installProgressTimer);
    installProgressTimer = null;
    wizard.term?.dispose();
    wizard.term = null;
    wizard.session = null;
    wizard.starting = false;
    $('#wizardTerminal').replaceChildren();
  });
  installIcons($('#accountWizard'));
}
