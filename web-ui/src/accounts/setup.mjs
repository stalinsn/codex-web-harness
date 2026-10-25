// Account set-up helpers: isolated folder preparation, CLI detection, manual tokens
// and signing out. The primary Codex account (the chat's own login) is never touched.
import { execFile } from 'node:child_process';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { config } from '../config.mjs';
import { httpError } from '../http/respond.mjs';
import { accountEnv, commandFor } from './cli-runner.mjs';
import { PROVIDERS } from './providers.mjs';
import { accountsDir } from './registry.mjs';
import { saveSecret } from './secrets.mjs';

const execFileAsync = promisify(execFile);

function assertManaged(account) {
  if (account.primary) throw httpError('A conta principal do Codex é gerenciada fora do painel e não é alterada aqui.', 400);
  if (!resolve(account.dir).startsWith(resolve(accountsDir()) + sep)) throw httpError('Esta conta usa uma pasta externa ao harness; gerencie o login pela própria CLI.', 400);
}

/** Create the isolated folder; extra Codex accounts inherit the primary config and policy. */
export async function prepareAccountDir(account) {
  if (account.primary) return;
  await mkdir(account.dir, { recursive: true, mode: 0o700 });
  if (account.provider !== 'codex') return;
  for (const file of ['config.toml', 'AGENTS.md']) {
    await copyFile(join(config.codexHome, file), join(account.dir, file), 1 /* COPYFILE_EXCL */).catch(() => {});
  }
  const configFile = join(account.dir, 'config.toml');
  const current = await readFile(configFile, 'utf8').catch(() => '');
  if (!/^\s*cli_auth_credentials_store\s*=/m.test(current)) {
    await writeFile(configFile, `cli_auth_credentials_store = "file"\n${current}`, { mode: 0o600 });
  }
}

export async function findBinary(account) {
  const bin = commandFor(account);
  if (!bin) return '';
  try {
    const { stdout } = await execFileAsync('sh', ['-c', 'command -v "$1"', 'sh', bin], { env: accountEnv(account), timeout: 5000 });
    return stdout.trim();
  } catch { return ''; }
}

async function version(account, binPath) {
  if (!binPath) return '';
  try {
    const { stdout } = await execFileAsync(binPath, ['--version'], { env: accountEnv(account), timeout: 8000, cwd: config.homeDir });
    return stdout.trim().split('\n')[0].slice(0, 80);
  } catch { return ''; }
}

/** Everything the connection wizard needs to show for one account. */
export async function setupInfo(account) {
  const preset = PROVIDERS[account.provider];
  const setup = preset.setup || { flows: [] };
  const binPath = await findBinary(account);
  return {
    accountId: account.id,
    provider: account.provider,
    providerLabel: preset.label,
    primary: Boolean(account.primary),
    bin: commandFor(account),
    binPath,
    version: await version(account, binPath),
    install: setup.install || '',
    notes: setup.notes || '',
    flows: (setup.flows || []).map(({ id, label, steps }) => ({ id, label, steps })),
    secret: setup.secret ? { label: setup.secret.label, placeholder: setup.secret.placeholder || '' } : null,
    dir: account.dir,
  };
}

export async function saveManualSecret(account, value) {
  assertManaged(account);
  const secret = PROVIDERS[account.provider].setup?.secret;
  if (!secret) throw httpError('Este provedor não aceita token manual.', 400);
  try { await saveSecret(account.dir, secret.env, value); }
  catch (error) { throw httpError(error.message, 400); }
  if (secret.settings) {
    const file = join(account.dir, secret.settings.file);
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    let current = {};
    try { current = JSON.parse(await readFile(file, 'utf8')) || {}; } catch { /* new settings file */ }
    await writeFile(file, `${JSON.stringify({ ...current, ...secret.settings.merge }, null, 2)}\n`, { mode: 0o600 });
  }
}

/** Sign out: wipe the account's isolated folder (tokens, caches) and recreate it empty. */
export async function signOut(account) {
  assertManaged(account);
  await rm(account.dir, { recursive: true, force: true });
  await prepareAccountDir(account);
}

export { assertManaged };
