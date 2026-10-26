import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { LocalThreadStore, isLocalThread } from '../src/threads/local-store.mjs';
import { transcriptOf } from '../src/threads/provider-chat.mjs';
import { TurnRecorder, toolItem } from '../src/threads/recorder.mjs';

test('provider tools map to Codex item types', () => {
  assert.equal(toolItem({ name: 'Bash', input: { command: 'ls' } }, 'i').type, 'commandExecution');
  assert.equal(toolItem({ name: 'run_shell_command', input: { command: 'ls' } }, 'i').command, 'ls');
  assert.deepEqual(toolItem({ name: 'Edit', input: { file_path: 'a.js', new_string: 'x' } }, 'i').changes.map((change) => change.path), ['a.js']);
  assert.equal(toolItem({ name: 'google_web_search', input: { query: 'q' } }, 'i').type, 'webSearch');
  assert.equal(toolItem({ name: 'mcp__docs__read' }, 'i').type, 'mcpToolCall');
});

test('a recorded turn stores Codex-shaped items and emits app-server notifications', async () => {
  const store = await new LocalThreadStore({ dir: await mkdtemp(join(tmpdir(), 'harness-threads-')) }).load();
  const record = await store.create({ cwd: '/tmp', accountId: 'claude-1', provider: 'claude-code' });
  assert.ok(isLocalThread(record.thread.id));
  const sent = [];
  const recorder = new TurnRecorder({ store, threadId: record.thread.id, emit: (type, data) => sent.push([type, data.method || '']) });
  await recorder.start({ text: 'Olá' });
  await recorder.handle({ type: 'reasoning', text: 'pensando', key: 'm1:0' });
  await recorder.handle({ type: 'text', text: 'Vou ', key: 'm2:0', delta: true });
  await recorder.handle({ type: 'text', text: 'olhar.', key: 'm2:0', delta: true });
  await recorder.handle({ type: 'tool', id: 't1', name: 'Bash', input: { command: 'ls' } });
  await recorder.handle({ type: 'tool-result', id: 't1', output: 'README.md' });
  await recorder.handle({ type: 'text', text: 'Pronto.', key: 'm3:0' });
  await recorder.finish({ status: 'completed' });
  const stored = await store.get(record.thread.id);
  const items = stored.turns[0].items;
  assert.deepEqual(items.map((item) => item.type), ['userMessage', 'reasoning', 'agentMessage', 'commandExecution', 'agentMessage']);
  assert.equal(items[2].text, 'Vou olhar.');
  assert.equal(items[2].phase, 'commentary');
  assert.equal(items[3].aggregatedOutput, 'README.md');
  assert.equal(items.at(-1).phase, 'final_answer');
  assert.equal(stored.turns[0].status, 'completed');
  assert.equal(stored.thread.preview, 'Olá');
  const methods = sent.map(([type, method]) => method || type);
  assert.ok(methods.includes('turn/started') && methods.includes('item/agentMessage/delta') && methods.includes('turn-completed'));
});

test('transcripts keep the user messages and final answers', () => {
  const text = transcriptOf([{ items: [
    { type: 'userMessage', content: [{ type: 'text', text: 'Pergunta' }] },
    { type: 'agentMessage', text: 'rascunho', phase: 'commentary' },
    { type: 'agentMessage', text: 'Resposta', phase: 'final_answer' },
  ] }]);
  assert.equal(text, 'Usuário: Pergunta\n\nAssistente: Resposta');
});

test('concurrent updates of an evicted thread are not lost', async () => {
  const store = await new LocalThreadStore({ dir: await mkdtemp(join(tmpdir(), 'harness-threads-')) }).load();
  const { thread } = await store.create({ cwd: '/tmp', accountId: 'a', provider: 'claude-code' });
  await store.flush(thread.id);
  store.cache.delete(thread.id);
  await Promise.all([
    store.update(thread.id, (record) => { record.queue.push('A'); }),
    store.update(thread.id, (record) => { record.queue.push('B'); }),
  ]);
  await store.flush(thread.id);
  store.cache.delete(thread.id);
  assert.deepEqual((await store.get(thread.id)).queue.sort(), ['A', 'B']);
});

test('one turn per conversation: a concurrent send is queued', async () => {
  const { ProviderChat } = await import('../src/threads/provider-chat.mjs');
  const store = await new LocalThreadStore({ dir: await mkdtemp(join(tmpdir(), 'harness-threads-')) }).load();
  const account = { id: 'claude-1', label: 'Claude', provider: 'claude-code' };
  let running = 0;
  let maxRunning = 0;
  const accounts = {
    registry: { get: (id) => (id === account.id ? account : null), rotation: { order: [], autoContinue: false } },
    availability: () => ({ ok: true }),
    runSegment: async () => {
      running += 1; maxRunning = Math.max(maxRunning, running);
      await new Promise((resolve) => setTimeout(resolve, 80));
      running -= 1;
      return { status: 'completed', text: 'ok', sessionId: 's1' };
    },
  };
  const chat = new ProviderChat({ store, accounts, emit: () => {} });
  const { thread } = await store.create({ cwd: '/tmp', accountId: account.id, provider: account.provider });
  const results = await Promise.all([chat.send({ threadId: thread.id, text: 'um' }), chat.send({ threadId: thread.id, text: 'dois' })]);
  assert.equal(results.filter((result) => result.queued).length, 1);
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(maxRunning, 1);
  const record = await store.get(thread.id);
  assert.deepEqual(record.turns.map((turn) => turn.status), ['completed', 'completed']);
  assert.equal(record.queue.length, 0);
});

test('merged thread lists keep the Codex order and slot local threads by time', async () => {
  const { mergeThreads } = await import('../src/routes/threads.mjs');
  const codex = [{ id: 'a', updatedAt: 50 }, { id: 'b', updatedAt: 90 }, { id: 'c', updatedAt: 10 }];
  const local = [{ id: 'x', updatedAt: 70 }, { id: 'y', updatedAt: 5 }];
  assert.deepEqual(mergeThreads(codex, local).map((thread) => thread.id), ['x', 'a', 'b', 'c', 'y']);
});
