// Model and reasoning-effort selectors.
import { api } from './api.js';
import { updateComposerControls } from './composer.js';
import { $ } from './dom.js';
import { effortLabel } from './format.js';
import { setProviderClass } from './responders.js';
import { syncComposerSelect } from './custom-selects.js';
import { state } from './state.js';

const chatCatalogs = new Map();
const catalogRequests = new Map();
const CHAT_CATALOG_TTL_MS = 55_000;

const isExternalChat = () => state.chatAccountId && state.chatAccountId !== 'codex';
const chatModelKey = (accountId) => `codex-chat-model:${accountId}`;
const chatEffortKey = (accountId) => `codex-chat-effort:${accountId}`;

function loadChatPreference(key) {
  try { return localStorage.getItem(key) || ''; } catch { return ''; }
}

function saveChatPreference(key, value) {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch { /* Browser storage is optional. */ }
}

function effortsOf(model) {
  return (model?.supportedReasoningEfforts || []).map((item) => item.reasoningEffort || item).filter(Boolean);
}

export function getSelectedModel() {
  if (isExternalChat()) {
    return state.chatModels.find((model) => model.id === state.chatModelId)
      || state.chatModels.find((model) => model.isDefault)
      || null;
  }
  return state.models.find((model) => model.id === state.modelId) || state.models.find((model) => model.isDefault) || state.models[0] || null;
}

export function getComposerModelSelection() {
  return isExternalChat()
    ? { model: state.chatModelId || '', effort: state.chatEffort || '' }
    : { model: state.modelId || '', effort: state.effort || '' };
}

export function populateModels() {
  if (isExternalChat()) {
    const account = state.accounts.find((item) => item.id === state.chatAccountId);
    if (account && !account.primary) {
      renderExternalModels(account);
      return;
    }
  }
  const select = $('#modelSelect');
  select.replaceChildren();
  state.models.forEach((model) => {
    const option = document.createElement('option');
    option.value = model.id;
    option.textContent = model.displayName || model.model || model.id;
    select.append(option);
  });
  if (!state.models.some((model) => model.id === state.modelId)) state.modelId = getSelectedModel()?.id || '';
  select.value = state.modelId;
  syncComposerSelect(select);
  updateEfforts();
  updateComposerControls();
}

function applyAccountModelSettings(account, catalog) {
  let models = (catalog.models || []).map((item) => {
    const encoded = account.provider === 'antigravity' && (item.effortEncoded || /-(low|medium|high|xhigh|max)$/i.test(item.id || ''));
    return {
      ...item,
      displayName: item.label || item.displayName || item.id,
      supportedReasoningEfforts: encoded ? [] : (item.efforts || item.supportedReasoningEfforts || []),
      defaultReasoningEffort: encoded ? '' : (item.defaultEffort || item.defaultReasoningEffort || ''),
      effortEncoded: encoded,
      toolSupport: item.toolSupport || 'unknown',
    };
  });

  // Keep an account's configured choice available even if its CLI catalog is incomplete.
  if (account.model && !models.some((item) => item.id === account.model)) {
    const encoded = account.provider === 'antigravity' && /-(low|medium|high|xhigh|max)$/i.test(account.model);
    models = [{
      id: account.model,
      displayName: `${account.model} · configuração atual`,
      supportedReasoningEfforts: encoded ? [] : (account.effort ? [account.effort] : []),
      defaultReasoningEffort: encoded ? '' : (account.effort || ''),
      effortEncoded: encoded,
      toolSupport: 'unknown',
    }, ...models];
  }

  state.chatModels = models;
  state.chatModelAccountId = account.id;
  const listedIds = new Set((catalog.models || []).map((item) => item.id));
  const savedModel = loadChatPreference(chatModelKey(account.id));
  const selectedModel = (savedModel && listedIds.has(savedModel) ? savedModel : '')
    || models.find((item) => item.isDefault)?.id
    || (account.model && listedIds.has(account.model) ? account.model : '')
    || (!catalog.models?.length ? account.model || '' : '');
  state.chatModelId = selectedModel;
  const model = models.find((item) => item.id === selectedModel);
  const supported = effortsOf(model);
  const savedEffort = loadChatPreference(chatEffortKey(account.id));
  const configuredEffort = account.provider === 'antigravity' && model?.effortEncoded ? '' : account.effort || '';
  state.chatEffort = supported.includes(savedEffort) ? savedEffort
    : supported.includes(configuredEffort) ? configuredEffort
      : model?.defaultReasoningEffort || supported[0] || '';
}

function renderExternalModels(account) {
  const select = $('#modelSelect');
  select.replaceChildren(new Option('Padrão da CLI', ''));
  state.chatModels.forEach((model) => select.add(new Option(model.displayName, model.id)));
  select.value = state.chatModelId;
  syncComposerSelect(select);
  updateEfforts();
  updateModelCompatibility();
  $('.model-wrap')?.classList.remove('hidden');
  $('.model-wrap')?.classList.add('external-model');
  select.title = [account.providerLabel, state.chatModels.find((item) => item.id === state.chatModelId)?.displayName].filter(Boolean).join(' · ');
  updateComposerControls();
}

function showCatalogLoading(account) {
  const select = $('#modelSelect');
  select.replaceChildren(new Option('Carregando modelos…', ''));
  select.value = '';
  syncComposerSelect(select);
  state.chatModels = [];
  state.chatModelId = '';
  state.chatEffort = '';
  state.chatModelsLoading = true;
  $('#modelCompatibilityNote')?.classList.add('hidden');
  $('.model-wrap')?.classList.remove('hidden');
  $('.model-wrap')?.classList.add('external-model');
  $('.effort-wrap')?.classList.add('hidden');
  select.title = `${account.providerLabel || account.provider} · carregando opções`;
  updateComposerControls();
}

async function loadExternalCatalog(account) {
  const cachedEntry = chatCatalogs.get(account.id);
  const cached = cachedEntry?.expiresAt > Date.now() ? cachedEntry.catalog : null;
  if (cached) {
    if (state.chatModelAccountId !== account.id || !state.chatModels.length) applyAccountModelSettings(account, cached);
    renderExternalModels(account);
    state.chatModelsLoading = false;
    updateComposerControls();
    return;
  }
  if (!catalogRequests.has(account.id)) {
    const request = api(`/api/accounts/${encodeURIComponent(account.id)}/models`)
      .catch((error) => ({ models: [], note: error.message, source: '' }))
      .then((catalog) => {
        chatCatalogs.set(account.id, { catalog, expiresAt: Date.now() + CHAT_CATALOG_TTL_MS });
        return catalog;
      })
      .finally(() => catalogRequests.delete(account.id));
    catalogRequests.set(account.id, request);
  }
  showCatalogLoading(account);
  const catalog = await catalogRequests.get(account.id);
  if (state.chatAccountId !== account.id) return;
  applyAccountModelSettings(account, catalog);
  state.chatModelsLoading = false;
  renderExternalModels(account);
}

export function updateEfforts() {
  const model = getSelectedModel();
  const select = $('#effortSelect');
  select.replaceChildren();
  if (isExternalChat()) {
    const account = state.accounts.find((item) => item.id === state.chatAccountId);
    const supported = effortsOf(model);
    const encoded = account?.provider === 'antigravity' && Boolean(model?.effortEncoded);
    $('.effort-wrap')?.classList.toggle('hidden', !supported.length && !encoded);
    if (encoded) {
      select.add(new Option('Incluído no modelo', ''));
      select.disabled = true;
      select.title = 'O esforço já está definido pelo modelo selecionado.';
      state.chatEffort = '';
    } else if (supported.length) {
      supported.forEach((value) => select.add(new Option(effortLabel(value), value)));
      if (!supported.includes(state.chatEffort)) state.chatEffort = model.defaultReasoningEffort || supported[0] || '';
      select.value = state.chatEffort;
      select.disabled = false;
      select.title = `Raciocínio ${effortLabel(state.chatEffort).toLowerCase()}`;
    } else {
      state.chatEffort = '';
      select.disabled = true;
    }
    syncComposerSelect(select);
    return;
  }

  if (!model) { syncComposerSelect(select); return; }
  const supported = model.supportedReasoningEfforts || [];
  supported.forEach((item) => {
    const value = item.reasoningEffort || item;
    const option = document.createElement('option');
    option.value = value;
    option.textContent = effortLabel(value);
    select.append(option);
  });
  if (!supported.some((item) => (item.reasoningEffort || item) === state.effort)) state.effort = model.defaultReasoningEffort || (supported[0]?.reasoningEffort || supported[0]) || '';
  select.value = state.effort;
  select.title = supported.find((item) => (item.reasoningEffort || item) === state.effort)?.description || `Raciocínio ${effortLabel(state.effort).toLowerCase()}`;
  syncComposerSelect(select);
}

function updateModelCompatibility() {
  const note = $('#modelCompatibilityNote');
  if (!note) return;
  const account = state.accounts.find((item) => item.id === state.chatAccountId);
  if (!account || account.primary) {
    note.classList.add('hidden');
    note.removeAttribute('data-tone');
    return;
  }
  const model = getSelectedModel();
  const support = model?.toolSupport || 'unknown';
  note.classList.remove('hidden');
  note.dataset.tone = support === 'unsupported' ? 'warning' : support === 'supported' ? 'confirmed' : 'unknown';
  if (support === 'supported') {
    note.textContent = 'O catálogo declara suporte a ferramentas para este modelo. As permissões da CLI continuam sendo aplicadas por conta.';
  } else if (support === 'unsupported') {
    note.textContent = 'O catálogo declara que este modelo não oferece ferramentas. Use-o para conversa; tarefas com comandos ou arquivos podem falhar.';
  } else if (account.provider === 'antigravity') {
    note.textContent = 'A Antigravity CLI oferece ferramentas de agente, mas não informa compatibilidade por modelo. O harness não presume esse suporte.';
  } else {
    note.textContent = 'O catálogo não informa suporte a ferramentas para este modelo. O harness não presume compatibilidade; consulte o histórico de erros após executar.';
  }
}

export function setComposerModel(modelId) {
  if (isExternalChat()) {
    state.chatModelId = modelId || '';
    saveChatPreference(chatModelKey(state.chatAccountId), state.chatModelId);
    updateEfforts();
    updateModelCompatibility();
    updateComposerControls();
    return;
  }
  state.modelId = modelId;
  localStorage.setItem('codex-model', state.modelId);
  updateEfforts();
  localStorage.setItem('codex-effort', state.effort);
  updateComposerControls();
}

export function setComposerEffort(effort) {
  if (isExternalChat()) {
    state.chatEffort = effort || '';
    saveChatPreference(chatEffortKey(state.chatAccountId), state.chatEffort);
    return;
  }
  state.effort = effort;
  localStorage.setItem('codex-effort', state.effort);
}

/** Accounts the next message can go to: Codex (the chat's own) plus connected accounts. */
export function populateAccountSelect() {
  const select = $('#accountSelect');
  if (!select) return;
  const choices = state.accounts.filter((account) => account.primary || (account.enabled && account.loggedIn !== false));
  if (!choices.some((account) => account.id === state.chatAccountId)) state.chatAccountId = 'codex';
  select.replaceChildren(...(choices.length ? choices : [{ id: 'codex', label: 'Codex', available: true, primary: true }]).map((account) => {
    const option = document.createElement('option');
    option.value = account.id;
    const answeringHere = Boolean(state.selectedThreadId) && account.busyWith === `chat:${state.selectedThreadId}`;
    option.textContent = `${account.label}${account.available || account.primary || answeringHere ? '' : ' · indisponível'}`;
    return option;
  }));
  select.value = state.chatAccountId;
  syncComposerSelect(select);
  $('.account-wrap')?.classList.toggle('hidden', choices.length <= 1);
  applyChatAccount();
}

/** Show the model controls for the selected provider and load its actual CLI catalog. */
export function applyChatAccount() {
  const account = state.accounts.find((item) => item.id === state.chatAccountId);
  const external = Boolean(account && !account.primary);
  $('.account-wrap')?.classList.toggle('external', external);
  setProviderClass($('.account-wrap'), account?.provider || 'codex');
  const select = $('#accountSelect');
  if (select) {
    select.title = external ? [account.providerLabel, account.model].filter(Boolean).join(' · ') : 'Codex (conta principal)';
    syncComposerSelect(select);
  }
  if (external) {
    $('.model-wrap')?.classList.remove('hidden');
    loadExternalCatalog(account).catch(() => {});
  } else {
    state.chatModelsLoading = false;
    $('.model-wrap')?.classList.remove('external-model');
    $('.model-wrap')?.classList.remove('hidden');
    $('.effort-wrap')?.classList.remove('hidden');
    $('#modelCompatibilityNote')?.classList.add('hidden');
    populateModels();
  }
}

export function setChatAccount(accountId) {
  state.chatAccountId = accountId || 'codex';
  try { localStorage.setItem('codex-chat-account', state.chatAccountId); } catch { /* optional */ }
  const select = $('#accountSelect');
  if (select && [...select.options].some((option) => option.value === state.chatAccountId)) select.value = state.chatAccountId;
  syncComposerSelect(select);
  applyChatAccount();
  updateComposerControls();
}
