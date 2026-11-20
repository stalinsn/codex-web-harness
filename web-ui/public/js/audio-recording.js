// Prefer the compressed format supported by Chromium/Samsung Internet.
export function createAudioRecorder(stream, Recorder = globalThis.MediaRecorder) {
  const types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
  let lastError;
  for (const mimeType of types) {
    if (typeof Recorder.isTypeSupported === 'function' && !Recorder.isTypeSupported(mimeType)) continue;
    try { return new Recorder(stream, { mimeType }); }
    catch (error) { lastError = error; }
  }
  try { return new Recorder(stream); }
  catch (error) { throw lastError || error; }
}

export function audioMime(type = '') {
  return String(type).split(';')[0].trim().toLowerCase();
}
