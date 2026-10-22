// Your own voice for narration: a short sample of you speaking, cloned locally by Qwen3-TTS
// (mlx-audio). Samples live in ~/.justrec/voices: <name>.wav and <name>.txt (what was said).
// A film with "voice": {"name": "<name>"} is then narrated in that voice.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {root, run} from './common.mjs';

export const voicesDir = process.env.JUSTREC_VOICES || path.join(os.homedir(), '.justrec/voices');
const model = process.env.JUSTREC_CLONE_MODEL || 'mlx-community/Qwen3-TTS-12Hz-1.7B-Base-bf16';
const exists = file => fs.access(file).then(() => true, () => false);

// Read aloud while recording: varied sounds, a number, a product-demo tone.
const script = `Hi, I'm going to show you something I built. It records the screen, cuts the boring parts,
and turns it into a short video in about two minutes. Let's open the dashboard and look at the numbers.`;

export async function findVoice(name) {
  const audio = path.join(voicesDir, `${name}.wav`);
  if (!await exists(audio)) return null;
  return {audio, text: (await fs.readFile(path.join(voicesDir, `${name}.txt`), 'utf8')).trim()};
}

// Loads the model once and speaks every line; writes 16-bit mono WAVs.
const helper = `
import json, sys, wave
import numpy as np
from mlx_audio.tts.utils import load_model
job = json.loads(sys.argv[1])
model = load_model(job["model"])
for line in job["lines"]:
    chunks = [np.array(result.audio) for result in model.generate(text=line["text"], ref_audio=job["audio"], ref_text=job["ref"])]
    pcm = (np.clip(np.concatenate(chunks), -1, 1) * 32767).astype("<i2")
    with wave.open(line["out"], "wb") as out:
        out.setnchannels(1); out.setsampwidth(2); out.setframerate(model.sample_rate); out.writeframes(pcm.tobytes())
`;

// lines: [{text, out}]. The first run downloads the model (~4 GB, a few minutes).
export async function speakAs(voice, lines) {
  const file = path.join(root, '.build/justrec_clone.py');
  await fs.mkdir(path.dirname(file), {recursive: true});
  await fs.writeFile(file, helper);
  await run('uvx', ['--from', 'mlx-audio', 'python', '-I', file, JSON.stringify({model, audio: voice.audio, ref: voice.text, lines})], {timeout: 1800000});
}

// justrec voice add <name> [--from file] [--seconds 15] [--mic default] | list | say <name> "<text>" | remove <name>
export async function voiceCommand([action, name, ...rest]) {
  if (action === 'list' || !action) {
    const names = (await fs.readdir(voicesDir).catch(() => [])).filter(file => file.endsWith('.wav')).map(file => file.slice(0, -4));
    return Promise.all(names.map(async item => ({name: item, said: (await findVoice(item)).text})));
  }
  if (!name || !/^[\w-]+$/.test(name)) throw new Error('Give the voice a name (letters, digits, - or _), e.g. justrec voice add me');
  if (action === 'remove') {
    for (const ext of ['wav', 'txt']) await fs.rm(path.join(voicesDir, `${name}.${ext}`), {force: true});
    return {removed: name};
  }
  if (action === 'say') {
    const voice = await findVoice(name);
    if (!voice) throw new Error(`No voice named ${name}: justrec voice add ${name}`);
    const out = path.resolve(`voice-${name}.wav`);
    await speakAs(voice, [{text: rest.join(' ') || script, out}]);
    return {output: out};
  }
  if (action !== 'add') throw new Error('Usage: justrec voice add <name> [--from file] | list | say <name> "<text>" | remove <name>');
  const option = flag => { const index = rest.indexOf(flag); return index < 0 ? undefined : rest[index + 1]; };
  await fs.mkdir(voicesDir, {recursive: true});
  const raw = path.join(voicesDir, `${name}.raw.wav`);
  if (option('--from')) await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', path.resolve(option('--from')), '-t', '20', raw]);
  else {
    const seconds = Number(option('--seconds') || 15);
    console.error(`Read this aloud, in your normal demo voice (recording ${seconds} s, starts in 3):\n\n${script}\n`);
    await new Promise(resolve => setTimeout(resolve, 3000));
    console.error('Recording...');
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'avfoundation', '-i', `:${option('--mic') || 'default'}`, '-t', String(seconds), raw]);
    console.error('Done.');
  }
  // Trim silence at both ends, one level (-20 LUFS), 24 kHz mono like the model.
  const audio = path.join(voicesDir, `${name}.wav`);
  const trim = 'silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.2';
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', raw, '-af', `${trim},areverse,${trim},areverse,loudnorm=I=-20:TP=-2`, '-ar', '24000', '-ac', '1', audio]);
  // The model needs the exact words of the sample. Room noise after the last word passes the silence
  // trim (and loudnorm lifts it to voice level), so cut the sample where Whisper hears the last word end.
  await run('uvx', ['--from', 'mlx-whisper', 'mlx_whisper', audio, '--model', process.env.JUSTREC_WHISPER_MODEL || 'mlx-community/whisper-large-v3-turbo',
    '--word-timestamps', 'True', '--output-format', 'json', '--output-dir', voicesDir, '--output-name', name]);
  const heard = JSON.parse(await fs.readFile(path.join(voicesDir, `${name}.json`), 'utf8'));
  await fs.rm(path.join(voicesDir, `${name}.json`));
  const text = heard.text.trim();
  const end = heard.segments.flatMap(segment => segment.words).at(-1)?.end;
  if (end) {
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', audio, '-t', String(end + 0.3), raw]);
    await fs.rename(raw, audio);
  }
  await fs.rm(raw, {force: true});
  await fs.writeFile(path.join(voicesDir, `${name}.txt`), text);
  if (text.split(/\s+/).length < 8) throw new Error(`Heard only "${text}". Speak closer to the mic and try again.`);
  return {voice: name, audio, said: text, next: `justrec voice say ${name} "Hello, this is my voice."`};
}
