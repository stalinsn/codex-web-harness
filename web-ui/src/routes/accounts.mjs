// /api/accounts: registered agent accounts, their status/usage and the rotation queue.
import { fail, json, readBody } from '../http/respond.mjs';
import { PROVIDERS } from '../accounts/providers.mjs';
import { getAccountModelCatalog } from '../accounts/model-catalog.mjs';
import { prepareAccountDir, saveManualSecret, setupInfo, signOut } from '../accounts/setup.mjs';

const ACCOUNT = /^\/api\/accounts\/([a-z0-9][a-z0-9-]{0,39})$/;
const ACCOUNT_ACTION = (action) => new RegExp(`^/api/accounts/([a-z0-9][a-z0-9-]{0,39})/${action}$`);

export function registerAccountRoutes(router, { accounts, logins }) {
  const snapshot = () => ({
    accounts: accounts.list(),
    rotation: accounts.registry.rotation,
    providers: Object.entries(PROVIDERS).map(([id, preset]) => ({ id, label: preset.label, usage: preset.usage, kind: preset.kind })),
  });

  router.get('/api/accounts', ({ res }) => json(res, 200, snapshot()));

  router.post('/api/accounts', async ({ req, res }) => {
    const body = await readBody(req);
    const account = await accounts.registry.add(body);
    await prepareAccountDir(account);
    await accounts.checkStatus(account.id).catch(() => {});
    return json(res, 201, { account: accounts.list().find((item) => item.id === account.id), ...snapshot() });
  });

  // Registered before the /api/accounts/:id pattern, which would also match it.
  router.post('/api/accounts/rotation', async ({ req, res }) => {
    await accounts.registry.setRotation(await readBody(req));
    return json(res, 200, snapshot());
  });

  router.post(ACCOUNT, async ({ req, res, params: [id] }) => {
    await accounts.registry.update(id, await readBody(req));
    return json(res, 200, snapshot());
  });

  router.delete(ACCOUNT, async ({ res, url, params: [id] }) => {
    const account = accounts.registry.get(id);
    if (!account) return fail(res, 404, 'Conta não encontrada.');
    if (accounts.busy.has(id)) return fail(res, 409, 'A conta está executando uma tarefa. Pare a tarefa antes de removê-la.');
    accounts.dropAccount(account);
    if (url.searchParams.get('forget') === 'true') await accounts.forgetCredentials(account);
    await accounts.registry.remove(id);
    return json(res, 200, snapshot());
  });

  router.post(ACCOUNT_ACTION('check'), async ({ res, params: [id] }) => {
    await accounts.checkStatus(id);
    return json(res, 200, snapshot());
  });

  // Connection wizard: CLI detection, login/install terminals, manual tokens, sign-out.
  const requireAccount = (id) => {
    const account = accounts.registry.get(id);
    if (!account) throw Object.assign(new Error('Conta não encontrada.'), { statusCode: 404 });
    return account;
  };
  router.get(ACCOUNT_ACTION('setup'), async ({ res, params: [id] }) => {
    const account = requireAccount(id);
    const state = accounts.registry.stateOf(id);
    return json(res, 200, { setup: await setupInfo(account), loggedIn: state.loggedIn, statusDetail: state.statusDetail });
  });
  router.get(ACCOUNT_ACTION('models'), async ({ res, params: [id] }) => {
    const account = requireAccount(id);
    return json(res, 200, await getAccountModelCatalog(account, accounts));
  });
  router.post(ACCOUNT_ACTION('login'), async ({ req, res, params: [id] }) => {
    const body = await readBody(req, 4096);
    return json(res, 201, { session: await logins.start(id, { kind: 'login', flowId: String(body.flowId || '') }) });
  });
  router.post(ACCOUNT_ACTION('install'), async ({ res, params: [id] }) => json(res, 201, { session: await logins.start(id, { kind: 'install' }) }));
  router.post(ACCOUNT_ACTION('secret'), async ({ req, res, params: [id] }) => {
    const body = await readBody(req, 16 * 1024);
    await saveManualSecret(requireAccount(id), body.value);
    await accounts.checkStatus(id);
    return json(res, 200, snapshot());
  });
  router.post(ACCOUNT_ACTION('logout'), async ({ res, params: [id] }) => {
    if (accounts.busy.has(id)) return fail(res, 409, 'A conta está executando uma tarefa. Pare a tarefa antes de sair.');
    const account = requireAccount(id);
    logins.stopAccount(id, 'A conta foi desconectada.');
    accounts.dropAccount(account);
    await signOut(account);
    Object.assign(accounts.registry.stateOf(id), { loggedIn: false, statusDetail: 'Desconectada pelo painel.', checkedAt: Date.now(), cooldownUntil: 0, percent: null });
    await accounts.registry.saveState();
    return json(res, 200, snapshot());
  });
  const SESSION = (suffix = '') => new RegExp(`^/api/login-sessions/([a-f0-9-]{36})${suffix}$`);
  router.get(SESSION(), ({ res, params: [sid] }) => json(res, 200, { session: logins.view(logins.get(sid)) }));
  router.post(SESSION('/input'), async ({ req, res, params: [sid] }) => {
    const body = await readBody(req, 16 * 1024);
    logins.write(sid, body.data);
    return json(res, 200, { ok: true });
  });
  router.delete(SESSION(), ({ res, params: [sid] }) => { logins.stop(sid); return json(res, 200, { session: logins.view(logins.get(sid)) }); });

  router.post(ACCOUNT_ACTION('reset-cooldown'), async ({ res, params: [id] }) => {
    if (!accounts.registry.get(id)) return fail(res, 404, 'Conta não encontrada.');
    Object.assign(accounts.registry.stateOf(id), { cooldownUntil: 0, percent: null, percentAt: 0 });
    await accounts.registry.saveState();
    return json(res, 200, snapshot());
  });
}
