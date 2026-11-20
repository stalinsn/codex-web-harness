// The authenticated private inspector's single shell session.
import { readBody, json } from '../http/respond.mjs';
import { config } from '../config.mjs';
import { validateCwd } from '../projects.mjs';

const SESSION = /^\/api\/server-terminal\/([a-f0-9-]{36})$/;
const INPUT = /^\/api\/server-terminal\/([a-f0-9-]{36})\/input$/;

export function registerTerminalRoutes(router, { terminal }) {
  router.get('/api/server-terminal', ({ res }) => json(res, 200, { session: terminal.view() }));
  router.post('/api/server-terminal', async ({ req, res }) => {
    const body = await readBody(req, 16 * 1024);
    const cwd = await validateCwd(typeof body.cwd === 'string' && body.cwd ? body.cwd : config.homeDir);
    const session = await terminal.start({ cwd, cols: body.cols, rows: body.rows });
    return json(res, 201, { session });
  });
  router.get(SESSION, ({ res, params: [id] }) => json(res, 200, { session: terminal.view(terminal.get(id)) }));
  router.post(INPUT, async ({ req, res, params: [id] }) => {
    const body = await readBody(req, 64 * 1024);
    terminal.write(id, body.data);
    return json(res, 200, { ok: true });
  });
  router.delete(SESSION, ({ res, params: [id] }) => json(res, 200, { session: terminal.stop(id) }));
}
