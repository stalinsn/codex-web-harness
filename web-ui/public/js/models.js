// Model and reasoning-effort selectors.
import { updateComposerControls } from './composer.js';
import { $ } from './dom.js';
import { effortLabel } from './format.js';
import { setProviderClass } from './responders.js';
import { state } from './state.js';

export function getSelectedModel() { return state.models.find((model) => model.id === state.modelId) || state.models.find((model) => model.isDefault) || state.models[0] || null; }

export function populateModels() {
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
  updateEfforts();
  updateComposerControls();
}

export function updateEfforts() {
  const model = getSelectedModel();
  const select = $('#effortSelect');
  select.replaceChildren();
  if (!model) return;
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
    // Busy answering the open conversation is not "unavailable" from this chat's point of view.
    const answeringHere = Boolean(state.selectedThreadId) && account.busyWith === `chat:${state.selectedThreadId}`;
    option.textContent = `${account.label}${account.available || account.primary || answeringHere ? '' : ' · indisponível'}`;
    return option;
  }));
  select.value = state.chatAccountId;
  // Only worth the space once there is another account to choose.
  $('.account-wrap')?.classList.toggle('hidden', choices.length <= 1);
  applyChatAccount();
}

/** Model and effort only apply to the Codex account; other accounts use their own settings. */
export function applyChatAccount() {
  const account = state.accounts.find((item) => item.id === state.chatAccountId);
  const external = Boolean(account && !account.primary);
  $('.model-wrap')?.classList.toggle('hidden', external);
  $('.effort-wrap')?.classList.toggle('hidden', external);
  $('.account-wrap')?.classList.toggle('external', external);
  setProviderClass($('.account-wrap'), account?.provider || 'codex');
  const select = $('#accountSelect');
  if (select) select.title = external ? [account.providerLabel, account.model].filter(Boolean).join(' · ') : 'Codex (conta principal)';
}

export function setChatAccount(accountId) {
  state.chatAccountId = accountId || 'codex';
  try { localStorage.setItem('codex-chat-account', state.chatAccountId); } catch { /* optional */ }
  const select = $('#accountSelect');
  if (select && [...select.options].some((option) => option.value === state.chatAccountId)) select.value = state.chatAccountId;
  applyChatAccount();
}
