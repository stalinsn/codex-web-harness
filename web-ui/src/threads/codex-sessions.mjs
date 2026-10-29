// Lightweight metadata for Codex rollout sessions. The harness uses it to keep
// provider-backed sessions out of the conversation list and to recover links lost
// when a Codex process stops before the turn finishes.
import { createReadStream } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const CACHE_TTL_MS = 30_000;
const cache = new Map();

async function rolloutFiles(directory, depth = 0) {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch { return []; }
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory() && depth < 4) files.push(...await rolloutFiles(path, depth + 1));
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(path);
  }
  return files;
}

async function firstLines(path, limit = 12) {
  const stream = createReadStream(path, { encoding: 'utf8', highWaterMark: 32 * 1024 });
  const reader = createInterface({ input: stream, crlfDelay: Infinity });
  const lines = [];
  try {
    for await (const line of reader) {
      lines.push(line);
      if (lines.length >= limit) break;
    }
  } catch { /* unreadable or truncated session */ }
  finally { reader.close(); stream.destroy(); }
  return lines;
}

function parseJson(line) {
  try { return JSON.parse(line); } catch { return null; }
}

function sessionSource(payload) {
  const source = payload?.source;
  const spawned = source?.subagent?.thread_spawn;
  return {
    isSubagent: payload?.thread_source === 'subagent' || Boolean(spawned),
    parentThreadId: payload?.parent_thread_id || spawned?.parent_thread_id || '',
  };
}

function normalizeTitle(value) {
  return String(value || '').trim().toLocaleLowerCase('pt-BR').replace(/\s+/g, ' ');
}

function titlesMatch(left, right) {
  const a = normalizeTitle(left);
  const b = normalizeTitle(right);
  return Boolean(a && b && (a === b || a.startsWith(b) || b.startsWith(a)));
}

export async function getCodexSessionMetadata(codexHome) {
  const cached = cache.get(codexHome);
  if (cached?.value && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;
  if (cached?.pending) return cached.pending;

  const pending = (async () => {
    const sessionsRoot = join(codexHome, 'sessions');
    const [files, indexText] = await Promise.all([
      rolloutFiles(sessionsRoot),
      readFile(join(codexHome, 'session_index.jsonl'), 'utf8').catch(() => ''),
    ]);
    const names = new Map();
    for (const line of indexText.split('\n')) {
      const entry = parseJson(line);
      if (entry?.id) names.set(entry.id, entry.thread_name || '');
    }

    const sessions = [];
    for (const file of files) {
      const lines = await firstLines(file);
      const envelope = parseJson(lines[0]);
      if (envelope?.type !== 'session_meta') continue;
      const payload = envelope.payload || {};
      const id = typeof payload.id === 'string' ? payload.id : payload.session_id;
      if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(id)) continue;
      const source = sessionSource(payload);
      let model = '';
      for (const line of lines.slice(1)) {
        const record = parseJson(line);
        if (record?.type === 'event_msg' && record.payload?.type === 'thread_settings_applied') {
          model = String(record.payload.thread_settings?.model || '');
          break;
        }
      }
      const timestamp = Date.parse(payload.timestamp || envelope.timestamp || '');
      sessions.push({
        id,
        cwd: typeof payload.cwd === 'string' ? payload.cwd : '',
        title: names.get(id) || '',
        createdAt: Number.isFinite(timestamp) ? timestamp : 0,
        model,
        ...source,
      });
    }
    return sessions;
  })();

  cache.set(codexHome, { at: Date.now(), pending });
  try {
    const value = await pending;
    cache.set(codexHome, { at: Date.now(), value });
    return value;
  } catch (error) {
    cache.delete(codexHome);
    throw error;
  }
}

export async function subagentThreadIds(codexHome) {
  const sessions = await getCodexSessionMetadata(codexHome);
  return new Set(sessions.filter((session) => session.isSubagent).map((session) => session.id));
}

/**
 * Recover native Codex sessions created by a harness-backed Codex turn. Exact
 * timestamp, working directory and title matches avoid merging unrelated chats.
 */
export function reconcileCodexSessions(record, sessions, claimedIds = new Set()) {
  record.sessions ||= {};
  record.sessionModels ||= {};
  record.sessionTurnCounts ||= {};
  const turns = Array.isArray(record.turns) ? record.turns : [];
  const thread = record.thread || {};
  const title = thread.name || thread.preview || '';
  const knownIds = new Set([
    ...(Array.isArray(thread.internalCodexThreadIds) ? thread.internalCodexThreadIds : []),
    ...(thread.internalCodexThreadId ? [thread.internalCodexThreadId] : []),
    ...(typeof record.sessions?.codex === 'string' ? [record.sessions.codex] : []),
  ]);
  const matches = [];
  turns.forEach((turn, index) => {
    if (turn.account?.provider !== 'codex' || !Number.isFinite(Number(turn.startedAt))) return;
    const startedAt = Number(turn.startedAt) * 1000;
    const candidates = sessions.filter((session) => !session.isSubagent
      && session.cwd === thread.cwd
      && Math.abs(session.createdAt - startedAt) <= 250
      && titlesMatch(session.title, title)
      && (!claimedIds.has(session.id) || knownIds.has(session.id)));
    if (candidates.length === 1) matches.push({ session: candidates[0], turnIndex: index });
  });

  if (!matches.length) return false;
  let changed = false;
  for (const { session } of matches) {
    if (!knownIds.has(session.id)) { knownIds.add(session.id); changed = true; }
    claimedIds.add(session.id);
  }
  const latest = matches.at(-1);
  if (latest && record.sessions?.codex !== latest.session.id) {
    record.sessions.codex = latest.session.id;
    if (latest.session.model) record.sessionModels.codex = ['Codex', latest.session.model].filter(Boolean).join(' · ');
    record.sessionTurnCounts.codex = latest.turnIndex + 1;
    changed = true;
  }
  const ids = [...knownIds];
  if (JSON.stringify(thread.internalCodexThreadIds || []) !== JSON.stringify(ids)) {
    thread.internalCodexThreadIds = ids;
    changed = true;
  }
  return changed;
}
