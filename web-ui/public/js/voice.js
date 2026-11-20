// Voice recording, preview, upload and local transcription flow.
import { api } from './api.js';
import { audioMime, createAudioRecorder } from './audio-recording.js';
import { blobDataUrl, renderAttachments, submitMessage, updateComposerControls } from './composer.js';
import { $, icons, toast } from './dom.js';
import { state, voice } from './state.js';

export function touchComposer() { return window.matchMedia('(pointer: coarse)').matches; }

export function voiceTime(seconds) { return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`; }

export function renderVoice(error = '') {
  const panel = $('#voicePanel');
  $('#composerForm').classList.toggle('has-voice', voice.phase !== 'idle');
  const recording = voice.phase === 'recording';
  const hasPreview = Boolean(voice.blob) && !recording;
  panel.hidden = voice.phase === 'idle' && !error;
  panel.classList.toggle('is-recording', recording);
  panel.classList.toggle('is-transcribing', voice.phase === 'transcribing');
  $('#voiceStatus').textContent = ({ requesting: 'Liberando microfone…', recording: 'Gravando · toque em Concluir para ouvir', preparing: 'Preparando prévia do áudio…', transcribing: 'Transcrevendo o áudio…' })[voice.phase]
    || (voice.transcriptInserted ? 'Transcrição pronta · revise o texto antes de enviar' : voice.phase === 'ready' ? 'Prévia pronta · ouça antes de enviar' : '');
  $('#voiceTimer').textContent = voiceTime(voice.seconds);
  $('#voicePlayerWrap').hidden = !hasPreview;
  $('#transcribeAudio').hidden = !hasPreview || voice.transcriptInserted;
  $('#transcribeAudio').disabled = voice.phase !== 'ready' || state.sending;
  $('#transcribeAudio').textContent = voice.phase === 'transcribing' ? 'Transcrevendo…' : 'Transcrever para revisar';
  $('#discardAudio').hidden = !voice.blob;
  $('#discardAudio').disabled = state.sending && voice.phase !== 'transcribing';
  $('#discardAudio').textContent = voice.phase === 'transcribing' ? 'Cancelar transcrição' : 'Descartar';
  $('#discardAudio').setAttribute('aria-label', voice.phase === 'transcribing' ? 'Cancelar transcrição' : 'Descartar gravação');
  $('#voiceError').hidden = !error;
  $('#voiceError').textContent = error;
  $('#voiceInput').classList.toggle('listening', recording);
  $('#voiceInput').classList.toggle('hidden', voice.phase !== 'idle' && !recording);
  $('#voiceInput').setAttribute('aria-pressed', String(recording));
  $('#voiceInput').title = recording ? 'Concluir gravação' : 'Gravar áudio';
  $('#voiceInput').setAttribute('aria-label', recording ? 'Concluir gravação' : 'Gravar áudio');
  $('#voiceInput .icon').innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${recording ? icons.stop : icons.microphone}</svg>`;
  $('#voiceInput').disabled = voice.phase !== 'idle' && voice.phase !== 'recording';
  $('#voiceButtonLabel').textContent = recording ? 'Concluir' : 'Gravar';
  updateComposerControls();
}

function releaseMicrophone() {
  clearInterval(voice.timer); voice.timer = null;
  cancelAnimationFrame(voice.meterFrame);
  voice.stream?.getTracks().forEach((track) => track.stop()); voice.stream = null;
  voice.meterSource?.disconnect(); voice.meterSource = null;
  voice.context?.close().catch(() => {}); voice.context = null;
}

export function clearRecordedAudio() {
  voice.cancelled = true;
  voice.generation += 1;
  voice.request?.abort(); voice.request = null;
  if (voice.jobId) api(`/api/voice/transcriptions/${voice.jobId}`, { method: 'DELETE' }).catch(() => {});
  voice.jobId = null;
  if (voice.attachedFile && state.files.includes(voice.attachedFile)) {
    state.files = state.files.filter((file) => file !== voice.attachedFile);
    renderAttachments();
  }
  voice.attachedFile = null;
  if (voice.recorder?.state === 'recording') voice.recorder.stop();
  releaseMicrophone(); voice.recorder = null;
  $('#voicePlayer').pause(); $('#voicePlayer').removeAttribute('src'); $('#voicePlayer').load();
  if (voice.url) URL.revokeObjectURL(voice.url);
  voice.url = ''; voice.blob = null; voice.chunks = []; voice.phase = 'idle'; voice.seconds = 0; voice.transcriptInserted = false;
  renderVoice();
}

function showRecordedAudio(blob) {
  if (!blob.size) { clearRecordedAudio(); toast('O áudio ficou vazio. Tente gravar novamente.', 'error'); return; }
  if (blob.size > 12 * 1024 * 1024) { clearRecordedAudio(); toast('O limite é de 12 MB por áudio.', 'error'); return; }
  if (voice.url) URL.revokeObjectURL(voice.url);
  voice.blob = blob; voice.url = URL.createObjectURL(blob); voice.phase = 'ready'; voice.transcriptInserted = false;
  const player = $('#voicePlayer'); player.src = voice.url; player.muted = false; player.volume = 1; player.load();
  renderVoice();
}

export async function prepareVoicePreview(blob) {
  // Preserve the original compressed recording. Decoding and creating WAV here
  // delayed playback, increased uploads and depended on a second browser codec.
  showRecordedAudio(blob);
}

export async function sendVoiceRecording() {
  if (!voice.blob || voice.phase !== 'ready' || state.sending) return false;
  const generation = voice.generation;
  $('#voicePlayer').pause();
  try {
    if (!voice.attachedFile || !state.files.includes(voice.attachedFile)) {
      if (state.files.length >= 8) throw new Error('Remova um anexo antes de enviar a gravação.');
      if (state.files.reduce((total, file) => total + (file.size || 0), 0) + voice.blob.size > 24 * 1024 * 1024) throw new Error('O total dos anexos ultrapassa 24 MB. Remova um anexo antes de enviar a gravação.');
      const blob = voice.blob;
      voice.phase = 'preparing'; renderVoice();
      const dataUrl = await blobDataUrl(blob);
      if (generation !== voice.generation) return false;
      const extension = blob.type.includes('mp4') ? 'm4a' : blob.type.includes('mpeg') ? 'mp3' : blob.type.includes('wav') ? 'wav' : blob.type.includes('ogg') ? 'ogg' : 'webm';
      voice.attachedFile = { name: `gravacao-${Date.now()}.${extension}`, mime: blob.type || 'audio/webm', isImage: false, size: blob.size, dataUrl, data: String(dataUrl).split(',')[1] };
      state.files.push(voice.attachedFile);
    }
    voice.phase = 'ready'; renderVoice();
    const sent = await submitMessage(undefined, { allowVoice: true });
    if (sent) clearRecordedAudio();
    else renderVoice('Não consegui enviar. A gravação continua aqui para ouvir ou tentar novamente.');
    return sent;
  } catch (error) {
    if (generation === voice.generation) { voice.phase = 'ready'; renderVoice(error.message || 'Não consegui preparar a gravação para envio.'); }
    return false;
  }
}

export async function transcribeRecordedAudio() {
  if (!voice.blob || voice.phase !== 'ready' || state.sending) return;
  if (voice.transcriptInserted) return;
  if (voice.attachedFile && state.files.includes(voice.attachedFile)) {
    state.files = state.files.filter((file) => file !== voice.attachedFile);
    voice.attachedFile = null;
    renderAttachments();
  }
  const targetThreadId = state.selectedThreadId;
  $('#voicePlayer').pause();
  const generation = voice.generation;
  voice.phase = 'transcribing'; voice.request = new AbortController();
  const signal = voice.request.signal;
  renderVoice();
  try {
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(new Error('Não consegui ler a gravação.')); reader.readAsDataURL(voice.blob);
    });
    if (signal.aborted) return;
    const job = await api('/api/voice/transcriptions', { method: 'POST', signal, body: JSON.stringify({ mime: audioMime(voice.blob.type), data: String(dataUrl).split(',')[1] }) });
    voice.jobId = job.id;
    const deadline = Date.now() + 330_000;
    while (!signal.aborted && Date.now() < deadline) {
      let result;
      try { result = await api(`/api/voice/transcriptions/${job.id}`, { signal }); }
      catch (error) {
        // A temporary gateway limit must not cancel a transcription already running.
        if (error.status !== 429 && error.status !== 503) throw error;
      }
      if (result?.status === 'failed' || result?.status === 'cancelled') throw new Error(result.error || 'Transcrição cancelada.');
      if (result?.status === 'completed') {
        if (!result.text?.trim()) throw new Error('Não identifiquei fala neste áudio. Tente gravar novamente.');
        if (generation !== voice.generation) return;
        if (targetThreadId !== state.selectedThreadId) throw new Error('A conversa mudou. O áudio foi preservado; escolha onde deseja enviá-lo e tente novamente.');
        const textarea = $('#messageInput');
        const draft = textarea.value.trimEnd();
        textarea.value = `${draft}${draft ? '\n\n' : ''}${result.text.trim()}`;
        voice.jobId = null; voice.request = null; voice.transcriptInserted = true; voice.phase = 'ready';
        renderVoice();
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        if (!touchComposer()) textarea.focus();
        toast('Transcrição pronta. Revise o texto e toque em Enviar texto.');
        return;
      }
      await new Promise((resolve, reject) => {
        const cancel = () => { clearTimeout(timer); reject(new DOMException('Cancelado', 'AbortError')); };
        const timer = setTimeout(() => { signal.removeEventListener('abort', cancel); resolve(); }, 4000);
        signal.addEventListener('abort', cancel, { once: true });
      });
    }
    if (!signal.aborted) throw new Error('A transcrição demorou demais. Seu áudio continua aqui para tentar novamente.');
  } catch (error) {
    if (error.name === 'AbortError' || generation !== voice.generation) return;
    if (voice.jobId) api(`/api/voice/transcriptions/${voice.jobId}`, { method: 'DELETE' }).catch(() => {});
    voice.jobId = null; voice.request = null; voice.phase = 'ready';
    renderVoice(error.message || 'Não foi possível transcrever. Seu áudio foi preservado.');
  }
}

export async function startVoiceRecording() {
  if (voice.phase === 'recording') { stopVoiceRecording(); return; }
  if (voice.phase !== 'idle') return;
  if (touchComposer()) $('#messageInput').blur();
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) { $('#audioInput').click(); return; }
  voice.cancelled = false; voice.phase = 'requesting'; voice.hasSignal = false;
  const generation = ++voice.generation;
  renderVoice();
  try {
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false }); }
    catch (error) {
      if (error.name !== 'OverconstrainedError' && error.name !== 'NotSupportedError') throw error;
      stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    }
    if (voice.cancelled || generation !== voice.generation) { stream.getTracks().forEach((track) => track.stop()); return; }
    voice.stream = stream;
    const recorder = createAudioRecorder(stream);
    voice.recorder = recorder; voice.chunks = [];
    recorder.ondataavailable = (event) => { if (event.data.size && generation === voice.generation) voice.chunks.push(event.data); };
    recorder.onstop = () => {
      if (generation !== voice.generation) return;
      releaseMicrophone(); voice.recorder = null;
      if (voice.cancelled) return;
      const blob = new Blob(voice.chunks, { type: recorder.mimeType || voice.chunks[0]?.type || 'audio/webm' });
      prepareVoicePreview(blob);
    };
    recorder.onerror = () => {
      if (generation !== voice.generation) return;
      if (voice.chunks.length) {
        releaseMicrophone(); voice.recorder = null;
        showRecordedAudio(new Blob(voice.chunks, { type: recorder.mimeType || voice.chunks[0]?.type || 'audio/webm' }));
        renderVoice('O navegador interrompeu a gravação. O trecho já gravado foi preservado.');
      } else { clearRecordedAudio(); renderVoice('O navegador interrompeu a gravação. Tente novamente ou anexe um áudio.'); }
    };
    recorder.start(500); voice.startedAt = Date.now(); voice.seconds = 0; voice.phase = 'recording';
    voice.timer = setInterval(() => {
      voice.seconds = Math.floor((Date.now() - voice.startedAt) / 1000);
      $('#voiceTimer').textContent = `${voiceTime(voice.seconds)} / 3:00`;
      if (voice.seconds >= 180 && recorder.state === 'recording') stopVoiceRecording();
    }, 500);
    renderVoice();
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (AudioContextClass) {
      try {
        voice.context = new AudioContextClass();
        voice.context.resume().catch(() => {});
        voice.meterSource = voice.context.createMediaStreamSource(stream);
        const analyser = voice.context.createAnalyser(); analyser.fftSize = 256;
        voice.meterSource.connect(analyser);
        const data = new Uint8Array(analyser.fftSize);
        const draw = () => {
          if (voice.phase !== 'recording') return;
          analyser.getByteTimeDomainData(data);
          const level = Math.sqrt(data.reduce((sum, value) => sum + ((value - 128) / 128) ** 2, 0) / data.length);
          voice.hasSignal ||= level > .01;
          $('#voicePanel').style.setProperty('--voice-level', `${Math.min(100, Math.max(4, level * 600))}%`);
          if (voice.context?.state === 'running' && voice.seconds >= 5 && !voice.hasSignal) $('#voiceStatus').textContent = 'Som muito baixo. Confira seu microfone';
          else $('#voiceStatus').textContent = 'Gravando sua mensagem';
          voice.meterFrame = requestAnimationFrame(draw);
        };
        draw();
      } catch { /* Recording remains usable if metering is unavailable. */ }
    }
  } catch (error) {
    clearRecordedAudio();
    renderVoice(error.name === 'NotAllowedError'
      ? 'Microfone bloqueado. No Samsung Internet, abra as permissões deste site pelo cadeado e permita o microfone. Confira também a permissão do aplicativo nas configurações do Android.'
      : error.name === 'NotReadableError' ? 'O microfone está ocupado por outro aplicativo. Feche a outra gravação e tente novamente.'
        : 'Não consegui iniciar o microfone. Tente novamente ou use Anexar para escolher um áudio.');
  }
}

export function stopVoiceRecording() {
  if (voice.recorder?.state === 'recording') {
    voice.phase = 'preparing';
    renderVoice();
    voice.recorder.stop();
  }
}
