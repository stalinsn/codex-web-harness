// Viewport, sidebar, inspector and dialog chrome.
import { $ } from './dom.js';
import { voice } from './state.js';
import { stopVoiceRecording } from './voice.js';

export function setupComposerViewport() {
  const sync = () => {
    const viewport = window.visualViewport;
    document.documentElement.style.setProperty('--app-height', `${viewport?.height || window.innerHeight}px`);
    document.documentElement.style.setProperty('--viewport-top', `${viewport?.offsetTop || 0}px`);
  };
  window.visualViewport?.addEventListener('resize', sync);
  window.visualViewport?.addEventListener('scroll', sync);
  window.addEventListener('resize', sync);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && voice.phase === 'recording') stopVoiceRecording();
  });
  sync();
}

export function setConnection(online, message) {
  $('#connectionDot').className = `status-dot ${online ? 'online' : 'offline'}`;
  $('#connectionText').textContent = message || (online ? 'Codex conectado' : 'Reconectando…');
}

export function showInspector(show) {
  if (show) closeSidebar();
  $('#inspector').classList.toggle('open', show);
  if (window.innerWidth <= 680) {
    $('#mobileScrim').classList.toggle('show', show || $('#sidebar').classList.contains('open'));
  }
}

export function setupInspectorResize() {
  const handle = $('#inspectorResizeHandle');
  const root = document.documentElement;
  const minimum = 260;
  const maximum = () => {
    const sidebarWidth = Number.parseFloat(getComputedStyle(root).getPropertyValue('--side-width')) || 264;
    return Math.max(minimum, Math.min(560, window.innerWidth - sidebarWidth - 460));
  };
  const current = () => Number.parseFloat(getComputedStyle(root).getPropertyValue('--inspector-width')) || 300;
  let preferredWidth = Number(localStorage.getItem('codex-inspector-width'));
  if (!Number.isFinite(preferredWidth) || preferredWidth < minimum) preferredWidth = current();
  const apply = (requested) => {
    const width = Math.min(maximum(), Math.max(minimum, requested));
    root.style.setProperty('--inspector-width', `${width}px`);
    handle.setAttribute('aria-valuemax', String(Math.round(maximum())));
    handle.setAttribute('aria-valuenow', String(Math.round(width)));
  };
  apply(preferredWidth);
  let pointerId = null;
  handle.addEventListener('pointerdown', (event) => {
    if (window.innerWidth <= 980 || event.button !== 0) return;
    pointerId = event.pointerId;
    handle.setPointerCapture(pointerId);
    document.body.classList.add('resizing-inspector');
    event.preventDefault();
  });
  handle.addEventListener('pointermove', (event) => {
    if (event.pointerId === pointerId) apply(window.innerWidth - event.clientX);
  });
  const finish = (event) => {
    if (event.pointerId !== pointerId) return;
    pointerId = null;
    document.body.classList.remove('resizing-inspector');
    preferredWidth = current();
    localStorage.setItem('codex-inspector-width', String(Math.round(preferredWidth)));
  };
  handle.addEventListener('pointerup', finish);
  handle.addEventListener('pointercancel', finish);
  handle.addEventListener('keydown', (event) => {
    const step = event.shiftKey ? 48 : 16;
    if (event.key === 'ArrowLeft') { event.preventDefault(); apply(current() + step); }
    else if (event.key === 'ArrowRight') { event.preventDefault(); apply(current() - step); }
    else if (event.key === 'Home') { event.preventDefault(); apply(minimum); }
    else if (event.key === 'End') { event.preventDefault(); apply(maximum()); }
    else return;
    preferredWidth = current();
    localStorage.setItem('codex-inspector-width', String(Math.round(preferredWidth)));
  });
  window.addEventListener('resize', () => { if (window.innerWidth > 980) apply(preferredWidth); });
}

export function openImagePreview(src, caption = 'Imagem anexada') {
  if (!src) return;
  $('#imagePreviewImage').src = src;
  $('#imagePreviewImage').alt = caption;
  $('#imagePreviewCaption').textContent = caption;
  $('#imagePreviewDialog').showModal();
}

export function openSidebar() { showInspector(false); $('#sidebar').classList.add('open'); $('#mobileScrim').classList.add('show'); }

export function closeSidebar() { $('#sidebar').classList.remove('open'); if (!$('#inspector').classList.contains('open')) $('#mobileScrim').classList.remove('show'); }
