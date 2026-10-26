// Discover model and reasoning choices using each provider's installed CLI/API.
// Provider credentials remain in their isolated account directories.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from '../config.mjs';
import { accountEnv, commandFor } from './cli-runner.mjs';

const execFileAsync = promisify(execFile);
const CLAUDE_MODELS = ['best', 'fable', 'opus', 'sonnet', 'haiku'];
const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const EFFORT_ORDER = ['low', 'medium', 'high', 'xhigh', 'max'];
const MODEL_EFFORT_SUFFIX = /-(low|medium|high|xhigh|max)$/i;

function parseJsonOutput(output) {
  const value = String(output || '').trim();
  try { return JSON.parse(value); } catch { /* CLI may include a short preamble. */ }
  const openers = [value.indexOf('['), value.indexOf('{')].filter((index) => index >= 0);
  const first = openers.length ? Math.min(...openers) : -1;
  const last = Math.max(value.lastIndexOf(']'), value.lastIndexOf('}'));
  if (first >= 0 && last > first) {
    try { return JSON.parse(value.slice(first, last + 1)); } catch { /* return null below */ }
  }
  return null;
}

function normalizeEfforts(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => typeof item === 'string' ? item : item?.reasoningEffort || item?.id || item?.name || item?.value).filter((item) => typeof item === 'string' && item))];
}

function findArray(payload, keys, depth = 0) {
  if (!payload || typeof payload !== 'object' || depth > 7) return null;
  if (Array.isArray(payload)) return payload;
  for (const key of keys) if (Array.isArray(payload[key])) return payload[key];
  for (const value of Object.values(payload)) {
    const found = findArray(value, keys, depth + 1);
    if (found) return found;
  }
  return null;
}

function normalizeModels(payload) {
  const items = findArray(payload, ['models', 'availableModels', 'available_models', 'data', 'items']);
  if (!items) return [];
  const seen = new Set();
  const models = items.map((item) => {
    if (typeof item === 'string') return { id: item, label: item, efforts: [], defaultEffort: '' };
    const id = item?.id || item?.model || item?.slug || item?.name;
    if (typeof id !== 'string' || !id || seen.has(id)) return null;
    seen.add(id);
    return {
      id,
      label: item.displayName || item.display_name || item.label || item.name || id,
      isDefault: Boolean(item.isDefault || item.default || item.is_default),
      efforts: normalizeEfforts(item.supportedReasoningEfforts || item.supported_reasoning_efforts || item.reasoningEfforts || item.efforts),
      defaultEffort: item.defaultReasoningEffort || item.default_reasoning_effort || '',
    };
  }).filter(Boolean);
  return inferModelEfforts(models);
}

function inferModelEfforts(models) {
  const groups = new Map();
  const effortFor = (model) => model.id.match(MODEL_EFFORT_SUFFIX)?.[1]?.toLowerCase()
    || model.label.match(/\((low|medium|high|xhigh|max)\)\s*$/i)?.[1]?.toLowerCase()
    || '';
  for (const model of models) {
    const effort = effortFor(model);
    if (!effort) continue;
    const family = model.id.replace(MODEL_EFFORT_SUFFIX, '');
    groups.set(family, [...(groups.get(family) || []), effort]);
  }
  return models.map((model) => {
    const effort = effortFor(model);
    const family = model.id.replace(MODEL_EFFORT_SUFFIX, '');
    const inferred = EFFORT_ORDER.filter((item) => (groups.get(family) || []).includes(item));
    return {
      ...model,
      efforts: model.efforts.length ? model.efforts : inferred,
      defaultEffort: model.defaultEffort || effort,
    };
  });
}

function parseTextModels(output) {
  const models = [];
  for (const line of String(output || '').split(/\r?\n/)) {
    const match = line.trim().match(/^([a-z0-9][a-z0-9._-]*[._-][a-z0-9._-]*)[\t ]+(.+?)\s*$/i);
    if (!match) continue;
    models.push({ id: match[1], label: match[2], isDefault: false, efforts: [], defaultEffort: '' });
  }
  return inferModelEfforts(models);
}

function normalizeEffortPayload(payload) {
  const direct = normalizeEfforts(payload?.supportedReasoningEfforts || payload?.supported_reasoning_efforts || payload?.availableEfforts || payload?.available_efforts || payload?.efforts);
  if (direct.length) return direct;
  const nested = findArray(payload, ['supportedReasoningEfforts', 'supported_reasoning_efforts', 'availableEfforts', 'available_efforts', 'efforts']);
  const normalized = normalizeEfforts(nested);
  if (normalized.length) return normalized;
  const text = [payload?.response, payload?.text, payload?.message, payload?.result].filter((value) => typeof value === 'string').join('\n');
  const available = text.match(/available(?:\s+(?:effort|reasoning)?\s*(?:levels|tiers))?\s*[:(]\s*([^\n)]+)/i)?.[1];
  return available ? [...new Set([...available.matchAll(/\b(low|medium|high|xhigh|max)\b/gi)].map((match) => match[1].toLowerCase()))] : [];
}

async function runText(account, args, timeout = 12000) {
  const { stdout } = await execFileAsync(commandFor(account), args, {
    cwd: config.homeDir,
    env: accountEnv(account),
    timeout,
    maxBuffer: 512 * 1024,
    windowsHide: true,
  });
  return stdout;
}

async function codexCatalog(account, accounts) {
  const server = accounts.codexServerFor(account);
  const deadline = Date.now() + 20000;
  while (!server.ready && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
  if (!server.ready) throw new Error('O app-server do Codex ainda está iniciando.');
  await server.refreshAccountData(true);
  const models = (server.models || []).map((item) => ({
    id: item.id || item.model,
    label: item.displayName || item.model || item.id,
    isDefault: Boolean(item.isDefault),
    efforts: normalizeEfforts(item.supportedReasoningEfforts),
    defaultEffort: item.defaultReasoningEffort || '',
  })).filter((item) => item.id);
  return { models, source: 'Codex app-server', note: models.length ? 'Catálogo do cliente Codex. Ele pode não refletir o acesso liberado para a conta; o Codex confirma isso ao iniciar uma tarefa.' : 'O Codex não informou modelos nesta sessão; você pode usar o padrão da CLI.' };
}

async function antigravityCatalog(account) {
  let models = [];
  try {
    const output = await runText(account, ['models']);
    models = normalizeModels(parseJsonOutput(output)) || [];
    if (!models.length) models = parseTextModels(output);
  } catch { /* Keep the safe CLI default if this version cannot list models. */ }

  return {
    models,
    source: 'Antigravity CLI',
    note: models.length
      ? 'Modelos detectados pelo comando agy models. As variantes de esforço listadas foram identificadas na própria saída da CLI.'
      : 'Esta versão do agy não retornou uma lista legível. Você pode usar o padrão da CLI; nenhuma opção foi presumida.',
  };
}

function claudeCatalog() {
  return {
    models: CLAUDE_MODELS.map((id) => ({ id, label: ({ best: 'Best (melhor disponível)', fable: 'Fable', opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku' })[id], efforts: CLAUDE_EFFORTS, defaultEffort: '' })),
    source: 'Opções documentadas da Claude Code CLI',
    note: 'Aliases e níveis aceitos pela CLI. O plano e o modelo escolhido podem limitar a disponibilidade; a própria Claude confirma o acesso ao iniciar a tarefa.',
  };
}

export async function getAccountModelCatalog(account, accounts) {
  if (account.provider === 'codex') return codexCatalog(account, accounts);
  if (account.provider === 'antigravity') return antigravityCatalog(account);
  if (account.provider === 'claude-code') return claudeCatalog();
  return {
    models: [],
    source: 'Padrão da CLI',
    note: 'Esta CLI não fornece uma lista de modelos ao harness. Deixe os campos no padrão para usar as escolhas definidas por ela.',
  };
}

export { normalizeEffortPayload, normalizeModels, parseTextModels };
