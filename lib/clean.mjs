// The one cleanup for a voice recorded on a mic: recordings (at render) and the cloned voice's sample (voice add).
// Cut the low rumble, bring a quiet mic up to the level the model expects, then DeepFilterNet (a local speech
// denoiser) keeps the voice and removes the background. Measured on a built-in-mic recording at -50 dB with fan
// rumble: Whisper heard "That" before and the whole sentence after; the pauses went from noise to silence.
// Without the level step the model took the quiet voice for noise and returned silence.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {run} from './common.mjs';

// DeepFilterNet 0.5.6 needs torch 2.2 (newer torchaudio dropped the API it uses); the first run downloads ~1 GB.
const denoiser = ['--python', '3.11', '--from', 'deepfilternet==0.5.6', '--with', 'torch==2.2.2', '--with', 'torchaudio==2.2.2',
  '--with', 'numpy<2', '--with', 'soundfile', 'deepFilter'];

// input: any audio or video file. output: a mono 48 kHz WAV of the cleaned voice, same length as the input.
export async function cleanVoice(input, output) {
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'justrec-clean-'));
  try {
    const level = path.join(work, 'voice.wav');
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', input, '-vn', '-ac', '1', '-ar', '48000', '-af', 'highpass=f=80,loudnorm=I=-23:TP=-3', level]);
    await run('uvx', [...denoiser, level, '-o', work], {timeout: 1800000});
    await fs.mkdir(path.dirname(output), {recursive: true});
    await fs.copyFile(path.join(work, 'voice_DeepFilterNet3.wav'), output);
    return output;
  } finally { await fs.rm(work, {recursive: true, force: true}); }
}
