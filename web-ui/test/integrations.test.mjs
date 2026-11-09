import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { access, mkdtemp, readdir, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { test } from 'node:test';
import { AccountRegistry } from '../src/accounts/registry.mjs';
import { AccountService } from '../src/accounts/service.mjs';
import { AuthError, AuthManager } from '../src/auth/auth-manager.mjs';
import { IntegrationService } from '../src/integrations/service.mjs';
import { INTEGRATION_TTL_MS, IntegrationSessions, MAX_ACTIVE_INTEGRATIONS } from '../src/integrations/sessions.mjs';
import { buildTextCommand, CLAUDE_TEXT_ARGS, claudeUsageFromRateLimit, readClaudeStream, runText, textSupport } from '../src/integrations/text-runner.mjs';
import { handleIntegrationApi } from '../src/routes/integrations.mjs';

const tempDir = (prefix) => mkdtemp(join(tmpdir(), prefix));
const sha256 = (value) => createHash('sha256').update(value, 'utf8').digest('hex');
const account = (id, provider, extra = {}) => ({ id, provider, label: id, enabled: true, dir: join(tmpdir(), `acct-${id}`), model: '', effort: '', permissionMode: '', bin: '', env: {}, ...extra });

function fakeAccounts(list) {
  const registry = new AccountRegistry();
  registry.accounts = list;
  registry.rotation = { order: list.map((item) => item.id), switchAtPercent: 95, proactiveHandoff: true, autoContinue: true, defaultCooldownMinutes: 60 };
  registry.saveState = async () => {};
  for (const item of list) registry.stateOf(item.id).loggedIn = true;
  return new AccountService({ registry, primaryCodex: { codexHome: join(tmpdir(), 'no-codex'), subscribe() {}, rateLimits: null }, emit() {} });
}

function fakeAuth() {
  return { onPasswordReset: null, async startIntegrationLogin() { return { challengeId: 'c1', expiresIn: 600 }; }, async verifyIntegration() { return { client: 'live-rooms' }; } };
}

function fakeReq({ method = 'POST', headers = {}, body = null } = {}) {
  const req = new EventEmitter();
  Object.assign(req, { method, headers, socket: { remoteAddress: '127.0.0.1' }, destroy() {} });
  setImmediate(() => { if (body != null) req.emit('data', Buffer.from(JSON.stringify(body))); req.emit('end'); });
  return req;
}

function fakeRes() {
  return { status: 0, headers: {}, body: '', setHeader(name, value) { this.headers[name] = value; }, writeHead(status, headers) { this.status = status; Object.assign(this.headers, headers); }, end(body) { this.body = body; } };
}

/** A child process stand-in: records stdin and lets the test script the output. */
function fakeSpawn(script) {
  const calls = [];
  const impl = (bin, args, options) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    let input = '';
    child.stdin = new Writable({ write(chunk, encoding, callback) { input += chunk; callback(); } });
    child.kill = (signal) => { child.killedWith = signal; setImmediate(() => child.emit('close', null)); };
    const call = { bin, args, options, child, get input() { return input; } };
    calls.push(call);
    child.stdin.on('finish', () => setImmediate(() => script(call)));
    return child;
  };
  return { impl, calls };
}

const reply = (text, code = 0, stderr = '') => (call) => {
  if (stderr) call.child.stderr.write(stderr);
  call.child.stdout.end(text);
  call.child.stderr.end();
  setImmediate(() => call.child.emit('close', code));
};

test('integration tokens are shown once and stored only as a hash (0600)', async () => {
  const dir = await tempDir('harness-int-');
  const file = join(dir, 'web-integrations.json');
  const sessions = await new IntegrationSessions(file).load();
  const { token, session } = await sessions.issue({ client: 'live-rooms', label: 'Live Rooms prod' });
  assert.match(token, /^nyxh_[a-f0-9]{16}_[A-Za-z0-9_-]{43}$/);
  const raw = await readFile(file, 'utf8');
  assert.equal(raw.includes(token), false);
  assert.equal(raw.includes(token.split('_').slice(2).join('_')), false);
  const stored = JSON.parse(raw).sessions[0];
  assert.equal(stored.tokenHash, sha256(token));
  assert.deepEqual(Object.keys(session).includes('tokenHash'), false);
  assert.deepEqual(stored.scopes, ['generate:text']);
  if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.deepEqual((await readdir(dir)).filter((name) => name.includes('.tmp')), []);

  assert.equal(sessions.authenticate(token).id, session.id);
  assert.equal(sessions.authenticate(`${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`), null);
  assert.equal(sessions.authenticate('nyxh_0000000000000000_' + 'A'.repeat(43)), null);
  assert.equal(sessions.authenticate(''), null);
  assert.equal(sessions.list()[0].tokenHash, undefined);

  const reloaded = await new IntegrationSessions(file).load();
  assert.equal(reloaded.authenticate(token).client, 'live-rooms');
});

test('integration tokens expire, can be revoked and are capped', async () => {
  let now = 1_800_000_000_000;
  const sessions = await new IntegrationSessions(join(await tempDir('harness-int-'), 'i.json'), { now: () => now }).load();
  const first = await sessions.issue({ client: 'a' });
  assert.equal(first.session.expiresAt, now + INTEGRATION_TTL_MS);
  now += INTEGRATION_TTL_MS + 1;
  assert.equal(sessions.authenticate(first.token), null);

  const second = await sessions.issue({ client: 'b' });
  assert.ok(sessions.authenticate(second.token));
  assert.equal(await sessions.revoke(second.session.id), true);
  assert.equal(sessions.authenticate(second.token), null);
  assert.equal(await sessions.revoke('ffffffffffffffff'), false);

  const issued = [];
  for (let index = 0; index < MAX_ACTIVE_INTEGRATIONS + 1; index += 1) { now += 1000; issued.push(await sessions.issue({ client: `c${index}` })); }
  assert.equal(sessions.list().filter((entry) => entry.active).length, MAX_ACTIVE_INTEGRATIONS);
  assert.equal(sessions.authenticate(issued[0].token), null);
  assert.ok(sessions.authenticate(issued.at(-1).token));
  await sessions.revokeAll();
  assert.equal(sessions.list().some((entry) => entry.active), false);
});

test('integration routes refuse browser requests and missing bearer tokens', async () => {
  const sessions = await new IntegrationSessions(join(await tempDir('harness-int-'), 'i.json')).load();
  const integrations = new IntegrationService({ auth: fakeAuth(), accounts: fakeAccounts([]), sessions, log() {} });
  const { token } = await sessions.issue({ client: 'live-rooms' });
  for (const headers of [{ origin: 'https://evil.example', authorization: `Bearer ${token}` }, { 'sec-fetch-site': 'cross-site', authorization: `Bearer ${token}` }]) {
    const res = fakeRes();
    await handleIntegrationApi(integrations, fakeReq({ method: 'GET', headers }), res, '/api/integrations/status');
    assert.equal(res.status, 403);
  }
  const loginRes = fakeRes();
  await handleIntegrationApi(integrations, fakeReq({ headers: { origin: 'https://a.example' }, body: { password: 'x', client: 'live-rooms' } }), loginRes, '/api/integrations/login');
  assert.equal(loginRes.status, 403);

  const missing = fakeRes();
  await handleIntegrationApi(integrations, fakeReq({ method: 'GET' }), missing, '/api/integrations/status');
  assert.equal(missing.status, 401);
  assert.equal(missing.headers['WWW-Authenticate'], 'Bearer');

  const ok = fakeRes();
  await handleIntegrationApi(integrations, fakeReq({ method: 'GET', headers: { authorization: `Bearer ${token}` } }), ok, '/api/integrations/status');
  assert.equal(ok.status, 200);
  assert.equal(JSON.parse(ok.body).valid, true);

  const login = fakeRes();
  await handleIntegrationApi(integrations, fakeReq({ body: { password: 'x', client: 'live-rooms' } }), login, '/api/integrations/login');
  assert.deepEqual(JSON.parse(login.body), { challengeId: 'c1', expiresIn: 600 });
  const badClient = fakeRes();
  await handleIntegrationApi(integrations, fakeReq({ body: { password: 'x', client: '<script>' } }), badClient, '/api/integrations/login');
  assert.equal(badClient.status, 400);

  const verify = fakeRes();
  await handleIntegrationApi(integrations, fakeReq({ body: { challengeId: 'c1', code: '123456' } }), verify, '/api/integrations/verify');
  const issued = JSON.parse(verify.body);
  assert.equal(verify.headers['Set-Cookie'], undefined);
  assert.deepEqual(issued.scopes, ['generate:text']);
  const logout = fakeRes();
  await handleIntegrationApi(integrations, fakeReq({ headers: { authorization: `Bearer ${issued.token}` }, body: {} }), logout, '/api/integrations/logout');
  assert.equal(logout.status, 200);
  assert.equal(sessions.authenticate(issued.token), null);
});

test('integration challenges cannot become browser sessions', async () => {
  const auth = new AuthManager(join(await tempDir('harness-int-'), 'auth.json'));
  auth.state = { sessionPepper: 'pepper', sessions: [], emailSendTimestamps: [] };
  const add = (id) => auth.challenges.set(id, { intent: 'integration', detail: 'live-rooms', attempts: 0, expiresAt: Date.now() + 60_000, codeHash: createHmac('sha256', 'pepper').update(`${id}:123456`).digest('hex') });
  add('a');
  await assert.rejects(auth.verifyLogin('a', '123456'), AuthError);
  add('b');
  assert.deepEqual(await auth.verifyIntegration('b', '123456'), { client: 'live-rooms' });
  assert.equal(auth.state.sessions.length, 0);
});

test('Claude Code text runs use the no-tools argument list, stdin and an empty temp dir', async () => {
  const claude = account('claude-a', 'claude-code', { model: 'sonnet', args: ['-p', '{prompt}', '--permission-mode', 'bypassPermissions'] });
  const { bin, args } = buildTextCommand(claude);
  assert.equal(bin, 'claude');
  assert.deepEqual(args, [...CLAUDE_TEXT_ARGS, '--model', 'sonnet']);
  assert.deepEqual(CLAUDE_TEXT_ARGS, ['-p', '--output-format', 'stream-json', '--verbose', '--tools', '', '--strict-mcp-config', '--no-session-persistence', '--disable-slash-commands', '--settings', '{"disableAllHooks":true}']);
  assert.equal(args.includes('bypassPermissions'), false);

  let seenDir = '';
  const spawn = fakeSpawn(async (call) => {
    seenDir = call.options.cwd;
    assert.deepEqual(await readdir(seenDir), []);
    reply('{"voxels":[]}\n')(call);
  });
  const prompt = 'Gere um sprite 16x16 em JSON.';
  const outcome = await runText({ account: claude, prompt, timeoutMs: 5000, spawnImpl: spawn.impl });
  assert.deepEqual(outcome, { status: 'completed', text: '{"voxels":[]}', error: '', resetsAt: 0 });
  const [call] = spawn.calls;
  assert.equal(call.input, prompt);
  assert.equal(call.args.some((arg) => arg.includes(prompt)), false);
  assert.deepEqual(call.options.stdio, ['pipe', 'pipe', 'pipe']);
  assert.equal(call.options.env.CLAUDE_CONFIG_DIR, claude.dir);
  await assert.rejects(access(seenDir));
});

const streamLines = (...events) => `${events.map((event) => JSON.stringify(event)).join('\n')}\n`;
const INIT = { type: 'system', subtype: 'init', tools: [], mcp_servers: [], slash_commands: [] };
const RATE = { type: 'rate_limit_event', rate_limit_info: { status: 'allowed', resetsAt: 1794275400, rateLimitType: 'five_hour', unifiedWindows: { five_hour: { utilization: 0.09, resetsAt: 1794275400, status: 'allowed' }, seven_day: { utilization: 0.28, resetsAt: 1794484800, status: 'allowed' } } } };
const RESULT = { type: 'result', subtype: 'success', is_error: false, result: '{"ok":true}', usage: { input_tokens: 2, output_tokens: 8 } };

test('Claude stream-json runs return the result text plus subscription usage', async () => {
  const claude = account('claude-a', 'claude-code');
  const spawn = fakeSpawn(reply(streamLines(INIT, { type: 'assistant' }, RATE, RESULT)));
  const outcome = await runText({ account: claude, prompt: 'oi', timeoutMs: 5000, spawnImpl: spawn.impl });
  assert.equal(outcome.status, 'completed');
  assert.equal(outcome.text, '{"ok":true}');
  assert.deepEqual(outcome.usage, {
    percent: 28,
    resetsAt: 1794484800,
    windows: { five_hour: { percent: 9, resetsAt: 1794275400, status: 'allowed' }, seven_day: { percent: 28, resetsAt: 1794484800, status: 'allowed' } },
  });
  assert.deepEqual(outcome.tokens, { input_tokens: 2, output_tokens: 8 });
  assert.equal(claudeUsageFromRateLimit({ utilization: 0.5, resetsAt: 10, rateLimitType: 'five_hour' }).windows.five_hour.percent, 50);
  assert.equal(claudeUsageFromRateLimit({}), null);
});

test('Claude stream-json runs are discarded when tools or MCP servers show up', async () => {
  const claude = account('claude-a', 'claude-code');
  for (const init of [{ ...INIT, tools: ['Bash'] }, { ...INIT, mcp_servers: [{ name: 'x' }] }]) {
    const spawn = fakeSpawn(reply(streamLines(init, RESULT)));
    const outcome = await runText({ account: claude, prompt: 'oi', timeoutMs: 5000, spawnImpl: spawn.impl });
    assert.equal(outcome.status, 'failed');
    assert.equal(outcome.text, '');
  }
  assert.equal(readClaudeStream(streamLines(INIT, RESULT)).exposedTools, false);
});

test('Claude stream-json limits and errors are reported', async () => {
  const claude = account('claude-a', 'claude-code');
  const rejected = { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1800000000, rateLimitType: 'seven_day' } };
  const limited = await runText({ account: claude, prompt: 'oi', timeoutMs: 5000, spawnImpl: fakeSpawn(reply(streamLines(INIT, rejected), 1)).impl });
  assert.equal(limited.status, 'rate-limited');
  assert.equal(limited.resetsAt, 1800000000);
  const failed = await runText({ account: claude, prompt: 'oi', timeoutMs: 5000, spawnImpl: fakeSpawn(reply(streamLines(INIT, { type: 'result', subtype: 'error_during_execution', is_error: true, result: 'falhou feio' }), 1)).impl });
  assert.equal(failed.status, 'failed');
  assert.match(failed.error, /falhou feio/u);
});

test('generate-text records usage and status reports it per account', async () => {
  const accounts = fakeAccounts([account('claude-a', 'claude-code'), account('gem', 'gemini-cli')]);
  const usage = { percent: 28, resetsAt: 1794484800, windows: { five_hour: { percent: 9, resetsAt: 1794275400, status: 'allowed' }, seven_day: { percent: 28, resetsAt: 1794484800, status: 'allowed' } } };
  const runTextImpl = async () => ({ status: 'completed', text: 'ok', error: '', resetsAt: 0, usage, tokens: { input_tokens: 2, output_tokens: 8 } });
  const sessions = await new IntegrationSessions(join(await tempDir('harness-int-'), 'i.json')).load();
  const integrations = new IntegrationService({ auth: fakeAuth(), accounts, sessions, runTextImpl, log() {} });
  await sessions.issue({ client: 'live-rooms' });
  const entry = sessions.sessions[0];
  await integrations.generate(entry, { prompt: 'x' });
  const [claude, gem] = integrations.status(entry).providers;
  assert.equal(claude.usage.percent, 28);
  assert.equal(claude.usage.resetsAt, 1794484800);
  assert.deepEqual(claude.usage.windows, usage.windows);
  assert.equal(claude.usage.tokens.total, 10);
  assert.equal(claude.usage.tokens.runs, 1);
  assert.ok(claude.usage.checkedAt > 0);
  assert.equal(gem.usage, undefined, 'contas sem modo de texto não expõem uso');
});

test('providers without a guaranteed no-tools mode are refused', () => {
  for (const provider of ['gemini-cli', 'antigravity', 'custom']) {
    assert.equal(textSupport(account('x', provider)).ok, false);
    assert.throws(() => buildTextCommand(account('x', provider)), (error) => error.statusCode === 422);
  }
  assert.equal(textSupport(account('codex', 'codex'), { allowCodex: false }).ok, false);
  assert.throws(() => buildTextCommand(account('codex', 'codex'), { allowCodex: false }), (error) => error.statusCode === 422);
  const codex = buildTextCommand(account('codex-b', 'codex'), { allowCodex: true });
  assert.deepEqual(codex.args.slice(0, 4), ['exec', '--sandbox', 'read-only', '--skip-git-repo-check']);
  assert.equal(codex.args.at(-1), '-');
  assert.ok(codex.args.includes('features.shell_tool=false'));
});

test('text runs stop on timeout and on oversized output, and detect limits', async () => {
  const claude = account('claude-a', 'claude-code');
  const hang = fakeSpawn(() => {});
  const timedOut = await runText({ account: claude, prompt: 'oi', timeoutMs: 50, spawnImpl: hang.impl });
  assert.equal(timedOut.status, 'timeout');
  assert.equal(hang.calls[0].child.killedWith, 'SIGTERM');

  const flood = fakeSpawn((call) => { call.child.stdout.write(Buffer.alloc(2048, 97)); });
  assert.equal((await runText({ account: claude, prompt: 'oi', timeoutMs: 5000, maxOutputBytes: 1024, spawnImpl: flood.impl })).status, 'too-large');

  const limited = fakeSpawn(reply('Claude AI usage limit reached|1800000000\n', 1));
  const outcome = await runText({ account: claude, prompt: 'oi', timeoutMs: 5000, spawnImpl: limited.impl });
  assert.equal(outcome.status, 'rate-limited');
  assert.equal(outcome.resetsAt, 1800000000);
});

test('generate-text follows the queue, skips unsafe providers and hands off on limits', async () => {
  const accounts = fakeAccounts([account('codex', 'codex', { primary: true }), account('gem', 'gemini-cli'), account('claude-a', 'claude-code'), account('claude-b', 'claude-code')]);
  const runs = [];
  const runTextImpl = async ({ account: target }) => {
    runs.push(target.id);
    return target.id === 'claude-a' ? { status: 'rate-limited', text: '', error: 'usage limit', resetsAt: 0 } : { status: 'completed', text: 'ok', error: '', resetsAt: 0 };
  };
  const sessions = await new IntegrationSessions(join(await tempDir('harness-int-'), 'i.json')).load();
  const integrations = new IntegrationService({ auth: fakeAuth(), accounts, sessions, runTextImpl, allowCodex: false, log() {} });
  const { session } = await sessions.issue({ client: 'live-rooms' });
  const entry = sessions.sessions[0];
  assert.equal(entry.id, session.id);

  const result = await integrations.generate(entry, { prompt: 'Gere JSON' });
  assert.deepEqual(runs, ['claude-a', 'claude-b']);
  assert.equal(result.accountId, 'claude-b');
  assert.equal(result.provider, 'claude-code');
  assert.ok(accounts.registry.stateOf('claude-a').cooldownUntil > Date.now());
  assert.equal(accounts.busy.size, 0);

  const status = integrations.status(entry);
  assert.deepEqual(status.providers.map((item) => [item.id, item.available]), [['codex', false], ['gem', false], ['claude-a', false], ['claude-b', true]]);

  for (const provider of ['gemini-cli', 'gem', 'codex']) {
    await assert.rejects(integrations.generate(entry, { prompt: 'x', provider }), (error) => error.statusCode === 422);
  }
  await assert.rejects(integrations.generate(entry, { prompt: 'x', provider: 'claude-a' }), (error) => error.statusCode === 503);
  await assert.rejects(integrations.generate(entry, { prompt: '' }), (error) => error.statusCode === 400);
  await assert.rejects(integrations.generate(entry, { prompt: 'x'.repeat(60_001) }), (error) => error.statusCode === 400);
  await assert.rejects(integrations.generate(entry, { prompt: 'x', timeoutSeconds: 5 }), (error) => error.statusCode === 400);
  await assert.rejects(integrations.generate(entry, { prompt: 'x', provider: 'nope' }), (error) => error.statusCode === 404);
});

test('generate-text allows one run per token and 30 per hour', async () => {
  const accounts = fakeAccounts([account('claude-a', 'claude-code')]);
  let release;
  let pending = 0;
  const runTextImpl = () => (pending++ === 0 ? new Promise((resolvePromise) => { release = () => resolvePromise({ status: 'completed', text: 'ok', error: '', resetsAt: 0 }); }) : Promise.resolve({ status: 'completed', text: 'ok', error: '', resetsAt: 0 }));
  const sessions = await new IntegrationSessions(join(await tempDir('harness-int-'), 'i.json')).load();
  const integrations = new IntegrationService({ auth: fakeAuth(), accounts, sessions, runTextImpl, log() {} });
  await sessions.issue({ client: 'a' });
  await sessions.issue({ client: 'b' });
  const [one, two] = sessions.sessions;

  const first = integrations.generate(one, { prompt: 'x' });
  await assert.rejects(integrations.generate(one, { prompt: 'y' }), (error) => error.statusCode === 409);
  release();
  assert.equal((await first).text, 'ok');

  for (let index = 1; index < 30; index += 1) await integrations.generate(one, { prompt: 'x' });
  await assert.rejects(integrations.generate(one, { prompt: 'x' }), (error) => error.statusCode === 429 && error.retryAfter > 0);
  assert.equal((await integrations.generate(two, { prompt: 'x' })).text, 'ok');
});
