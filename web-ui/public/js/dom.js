// DOM helpers, inline icon set and small generic utilities.
import { rememberError } from './error-history.js';

export const $ = (selector, root = document) => root.querySelector(selector);

export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

export const icons = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="10.8" cy="10.8" r="6.7"/><path d="m16 16 4 4"/>',
  refresh: '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M5.6 9a7 7 0 0 1 11.6-2L20 12M4 12l2.8 5a7 7 0 0 0 11.6-2"/>',
  terminal: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3m6 0h4"/>',
  external: '<path d="M14 4h6v6m-10 4L20 4"/><path d="M18 13v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h5"/>',
  chart: '<path d="M4 19V5m0 14h17"/><path d="m7 15 4-4 3 2 6-7"/>',
  archive: '<rect x="3" y="5" width="18" height="4" rx="1"/><path d="M5 9v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9m-8 3h2"/>',
  arrow: '<path d="M5 12h14m-6-6 6 6-6 6"/>',
  'arrow-up': '<path d="M12 19V5m-7 7 7-7 7 7"/>',
  sliders: '<path d="M4 7h9m4 0h3M4 17h3m4 0h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
  paperclip: '<path d="m8 12.5 6.9-6.9a3.3 3.3 0 0 1 4.7 4.7l-8.4 8.4a5 5 0 0 1-7.1-7.1l8.3-8.3"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M3 10h18"/>',
  chevron: '<path d="m7 10 5 5 5-5"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  gauge: '<path d="M4.8 18a9 9 0 1 1 14.4 0"/><path d="m12 13 4-4m-4 4-2 2"/><circle cx="12" cy="13" r="1"/>',
  server: '<rect x="4" y="4" width="16" height="6" rx="1.5"/><rect x="4" y="14" width="16" height="6" rx="1.5"/><path d="M7 7h.01M7 17h.01m3-10h7m-7 10h7"/>',
  shield: '<path d="M12 3 20 6v5c0 5.3-3.4 8.4-8 10-4.6-1.6-8-4.7-8-10V6z"/><path d="m9 12 2 2 4-4"/>',
  chat: '<path d="M20 11.5a7.5 7.5 0 0 1-7.5 7.5H6l-3 2v-9.5a7.5 7.5 0 1 1 17 0Z"/>',
  lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 1 1 8 0v3m-4 4v3"/>',
  containers: '<rect x="3" y="8" width="18" height="12" rx="2"/><path d="M7 12h2m2 0h2m2 0h2M8 8V5m4 3V5m4 3V5"/>',
  bolt: '<path d="m13 2-9 12h7l-1 8 10-13h-7z"/>',
  warning: '<path d="M12 3 2.8 19a1.7 1.7 0 0 0 1.5 2.5h15.4a1.7 1.7 0 0 0 1.5-2.5L12 3Z"/><path d="M12 9v4m0 3h.01"/>',
  user: '<circle cx="12" cy="8" r="3.5"/><path d="M5 20a7 7 0 0 1 14 0"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="m11 12 9-9m-4 4 3 3m-6-1 3 3"/>',
  pin: '<path d="m15 3 6 6-4 1-4 5-4-4 5-4zM9 15l-6 6m4-12 8 8"/>',
  tag: '<path d="M20 13 11 22 2 13V4h9z"/><circle cx="7.5" cy="8.5" r="1.2"/>',
  rename: '<path d="m15 4 5 5M4 20l5-1L20 8a2 2 0 0 0-5-5L4 14z"/>',
  trash: '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7"/>',
  microphone: '<rect x="9" y="2.5" width="6" height="12" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V22m-4 0h8"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
};

export function installIcons(root = document) {
  $$('[data-icon]', root).forEach((node) => {
    const name = node.dataset.icon;
    if (!icons[name]) return;
    node.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${icons[name]}</svg>`;
  });
}

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

export function toast(message, kind = '') {
  if (kind === 'error') rememberError(message);
  const node = document.createElement('div');
  node.className = `toast ${kind}`;
  node.textContent = message;
  $('#toastContainer').append(node);
  setTimeout(() => node.remove(), 4200);
}

export function randomKey() { return `request-${Date.now()}-${Math.random().toString(36).slice(2)}`; }

const frameTasks = new Map();

/**
 * Run `task` once on the next animation frame, coalescing repeated requests with the
 * same key. Streaming deltas use it so a burst of tokens costs one render per frame.
 */
export function onNextFrame(key, task) {
  const pending = frameTasks.size > 0;
  frameTasks.set(key, task);
  if (pending) return;
  requestAnimationFrame(() => {
    const tasks = [...frameTasks.values()];
    frameTasks.clear();
    for (const run of tasks) run();
  });
}

export function debounce(callback, delay) { let timer; return (...args) => { clearTimeout(timer); timer = setTimeout(() => callback(...args), delay); }; }
