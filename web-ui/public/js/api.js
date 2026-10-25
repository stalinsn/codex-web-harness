// Same-origin JSON client for the harness API.
import { PREFIX } from './config.js';

export async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.body != null) headers.set('Content-Type', 'application/json');
  const response = await fetch(`${PREFIX}${path}`, { credentials: 'same-origin', cache: 'no-store', ...options, headers });
  const data = response.status === 204 ? {} : await response.json().catch(() => ({}));
  if (!response.ok) { const error = new Error(data.error || `Falha na solicitação (${response.status}).`); error.data = data; error.status = response.status; throw error; }
  return data;
}
