// The one cleanup for a voice recorded on a mic: recordings (at render) and the cloned voice's sample (voice add).
// Cut the low rumble, bring a quiet mic up to the level the model expects, then DeepFilterNet (a local speech
// denoiser, its standalone program) keeps the voice and removes the background. Measured on a built-in-mic recording at -50 dB with fan
// rumble: Whisper heard "That" before and the whole sentence after; the pauses went from noise to silence.
// Without the level step the model took the quiet voice for noise and returned silence.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {run} from './common.mjs';


// input: any audio or video file. output: a mono 48 kHz WAV of the cleaned voice, same length as the input.
export async function cleanVoice(input, output) {
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'ciak-clean-'));
  try {
    const level = path.join(work, 'voice.wav');
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', input, '-vn', '-ac', '1', '-ar', '48000', '-af', 'highpass=f=80,loudnorm=I=-23:TP=-3', level]);
    await fs.mkdir(path.dirname(output), {recursive: true});
    // The Python DeepFilterNet's result to -51 dB, without PyTorch (28 MB, not ~1 GB): 1.5 s for 30 s of voice.
    // -D lines the result up with the input (the model looks a little ahead).
    await run('deep-filter', ['-D', '-o', path.join(work, 'clean'), level], {timeout: 1800000});
    await fs.copyFile(path.join(work, 'clean', 'voice.wav'), output);
    return output;
  } finally { await fs.rm(work, {recursive: true, force: true}); }
}
