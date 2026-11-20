import { $, toast } from './dom.js';

const checkIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6"/></svg>';
const copyIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/></svg>';
const resetTimers = new WeakMap();

async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
  } catch { /* Try the selection based fallback below. */ }

  if (typeof document.execCommand !== 'function') throw new Error('A cópia não está disponível neste navegador.');
  const field = document.createElement('textarea');
  field.value = text;
  field.readOnly = true;
  field.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
  document.body.append(field);
  field.focus();
  field.select();
  const copied = document.execCommand('copy');
  field.remove();
  if (!copied) throw new Error('Não consegui copiar o bloco de código.');
}

export function bindCodeCopy() {
  $('#messages').addEventListener('click', async (event) => {
    const button = event.target.closest('[data-copy-code]');
    if (!button) return;
    const code = button.closest('.code-block')?.querySelector('code');
    if (!code) return;

    try {
      await copyText(code.textContent || '');
      clearTimeout(resetTimers.get(button));
      button.innerHTML = checkIcon;
      button.title = 'Copiado';
      button.setAttribute('aria-label', 'Código copiado');
      button.classList.add('copied');
      resetTimers.set(button, setTimeout(() => {
        if (!button.isConnected) return;
        button.innerHTML = copyIcon;
        button.title = 'Copiar código';
        button.setAttribute('aria-label', 'Copiar bloco de código');
        button.classList.remove('copied');
      }, 1400));
    } catch (error) {
      toast(error.message || 'Não consegui copiar o bloco de código.', 'error');
    }
  });
}
