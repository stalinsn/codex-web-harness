// Runtime configuration, read once from the environment.
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const HOME_DIR = process.env.HOME || homedir();
const CODEX_HOME = process.env.CODEX_HOME || join(HOME_DIR, '.codex');

export const config = Object.freeze({
  host: process.env.CODEX_UI_HOST || '127.0.0.1',
  port: Number(process.env.CODEX_UI_PORT || 7682),
  prefix: '/codex-agent',
  homeDir: HOME_DIR,
  codexHome: CODEX_HOME,
  codexBin: process.env.CODEX_BIN || join(HOME_DIR, '.local', 'bin', 'codex'),
  defaultCwd: process.env.CODEX_DEFAULT_CWD || HOME_DIR,
  publicDir: resolve(process.env.CODEX_UI_PUBLIC || join(import.meta.dirname, '..', 'public')),
  uploadDir: join(CODEX_HOME, 'web-uploads'),
  projectsFile: join(CODEX_HOME, 'web-projects.json'),
  authFile: join(CODEX_HOME, 'web-auth.json'),
  authOrigin: process.env.CODEX_UI_ORIGIN ? new URL(process.env.CODEX_UI_ORIGIN).origin : null,
});

export const limits = Object.freeze({
  maxBody: 48 * 1024 * 1024,
  maxAuthBody: 16 * 1024,
  maxVoiceBody: 17 * 1024 * 1024,
  maxImage: 8 * 1024 * 1024,
  maxImages: 4,
  maxAttachments: 8,
  maxAttachmentBytes: 24 * 1024 * 1024,
});

// Codex app-server section id used to pin conversations (shared with the client).
export const PINNED_THREAD_SECTION_ID = '01984de2-8f74-7c91-a3b2-5c5e937cf318';
