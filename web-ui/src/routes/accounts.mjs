// /api/accounts: registered agent accounts, their status/usage and the rotation queue.
import { fail, json, readBody } from '../http/respond.mjs';
import { PROVIDERS } from '../accounts/providers.mjs';

const ACCOUNT = /^\/api\/accounts\/([a-z0-9][a-z0-9-]{0,39})$/;
const ACCOUNT_ACTION = (action) => new RegExp(`^/api/accounts/([a-z0-9][a-z0-9-]{0,39})/${action}$`);

export function registerAccountRoutes(router, { accounts }) {
  const snapshot = () => ({
    accounts: accounts.list(),
    rotation: accounts.registry.rotation,
    providers: Object.entries(PROVIDERS).map(([id, preset]) => ({ id, label: preset.label, usage: preset.usage, kind: preset.kind })),
  });

  router.get('/api/accounts', ({ res }) => json(res, 200, snapshot()));

  router.post('/api/accounts', async ({ req, res }) => {
    const body = await readBody(req);
    const account = await accounts.registry.add(body);
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
    if (url.searchParams.get('forget') === 'true') await accounts.forgetCredentials(account);
    await accounts.registry.remove(id);
    return json(res, 200, snapshot());
  });

  router.post(ACCOUNT_ACTION('check'), async ({ res, params: [id] }) => {
    await accounts.checkStatus(id);
    return json(res, 200, snapshot());
  });

  router.post(ACCOUNT_ACTION('reset-cooldown'), async ({ res, params: [id] }) => {
    if (!accounts.registry.get(id)) return fail(res, 404, 'Conta não encontrada.');
    Object.assign(accounts.registry.stateOf(id), { cooldownUntil: 0, percent: null, percentAt: 0 });
    await accounts.registry.saveState();
    return json(res, 200, snapshot());
  });
}
