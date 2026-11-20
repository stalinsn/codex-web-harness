import assert from 'node:assert/strict';
import { test } from 'node:test';
import { accessModeFromSettings, accessParams } from '../src/codex/access-mode.mjs';
import { CodexAppServer } from '../src/codex/app-server.mjs';

test('automatic development uses full access and no approval prompts', () => {
  assert.deepEqual(accessParams('automatic', { threadStart: true }), { approvalPolicy: 'never', sandbox: 'danger-full-access' });
  assert.deepEqual(accessParams('automatic'), { approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' } });
  assert.deepEqual(accessParams('manual'), { approvalPolicy: 'on-request', approvalsReviewer: 'user' });
  assert.equal(accessModeFromSettings('never', { type: 'dangerFullAccess' }), 'automatic');
  assert.equal(accessModeFromSettings('on-request', { type: 'dangerFullAccess' }), 'manual');
});

test('switching an active thread to automatic releases only its command approvals', async () => {
  const calls = [];
  const accepted = [];
  const server = new CodexAppServer({ bin: 'codex', homeDir: '/tmp', codexHome: '/tmp', emit: () => {} });
  server.resumedThreads.add('current');
  server.threadAccessModes.set('current', 'manual');
  server.activeTurns.set('current', 'turn-1');
  server.pendingRequests.set('1', { id: 1, method: 'item/commandExecution/requestApproval', params: { threadId: 'current' } });
  server.pendingRequests.set('2', { id: 2, method: 'item/fileChange/requestApproval', params: { threadId: 'other' } });
  server.pendingRequests.set('3', { id: 3, method: 'item/tool/requestUserInput', params: { threadId: 'current' } });
  server.rpc = async (method, params) => { calls.push([method, params]); return {}; };
  server.respondToServerRequest = (id, result) => { accepted.push([id, result]); server.pendingRequests.delete(String(id)); };

  assert.deepEqual(await server.setThreadAccessMode('current', 'automatic'), { mode: 'automatic', active: true });
  assert.deepEqual(calls, [['thread/settings/update', { threadId: 'current', approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' } }]]);
  assert.deepEqual(accepted, [[1, { decision: 'accept' }]]);
  assert.deepEqual([...server.pendingRequests.keys()], ['2', '3']);
});
