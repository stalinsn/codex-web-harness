import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

const python = process.env.CODEX_VOICE_PYTHON || join(homedir(), '.local/venvs/harness-voice/bin/python');
const model = process.env.CODEX_VOICE_MODEL || join(homedir(), '.cache/harness-voice/small');
const worker = join(import.meta.dirname, 'transcribe.py');
const jobs = new Map();
let activeJob = null;
const error = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });

export async function voiceStatus() {
  try {
    await Promise.all([access(python), access(join(model, 'model.bin')), access(worker)]);
    return { available: true, provider: 'local', maxBytes: 12 * 1024 * 1024, maxSeconds: 180 };
  } catch { return { available: false, provider: 'local', reason: 'A transcrição de voz ainda não foi configurada no servidor.' }; }
}

export async function startTranscription(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw error('Solicitação de áudio inválida.');
  if (activeJob) throw error('Outro áudio está sendo transcrito. Aguarde e tente novamente.', 429);
  const extensions = { 'audio/webm': 'webm', 'audio/mp4': 'm4a', 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/ogg': 'ogg', 'audio/aac': 'aac', 'audio/x-m4a': 'm4a' };
  const extension = extensions[String(body.mime || '').split(';')[0].toLowerCase()];
  if (!extension || typeof body.data !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(body.data)) throw error('Formato de áudio inválido. Grave novamente ou escolha MP3, M4A, WAV ou WebM.');
  if (body.data.length > 16 * 1024 * 1024) throw error('O limite é de 12 MB por áudio.', 413);
  const audio = Buffer.from(body.data, 'base64');
  if (!audio.length || audio.length > 12 * 1024 * 1024) throw error('O áudio está vazio ou ultrapassa 12 MB.', 413);
  if (!(await voiceStatus()).available) throw error('A transcrição de voz ainda não foi configurada no servidor.', 503);
  if (activeJob) throw error('Outro áudio está sendo transcrito. Aguarde e tente novamente.', 429);
  // Reserve the slot before any asynchronous filesystem operation.
  const job = { id: randomUUID(), status: 'processing', createdAt: Date.now(), child: null };
  activeJob = job;
  jobs.set(job.id, job);
  runTranscription(job, audio, extension).catch(() => {});
  return { id: job.id, status: job.status };
}

async function runTranscription(job, audio, extension) {
  let directory;
  try {
    const root = join(tmpdir(), 'codex-voice');
    await mkdir(root, { recursive: true, mode: 0o700 });
    directory = await mkdtemp(join(root, 'audio-'));
    const path = join(directory, `recording.${extension}`);
    await writeFile(path, audio, { mode: 0o600 });
    const result = await new Promise((resolve, reject) => {
      if (job.status === 'cancelled') return reject(error('Transcrição cancelada.'));
      const child = spawn('nice', ['-n', '10', python, worker, path, model], { env: { ...process.env, OMP_NUM_THREADS: '1', OPENBLAS_NUM_THREADS: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
      job.child = child;
      let output = '';
      const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(error('O processamento demorou demais. Tente um áudio mais curto.')); }, 300_000);
      child.stdout.on('data', (chunk) => { output += chunk; if (output.length > 128 * 1024) child.kill('SIGKILL'); });
      // Worker errors never include the recording or private paths in API responses.
      child.stderr.resume();
      child.on('error', () => { clearTimeout(timeout); reject(error('Não foi possível iniciar a transcrição.')); });
      child.on('close', (code) => {
        clearTimeout(timeout);
        try {
          const data = JSON.parse(output);
          if (code !== 0 || data.error) reject(error(data.error || 'Não foi possível transcrever o áudio.'));
          else resolve(data);
        } catch { reject(error('Não foi possível ler este áudio. Grave novamente ou tente outro formato.')); }
      });
    });
    if (job.status !== 'cancelled') { job.status = 'completed'; job.text = result.text; job.duration = result.duration; }
  } catch (failure) {
    if (job.status !== 'cancelled') { job.status = 'failed'; job.error = failure.message; }
  } finally {
    job.child = null;
    if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {});
    activeJob = null;
    const cleanup = setTimeout(() => jobs.delete(job.id), 10 * 60_000);
    cleanup.unref();
  }
}

export function getTranscription(id) {
  const job = jobs.get(id);
  if (!job) throw error('Esta transcrição expirou. O áudio pode ser enviado novamente.', 404);
  return { id: job.id, status: job.status, text: job.text, error: job.error, duration: job.duration };
}

export function cancelTranscription(id) {
  const job = jobs.get(id);
  if (job?.status === 'processing') { job.status = 'cancelled'; job.child?.kill('SIGKILL'); }
  return { cancelled: true };
}
