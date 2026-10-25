import assert from 'node:assert/strict';
import { test } from 'node:test';
import { codexUsage } from '../src/accounts/codex-usage.mjs';
import { getParser, looksRateLimited, resetFromText } from '../src/accounts/parsers.mjs';
import { expandArgs } from '../src/accounts/providers.mjs';
import { buildSegmentPrompt, goalFromThread, outcomeMarker } from '../src/tasks/prompt.mjs';

test('arg templates fill placeholders and drop empty optional groups', () => {
  const template = ['-p', '{prompt}', ['--model', '{model}'], ['--effort', '{effort}']];
  assert.deepEqual(expandArgs(template, { prompt: 'oi', model: 'opus', effort: '' }), ['-p', 'oi', '--model', 'opus']);
});

test('claude stream-json: session, text, tools, limit and result', () => {
  const parse = getParser('claude');
  assert.deepEqual(parse('{"type":"system","subtype":"init","session_id":"s1"}'), [{ type: 'session', sessionId: 's1' }]);
  const assistant = parse(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'oi' }, { type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] } }));
  assert.deepEqual(assistant.map((event) => event.type), ['text', 'tool']);
  assert.equal(parse('{"type":"rate_limit_event","rate_limit_info":{"status":"rate_limited","resetsAt":1800000000}}')[0].resetsAt, 1800000000);
  assert.equal(parse('{"type":"rate_limit_event","rate_limit_info":{"status":"allowed_warning","utilization":0.91}}')[0].percent, 91);
  const result = parse('{"type":"result","subtype":"success","is_error":true,"result":"Claude AI usage limit reached|1800000000"}');
  assert.equal(result[0].type, 'rate-limit');
  assert.equal(result[0].message, 'Claude AI usage limit reached');
  assert.equal(result[1].ok, false);
});

test('generic JSONL (Gemini/Antigravity) and quota detection', () => {
  const parse = getParser('generic');
  assert.deepEqual(parse('{"type":"init","session_id":"g1"}'), [{ type: 'session', sessionId: 'g1' }]);
  assert.equal(parse('{"type":"message","role":"assistant","content":"feito"}')[0].text, 'feito');
  assert.equal(parse('{"type":"message","role":"user","content":"pedido"}').length, 0);
  assert.equal(parse('{"type":"error","message":"429 RESOURCE_EXHAUSTED: quota exceeded"}')[0].type, 'rate-limit');
  assert.equal(parse('{"type":"result","response":"ok","status":"success"}').at(-1).ok, true);
  assert.equal(parse('texto solto')[0].text, 'texto solto');
  assert.ok(looksRateLimited('You have exhausted your quota') && !looksRateLimited('tudo certo'));
  assert.equal(resetFromText('limit|1800000000'), 1800000000);
});

test('codex usage takes the most used window', () => {
  const usage = codexUsage({ rateLimitsByLimitId: { codex: { primary: { usedPercent: 40, resetsAt: 10 }, secondary: { usedPercent: 97, resetsAt: 20 } } } });
  assert.deepEqual(usage, { percent: 97, resetsAt: 20 });
  assert.deepEqual(codexUsage(null), { percent: null, resetsAt: 0 });
});

test('segment prompts carry policy (non-Codex), handoff and markers', () => {
  const task = { goal: 'Fazer X', cwd: '/srv/app' };
  const claude = buildSegmentPrompt({ task, account: { provider: 'claude-code' }, policies: ['Não mexa em produção.'], handoff: 'Estado: metade', previous: { accountLabel: 'Codex', outcome: 'limite de uso atingido', summary: 'parei' }, mode: 'handoff' });
  assert.match(claude, /Diretrizes da instalação/);
  assert.match(claude, /Estado: metade/);
  assert.match(claude, /HARNESS_STATUS: DONE/);
  const codex = buildSegmentPrompt({ task, account: { provider: 'codex' }, policies: ['Não mexa em produção.'] });
  assert.doesNotMatch(codex, /Diretrizes da instalação/);
  assert.equal(outcomeMarker('...\nHARNESS_STATUS: DONE'), 'done');
  assert.equal(outcomeMarker('HARNESS_STATUS: BLOCKED'), 'blocked');
  assert.equal(outcomeMarker('continua'), '');
});

test('goal from an interrupted thread keeps the original ask and the last answer', () => {
  const goal = goalFromThread({ thread: { name: 'Ateliê' }, turns: [
    { items: [{ type: 'userMessage', content: [{ type: 'text', text: 'Crie o ateliê' }] }, { type: 'agentMessage', text: 'Comecei' }] },
    { items: [{ type: 'userMessage', content: [{ type: 'text', text: 'Pode continuar' }] }, { type: 'agentMessage', text: 'Falta o build' }] },
  ] });
  assert.match(goal, /Ateliê/);
  assert.match(goal, /Crie o ateliê/);
  assert.match(goal, /Pode continuar/);
  assert.match(goal, /Falta o build/);
});
