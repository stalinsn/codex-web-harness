// Turn CLI stdout lines into normalized events:
//   { type: 'session', sessionId }
//   { type: 'text', text }                       assistant prose
//   { type: 'tool', name, detail }               tool / command use
//   { type: 'usage', percent, resetsAt }         quota telemetry (no limit hit yet)
//   { type: 'rate-limit', resetsAt, message }    the account hit its limit
//   { type: 'result', ok, text, sessionId }      end of the run
//   { type: 'error', message }
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

function percentOf(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return number <= 1 ? Math.round(number * 1000) / 10 : Math.round(number * 10) / 10;
}

function parseClaude(line) {
  let event;
  try { event = JSON.parse(line); } catch { return [{ type: 'text', text: line }]; }
  switch (event.type) {
    case 'system':
      return event.session_id ? [{ type: 'session', sessionId: event.session_id }] : [];
    case 'assistant':
      return (event.message?.content || []).flatMap((block) => {
        if (block.type === 'text' && block.text) return [{ type: 'text', text: block.text }];
        if (block.type === 'tool_use') return [{ type: 'tool', name: block.name, detail: short(block.input?.command || block.input?.file_path || block.input) }];
        return [];
      });
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
      out.push({ type: 'result', ok: !event.is_error && event.subtype !== 'error', text, sessionId: event.session_id || '' });
      return out;
    }
    default:
      return [];
  }
}

const pickText = (event) => {
  for (const value of [event.text, event.delta, event.response, event.result, event.content, event.message?.content, event.message]) {
    if (typeof value === 'string' && value) return value;
    if (Array.isArray(value)) {
      const joined = value.map((part) => (typeof part === 'string' ? part : part?.text || '')).join('');
      if (joined) return joined;
    }
  }
  return '';
};

/** Tolerant parser for Gemini CLI / Antigravity style JSONL (init, message, tool_use, error, result). */
function parseGeneric(line) {
  let event;
  try { event = JSON.parse(line); } catch { return line.trim() ? [{ type: 'text', text: line }] : []; }
  if (!event || typeof event !== 'object') return [];
  const out = [];
  const sessionId = event.session_id || event.sessionId || event.conversation_id || event.conversationId;
  const kind = String(event.type || event.event || '').toLowerCase();
  if (sessionId && (kind === 'init' || kind === 'system' || kind === 'result' || !kind)) out.push({ type: 'session', sessionId });
  const errorText = typeof event.error === 'string' ? event.error : event.error?.message || (kind === 'error' ? pickText(event) : '');
  if (errorText) {
    if (looksRateLimited(errorText) || /RESOURCE_EXHAUSTED/.test(JSON.stringify(event.error || ''))) out.push({ type: 'rate-limit', resetsAt: resetFromText(errorText), message: errorText });
    else out.push({ type: 'error', message: errorText });
  }
  if (kind === 'tool_use' || kind === 'tool_call') out.push({ type: 'tool', name: event.tool_name || event.name || event.tool || 'ferramenta', detail: short(event.parameters || event.args || event.input) });
  else if (kind === 'result' || 'response' in event || 'status' in event && 'response' in event) {
    const text = pickText(event);
    const ok = !errorText && !/error|fail/i.test(String(event.status || ''));
    out.push({ type: 'result', ok, text, sessionId: sessionId || '' });
  } else if (kind === 'message' || kind === 'content' || kind === 'assistant') {
    const role = event.role || event.message?.role;
    if (role !== 'user') { const text = pickText(event); if (text) out.push({ type: 'text', text }); }
  }
  return out;
}

function parseText(line) {
  return line.trim() ? [{ type: 'text', text: line }] : [];
}

export const PARSERS = { claude: parseClaude, generic: parseGeneric, text: parseText };

export function getParser(name) {
  return PARSERS[name] || parseGeneric;
}
