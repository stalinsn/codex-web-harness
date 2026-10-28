// Intermediate turn activity: commands, reasoning summaries, tools and sub-agents.
import { AGENT_COLORS } from './config.js';
import { $, $$, icons } from './dom.js';
import { effortLabel, formatDuration } from './format.js';
import { markdown } from './markdown.js';
import { scrollConversation } from './messages.js';
import { state } from './state.js';

export function updateTurnIntermediateTitle(group) {
  const isLive = state.busy && group.turnId === (state.activeTurnId || 'active');
  const elapsed = group.durationMs ?? (isLive && state.turnStartedAtMs ? Date.now() - state.turnStartedAtMs : 0);
  group.card.classList.toggle('is-live', isLive);
  group.title.textContent = isLive
    ? (elapsed > 0 ? `Em andamento · ${formatDuration(elapsed)}` : 'Progresso em andamento')
    : (elapsed > 0 ? `Trabalhou por ${formatDuration(elapsed)}` : 'Atividades intermediárias');
  group.hint.textContent = group.card.open ? 'Recolher' : 'Ver detalhes';
}

function ensureTurnIntermediates(turnId, append = true) {
  const normalizedTurnId = turnId || state.activeTurnId || 'active';
  const groupKey = `${state.selectedThreadId}:${normalizedTurnId}:${state.progressSegments.get(normalizedTurnId) || 0}`;
  let group = state.turnIntermediates.get(groupKey);
  if (group) return group;

  const card = document.createElement('details');
  card.className = 'activity-card turn-intermediates';
  card.open = state.busy && normalizedTurnId === (state.activeTurnId || 'active');
  const heading = document.createElement('summary');
  heading.className = 'activity-heading';
  const icon = document.createElement('span'); icon.className = 'icon';
  icon.innerHTML = `<svg viewBox="0 0 24 24">${icons.bolt}</svg>`;
  const title = document.createElement('span'); title.className = 'turn-intermediates-title';
  const hint = document.createElement('span'); hint.className = 'turn-intermediates-hint';
  const content = document.createElement('div'); content.className = 'turn-intermediate-content';
  heading.append(icon, title, hint); card.append(heading, content);
  card.addEventListener('toggle', () => updateTurnIntermediateTitle(group));
  group = { key: groupKey, card, title, hint, content, items: new Set(), turnId: normalizedTurnId, durationMs: null };
  state.turnIntermediates.set(groupKey, group);

  const finalAnswer = normalizedTurnId === 'active' ? null : $$('.message.assistant', $('#messages')).find((message) => message.dataset.turnId === normalizedTurnId && message.dataset.finalAnswer === 'true');
  if (finalAnswer) $('#messages').insertBefore(card, finalAnswer);
  else if (append) $('#messages').append(card);
  updateTurnIntermediateTitle(group);
  return group;
}

export function startProgressSegment(turnId) {
  const id = turnId || state.activeTurnId || 'active';
  if ([...state.turnIntermediates.values()].some((group) => group.turnId === id)) {
    state.progressSegments.set(id, (state.progressSegments.get(id) || 0) + 1);
  }
}

export function registerIntermediate(turnId, itemId, append = true) {
  const group = ensureTurnIntermediates(turnId, append);
  group.items.add(String(itemId || `item-${group.items.size + 1}`));
  updateTurnIntermediateTitle(group);
  return group;
}

function registerAction(turnGroup, itemId, status = 'completed') {
  let group = turnGroup.actionsGroup;
  if (!group) {
    const card = document.createElement('details');
    card.className = 'activity-card action-group';
    const heading = document.createElement('summary');
    heading.className = 'activity-heading';
    const icon = document.createElement('span'); icon.className = 'icon';
    icon.innerHTML = `<svg viewBox="0 0 24 24">${icons.terminal}</svg>`;
    const title = document.createElement('span'); title.className = 'action-group-title';
    const hint = document.createElement('span'); hint.className = 'action-group-hint';
    const content = document.createElement('div'); content.className = 'action-group-content';
    heading.append(icon, title, hint); card.append(heading, content);
    card.addEventListener('toggle', () => { hint.textContent = card.open ? 'Recolher ações' : 'Ver ações'; });
    group = { card, title, hint, content, items: new Map() };
    turnGroup.actionsGroup = group;
    turnGroup.content.append(card);
  }
  group.items.set(String(itemId || `action-${group.items.size + 1}`), status || 'completed');
  const statuses = [...group.items.values()];
  const running = statuses.filter((value) => ['inProgress', 'running', 'pending', 'started', 'interacted'].includes(value)).length;
  const failed = statuses.filter((value) => ['failed', 'errored'].includes(value)).length;
  group.title.textContent = `Ações · ${statuses.length}${running ? ` · ${running} em andamento` : ''}${failed ? ` · ${failed} com falha` : ''}`;
  group.hint.textContent = group.card.open ? 'Recolher ações' : 'Ver ações';
  return group;
}

function renderCommandActivity(item, append, turnId) {
  const key = `${state.selectedThreadId}:${item.id}`;
  const turnGroup = registerIntermediate(turnId, `command:${item.id}`, append);
  const actions = registerAction(turnGroup, `command:${item.id}`, item.status);
  const groupKey = turnGroup.key;
  let group = state.commandGroups.get(groupKey);
  if (!group) {
    const card = document.createElement('details');
    card.className = 'activity-card command-group';
    const heading = document.createElement('summary');
    heading.className = 'activity-heading';
    const icon = document.createElement('span'); icon.className = 'icon';
    icon.innerHTML = `<svg viewBox="0 0 24 24">${icons.terminal}</svg>`;
    const title = document.createElement('span');
    const hint = document.createElement('span'); hint.className = 'command-group-hint'; hint.textContent = 'Ver detalhes';
    const content = document.createElement('div'); content.className = 'command-list';
    heading.append(icon, title, hint); card.append(heading, content);
    card.addEventListener('toggle', () => { hint.textContent = card.open ? 'Recolher' : 'Ver detalhes'; });
    group = { card, title, content, items: new Map() };
    state.commandGroups.set(groupKey, group);
    if (append) actions.content.append(card);
  }
  let entry = state.activityCards.get(key);
  if (!entry) {
    entry = document.createElement('div'); entry.className = 'command-entry';
    const command = document.createElement('code'); command.className = 'command-name';
    const output = document.createElement('pre'); output.className = 'activity-output hidden';
    entry.append(command, output); group.content.append(entry);
    state.activityCards.set(key, entry);
  }
  const command = $('.command-name', entry);
  const output = $('.activity-output', entry);
  command.textContent = item.command || 'Comando';
  if (item.aggregatedOutput) { output.textContent = item.aggregatedOutput; entry.pendingOutput = ''; }
  output.classList.toggle('hidden', !output.textContent);
  group.items.set(key, item.status || 'inProgress');
  const statuses = [...group.items.values()];
  const running = statuses.some((status) => ['inProgress', 'running', 'pending'].includes(status));
  const failed = statuses.filter((status) => status === 'failed').length;
  group.title.textContent = `${running ? 'Comandos em execução' : 'Comandos executados'} · ${statuses.length}${failed ? ` · ${failed} falhou${failed > 1 ? 'ram' : ''}` : ''}`;
  if (append) scrollConversation();
  return entry;
}

function ensureReasoningGroup(turnId, append = true, itemId = '') {
  const turnGroup = registerIntermediate(turnId, `reasoning:${itemId || 'summary'}`, append);
  const normalizedTurnId = turnGroup.turnId;
  const groupKey = turnGroup.key;
  let group = state.reasoningGroups.get(groupKey);
  if (group) return group;

  const card = document.createElement('div');
  card.className = 'activity-card reasoning-group';
  const heading = document.createElement('div');
  heading.className = 'activity-heading';
  const icon = document.createElement('span'); icon.className = 'icon';
  icon.innerHTML = `<svg viewBox="0 0 24 24">${icons.bolt}</svg>`;
  const title = document.createElement('span'); title.className = 'reasoning-group-title';
  const content = document.createElement('div'); content.className = 'reasoning-steps';
  heading.append(icon, title); card.append(heading, content);
  group = { card, title, content, parts: new Map(), turnId: normalizedTurnId };
  state.reasoningGroups.set(groupKey, group);
  if (append) turnGroup.content.append(card);
  updateReasoningGroup(group);
  return group;
}

export function updateReasoningGroup(group) {
  const visibleParts = [...group.parts.values()].filter((part) => part.text.trim());
  visibleParts.forEach((part, index) => {
    part.number.textContent = `Etapa ${index + 1}`;
    part.row.hidden = false;
    part.body.innerHTML = markdown(part.text);
  });
  for (const part of group.parts.values()) {
    if (!part.text.trim()) part.row.hidden = true;
  }
  group.card.hidden = visibleParts.length === 0;
  group.title.textContent = `Resumo do raciocínio · ${visibleParts.length} ${visibleParts.length === 1 ? 'etapa' : 'etapas'}`;
}

export function setReasoningPart({ itemId, summaryIndex = 0, turnId = '', text = '', delta = false, append = true }) {
  const group = ensureReasoningGroup(turnId, append, itemId);
  const partKey = `${itemId || 'reasoning'}:${Number(summaryIndex) || 0}`;
  let part = group.parts.get(partKey);
  if (!part) {
    const row = document.createElement('section'); row.className = 'reasoning-step'; row.hidden = true;
    const number = document.createElement('span'); number.className = 'reasoning-step-number';
    const body = document.createElement('div'); body.className = 'reasoning-step-content';
    row.append(number, body); group.content.append(row);
    part = { row, number, body, text: '' };
    group.parts.set(partKey, part);
  }
  part.text = delta ? part.text + String(text || '') : String(text || '');
  updateReasoningGroup(group);
  if (append) scrollConversation();
  return group;
}

export function renderReasoningSummary(item, turnId = '', append = true) {
  const summary = Array.isArray(item.summary) ? item.summary : (typeof item.summary === 'string' ? [item.summary] : []);
  let rendered = false;
  summary.forEach((part, index) => {
    const text = typeof part === 'string' ? part : (typeof part?.text === 'string' ? part.text : '');
    if (!text.trim()) return;
    setReasoningPart({ itemId: item.id, summaryIndex: index, turnId, text, append });
    rendered = true;
  });
  return rendered;
}

export function rememberAgentThread(agentThreadId, details = {}) {
  const id = String(agentThreadId || '');
  if (!id) return null;
  const previous = state.agentThreads.get(id);
  const number = previous?.number || state.agentThreads.size + 1;
  const meta = {
    ...previous,
    ...Object.fromEntries(Object.entries(details).filter(([, value]) => value != null && value !== '')),
    number,
    color: previous?.color || AGENT_COLORS[(number - 1) % AGENT_COLORS.length],
  };
  state.agentThreads.set(id, meta);
  return meta;
}

function agentName(meta) {
  const pathName = String(meta?.agentPath || '').replace(/\\/g, '/').split('/').filter(Boolean).at(-1) || '';
  const readablePathName = pathName.replace(/\.(md|toml|json)$/i, '').split(/[_.-]+/).filter(Boolean).map((word) => word[0].toUpperCase() + word.slice(1)).join(' ');
  return meta?.nickname || readablePathName || `Agente ${meta?.number || ''}`.trim();
}

function agentRoleName(meta) {
  return [agentName(meta), meta?.role].filter(Boolean).join(' · ');
}

function agentStatusLabel(status) {
  const normalized = String(status || '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').toLowerCase();
  return ({ 'pending init': 'iniciando', running: 'trabalhando', interrupted: 'interrompido', completed: 'concluído', errored: 'falhou', shutdown: 'encerrado', 'not found': 'indisponível' })[normalized] || normalized || 'designado';
}

function refreshAgentActivityCards(agentThreadId) {
  for (const card of state.activityCards.values()) {
    if (card.dataset.agentThreadId === agentThreadId && card.agentActivityItem) {
      renderActivity(card.agentActivityItem, false, card.dataset.agentTurnId || '');
    }
  }
}

export function indexAgentThreads(turns) {
  for (const turn of turns || []) for (const item of turn.items || []) {
    if (item.type === 'subAgentActivity') {
      rememberAgentThread(item.agentThreadId, {
        agentPath: item.agentPath,
        model: item.model,
        reasoningEffort: item.reasoningEffort,
        kind: item.kind,
      });
    }
  }
  for (const turn of turns || []) for (const item of turn.items || []) {
    if (item.type !== 'collabToolCall') continue;
    const states = item.agentsStates && typeof item.agentsStates === 'object' ? item.agentsStates : {};
    const refs = Array.isArray(item.receiverAgents) ? item.receiverAgents : [];
    const ids = [...new Set([...(item.receiverThreadIds || []), ...Object.keys(states), ...refs.map((agent) => agent.threadId)].filter(Boolean))];
    for (const id of ids) {
      const ref = refs.find((agent) => agent.threadId === id);
      const agentState = states[id] || {};
      rememberAgentThread(id, {
        nickname: ref?.agentNickname,
        role: ref?.agentRole,
        status: agentState.status,
        message: agentState.message,
        prompt: item.prompt,
        model: item.model,
        reasoningEffort: item.reasoningEffort,
      });
    }
  }
}

export function renderActivity(item, append = false, turnId = '') {
  if (item.type === 'commandExecution') return renderCommandActivity(item, append, turnId);
  const key = `${state.selectedThreadId}:${item.id}`;
  const turnGroup = registerIntermediate(turnId, `activity:${item.id || item.type}`, append);
  const groupedAction = ['fileChange', 'webSearch', 'mcpToolCall'].includes(item.type);
  const actions = groupedAction ? registerAction(turnGroup, `activity:${item.id || item.type}`, item.status) : null;
  let card = state.activityCards.get(key);
  if (!card) {
    const collapsible = ['fileChange', 'mcpToolCall'].includes(item.type);
    card = document.createElement(collapsible ? 'details' : 'div');
    card.className = `activity-card${collapsible ? ' action-detail-card' : ''}`;
    const heading = document.createElement(collapsible ? 'summary' : 'div');
    heading.className = 'activity-heading';
    const icon = document.createElement('span'); icon.className = 'icon';
    const title = document.createElement('span'); title.className = 'activity-title';
    const agentRoster = document.createElement('div'); agentRoster.className = 'agent-roster hidden';
    const output = document.createElement('pre'); output.className = 'activity-output hidden';
    heading.append(icon, title);
    if (collapsible) {
      const hint = document.createElement('span'); hint.className = 'action-detail-hint'; hint.textContent = 'Ver conteúdo';
      heading.append(hint);
      card.addEventListener('toggle', () => { hint.textContent = card.open ? 'Recolher' : 'Ver conteúdo'; });
    }
    card.append(heading, agentRoster, output);
    state.activityCards.set(key, card);
    if (append) (actions?.content || turnGroup.content).append(card);
  }
  const headingIcon = $('.icon', card);
  const headingText = $('.activity-title', card);
  const output = $('.activity-output', card);
  if (item.type === 'fileChange') {
    headingIcon.innerHTML = `<svg viewBox="0 0 24 24">${icons.folder}</svg>`;
    const files = (item.changes || []).map((change) => change.path).filter(Boolean);
    headingText.textContent = item.status === 'completed' ? `Alterações aplicadas · ${files.length || 1} arquivo(s)` : `Alterações em arquivos · ${files.join(', ') || 'em andamento'}`;
    const diff = (item.changes || []).map((change) => `--- ${change.path}\n${change.diff || ''}`).join('\n');
    if (diff) output.textContent = diff;
  } else if (item.type === 'webSearch') {
    headingIcon.innerHTML = `<svg viewBox="0 0 24 24">${icons.search}</svg>`;
    headingText.textContent = `Busca na web${item.query ? ` · ${item.query}` : ''}`;
  } else if (item.type === 'collabToolCall') {
    headingIcon.innerHTML = `<svg viewBox="0 0 24 24">${icons.bolt}</svg>`;
    const normalize = (value) => String(value || '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').toLowerCase();
    const tool = normalize(item.tool);
    const status = normalize(item.status);
    const states = item.agentsStates && typeof item.agentsStates === 'object' ? item.agentsStates : {};
    const agentRefs = Array.isArray(item.receiverAgents) ? item.receiverAgents : [];
    const agentIds = [...new Set([...agentRefs.map((agent) => agent.threadId), ...Object.keys(states), ...(item.receiverThreadIds || [])].filter(Boolean))];
    const hasRunningAgent = Object.values(states).some((agent) => ['running', 'pending init'].includes(normalize(agent?.status)));
    const isFailed = status === 'failed' || Object.values(states).some((agent) => ['errored', 'not found'].includes(normalize(agent?.status)));
    const action = tool === 'spawn agent' ? 'delegou uma tarefa' : tool === 'wait' ? 'aguardou o trabalho' : tool === 'send input' ? 'enviou uma orientação' : tool === 'resume agent' ? 'retomou um agente' : tool === 'close agent' ? 'encerrou um agente' : tool === 'interrupt agent' ? 'interrompeu um agente' : tool === 'list agents' ? 'consultou os agentes' : 'coordenou agentes';
    const result = isFailed ? 'com falha' : status === 'interrupted' ? 'interrompido' : (status === 'in progress' || hasRunningAgent) ? 'em andamento' : 'concluído';
    const countLabel = agentIds.length ? ` · ${agentIds.length} agente${agentIds.length === 1 ? '' : 's'}` : '';
    headingText.textContent = `Agentes auxiliares · ${action}${countLabel} · ${result}`;
    const details = [];
    const prompt = typeof item.prompt === 'string' ? item.prompt.trim() : '';
    if (prompt) details.push(`Tarefa: ${prompt.slice(0, 500)}${prompt.length > 500 ? '…' : ''}`);
    const roster = $('.agent-roster', card);
    roster.replaceChildren();
    for (const agentId of agentIds) {
      const ref = agentRefs.find((agent) => agent.threadId === agentId);
      const agentState = states[agentId];
      const meta = rememberAgentThread(agentId, { nickname: ref?.agentNickname, role: ref?.agentRole, status: agentState?.status, message: agentState?.message, prompt, model: item.model, reasoningEffort: item.reasoningEffort });
      const chip = document.createElement('span');
      chip.className = 'agent-chip';
      chip.style.setProperty('--agent-color', meta.color);
      const avatar = document.createElement('span');
      avatar.className = 'agent-avatar';
      avatar.textContent = `A${meta.number}`;
      const chipLabel = document.createElement('span');
      chipLabel.className = 'agent-chip-label';
      chipLabel.textContent = agentRoleName(meta);
      const chipStatus = document.createElement('small');
      chipStatus.textContent = agentStatusLabel(agentState?.status);
      chip.append(avatar, chipLabel, chipStatus);
      roster.append(chip);
      const message = typeof agentState?.message === 'string' ? ` · ${agentState.message.slice(0, 180)}` : '';
      details.push(`${agentRoleName(meta)} — ${agentStatusLabel(agentState?.status)}${message}`);
    }
    agentIds.forEach(refreshAgentActivityCards);
    roster.classList.toggle('hidden', !agentIds.length);
    if (details.length) output.textContent = details.join('\n');
  } else if (item.type === 'subAgentActivity') {
    const meta = rememberAgentThread(item.agentThreadId, { agentPath: item.agentPath, model: item.model, reasoningEffort: item.reasoningEffort, kind: item.kind });
    card.dataset.agentThreadId = item.agentThreadId || '';
    card.dataset.agentTurnId = turnId || '';
    card.agentActivityItem = item;
    headingIcon.className = 'icon agent-avatar';
    headingIcon.style.setProperty('--agent-color', meta.color);
    headingIcon.textContent = `A${meta.number}`;
    headingText.textContent = `${agentRoleName(meta)} · ${({ started: 'iniciado', interacted: 'trabalhando', interrupted: 'interrompido', completed: 'concluído' })[item.kind] || 'atividade'}`;
    const details = [];
    if (meta.status) details.push(`Estado: ${agentStatusLabel(meta.status)}`);
    if (meta.message) details.push(String(meta.message).slice(0, 240));
    if (item.model || meta.model) details.push(`Modelo: ${item.model || meta.model}`);
    if (item.reasoningEffort || meta.reasoningEffort) details.push(`Esforço: ${effortLabel(item.reasoningEffort || meta.reasoningEffort)}`);
    if (meta.prompt) details.push(`Tarefa: ${String(meta.prompt).slice(0, 500)}`);
    if (details.length) output.textContent = details.join('\n');
  } else {
    headingIcon.innerHTML = `<svg viewBox="0 0 24 24">${icons.bolt}</svg>`;
    headingText.textContent = item.type === 'mcpToolCall' ? `Ferramenta · ${item.tool || 'MCP'}` : item.type === 'plan' ? 'Plano de trabalho' : item.type || 'Atividade';
    if (item.text || item.result || item.error) output.textContent = item.text || item.result || item.error;
  }
  if (output.textContent) output.classList.remove('hidden');
  if (append) scrollConversation();
  return card;
}
