// A soft two-note chime for "a session finished", made on the spot with the
// Web Audio API: no sound file to ship, and quiet enough not to startle.
// Played only when Settings → "Clauding mod" → sound is on (off by default).
let audioContext = null;

export function playSoftChime() {
  try {
    if (!audioContext) {
      audioContext = new AudioContext();
    }
    const startAt = audioContext.currentTime + 0.01;
    for (const [offset, frequency] of [
      [0, 880],
      [0.14, 1318.5]
    ]) {
      const oscillator = audioContext.createOscillator();
      const gain = audioContext.createGain();
      oscillator.type = "sine";
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0, startAt + offset);
      gain.gain.linearRampToValueAtTime(0.06, startAt + offset + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, startAt + offset + 0.45);
      oscillator.connect(gain);
      gain.connect(audioContext.destination);
      oscillator.start(startAt + offset);
      oscillator.stop(startAt + offset + 0.5);
    }
  } catch (error) {
    // No audio device, or audio is not allowed: the toast is enough.
  }
}
