// /api/projects and thread ↔ project association.
import { randomUUID } from 'node:crypto';
import { rmdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fail, json, readBody } from '../http/respond.mjs';
import { LABEL_COLORS, getLabelColors, migrateLabelColors, setLabelColor } from '../labels.mjs';
import { createProjectDirectory, findProjectForCwd, getProjects, saveProjects, validateCwd } from '../projects.mjs';

const MAX_PROJECTS = 100;

export function registerProjectRoutes(router, { codex }) {
  router.get('/api/projects', async ({ res }) => json(res, 200, { projects: await getProjects() }));

  router.get('/api/labels', async ({ res }) => json(res, 200, await getLabelColors()));

  router.post('/api/labels/migrate', async ({ req, res }) => {
    const body = await readBody(req, 256 * 1024);
    if (!body || typeof body !== 'object' || Array.isArray(body)) return fail(res, 400, 'Dados das etiquetas inválidos.');
    const labels = await migrateLabelColors(body.projectColors, body.threadColors);
    return json(res, 200, labels);
  });

  router.put(/^\/api\/labels\/(project|thread)\/([a-zA-Z0-9_-]{1,100})$/, async ({ req, res, params: [scope, id] }) => {
    const body = await readBody(req, 4096);
    if (!body || typeof body !== 'object' || Array.isArray(body)) return fail(res, 400, 'Dados da etiqueta inválidos.');
    const color = body.color;
    if (color !== '' && color !== null && !LABEL_COLORS.has(color)) return fail(res, 400, 'A cor selecionada não é válida.');
    await setLabelColor(scope, id, color || '');
    return json(res, 200, { ok: true });
  });

  router.post('/api/projects', async ({ req, res }) => {
    const body = await readBody(req);
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name || name.length > 80) return fail(res, 400, 'Informe um nome de projeto com até 80 caracteres.');
    const projects = await getProjects();
    if (projects.length >= MAX_PROJECTS) return fail(res, 400, 'O limite de projetos foi atingido.');
    const createDirectory = body.createDirectory === true;
    const requestedPath = typeof body.cwd === 'string' ? resolve(body.cwd) : '';
    if (projects.some((project) => resolve(project.cwd) === requestedPath)) return fail(res, 409, 'Já existe um projeto para essa pasta.');
    const cwd = createDirectory ? await createProjectDirectory(body.cwd) : await validateCwd(body.cwd);
    if (projects.some((project) => resolve(project.cwd) === resolve(cwd))) {
      if (createDirectory) await rmdir(cwd).catch(() => {});
      return fail(res, 409, 'Já existe um projeto para essa pasta.');
    }
    const project = { id: randomUUID(), name, cwd, threadIds: [] };
    const updated = [...projects, project];
    try { await saveProjects(updated); }
    catch (error) { if (createDirectory) await rmdir(cwd).catch(() => {}); throw error; }
    return json(res, 201, { project, projects: updated });
  });

  router.post(/^\/api\/threads\/([a-zA-Z0-9_-]{1,100})\/project-association$/, async ({ res, params: [threadId] }) => {
    const result = await codex.rpc('thread/read', { threadId });
    const threadCwd = typeof result.thread?.cwd === 'string' ? result.thread.cwd : '';
    const projects = await getProjects();
    const project = findProjectForCwd(projects, threadCwd) || projects.find((item) => item.threadIds.includes(threadId)) || null;
    if (project) {
      let changed = false;
      for (const item of projects) {
        const hasThread = item.threadIds.includes(threadId);
        if (item.id === project.id && !hasThread) {
          item.threadIds.push(threadId);
          changed = true;
        } else if (item.id !== project.id && hasThread) {
          item.threadIds = item.threadIds.filter((id) => id !== threadId);
          changed = true;
        }
      }
      if (changed) await saveProjects(projects);
    }
    return json(res, 200, { projectId: project?.id || '', projects });
  });
}
