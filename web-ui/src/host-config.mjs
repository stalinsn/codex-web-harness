// Optional per-installation settings in CODEX_HOME/web-config.json (never committed).
//
// {
//   "health": {
//     "dockerProjectLabels": { "my-app": "My App", "my-app-*": "My App" },
//     "buildkitLabel": "BuildKit",
//     "storagePaths": [{ "name": "Builds", "path": "~/builds" }]
//   }
// }
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.mjs';

const DEFAULT_STORAGE_PATHS = [
  { name: 'Repositórios de projetos', path: '~/projects' },
  { name: 'Dados e cache do Codex', path: config.codexHome },
  { name: 'Cache do usuário', path: '~/.cache' },
  { name: 'Cache npm', path: '~/.npm' },
];

function load() {
  try {
    return JSON.parse(readFileSync(join(config.codexHome, 'web-config.json'), 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('web-config.json inválido; usando valores padrão:', error.message);
    return {};
  }
}

const expandHome = (path) => (path === '~' || path.startsWith('~/') ? join(config.homeDir, path.slice(1)) : path);
const stored = load();
const health = stored.health && typeof stored.health === 'object' ? stored.health : {};
const labels = health.dockerProjectLabels && typeof health.dockerProjectLabels === 'object' ? health.dockerProjectLabels : {};

export const hostConfig = Object.freeze({
  buildkitLabel: typeof health.buildkitLabel === 'string' ? health.buildkitLabel : 'BuildKit',
  storagePaths: (Array.isArray(health.storagePaths) ? health.storagePaths : DEFAULT_STORAGE_PATHS)
    .filter((entry) => entry && typeof entry.name === 'string' && typeof entry.path === 'string' && entry.path)
    .map((entry) => ({ name: entry.name, path: expandHome(entry.path) })),
  /** Exact compose project / container name match first, then "prefix-*" patterns. */
  dockerLabel(...candidates) {
    for (const value of candidates) if (value && typeof labels[value] === 'string') return labels[value];
    for (const [pattern, label] of Object.entries(labels)) {
      if (!pattern.endsWith('*') || typeof label !== 'string') continue;
      if (candidates.some((value) => value && value.startsWith(pattern.slice(0, -1)))) return label;
    }
    return null;
  },
});
