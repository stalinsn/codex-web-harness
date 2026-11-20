// Open native platform pickers directly, preserving the browser user gesture.
import { addFiles } from './composer.js';
import { $, toast } from './dom.js';

export function bindAttachmentEvents() {
  $('#attachImage').addEventListener('click', () => $('#imageInput').click());
  $('#attachGallery').addEventListener('click', () => $('#galleryInput').click());
  for (const id of ['imageInput', 'galleryInput']) {
    $(`#${id}`).addEventListener('change', async event => {
      const files = [...event.target.files];
      event.target.value = '';
      try { await addFiles(files); }
      catch (error) { toast(error.message || 'Não consegui anexar o arquivo.', 'error'); }
    });
  }
}
