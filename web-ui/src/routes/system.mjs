// Voice transcription, VPS health and bootstrap data.
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { config, limits } from '../config.mjs';
import { getVpsHealth } from '../health/index.mjs';
import { json, readBody } from '../http/respond.mjs';
import { getProjects } from '../projects.mjs';
import { mergeThreads } from './threads.mjs';
import { cancelTranscription, getTranscription, startTranscription, voiceStatus } from '../voice/transcription.mjs';

const JOB_ID = /^\/api\/voice\/transcriptions\/([a-f0-9-]{36})$/;

export function registerSystemRoutes(router, { codex, localThreads }) {
  router.get('/api/voice', async ({ res }) => json(res, 200, await voiceStatus()));
  router.post('/api/voice/transcriptions', async ({ req, res }) => json(res, 202, await startTranscription(await readBody(req, limits.maxVoiceBody))));
  router.get(JOB_ID, ({ res, params: [id] }) => json(res, 200, getTranscription(id)));
  router.delete(JOB_ID, ({ res, params: [id] }) => json(res, 200, cancelTranscription(id)));

  router.get('/api/server-health', async ({ res, url }) => json(res, 200, await getVpsHealth(url.searchParams.get('refresh') === 'true')));
  router.get('/api/health', ({ res }) => json(res, 200, { online: true, codex: codex.ready, service: 'codex-web-harness' }));

  router.get('/api/account-data', async ({ res, url }) => {
    await codex.refreshAccountData(url.searchParams.get('refresh') === 'true');
    return json(res, 200, { models: codex.models, account: codex.account, rateLimits: codex.rateLimits, usage: codex.usage });
  });

  router.get('/api/bootstrap', async ({ res }) => {
    // The shell can render from cached account data. Refresh stale quota data in the
    // background so a page reload does not wait on several app-server RPCs.
    codex.refreshAccountData().catch((error) => console.error('Não foi possível atualizar os dados da conta:', error.message));
    const threads = await codex.rpc('thread/list', { limit: 50, sortKey: 'updated_at', sortDirection: 'desc' });
    return json(res, 200, {
      models: codex.models,
      threads: mergeThreads(threads.data || [], localThreads.list()),
      projects: await getProjects(),
      account: codex.account,
      rateLimits: codex.rateLimits,
      usage: codex.usage,
      pending: [...codex.pendingRequests.values()],
      defaultCwd: config.defaultCwd,
      projectsRoot: join(await realpath(config.homeDir), 'projects'),
      server: { online: true, version: '1.0.0' },
    });
  });
}
