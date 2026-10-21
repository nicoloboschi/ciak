// Generated background music: a 19.2 s loop at 100 BPM (Am–F–C–G), pad + plucked arpeggio +
// bass + soft beat, written as a WAV. Deterministic, so the same film always gets the same track.
import fs from 'node:fs/promises';
import path from 'node:path';

const rate = 48000;
const bpm = 100;
const beat = 60 / bpm;
const bars = 8;
const length = bars * 4 * beat;
// Chord tones as MIDI notes: A minor, F major, C major, G major (two bars each).
const chords = [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62]];
const hertz = note => 440 * 2 ** ((note - 69) / 12);

export function synthesize() {
  const total = Math.round(length * rate);
  // Pad and arpeggio are spread left/right; bass and beat sit in the center.
  const left = new Float32Array(total); const right = new Float32Array(total); const center = new Float32Array(total);
  let seed = 7; const noise = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 31 - 1; };
  const add = (channel, start, values) => { for (let index = 0; index < values.length && start + index < total; index++) channel[start + index] += values[index]; };
  const note = (frequency, seconds, shape) => {
    const values = new Float32Array(Math.round(seconds * rate));
    for (let index = 0; index < values.length; index++) values[index] = shape(index / rate, frequency);
    return values;
  };
  for (let bar = 0; bar < bars; bar++) {
    const chord = chords[Math.floor(bar / 2) % chords.length];
    const barStart = bar * 4 * beat;
    // Pad: soft saw-like stack, detuned left/right, slow swell over two bars.
    if (bar % 2 === 0) for (const tone of chord) {
      const frequency = hertz(tone);
      for (const [channel, detune] of [[left, 0.997], [right, 1.003]]) {
        add(channel, Math.round(barStart * rate), note(frequency * detune, 8 * beat, (t, f) => {
          const envelope = Math.min(1, t / 1.2) * Math.min(1, (8 * beat - t) / 1.0);
          return 0.035 * envelope * (Math.sin(2 * Math.PI * f * t) + 0.35 * Math.sin(4 * Math.PI * f * t) + 0.12 * Math.sin(6 * Math.PI * f * t));
        }));
      }
    }
    // Arpeggio: eighth notes over the chord an octave up, plucked, with a 3/16 echo.
    for (let step = 0; step < 8; step++) {
      const tone = chord[[0, 1, 2, 1, 0, 2, 1, 2][step]] + 12;
      const start = barStart + step * beat / 2;
      const pluck = note(hertz(tone), 0.6, (t, f) => 0.06 * Math.exp(-t * 7) * (Math.sin(2 * Math.PI * f * t) + 0.2 * Math.sin(4 * Math.PI * f * t)));
      add(left, Math.round(start * rate), pluck);
      add(right, Math.round((start + 0.75 * beat) * rate), pluck.map(value => value * 0.45));
    }
    // Bass on beats 1 and 3.
    for (const at of [0, 2]) add(center, Math.round((barStart + at * beat) * rate), note(hertz(chord[0] - 12), 1.6 * beat, (t, f) => 0.11 * Math.exp(-t * 2.2) * Math.sin(2 * Math.PI * f * t)));
    // Beat from bar 3: a soft kick on every beat, a quiet hat on the offbeats from bar 5.
    if (bar >= 2) for (let at = 0; at < 4; at++) {
      add(center, Math.round((barStart + at * beat) * rate), note(0, 0.35, t => 0.16 * Math.exp(-t * 12) * Math.sin(2 * Math.PI * (45 + 80 * Math.exp(-t * 30)) * t)));
      if (bar >= 4) add(center, Math.round((barStart + (at + 0.5) * beat) * rate), note(0, 0.05, t => 0.025 * Math.exp(-t * 90) * noise()));
    }
  }
  for (let index = 0; index < total; index++) { left[index] += center[index]; right[index] += center[index]; }
  // A short room: a few early reflections.
  for (const channel of [left, right]) for (const [delay, gain] of [[0.031, 0.25], [0.047, 0.18], [0.083, 0.12]]) {
    const offset = Math.round(delay * rate);
    for (let index = total - 1; index >= offset; index--) channel[index] += channel[index - offset] * gain;
  }
  return {left, right};
}

function wav({left, right}) {
  let peak = 1e-9;
  for (let index = 0; index < left.length; index++) peak = Math.max(peak, Math.abs(left[index]), Math.abs(right[index]));
  const scale = 0.89 / peak;
  const buffer = Buffer.alloc(44 + left.length * 4);
  buffer.write('RIFF', 0); buffer.writeUInt32LE(36 + left.length * 4, 4); buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(2, 22); buffer.writeUInt32LE(rate, 24);
  buffer.writeUInt32LE(rate * 4, 28); buffer.writeUInt16LE(4, 32); buffer.writeUInt16LE(16, 34); buffer.write('data', 36); buffer.writeUInt32LE(left.length * 4, 40);
  for (let index = 0; index < left.length; index++) {
    buffer.writeInt16LE(Math.round(Math.max(-1, Math.min(1, left[index] * scale)) * 32767), 44 + index * 4);
    buffer.writeInt16LE(Math.round(Math.max(-1, Math.min(1, right[index] * scale)) * 32767), 46 + index * 4);
  }
  return buffer;
}

export async function music(directory) {
  const file = path.join(directory, 'music-v2.wav');
  if (await fs.access(file).then(() => true, () => false)) return file;
  await fs.mkdir(directory, {recursive: true});
  await fs.writeFile(file, wav(synthesize()));
  return file;
}
