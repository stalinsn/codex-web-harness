// Project registry (web-projects.json) and working-directory validation.
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, rename, rmdir, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { config } from './config.mjs';
import { httpError } from './http/respond.mjs';

const PROJECT_SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;

export async function projectsRoot() {
  return join(await realpath(config.homeDir), 'projects');
}

export async function validateCwd(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.includes('\0')) throw httpError(`Informe uma pasta absoluta do servidor, por exemplo ${config.defaultCwd}.`, 400);
  let canonical;
  let info;
  try { canonical = await realpath(value); info = await stat(canonical); }
  catch { throw httpError('A pasta não existe ou não pode ser acessada pelo usuário do Codex.', 400); }
  if (!info.isDirectory()) throw httpError('O caminho informado não é uma pasta.', 400);
  return canonical;
}

export async function createProjectDirectory(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.includes('\0')) {
    throw httpError('Informe a pasta nova dentro da pasta de projetos da VPS.', 400);
  }
  const root = await projectsRoot();
  await mkdir(root, { recursive: true, mode: 0o750 });
  const actualRoot = await realpath(root);
  if (actualRoot !== root) {
    throw httpError('A pasta ~/projects precisa ser um diretório local, não um link para outro caminho.', 400);
  }
  const target = resolve(value);
  if (dirname(target) !== root || !PROJECT_SLUG.test(basename(target))) {
    throw httpError(`Projetos novos precisam ser pastas diretas de ${root}, com nome simples em letras minúsculas, números e hífens.`, 400);
  }
  try {
    await mkdir(target, { mode: 0o750 });
  } catch (error) {
    if (error.code === 'EEXIST') throw httpError('Essa pasta já existe. Selecione “Usar uma pasta existente” para associá-la.', 409);
    throw error;
  }
  try {
    const canonical = await realpath(target);
    if (dirname(canonical) !== root) throw new Error('O caminho criado saiu da pasta de projetos permitida.');
    return canonical;
  } catch (error) {
    await rmdir(target).catch(() => {});
    throw error;
  }
}

export async function getProjects() {
  try {
    const stored = JSON.parse(await readFile(config.projectsFile, 'utf8'));
    if (!Array.isArray(stored.projects)) return [];
    return stored.projects
      .filter((project) => project && typeof project.id === 'string' && typeof project.name === 'string' && typeof project.cwd === 'string')
      .map((project) => ({
        id: project.id,
        name: project.name,
        cwd: project.cwd,
        threadIds: Array.isArray(project.threadIds) ? project.threadIds.filter((id) => typeof id === 'string') : [],
      }));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

export async function saveProjects(projects) {
  const temporary = join(config.codexHome, `web-projects-${randomUUID()}.tmp`);
  await writeFile(temporary, `${JSON.stringify({ projects }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  await rename(temporary, config.projectsFile);
}

/** The most specific project whose folder contains `cwd`. */
export function findProjectForCwd(projects, cwd) {
  if (typeof cwd !== 'string' || !cwd.startsWith('/')) return null;
  const target = resolve(cwd);
  return projects
    .filter((project) => {
      const root = resolve(project.cwd);
      return target === root || target.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
    })
    .sort((left, right) => resolve(right.cwd).length - resolve(left.cwd).length)[0] || null;
}

/** Record `threadId` under the project that owns `cwd`, if any. Best effort. */
export async function attachThreadToProject(threadId, cwd) {
  const projects = await getProjects();
  const project = findProjectForCwd(projects, cwd);
  if (project && !project.threadIds.includes(threadId)) {
    project.threadIds.push(threadId);
    await saveProjects(projects);
  }
}
