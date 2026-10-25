// Model and reasoning-effort selectors.
import { updateComposerControls } from './composer.js';
import { $ } from './dom.js';
import { effortLabel } from './format.js';
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
