// Shared project and conversation label colors, stored with the user's Codex data.
import { randomUUID } from 'node:crypto';
import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from './config.mjs';

export const LABEL_COLORS = new Set(['#70b7ff', '#b398ff', '#59d2b1', '#ffbf69', '#ff8fa7', '#9bd58c']);
const ID = /^[a-zA-Z0-9_-]{1,100}$/;
let writeQueue = Promise.resolve();

function cleanMap(value, { keepTombstones = true } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value)
    .filter(([id, color]) => ID.test(id) && (LABEL_COLORS.has(color) || (keepTombstones && color === null)))
    .slice(0, 2000));
}

async function readLabels() {
  try {
    const stored = JSON.parse(await readFile(config.labelsFile, 'utf8'));
    if (stored?.version !== 1) return { version: 1, projectColors: {}, threadColors: {} };
    return {
      version: 1,
      projectColors: cleanMap(stored.projectColors),
      threadColors: cleanMap(stored.threadColors),
    };
  } catch (error) {
    if (error.code === 'ENOENT') return { version: 1, projectColors: {}, threadColors: {} };
    throw error;
  }
}

async function writeLabels(data) {
  const temporary = join(config.codexHome, `web-label-colors-${randomUUID()}.tmp`);
  await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  try { await rename(temporary, config.labelsFile); }
  catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

function serializeWrite(work) {
  const result = writeQueue.then(work);
  writeQueue = result.catch(() => {});
  return result;
}

export async function getLabelColors() {
  return readLabels();
}

/** Import this browser's legacy localStorage values only where the server has no value. */
export function migrateLabelColors(projectColors, threadColors) {
  return serializeWrite(async () => {
    const data = await readLabels();
    for (const [key, color] of Object.entries(cleanMap(projectColors, { keepTombstones: false }))) {
      if (!Object.hasOwn(data.projectColors, key)) data.projectColors[key] = color;
    }
    for (const [key, color] of Object.entries(cleanMap(threadColors, { keepTombstones: false }))) {
      if (!Object.hasOwn(data.threadColors, key)) data.threadColors[key] = color;
    }
    await writeLabels(data);
    return data;
  });
}

export function setLabelColor(scope, id, color) {
  return serializeWrite(async () => {
    const data = await readLabels();
    const map = scope === 'project' ? data.projectColors : data.threadColors;
    // Keep cleared entries as tombstones so an older browser cannot resurrect them.
    map[id] = color || null;
    await writeLabels(data);
    return data;
  });
}
