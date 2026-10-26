// Antigravity CLI permissions are stored per isolated account. In headless mode,
// request-review cannot pause for a browser approval; unapproved tools soft-deny.
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { httpError } from '../http/respond.mjs';
import { accountsDir } from './registry.mjs';

const MODES = new Set(['always-proceed', 'request-review']);
// These broad rules were added by the first harness setup. Remove them when
// switching back to review so they cannot silently override the requested mode.
const HARNESS_WILDCARD_RULES = ['command(*)', 'read_file(*)', 'write_file(*)'];

function accountSettingsPath(account) {
  if (!account || account.provider !== 'antigravity') throw httpError('Este controle de acesso está disponível para contas Antigravity.', 400);
  const root = resolve(accountsDir());
  const accountDir = resolve(account.dir);
  if (!accountDir.startsWith(`${root}${sep}`)) throw httpError('A conta Antigravity precisa usar sua pasta isolada do harness.', 400);
  return { root, accountDir, geminiDir: join(accountDir, '.gemini'), settingsDir: join(accountDir, '.gemini', 'antigravity-cli'), settingsFile: join(accountDir, '.gemini', 'antigravity-cli', 'settings.json') };
}

async function requireDirectory(path, { create = false } = {}) {
  let metadata;
  try { metadata = await lstat(path); }
  catch (error) {
    if (error.code !== 'ENOENT' || !create) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
    try { await mkdir(path, { mode: 0o700 }); }
    catch (createError) { if (createError.code !== 'EEXIST') throw createError; }
    metadata = await lstat(path);
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw httpError('A pasta das permissões contém um link simbólico ou não é um diretório seguro.', 400);
  return true;
}

async function readSettings(account, { create = false } = {}) {
  const paths = accountSettingsPath(account);
  if (!await requireDirectory(paths.root)) return { ...paths, settings: {} };
  if (!await requireDirectory(paths.accountDir)) return { ...paths, settings: {} };
  if (!await requireDirectory(paths.geminiDir, { create })) return { ...paths, settings: {} };
  if (!await requireDirectory(paths.settingsDir, { create })) return { ...paths, settings: {} };
  try {
    const metadata = await lstat(paths.settingsFile);
    if (metadata.isSymbolicLink() || !metadata.isFile()) throw httpError('O arquivo de permissões não é um arquivo regular.', 400);
    const settings = JSON.parse(await readFile(paths.settingsFile, 'utf8'));
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw httpError('A configuração de permissões do Antigravity não é um objeto JSON válido.', 400);
    return { ...paths, settings };
  } catch (error) {
    if (error.code === 'ENOENT') return { ...paths, settings: {} };
    throw error;
  }
}

export async function getAntigravityAccessMode(account, fallback = 'request-review') {
  const { settings } = await readSettings(account);
  return typeof settings.toolPermission === 'string' && settings.toolPermission.length <= 40 ? settings.toolPermission : fallback;
}

export async function setAntigravityAccessMode(account, mode) {
  if (!MODES.has(mode)) throw httpError('Modo de acesso inválido.', 400);
  const { settingsFile, settings } = await readSettings(account, { create: true });
  settings.toolPermission = mode;
  // This setting was written by the harness during the initial setup, but it is
  // not part of the documented Antigravity CLI settings schema.
  delete settings.allowNonWorkspaceAccess;
  const permissions = settings.permissions && typeof settings.permissions === 'object' && !Array.isArray(settings.permissions) ? settings.permissions : {};
  if (Array.isArray(permissions.allow)) {
    permissions.allow = permissions.allow.filter((rule) => !HARNESS_WILDCARD_RULES.includes(rule));
  }
  settings.permissions = permissions;

  const temporary = `${settingsFile}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  try { await rename(temporary, settingsFile); }
  catch (error) {
    const { unlink } = await import('node:fs/promises');
    await unlink(temporary).catch(() => {});
    throw error;
  }
  return mode;
}
