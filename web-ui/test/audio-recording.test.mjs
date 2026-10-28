import assert from 'node:assert/strict';
import { test } from 'node:test';
import { audioMime, createAudioRecorder } from '../public/js/audio-recording.js';

test('prefers compressed WebM/Opus even when MP4 is also advertised', () => {
  class Recorder {
    static isTypeSupported() { return true; }
    constructor(stream, options) { this.stream = stream; this.mimeType = options.mimeType; }
  }
  const stream = {};
  const recorder = createAudioRecorder(stream, Recorder);
  assert.equal(recorder.stream, stream);
  assert.equal(recorder.mimeType, 'audio/webm;codecs=opus');
});

test('a codec reported as supported can fail construction; try the next one', () => {
  class Recorder {
    static isTypeSupported() { return true; }
    constructor(stream, options) {
      if (options?.mimeType !== 'audio/mp4') throw new Error('codec unavailable');
      this.mimeType = options.mimeType;
    }
  }
  assert.equal(createAudioRecorder({}, Recorder).mimeType, 'audio/mp4');
});

test('falls back to the browser default without explicit recorder options', () => {
  class Recorder {
    static isTypeSupported() { return false; }
    constructor(stream, options) { assert.equal(options, undefined); this.mimeType = 'audio/webm'; }
  }
  assert.equal(createAudioRecorder({}, Recorder).mimeType, 'audio/webm');
  assert.equal(audioMime(' Audio/WebM;codecs=opus '), 'audio/webm');
});
