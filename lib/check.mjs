// The film check (ciak project check): find what a viewer would notice in a rendered film, with times and frames.
// Visual jumps and flashes, recordings frozen on a still, music too loud under the voice,
// narration a listener would mishear, captions too fast to read. Layout problems come from
// the probe stills that a film render makes (see renderFilm).
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {run, execute, readJSON, writeJSON} from './common.mjs';

const numberWords = new Set('zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty thirty forty fifty sixty seventy eighty ninety hundred thousand million billion point percent and a half'.split(' '));
// "$73,000" is heard as "seventy three thousand dollars": compare words, not symbols.
const words = text => text.toLowerCase().replace(/[’']/g, '').replace(/\$/g, ' dollars ').replace(/%/g, ' percent ').replace(/×/g, ' times ').match(/[a-z0-9]+/g) || [];

// Per-frame brightness and change score at 15 fps (small frames: fast).
async function pictureTimeline(video) {
  const {stderr} = await execute('ffmpeg', ['-hide_banner', '-i', video, '-an', '-vf', 'fps=15,scale=320:-2,signalstats,scdet=threshold=100,metadata=print', '-f', 'null', '-'], {maxBuffer: 256 * 1024 * 1024});
  const frames = [];
  let current;
  for (const line of stderr.split('\n')) {
    const time = line.match(/pts_time:([\d.]+)/);
    if (time) { current = {t: Number(time[1]), y: 0, score: 0}; frames.push(current); }
    const y = line.match(/lavfi\.signalstats\.YAVG=([\d.]+)/);
    if (y && current) current.y = Number(y[1]);
    const score = line.match(/lavfi\.scd\.score=([\d.]+)/);
    if (score && current) current.score = Number(score[1]);
  }
  return frames;
}

// Mono 8 kHz samples → loudness (dB) of any window.
async function audioLevels(video) {
  const child = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', video, '-vn', '-ac', '1', '-ar', '8000', '-f', 's16le', '-']);
  const chunks = [];
  for await (const chunk of child.stdout) chunks.push(chunk);
  const buffer = Buffer.concat(chunks);
  const samples = new Int16Array(buffer.buffer, buffer.byteOffset, Math.floor(buffer.length / 2));
  return (start, end) => {
    const from = Math.max(0, Math.floor(start * 8000)); const to = Math.min(samples.length, Math.floor(end * 8000));
    if (to - from < 400) return -120;
    let sum = 0;
    for (let index = from; index < to; index++) sum += (samples[index] / 32768) ** 2;
    return 10 * Math.log10(sum / (to - from) + 1e-12);
  };
}

async function frameAt(video, time, file) {
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-ss', String(Math.max(0, time)), '-i', video, '-frames:v', '1', '-vf', 'scale=960:-2', file]);
  return file;
}

export async function checkFilm(report, {transcribe = true} = {}) {
  const video = report.output;
  const folder = video.replace(/\.mp4$/, '.check');
  await fs.rm(folder, {recursive: true, force: true});
  await fs.mkdir(folder, {recursive: true});
  const issues = (report.layout || []).map(issue => ({...issue}));
  const sceneAt = time => report.scenes.findIndex(scene => time >= scene.start && time < scene.start + scene.seconds);
  const boundaries = report.scenes.slice(1).map(scene => scene.start);
  const near = (time, distance) => boundaries.some(boundary => Math.abs(boundary - time) < distance);

  // 1. Picture: jumps inside a scene, flashes at scene changes, frozen recordings.
  const frames = await pictureTimeline(video);
  for (const frame of frames) {
    if (frame.score > 14 && !near(frame.t, 0.35) && frame.t > 0.3) issues.push({kind: 'jump', time: frame.t, message: `the picture jumps (change score ${frame.score.toFixed(0)}) in the middle of a scene: a looping background, a recording ending, or a cut`});
  }
  const brightness = (start, end) => { const list = frames.filter(frame => frame.t >= start && frame.t < end); return list.length ? list.reduce((sum, frame) => sum + frame.y, 0) / list.length : null; };
  for (const boundary of boundaries) {
    const before = brightness(boundary - 0.7, boundary - 0.35); const after = brightness(boundary + 0.35, boundary + 0.7);
    const middle = frames.filter(frame => Math.abs(frame.t - boundary) < 0.25).map(frame => frame.y);
    if (before === null || after === null || !middle.length) continue;
    const peak = Math.max(...middle); const dip = Math.min(...middle);
    if (peak - Math.max(before, after) > 35) issues.push({kind: 'flash', time: boundary, message: `the screen flashes bright between two darker scenes (${before.toFixed(0)} → ${peak.toFixed(0)} → ${after.toFixed(0)}): fade between them directly instead of through the background`});
    if (Math.min(before, after) - dip > 35) issues.push({kind: 'flash', time: boundary, message: `the screen dips dark between two brighter scenes (${before.toFixed(0)} → ${dip.toFixed(0)} → ${after.toFixed(0)})`});
  }
  for (const [index, scene] of report.scenes.entries()) {
    if (!['recording', 'compare'].includes(scene.type)) continue;
    // Longest stretch with no change at all inside a recording scene.
    let still = 0; let longest = 0; let at = scene.start;
    for (const frame of frames.filter(frame => frame.t > scene.start + 0.3 && frame.t < scene.start + scene.seconds - 0.3)) {
      // A ticking timer scores ~0.001; only a picture with no change at all counts as frozen.
      still = frame.score < 0.0005 ? still + 1 / 15 : 0;
      if (still > longest) { longest = still; at = frame.t - still; }
    }
    if (longest > 2.5) issues.push({kind: 'frozen', time: at, scene: index, message: `the recording shows a still picture for ${longest.toFixed(1)} s: its narration outlasts the recording; record longer or shorten the say`});
  }

  // 2. Sound: voice must clearly sit above the music.
  const level = await audioLevels(video);
  for (const [index, scene] of report.scenes.entries()) {
    const lines = report.lines.filter(line => line.scene === index);
    if (!lines.length) continue;
    const voice = Math.max(...lines.map(line => level(line.start + 0.1, line.end - 0.1)));
    const gaps = [];
    const sceneEnd = scene.start + scene.seconds;
    for (let line = 0; line <= lines.length; line++) {
      const start = line ? lines[line - 1].end + 0.08 : scene.start + 0.35;
      const end = line < lines.length ? lines[line].start - 0.08 : sceneEnd - 0.35;
      if (end - start > 0.25) gaps.push(level(start, end));
    }
    const music = gaps.length ? Math.max(...gaps) : -120;
    if (music > -100 && voice - music < 8) issues.push({kind: 'music-loud', time: lines[0].start, scene: index, message: `voice is only ${(voice - music).toFixed(1)} dB above the music here (aim for 10+): lower musicVolume`});
    if (voice < -40) issues.push({kind: 'voice-quiet', time: lines[0].start, scene: index, message: `narration is very quiet (${voice.toFixed(0)} dB)`});
  }

  // 3. Captions a viewer can't read in time.
  for (const caption of report.captionLines || []) {
    const speed = caption.text.length / Math.max(0.01, caption.end - caption.start);
    if (speed > 24) issues.push({kind: 'caption-fast', time: caption.start, message: `caption "${caption.text}" is on screen for ${(caption.end - caption.start).toFixed(1)} s (${speed.toFixed(0)} characters/s; 20 is comfortable)`});
  }

  // 4. Would a listener hear the right words? Transcribe and compare with the script.
  if (transcribe && report.lines.length) {
    const audio = path.join(folder, 'audio.wav');
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', video, '-vn', '-ac', '1', '-ar', '16000', audio]);
    await run('uvx', ['--from', 'mlx-whisper', 'mlx_whisper', audio, '--model', process.env.CIAK_WHISPER_MODEL || 'mlx-community/whisper-large-v3-turbo',
      '--output-format', 'json', '--word-timestamps', 'True', '--condition-on-previous-text', 'False', '--output-dir', folder, '--output-name', 'heard'], {timeout: 900000});
    const heard = (await readJSON(path.join(folder, 'heard.json'))).segments.flatMap(segment => segment.words || []);
    for (const line of report.lines) {
      const window = heard.filter(word => word.end > line.start - 0.4 && word.start < line.end + 0.4);
      const got = new Set(window.flatMap(word => words(word.word)));
      // Only names and ordinary words: numbers come back as digits, which is fine.
      // "re-ranker" and "reranker" are the same word: also look in the heard text with spaces and hyphens removed.
      const joined = window.flatMap(word => words(word.word)).join('');
      const missing = words(line.text).filter(word => word.length > 2 && !numberWords.has(word) && !/^\d/.test(word) && !got.has(word) && !got.has(word.replace(/s$/, '')) && !joined.includes(word));
      if (missing.length) issues.push({kind: 'misheard', time: line.start, scene: line.scene, message: `listeners may mishear "${missing.join(', ')}" in: "${line.text}" (heard: "${window.map(word => word.word).join('').trim()}"). Spell it for the voice with "pronounce" or rephrase`});
    }
    await fs.rm(audio, {force: true});
  }

  // A frame for every timed issue, so it can be looked at.
  issues.sort((a, b) => (a.time ?? 0) - (b.time ?? 0));
  for (const [index, issue] of issues.entries()) {
    issue.scene ??= issue.time !== undefined ? sceneAt(issue.time) : undefined;
    if (issue.time !== undefined && !issue.frame) issue.frame = await frameAt(video, issue.time + 0.05, path.join(folder, `${String(index + 1).padStart(2, '0')}-${issue.kind}.png`));
    if (issue.time !== undefined) issue.time = Number(issue.time.toFixed(2));
  }
  const result = {video, issues, folder};
  await writeJSON(path.join(folder, 'issues.json'), result);
  return result;
}
