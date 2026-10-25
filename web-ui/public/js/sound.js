// Optional completion chime (Web Audio).
import { completionSound } from './state.js';

export function prepareCompletionSound() {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) return;
  try {
    completionSound.context ||= new AudioContextClass();
    if (completionSound.context.state === 'suspended') completionSound.context.resume().catch(() => {});
  } catch { /* Sound feedback is optional when the browser blocks Web Audio. */ }
}

export function playCompletionSound(turnId) {
  const context = completionSound.context;
  if (!context || context.state !== 'running' || (turnId && completionSound.playedTurnIds.has(turnId))) return;
  try {
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    const now = context.currentTime;
    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(740, now);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.045, now + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.22);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start(now);
    oscillator.stop(now + 0.23);
    if (turnId) {
      completionSound.playedTurnIds.add(turnId);
      if (completionSound.playedTurnIds.size > 200) completionSound.playedTurnIds.delete(completionSound.playedTurnIds.values().next().value);
    }
  } catch { /* A completion sound must never interfere with the chat. */ }
}
