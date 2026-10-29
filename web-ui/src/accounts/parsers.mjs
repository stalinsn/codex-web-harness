// Turn CLI stdout lines into normalized events:
//   { type: 'session', sessionId }
//   { type: 'text', text, key, delta? }          assistant prose; same key = same message block
//   { type: 'reasoning', text, key }             thinking / reasoning summary
//   { type: 'tool', id, name, input, detail }    tool call (shell, edits, search…)
//   { type: 'tool-result', id, output, isError } result of a tool call
//   { type: 'usage', percent, resetsAt }         quota telemetry (no limit hit yet)
//   { type: 'rate-limit', resetsAt, message }    the account hit its limit
//   { type: 'result', ok, text, sessionId }      end of the run
//   { type: 'error', message }
// getParser() returns a fresh, stateful parser per run (streams carry ids across lines).
const LIMIT_TEXT = /rate[ -]?limit|usage limit|quota|too many requests|resource[_ ]exhausted|\b429\b|limit (?:reached|exceeded)|out of credits|limite.{0,30}atingid/i;

export const looksRateLimited = (text) => LIMIT_TEXT.test(String(text || ''));

/** "Claude AI usage limit reached|1761400000" and similar carry the reset epoch. */
export function resetFromText(text) {
  const epoch = /\|(\d{10})\b/.exec(String(text || ''))?.[1];
  return epoch ? Number(epoch) : 0;
}

const short = (value, max = 240) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  return text.length > max ? `${text.slice(0, max)}…` : text;
};

function diagnosticText(value) {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  if (Array.isArray(value)) return value.map(diagnosticText).filter(Boolean).join('\n');
  if (typeof value === 'object') {
    if (typeof value.message === 'string') return `${value.type ? `${value.type}: ` : ''}${value.message}`;
    if (typeof value.stderr === 'string' || typeof value.stdout === 'string') return [value.stderr, value.stdout].filter(Boolean).join('\n');
    if (typeof value.output === 'string') return value.output;
    if (Array.isArray(value.content)) return diagnosticText(value.content);
    try { return JSON.stringify(value); } catch { return '[detalhe de erro indisponível]'; }
  }
  return String(value);
}

function percentOf(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return number <= 1 ? Math.round(number * 1000) / 10 : Math.round(number * 10) / 10;
}

const resultText = (content) => (typeof content === 'string' ? content : Array.isArray(content) ? content.map((part) => (typeof part === 'string' ? part : part?.text || '')).join('\n') : '');

function claudeParser() {
  let messageId = 'm0';
  return function parseClaude(line) {
    let event;
    try { event = JSON.parse(line); } catch { return [{ type: 'text', text: line, key: `raw:${Math.random()}` }]; }
    if (!event || typeof event !== 'object') return [];
    switch (event.type) {
      case 'system':
        return event.session_id ? [{ type: 'session', sessionId: event.session_id }] : [];
      case 'stream_event': {
        const inner = event.event || {};
        if (inner.type === 'message_start' && inner.message?.id) messageId = inner.message.id;
        if (inner.type !== 'content_block_delta') return [];
        const key = `${messageId}:${inner.index ?? 0}`;
        if (inner.delta?.type === 'text_delta' && inner.delta.text) return [{ type: 'text', text: inner.delta.text, key, delta: true }];
        if (inner.delta?.type === 'thinking_delta' && inner.delta.thinking) return [{ type: 'reasoning', text: inner.delta.thinking, key, delta: true }];
        return [];
      }
      case 'assistant': {
        const id = event.message?.id || messageId;
        const content = Array.isArray(event.message?.content) ? event.message.content : [];
        return content.flatMap((block, index) => {
          if (!block || typeof block !== 'object') return [];
          const key = `${id}:${index}`;
          if (block.type === 'text' && block.text) return [{ type: 'text', text: block.text, key }];
          if (block.type === 'thinking' && block.thinking) return [{ type: 'reasoning', text: block.thinking, key }];
          if (block.type === 'tool_use') return [{ type: 'tool', id: block.id || key, name: block.name, input: block.input || {}, detail: short(block.input?.command || block.input?.file_path || block.input) }];
          return [];
        });
      }
      case 'user': {
        const content = Array.isArray(event.message?.content) ? event.message.content : [];
        return content.filter((block) => block?.type === 'tool_result').map((block) => ({ type: 'tool-result', id: block.tool_use_id, output: resultText(block.content), isError: Boolean(block.is_error) }));
      }
      case 'rate_limit_event': {
        const info = event.rate_limit_info || {};
        const resetsAt = Number(info.resetsAt) || 0;
        if (/rate_?limited|rejected|exceeded/i.test(String(info.status || ''))) return [{ type: 'rate-limit', resetsAt, message: `Limite da assinatura (${info.rateLimitType || 'uso'})` }];
        const percent = percentOf(info.utilization);
        return percent == null ? [] : [{ type: 'usage', percent, resetsAt }];
      }
      case 'result': {
        const text = String(event.result || '');
        const out = [];
        if (event.is_error && looksRateLimited(text)) out.push({ type: 'rate-limit', resetsAt: resetFromText(text), message: text.replace(/\|\d{10}\b/, '') });
        out.push({ type: 'result', ok: !event.is_error && event.subtype !== 'error', text, sessionId: event.session_id || '', usage: event.usage || null });
        return out;
      }
      default:
        return [];
    }
  };
}

const pickText = (event) => {
  for (const value of [event.text, event.delta, event.response, event.result?.response, event.result, event.content, event.message?.content, event.message]) {
    if (typeof value === 'string' && value) return value;
    if (Array.isArray(value)) {
      const joined = value.map((part) => (typeof part === 'string' ? part : part?.text || '')).join('');
      if (joined) return joined;
    }
  }
  return '';
};

/** Tolerant parser for Gemini CLI / Antigravity style JSONL (init, message, thought, tool_use, tool_result, error, result). */
function genericParser() {
  let block = 0;
  let lastWasDelta = false;
  const seenTools = new Set();
  return function parseGeneric(line) {
    let event;
    try { event = JSON.parse(line); } catch { return line.trim() ? [{ type: 'text', text: line, key: `line:${block++}` }] : []; }
    if (!event || typeof event !== 'object') return [];
    const out = [];
    const resultPayload = event.result && typeof event.result === 'object' ? event.result : null;
    const sessionId = event.session_id || event.sessionId || event.conversation_id || event.conversationId || resultPayload?.conversation_id || resultPayload?.conversationId;
    const kind = String(event.type || event.event || '').toLowerCase();
    if (kind === 'step_update' && event.step_update && typeof event.step_update === 'object') {
      const step = event.step_update;
      const stepType = String(step.step_type || '').toLowerCase();
      if (stepType === 'agent_response') {
        if (typeof step.text_delta === 'string' && step.text_delta) {
          out.push({ type: 'text', text: step.text_delta, key: `agy:step:${step.step_index ?? 'response'}`, delta: true });
        }
        return out;
      }
      if (stepType === 'tool') {
        const info = step.tool_info || {};
        const id = String(step.step_index ?? info.call_id ?? info.id ?? `agy:tool:${block++}`);
        const parameters = info.parameters || info.input || {};
        if (!seenTools.has(id)) {
          seenTools.add(id);
          out.push({ type: 'tool', id, name: info.name || step.tool_name || 'ferramenta', input: parameters, detail: short(parameters.command || parameters.CommandLine || parameters.file_path || parameters.path || parameters) });
        }
        const stepState = String(step.state || '').toUpperCase();
        if (['DONE', 'ERROR', 'FAILED', 'CANCELED', 'CANCELLED'].includes(stepState)) {
          const errorText = diagnosticText(info.error ?? step.error ?? step.failure ?? event.error);
          const outputText = diagnosticText(info.output ?? step.output ?? step.result);
          const failed = Boolean(errorText) || ['ERROR', 'FAILED', 'CANCELED', 'CANCELLED'].includes(stepState);
          const finalText = errorText || outputText || (failed ? `A ferramenta terminou com estado ${stepState}.` : '');
          if (finalText) out.push({ type: 'tool-result', id, output: finalText, isError: failed });
        }
        return out;
      }
      return out;
    }
    if (sessionId && (kind === 'init' || kind === 'system' || kind === 'result' || !kind)) out.push({ type: 'session', sessionId });
    const isTool = /tool/.test(kind);
    const errorValue = event.error ?? resultPayload?.error;
    const errorText = typeof errorValue === 'string' ? errorValue : errorValue?.message || (kind === 'error' ? pickText(event) : '');
    const toolId = event.tool_id || event.toolId || event.call_id || event.id;
    const isDelta = event.delta === true;
    if (!isDelta || !['message', 'content', 'assistant'].includes(kind)) { if (lastWasDelta) block += 1; lastWasDelta = false; }
    // Errors from tools (npm, curl, …) are the agent's business, never the account's quota.
    if (errorText && isTool) out.push({ type: 'tool-result', id: toolId, output: errorText, isError: true });
    else if (errorText) {
      if (looksRateLimited(errorText) || /RESOURCE_EXHAUSTED/.test(JSON.stringify(event.error || ''))) out.push({ type: 'rate-limit', resetsAt: resetFromText(errorText), message: errorText });
      else out.push({ type: 'error', message: errorText });
    }
    if (errorText && isTool) return out;
    if (kind === 'tool_use' || kind === 'tool_call') {
      const input = event.parameters || event.args || event.input || {};
      out.push({ type: 'tool', id: toolId || `tool:${block}`, name: event.tool_name || event.name || event.tool || 'ferramenta', input, detail: short(input.command || input.file_path || input.path || input) });
    } else if (kind === 'tool_result' || kind === 'tool_response') {
      out.push({ type: 'tool-result', id: toolId, output: typeof event.output === 'string' ? event.output : pickText(event) || short(event.output ?? event.result ?? '', 4000), isError: /error|fail/i.test(String(event.status || '')) });
    } else if (kind === 'thought' || kind === 'thinking' || kind === 'reasoning') {
      const text = pickText(event) || event.subject || '';
      if (text) out.push({ type: 'reasoning', text, key: `thought:${block++}` });
    } else if (kind === 'result' || 'response' in event) {
      const resultStatus = String(resultPayload?.status || event.status || '').toUpperCase();
      const text = typeof resultPayload?.response === 'string' ? resultPayload.response : pickText(event);
      const resultError = errorText || (resultStatus && resultStatus !== 'SUCCESS' ? `Antigravity encerrou a execução com status ${resultStatus}.` : '');
      if (resultError) {
        if (looksRateLimited(resultError) || /RESOURCE_EXHAUSTED/.test(JSON.stringify(errorValue || ''))) out.push({ type: 'rate-limit', resetsAt: resetFromText(resultError), message: resultError });
        else out.push({ type: 'error', message: resultError });
      }
      const ok = resultStatus ? resultStatus === 'SUCCESS' : !resultError && !/error|fail/i.test(String(event.status || ''));
      out.push({ type: 'result', ok, text, error: resultError, sessionId: sessionId || '', usage: resultPayload?.usage || resultPayload?.usageMetadata || resultPayload?.usage_metadata || resultPayload?.stats || event.usage || event.usageMetadata || event.usage_metadata || event.stats || null });
    } else if (kind === 'message' || kind === 'content' || kind === 'assistant') {
      const role = event.role || event.message?.role;
      if (role !== 'user') {
        const text = pickText(event);
        if (text) {
          if (isDelta) { lastWasDelta = true; out.push({ type: 'text', text, key: `msg:${block}`, delta: true }); }
          else out.push({ type: 'text', text, key: `msg:${block++}` });
        }
      }
    }
    return out;
  };
}

function textParser() {
  let line = 0;
  return (text) => (text.trim() ? [{ type: 'text', text, key: `line:${line++}` }] : []);
}

const PARSERS = { claude: claudeParser, generic: genericParser, text: textParser };

const TOKEN_FIELDS = {
  inputTokens: ['input_tokens', 'inputTokens', 'prompt_tokens', 'promptTokens', 'promptTokenCount', 'prompt_token_count', 'total_input_tokens', 'totalInputTokens'],
  outputTokens: ['output_tokens', 'outputTokens', 'completion_tokens', 'completionTokens', 'candidates_token_count', 'candidatesTokenCount', 'candidate_token_count', 'candidateTokenCount', 'total_output_tokens', 'totalOutputTokens'],
  totalTokens: ['total_tokens', 'totalTokens', 'totalTokenCount', 'total_token_count'],
};

function tokenField(value, names, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 6) return null;
  for (const name of names) {
    if (!(name in value)) continue;
    const number = Number(value[name]);
    if (Number.isSafeInteger(number) && number >= 0) return number;
  }
  for (const child of Object.values(value)) {
    const found = tokenField(child, names, depth + 1);
    if (found != null) return found;
  }
  return null;
}

/** Token counts reported by a provider CLI; this is activity, not a quota estimate. */
export function reportedTokenUsage(value) {
  if (!value || typeof value !== 'object') return null;
  const inputTokens = tokenField(value, TOKEN_FIELDS.inputTokens);
  const outputTokens = tokenField(value, TOKEN_FIELDS.outputTokens);
  const reportedTotal = tokenField(value, TOKEN_FIELDS.totalTokens);
  if (inputTokens == null && outputTokens == null && reportedTotal == null) return null;
  return {
    inputTokens,
    outputTokens,
    totalTokens: reportedTotal ?? (inputTokens || 0) + (outputTokens || 0),
  };
}

export function getParser(name) {
  return (PARSERS[name] || genericParser)();
}
