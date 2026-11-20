// Inline previews for project files linked in messages: image lightbox and sandboxed HTML frames.
import { $ } from './dom.js';
import { openImagePreview } from './layout.js';

function togglePreview(card, button) {
  const open = card.classList.toggle('is-open');
  button.setAttribute('aria-expanded', String(open));
  button.textContent = open ? 'Ocultar prévia' : 'Mostrar prévia';
  let frame = card.querySelector('iframe');
  if (open && !frame) {
    frame = document.createElement('iframe');
    frame.className = 'local-preview-frame';
    // Opaque origin: the page runs its own scripts but can't reach the harness session.
    frame.setAttribute('sandbox', 'allow-scripts allow-popups allow-modals');
    frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.setAttribute('loading', 'lazy');
    frame.title = card.querySelector('.local-preview-title strong')?.textContent || 'Prévia';
    frame.src = card.dataset.localPreview;
    card.append(frame);
  }
}

export function bindLocalPreviews() {
  $('#messages').addEventListener('click', (event) => {
    const image = event.target.closest('[data-preview-image]');
    if (image) { event.preventDefault(); openImagePreview(image.dataset.previewImage, image.dataset.caption || 'Imagem do projeto'); return; }
    const toggle = event.target.closest('[data-toggle-preview]');
    const card = toggle?.closest('.local-preview-card');
    if (card) { event.preventDefault(); togglePreview(card, toggle); }
  });
}
