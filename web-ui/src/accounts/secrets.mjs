// Per-account secrets (tokens / API keys) kept in <account dir>/.harness-secrets.json (0600)
// and injected into that account's environment only.
import { readFileSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const FILE = '.harness-secrets.json';
const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,63}$/;

export function readSecretsSync(dir) {
  try {
    const value = JSON.parse(readFileSync(join(dir, FILE), 'utf8'));
    return Object.fromEntries(Object.entries(value || {}).filter(([key, secret]) => ENV_NAME.test(key) && typeof secret === 'string'));
  } catch { return {}; }
}

export async function saveSecret(dir, name, value) {
  if (!ENV_NAME.test(name)) throw new Error('Nome de variável inválido.');
  const clean = String(value || '').trim();
  if (!clean || clean.length > 4096 || /\s/.test(clean)) throw new Error('Valor inválido.');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  let current = {};
  try { current = JSON.parse(await readFile(join(dir, FILE), 'utf8')) || {}; } catch { /* first secret */ }
  const temporary = join(dir, `${FILE}.${process.pid}.tmp`);
  await writeFile(temporary, `${JSON.stringify({ ...current, [name]: clean }, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, join(dir, FILE));
}
