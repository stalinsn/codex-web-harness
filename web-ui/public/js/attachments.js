// Explicit attachment sources and an in-chat camera with front/rear switching.
import { addFiles } from './composer.js';
import { $, toast } from './dom.js';

let stream = null;
let generation = 0;
let facing = 'environment';

function releaseCamera() {
  generation += 1;
  stream?.getTracks().forEach(track => track.stop());
  stream = null;
  $('#cameraVideo').srcObject = null;
}

async function startCamera(nextFacing = 'environment') {
  releaseCamera();
  const attempt = generation;
  const status = $('#cameraStatus');
  $('#takePhoto').disabled = true;
  $('#switchCamera').disabled = true;
  $('#nativeCamera').hidden = true;
  status.textContent = nextFacing === 'environment' ? 'Abrindo câmera traseira…' : 'Abrindo câmera frontal…';
  try {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('unavailable');
    let acquired;
    try { acquired = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { exact: nextFacing }, width: { ideal: 1920 }, height: { ideal: 1080 } } }); }
    catch (error) {
      if (!['OverconstrainedError', 'NotFoundError'].includes(error.name)) throw error;
      acquired = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: nextFacing } } });
    }
    if (attempt !== generation || !$('#cameraDialog').open || document.hidden) {
      acquired.getTracks().forEach(track => track.stop());
      if (document.hidden && $('#cameraDialog').open) $('#cameraDialog').close();
      return;
    }
    stream = acquired;
    facing = acquired.getVideoTracks()[0]?.getSettings().facingMode || nextFacing;
    const video = $('#cameraVideo');
    video.srcObject = acquired;
    video.classList.toggle('is-selfie', facing === 'user');
    await video.play();
    if (attempt !== generation) return;
    status.textContent = facing === 'user' ? 'Câmera frontal' : facing === 'environment' ? 'Câmera traseira' : 'Câmera pronta';
    $('#takePhoto').disabled = false;
    $('#switchCamera').disabled = false;
  } catch (error) {
    if (attempt !== generation) return;
    releaseCamera();
    status.textContent = error.name === 'NotAllowedError'
      ? 'Permita a câmera pelo cadeado do Samsung Internet e nas permissões do aplicativo no Android. Você também pode usar a câmera do celular abaixo.'
      : 'Não consegui abrir essa câmera. Use a câmera do celular abaixo ou escolha uma foto da galeria.';
    $('#nativeCamera').hidden = false;
  }
}

async function capturePhoto() {
  const video = $('#cameraVideo');
  if (!stream || !video.videoWidth || !video.videoHeight) return;
  const attempt = generation;
  $('#takePhoto').disabled = true;
  try {
    const canvas = document.createElement('canvas');
    const scale = Math.min(1, 2048 / Math.max(video.videoWidth, video.videoHeight));
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', .9));
    if (attempt !== generation) return;
    if (!blob) throw new Error('Não consegui preparar a foto. Tente novamente.');
    await addFiles([new File([blob], `foto-${Date.now()}.jpg`, { type: 'image/jpeg' })]);
    $('#cameraDialog').close();
  } catch (error) { toast(error.message || 'Não consegui capturar a foto.', 'error'); }
  finally { $('#takePhoto').disabled = !stream; }
}

function bindOutsideClose(dialog) {
  dialog.addEventListener('click', event => {
    const rect = dialog.getBoundingClientRect();
    if (event.target === dialog && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom)) dialog.close();
  });
}

export function bindAttachmentEvents() {
  const picker = $('#attachmentPicker');
  const camera = $('#cameraDialog');
  $('#attachImage').addEventListener('click', () => picker.showModal());
  $('#closeAttachmentPicker').addEventListener('click', () => picker.close());
  $('#chooseGallery').addEventListener('click', () => { picker.close(); $('#galleryInput').click(); });
  $('#chooseFiles').addEventListener('click', () => { picker.close(); $('#imageInput').click(); });
  $('#chooseCamera').addEventListener('click', () => { picker.close(); camera.showModal(); startCamera(); });
  $('#closeCamera').addEventListener('click', () => camera.close());
  camera.addEventListener('close', releaseCamera);
  $('#switchCamera').addEventListener('click', () => startCamera(facing === 'environment' ? 'user' : 'environment'));
  $('#takePhoto').addEventListener('click', capturePhoto);
  $('#nativeCamera').addEventListener('click', () => { camera.close(); $('#cameraInput').click(); });
  for (const id of ['imageInput', 'galleryInput', 'cameraInput']) {
    $(`#${id}`).addEventListener('change', async event => {
      const files = [...event.target.files];
      event.target.value = '';
      try { await addFiles(files); } catch (error) { toast(error.message || 'Não consegui anexar o arquivo.', 'error'); }
    });
  }
  bindOutsideClose(picker);
  bindOutsideClose(camera);
  document.addEventListener('visibilitychange', () => { if (document.hidden && camera.open && stream) camera.close(); });
}
