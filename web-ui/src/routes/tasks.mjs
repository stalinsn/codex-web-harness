// /api/tasks: continuous tasks that move between accounts on usage limits.
import { json, readBody } from '../http/respond.mjs';

const TASK = (suffix = '') => new RegExp(`^/api/tasks/([a-f0-9-]{36})${suffix}$`);

export function registerTaskRoutes(router, { orchestrator }) {
  router.get('/api/tasks', ({ res }) => json(res, 200, { tasks: orchestrator.list() }));
  router.post('/api/tasks', async ({ req, res }) => {
    const body = await readBody(req, 256 * 1024);
    return json(res, 201, { task: await orchestrator.create(body) });
  });
  router.get(TASK(), async ({ res, params: [id] }) => json(res, 200, { task: await orchestrator.get(id) }));
  router.post(TASK('/stop'), async ({ res, params: [id] }) => json(res, 200, { task: await orchestrator.stop(id) }));
  router.post(TASK('/resume'), async ({ req, res, params: [id] }) => {
    const body = await readBody(req, 64 * 1024);
    return json(res, 200, { task: await orchestrator.resume(id, { note: typeof body.note === 'string' ? body.note : '' }) });
  });
}
