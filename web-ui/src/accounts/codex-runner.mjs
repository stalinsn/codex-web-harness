// Run one orchestrated segment on a Codex app-server (any Codex account).
import { randomUUID } from 'node:crypto';
import { codexUsage, handoffInstruction } from './codex-usage.mjs';
import { looksRateLimited } from './parsers.mjs';

async function waitReady(server, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (!server.ready && Date.now() < deadline) await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  if (!server.ready) throw new Error('O Codex desta conta não ficou pronto a tempo.');
}

/**
 * @returns {Promise<{status: 'completed'|'rate-limited'|'failed'|'stopped', text: string, sessionId: string, threadId: string, resetsAt: number, error: string}>}
 */
const SEGMENT_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const stoppedEarly = (threadId = '') => ({ status: 'stopped', text: '', sessionId: threadId, threadId, resetsAt: 0, error: '' });

export async function runCodexSegment({ server, prompt, cwd, model, effort, threadId = '', title = '', onEvent = () => {}, signal, handoff = { enabled: false, atPercent: 95 }, timeoutMs = SEGMENT_TIMEOUT_MS }) {
  if (signal?.aborted) return stoppedEarly(threadId);
  await waitReady(server);
  if (signal?.aborted) return stoppedEarly(threadId);
  if (threadId) await server.ensureResumed(threadId);
  else {
    const created = await server.rpc('thread/start', { ...(model ? { model } : {}), cwd });
    threadId = created.thread.id;
    server.resumedThreads.add(threadId);
    if (title) server.rpc('thread/name/set', { threadId, name: title.slice(0, 120) }).catch(() => {});
  }
  onEvent({ type: 'session', sessionId: threadId });
  if (signal?.aborted) return stoppedEarly(threadId);

  const outcome = { status: 'failed', text: '', sessionId: threadId, threadId, resetsAt: 0, error: '' };
  let turnId = '';
  let steered = false;
  let limited = false;
  const streams = new Map();

  return new Promise((resolvePromise) => {
    let finished = false;
    const finish = (status) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      unsubscribe();
      signal?.removeEventListener('abort', abort);
      // A turn that stopped because we asked for a handoff is a limit, not a finished goal.
      if (steered && status === 'completed') {
        limited = true;
        outcome.resetsAt ||= codexUsage(server.rateLimits).resetsAt;
      }
      outcome.status = limited ? 'rate-limited' : status;
      resolvePromise(outcome);
    };
    const abort = () => {
      if (turnId) server.rpc('turn/interrupt', { threadId, turnId }).catch(() => {});
      setTimeout(() => finish('stopped'), 3000).unref();
    };
    const steerHandoff = (percent) => {
      if (steered || !turnId) return;
      steered = true;
      onEvent({ type: 'tool', name: 'handoff', detail: `Limite em ${percent}% — pedindo registro de retomada.` });
      server.rpc('turn/steer', { threadId, expectedTurnId: turnId, clientUserMessageId: randomUUID(), input: [{ type: 'text', text: handoffInstruction(percent) }] }).catch(() => {});
    };

    const timer = setTimeout(() => { outcome.error = 'A etapa excedeu o tempo máximo.'; abort(); }, timeoutMs);
    const unsubscribe = server.subscribe((message) => {
      const params = message.params || {};
      if (message.method === 'server/closed') {
        outcome.error = 'O processo do Codex desta conta foi reiniciado durante a etapa.';
        finish('failed');
        return;
      }
      if (message.method === 'account/rateLimits/updated') {
        const { percent, resetsAt } = codexUsage(params);
        if (percent == null) return;
        onEvent({ type: 'usage', percent, resetsAt });
        if (percent >= 100) outcome.resetsAt = resetsAt;
        if (handoff.enabled && percent >= handoff.atPercent) steerHandoff(percent);
        return;
      }
      const eventThread = params.threadId || params.turn?.threadId;
      if (eventThread !== threadId) return;
      if (message.method === 'item/agentMessage/delta') {
        const id = params.itemId || 'message';
        streams.set(id, `${streams.get(id) || ''}${params.delta || ''}`);
      } else if (message.method === 'item/completed') {
        const item = params.item || {};
        if (item.type === 'agentMessage') {
          const text = item.text || streams.get(item.id) || '';
          if (text) { outcome.text = text; onEvent({ type: 'text', text }); }
        } else if (item.type === 'commandExecution') onEvent({ type: 'tool', name: 'comando', detail: String(item.command || '').slice(0, 240) });
        else if (item.type === 'fileChange') onEvent({ type: 'tool', name: 'arquivos', detail: (item.changes || []).map((change) => change.path).join(', ').slice(0, 240) });
      } else if (message.method === 'error') {
        const text = params.error?.message || '';
        if (looksRateLimited(text)) { limited = true; outcome.error = text; onEvent({ type: 'rate-limit', resetsAt: outcome.resetsAt, message: text }); }
        else if (params.willRetry !== true) { outcome.error = text; onEvent({ type: 'error', message: text }); }
      } else if (message.method === 'turn/completed') {
        const turn = params.turn || {};
        if (turnId && turn.id && turn.id !== turnId) return;
        const status = typeof turn.status === 'string' ? turn.status : turn.status?.type;
        const errorText = turn.error?.message || (typeof turn.error === 'string' ? turn.error : '') || '';
        if (looksRateLimited(errorText)) { limited = true; outcome.error = errorText; }
        onEvent({ type: 'result', ok: status === 'completed', text: outcome.text });
        finish(status === 'completed' ? 'completed' : status === 'interrupted' ? 'stopped' : 'failed');
      }
    });
    signal?.addEventListener('abort', abort, { once: true });

    server.rpc('turn/start', { threadId, input: [{ type: 'text', text: prompt }], cwd, ...(model ? { model } : {}), ...(effort ? { effort } : {}), clientUserMessageId: randomUUID() })
      .then((result) => {
        turnId = result.turn?.id || '';
        if (turnId) server.activeTurns.set(threadId, turnId);
        if (signal?.aborted) { abort(); return; }
        const { percent } = codexUsage(server.rateLimits);
        if (handoff.enabled && percent != null && percent >= handoff.atPercent) steerHandoff(percent);
      })
      .catch((error) => {
        if (looksRateLimited(error.message)) limited = true;
        outcome.error = error.message;
        finish('failed');
      });
  });
}
