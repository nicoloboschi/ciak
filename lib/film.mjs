// justrec film <film.json>: one storyboard file in, one finished launch video out.
// Narration, captions, music, scene timing and checks are all derived here, so the
// agent only writes what each scene shows and what the narrator says.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {renderMedia, renderStill, selectComposition} from '@remotion/renderer';
import {root, run, execute, probe, readJSON, writeJSON} from './common.mjs';
import {loadProject, cursorEvents} from './project.mjs';
import {assetServer, serveBundle, renderOptions, tick, progress} from './render.mjs';
import {checkFilm} from './check.mjs';

const themes = {
  dark: {background: 'radial-gradient(ellipse at 30% 20%, #1d2440 0%, #0d1020 70%)', text: '#f5f6fb', muted: '#a3a9bf', accent: '#7aa2ff', accentText: '#0b1020', panel: '#ffffff0d', card: '#ffffff0a'},
  // Keynote style: off-white, near-black type, grey for the second half of a headline.
  light: {background: '#f4f5f6', text: '#111214', muted: '#9a9ca3', accent: '#0f9494', accentText: '#ffffff', panel: '#ffffff', card: '#fbfcfc'},
};
const needs = {title: ['text'], image: ['src'], slide: ['heading'], stats: ['items'], chart: ['heading', 'bars'], lines: ['heading', 'panels'], recording: ['project'], compare: ['before', 'after'], end: ['columns']};
const minimum = {title: 3, image: 4, slide: 4, stats: 3, chart: 4.5, lines: 6, end: 6};
const lead = 0.45; // silence before the narrator starts in each scene
const tail = 0.8; // and after the narrator ends
const gap = 0.3; // between sentences

const fail = (index, message) => { throw new Error(`Scene ${index + 1}: ${message}`); };
const exists = file => fs.access(file).then(() => true, () => false);
const hash = value => createHash('sha256').update(value).digest('hex').slice(0, 16);

export function sentences(text = '') {
  return (text.match(/[^.!?]+[.!?]+["”')\]]*|[^.!?]+$/g) || []).map(item => item.trim()).filter(Boolean);
}

// Split a sentence into caption lines of at most 8 words, preferring to break after
// commas so lines read as phrases; lines are timed by their length.
export function captionLines(sentence, start, duration) {
  const lines = [];
  for (const clause of sentence.split(/(?<=[,;:])\s+/)) {
    const words = clause.split(/\s+/);
    const previous = lines.at(-1);
    if (previous && (words.length < 3 || previous.split(' ').length < 3) && previous.split(' ').length + words.length <= 8) { lines[lines.length - 1] = `${previous} ${clause}`; continue; }
    const count = Math.ceil(words.length / 8);
    const size = Math.ceil(words.length / count);
    for (let index = 0; index < words.length; index += size) lines.push(words.slice(index, index + size).join(' '));
  }
  const total = lines.reduce((sum, line) => sum + line.length, 0);
  let time = start;
  return lines.map(line => { const length = duration * line.length / total; const item = {start: time, end: time + length, text: line}; time += length; return item; });
}

async function validate(film, directory) {
  if (!Array.isArray(film.scenes) || !film.scenes.length) throw new Error('film.json needs a non-empty "scenes" list');
  for (const [index, scene] of film.scenes.entries()) {
    if (!needs[scene.type]) fail(index, `unknown type "${scene.type}"; use one of ${Object.keys(needs).join(', ')}`);
    for (const key of needs[scene.type]) if (scene[key] === undefined) fail(index, `a ${scene.type} scene needs "${key}"`);
    if (scene.type === 'stats' && !scene.items.every(item => item.value !== undefined && item.label)) fail(index, 'stats items need "value" and "label"');
    if (scene.type === 'chart' && !scene.bars.every(bar => bar.label && Number.isFinite(bar.value))) fail(index, 'chart bars need "label" and a numeric "value"');
    if (scene.type === 'compare' && !(scene.before.project && scene.after.project)) fail(index, 'compare needs before.project and after.project');
    if (scene.type === 'lines') for (const panel of scene.panels) {
      if (!Array.isArray(panel.x) || !Array.isArray(panel.series) || !panel.series.length) fail(index, 'each lines panel needs "x" labels and a "series" list');
      for (const series of panel.series) if (!Array.isArray(series.values) || series.values.length !== panel.x.length || !series.values.every(Number.isFinite)) fail(index, `series "${series.name || '?'}" needs ${panel.x.length} numeric values, one per x label`);
    }
    if (scene.type === 'end' && !scene.columns.every(column => column.title)) fail(index, 'end columns need a "title"');
    if (scene.counter && !(Number.isFinite(Number(String(scene.counter.to).replace(/,/g, ''))))) fail(index, 'counter needs a numeric "to"');
    if (scene.speed !== undefined && !(scene.speed >= 0.5 && scene.speed <= 4)) fail(index, '"speed" must be between 0.5 and 4');
    for (const file of [scene.src, scene.image, scene.background].filter(Boolean)) {
      await fs.access(path.resolve(directory, file)).catch(() => fail(index, `file not found: ${file}`));
    }
  }
}

// A project JSON, a recording mp4, or just the recording's --name (newest one wins).
async function projectFile(file, directory) {
  const absolute = path.resolve(directory, file);
  const candidate = absolute.endsWith('.json') ? absolute : absolute.replace(/(\.edited)?\.mp4$/, '.project.json');
  if (await exists(candidate)) return candidate;
  const folder = path.dirname(absolute);
  const named = (await fs.readdir(folder).catch(() => [])).filter(name => name.startsWith(`${path.basename(file)}-`) && name.endsWith('.project.json')).sort();
  if (!named.length) throw new Error(`Recording not found: ${file} (use the --name you recorded with, or a .project.json path)`);
  return path.join(folder, named.at(-1));
}

async function prepareRecording(file, files, origin, fps, cache) {
  const {directory, project} = await loadProject(file);
  const key = hash(file);
  const source = path.resolve(directory, project.source);
  files.set(`/rec-${key}.mp4`, source);
  const last = project.clips.at(-1);
  const still = path.join(cache, `last-${key}-${hash(JSON.stringify(project.clips))}.png`);
  if (!await exists(still)) await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-ss', String(Math.max(0, last.end - 0.1)), '-i', source, '-frames:v', '1', still]);
  files.set(`/rec-${key}-last.png`, still);
  const events = await cursorEvents(project, directory);
  const clicks = events.filter(event => event.type === 'click');
  // Clicks on the recording's own (cut) timeline, for the click sounds.
  const ticks = [];
  let frames = 0;
  for (const clip of project.clips) {
    for (const click of clicks) if (click.visible !== false && click.t >= clip.start && click.t < clip.end) ticks.push(frames / fps + click.t - clip.start);
    frames += Math.max(1, Math.round((clip.end - clip.start) * fps));
  }
  return {recording: {project, sourceUrl: `${origin}/rec-${key}.mp4`, events, clicks, webcams: [], lastFrameUrl: `${origin}/rec-${key}-last.png`}, seconds: frames / fps, ticks: project.audio?.clicks === false ? [] : ticks};
}

// Narration: every sentence becomes one cached audio file, so timings (and captions) are exact.
// "pronounce" ({"Memlake": "Mem-lake"}) changes only what the voice says; captions keep the real spelling.
async function narrate(lines, voice, speed, cache, pronounce = {}) {
  const spoken = line => Object.entries(pronounce).reduce((text, [word, sound]) => text.replace(new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g'), sound), line);
  const target = line => path.join(cache, `say-${hash(`kokoro|${voice}|${speed}|${spoken(line)}`)}.wav`);
  const missing = [];
  for (const line of new Set(lines)) if (!await exists(target(line))) missing.push(line);
  let engine = 'kokoro';
  if (missing.length) {
    const temporary = await fs.mkdtemp(path.join(cache, 'tts-'));
    try {
      await run('uvx', ['--with', 'misaki[en]', '--from', 'mlx-audio', 'mlx_audio.tts.generate', '--model', 'mlx-community/Kokoro-82M-bf16',
        '--voice', voice, '--speed', String(speed), '--text', missing.map(spoken).join('\n'), '--output_path', temporary, '--file_prefix', 'line'], {timeout: 600000});
      const made = (await fs.readdir(temporary)).filter(name => name.endsWith('.wav')).sort();
      if (made.length !== missing.length) throw new Error(`expected ${missing.length} narration files, got ${made.length}`);
      for (const [index, line] of missing.entries()) await fs.rename(path.join(temporary, made[index]), target(line));
    } catch (error) {
      // Always produce a film: fall back to the built-in macOS voice.
      console.error(`Kokoro narration failed (${error.message.split('\n')[0]}); using macOS say`);
      engine = 'say';
      for (const line of missing) {
        const aiff = path.join(temporary, `${hash(line)}.aiff`);
        await run('say', ['-o', aiff, spoken(line)]);
        await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', aiff, target(line)]);
      }
    } finally { await fs.rm(temporary, {recursive: true, force: true}); }
  }
  const durations = new Map();
  for (const line of new Set(lines)) durations.set(line, Number((await probe(target(line))).format.duration));
  return {engine, file: target, durations};
}

// Soft generated pad + arpeggio, so a film always has music without licensing questions.
async function generatedMusic() {
  const file = path.join(root, '.build', 'music-v1.wav');
  if (await exists(file)) return file;
  const chords = [[261.63, 329.63, 392.0], [220.0, 261.63, 329.63], [174.61, 220.0, 261.63], [196.0, 246.94, 293.66]];
  const bar = 4;
  const envelope = `min(1,mod(t,${bar})/0.8)*min(1,(${bar}-mod(t,${bar}))/0.7)`;
  const parts = chords.map((notes, index) => {
    const active = `between(mod(t,${bar * chords.length}),${index * bar},${(index + 1) * bar - 0.0001})`;
    const pad = notes.map(f => `0.07*sin(2*PI*${f}*t)+0.04*sin(2*PI*${(f * 1.004).toFixed(3)}*t)`).join('+');
    const bass = `0.09*sin(2*PI*${(notes[0] / 2).toFixed(2)}*t)`;
    const arpeggio = notes.map((f, step) => `between(mod(t,1.5),${step * 0.5},${step * 0.5 + 0.4999})*0.05*sin(2*PI*${f * 2}*t)*exp(-mod(t,0.5)*7)`).join('+');
    return `${active}*(${envelope}*(${pad}+${bass})+${arpeggio})`;
  });
  await fs.mkdir(path.dirname(file), {recursive: true});
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i',
    `aevalsrc=exprs='${parts.join('+')}':d=${bar * chords.length * 2}:s=48000`,
    '-af', 'lowpass=f=2400,aecho=0.8:0.6:180|360:0.25|0.12,aformat=channel_layouts=stereo', file]);
  return file;
}

// Any song becomes the same quiet bed (-32 LUFS at musicVolume 1, voice is -16), whatever its mastering.
export const musicLoudness = (volume = 1) => Math.max(-50, Math.min(-18, -32 + 20 * Math.log10(volume))).toFixed(1);

export async function renderFilm(file, options = {}) {
  const started = performance.now();
  // Seconds spent in each stage, reported so slow steps are visible.
  const timings = {};
  let lap = started;
  const mark = stage => { const now = performance.now(); timings[stage] = +((now - lap) / 1000).toFixed(1); lap = now; };
  file = path.resolve(file);
  const directory = path.dirname(file);
  const film = await readJSON(file);
  await validate(film, directory);
  const fps = film.fps || 60;
  const [width, height] = [film.width || 1920, film.height || 1080];
  const output = path.resolve(directory, options.output || film.output || path.basename(file).replace(/(\.film)?\.json$/, '.mp4'));
  const cache = path.join(directory, '.justrec-cache');
  await fs.mkdir(cache, {recursive: true});

  const files = new Map();
  const {server, origin} = await assetServer(files);
  try {
    // Recordings and images.
    const recordings = new Map();
    const recording = async name => {
      const key = await projectFile(name, directory);
      if (!recordings.has(key)) recordings.set(key, await prepareRecording(key, files, origin, fps, cache));
      return recordings.get(key);
    };
    const image = name => { const absolute = path.resolve(directory, name); const url = `/image-${hash(absolute)}${path.extname(absolute)}`; files.set(url, absolute); return origin + url; };

    // Narration for every sentence of every scene, in one batch.
    const said = film.scenes.map(scene => sentences(scene.say));
    mark('prepare');
    const voice = await narrate(said.flat(), film.voice || 'af_heart', film.speed || 1, cache, film.pronounce);
    mark('narration');

    // Timeline: each scene lasts as long as its content or its narration, whichever is longer.
    const scenes = [];
    const narration = [];
    const captions = [];
    const ticks = [];
    let from = 0;
    for (const [index, scene] of film.scenes.entries()) {
      const item = {...scene};
      let content = minimum[scene.type] || 0;
      if (scene.type === 'slide') content += (scene.bullets?.length || 0) * 0.8;
      if (scene.src) item.url = image(scene.src);
      if (scene.image) item.url = image(scene.image);
      if (scene.background) { item.backgroundUrl = image(scene.background); item.backgroundVideo = /\.(mp4|mov|m4v|webm)$/i.test(scene.background); }
      const sounds = [];
      if (scene.type === 'recording') {
        const prepared = await recording(scene.project).catch(error => fail(index, error.message));
        // "speed": 1.5 plays the recording 1.5x faster (zooms, cursor and click sounds follow).
        const rate = scene.speed || 1;
        item.recording = prepared.recording; content = prepared.seconds / rate; sounds.push(...prepared.ticks.map(at => at / rate));
      }
      if (scene.type === 'compare') {
        for (const side of ['before', 'after']) {
          const prepared = await recording(scene[side].project).catch(error => fail(index, error.message));
          const rate = scene.speed || 1;
          item[side] = {...scene[side], recording: prepared.recording}; content = Math.max(content, prepared.seconds / rate);
          if (side === 'after') sounds.push(...prepared.ticks.map(at => at / rate));
        }
      }
      const lines = said[index];
      const spoken = lines.reduce((sum, line) => sum + voice.durations.get(line), 0) + gap * Math.max(0, lines.length - 1);
      const seconds = Math.max(scene.duration || 0, content, spoken ? lead + spoken + tail : 0);
      const frames = Math.round(seconds * fps);
      const start = from / fps;
      let time = start + lead;
      for (const line of lines) {
        const length = voice.durations.get(line);
        narration.push({file: voice.file(line), start: time, end: time + length, scene: index, text: line});
        captions.push(...captionLines(line, time, length));
        time += length + gap;
      }
      for (const at of sounds) if (at < seconds) ticks.push(start + at);
      scenes.push({...item, from, frames});
      from += frames;
    }
    const duration = from / fps;
    const theme = {...themes[film.theme?.base || 'dark'], ...film.theme};
    const inputProps = {film: {width, height, fps, frames: from, theme, scenes, captions: film.captions === false ? null : captions}};

    await serveBundle(files);
    const composition = await selectComposition({serveUrl: origin, id: 'Film', inputProps});

    // Layout probe: one still per scene, once everything in it has appeared, measured in the browser.
    const sheet = path.join(cache, `probe-${process.pid}`);
    await fs.mkdir(sheet, {recursive: true});
    const layout = [];
    const probeProps = {film: {...inputProps.film, probe: true}};
    // Remotion renders the props baked into the composition, so the probe needs its own.
    const probeComposition = await selectComposition({serveUrl: origin, id: 'Film', inputProps: probeProps});
    for (const [index, scene] of scenes.entries()) {
      const frame = scene.from + Math.max(0, scene.frames - Math.round(fps * 0.4));
      const still = path.join(sheet, `scene-${String(index).padStart(3, '0')}.png`);
      const logs = [];
      await renderStill({serveUrl: origin, composition: probeComposition, inputProps: probeProps, frame, output: still, imageFormat: 'png', onBrowserLog: log => logs.push(log.text)});
      const found = logs.filter(text => text.startsWith('JUSTREC_LAYOUT ')).flatMap(text => JSON.parse(text.slice(15)).issues);
      const words = {'off-frame': 'runs off the frame', clipped: 'is cut off', overlap: 'overlaps other text', 'caption-zone': 'sits where the captions appear', contrast: 'is hard to read: too little contrast with what is behind it'};
      for (const issue of found) layout.push({kind: `layout-${issue.kind}`, time: frame / fps, scene: index, message: `"${issue.text}" ${words[issue.kind] || issue.kind}`, box: issue.box});
    }

    mark('layout check');
    if (options.preview) {
      const preview = output.replace(/\.mp4$/, '.preview.png');
      const columns = Math.min(3, scenes.length);
      await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-framerate', '1', '-i', path.join(sheet, 'scene-%03d.png'),
        '-vf', `scale=640:-2,pad=iw+8:ih+8:4:4:black,tile=${columns}x${Math.ceil(scenes.length / columns)}`, '-frames:v', '1', preview]);
      await fs.rm(sheet, {recursive: true, force: true});
      return {preview, duration, scenes: scenes.map(scene => ({type: scene.type, start: +(scene.from / fps).toFixed(2), seconds: +(scene.frames / fps).toFixed(2)})), narration: voice.engine,
        issues: layout.map(({box, ...issue}) => ({...issue, time: +issue.time.toFixed(2)})), timings};
    }

    const scratch = await fs.mkdtemp(path.join(root, '.build/film-'));
    try {
      const video = path.join(scratch, 'video.mp4');
      await renderMedia({serveUrl: origin, composition, inputProps, outputLocation: video, ...renderOptions, onProgress: progress()});
      mark('video render');

      // Audio in three small steps with fixed-length inputs (one big graph with a looped
      // input and a sidechain deadlocked): narration + clicks, music bed, then duck and mix.
      const pad = `apad,atrim=0:${duration}`;
      const spoken = path.join(scratch, 'spoken.wav');
      const voiceArgs = ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `anullsrc=r=48000:cl=stereo,atrim=0:${duration}`];
      const voiceFilters = [];
      const parts = ['[0:a]'];
      narration.forEach((item, index) => {
        voiceArgs.push('-i', item.file);
        voiceFilters.push(`[${index + 1}:a]aresample=48000,aformat=channel_layouts=stereo,adelay=${Math.round(item.start * 1000)}:all=1[n${index}]`);
        parts.push(`[n${index}]`);
      });
      if (ticks.length) {
        voiceFilters.push(`${tick},volume=0.6,asplit=${ticks.length}${ticks.map((_, index) => `[t${index}]`).join('')}`);
        ticks.forEach((time, index) => { voiceFilters.push(`[t${index}]adelay=${Math.round(time * 1000)}:all=1[c${index}]`); parts.push(`[c${index}]`); });
      }
      // Narration at -16 LUFS keeps it ~14 dB above the music bed (-30 LUFS), whatever the voice engine outputs.
      voiceFilters.push(`${parts.join('')}amix=inputs=${parts.length}:normalize=0:duration=first,loudnorm=I=-16:TP=-2:LRA=11,${pad}[out]`);
      await run('ffmpeg', [...voiceArgs, '-filter_complex', voiceFilters.join(';'), '-map', '[out]', spoken]);

      const musicFile = film.music === false ? null : typeof film.music === 'string' ? path.resolve(directory, film.music) : await generatedMusic();
      const mixed = path.join(scratch, 'mixed.wav');
      const inputs = ['-hide_banner', '-loglevel', 'error', '-y', '-i', spoken];
      let graph = '[0:a]anull[audio]';
      if (musicFile) {
        const bed = path.join(scratch, 'music.wav');
        await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-stream_loop', '-1', '-i', musicFile, '-t', String(duration),
          '-af', `aresample=48000,aformat=channel_layouts=stereo,loudnorm=I=${musicLoudness(film.musicVolume)}:TP=-8:LRA=7,afade=t=in:d=1.5,afade=t=out:st=${Math.max(0, duration - 2.5)}:d=2.5`, bed]);
        inputs.push('-i', bed);
        graph = '[0:a]asplit=2[spoken][key];[1:a][key]sidechaincompress=threshold=0.02:ratio=12:attack=20:release=450[ducked];[spoken][ducked]amix=inputs=2:normalize=0:duration=first[audio]';
      }
      await run('ffmpeg', [...inputs, '-filter_complex', graph, '-map', '[audio]', mixed]);
      // Two-pass loudness: measure the mix, then apply one linear gain. (Dynamic loudnorm lifts
      // quiet stretches, which brought the music back up between sentences.)
      const target = 'I=-14:TP=-1.5:LRA=20';
      const {stderr: measured} = await execute('ffmpeg', ['-hide_banner', '-i', mixed, '-af', `loudnorm=${target}:print_format=json`, '-f', 'null', '-'], {maxBuffer: 16 * 1024 * 1024});
      const level = JSON.parse(measured.match(/\{[^{}]*"target_offset"[^{}]*\}/)[0]);
      const final = path.join(scratch, 'final.mp4');
      await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', video, '-i', mixed, '-map', '0:v:0', '-map', '1:a:0',
        '-af', `loudnorm=${target}:measured_I=${level.input_i}:measured_TP=${level.input_tp}:measured_LRA=${level.input_lra}:measured_thresh=${level.input_thresh}:offset=${level.target_offset}:linear=true`,
        '-c:v', 'copy', '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-b:a', '192k', '-t', String(duration), '-movflags', '+faststart', final]);

      mark('audio mix');
      // Checks before calling it done.
      const metadata = await probe(final);
      if (metadata.streams.filter(stream => stream.codec_type === 'video').length !== 1 || metadata.streams.filter(stream => stream.codec_type === 'audio').length !== 1) throw new Error('Film must have exactly one video and one audio track');
      if (Math.abs(Number(metadata.format.duration) - duration) > 0.15) throw new Error('Film duration check failed');
      const {stderr} = await execute('ffmpeg', ['-hide_banner', '-i', final, '-vn', '-af', 'volumedetect', '-f', 'null', '-'], {maxBuffer: 16 * 1024 * 1024});
      const loudness = Number(stderr.match(/mean_volume: (-?[\d.]+)/)?.[1]);
      if (narration.length && !(loudness > -35)) throw new Error(`Narration is too quiet (mean ${loudness} dB)`);
      await fs.mkdir(path.dirname(output), {recursive: true});
      await fs.copyFile(final, output);
      const srt = output.replace(/\.mp4$/, '.srt');
      const stamp = seconds => new Date(seconds * 1000).toISOString().slice(11, 23).replace('.', ',');
      await fs.writeFile(srt, captions.map((caption, index) => `${index + 1}\n${stamp(caption.start)} --> ${stamp(caption.end)}\n${caption.text}\n`).join('\n'));
      const report = {output, captions: srt, duration, width, height, fps, narration: voice.engine, music: musicFile ? path.basename(musicFile) : null, meanVolume: loudness,
        scenes: scenes.map(scene => ({type: scene.type, start: +(scene.from / fps).toFixed(2), seconds: +(scene.frames / fps).toFixed(2)})),
        lines: narration.map(({file, ...line}) => line), captionLines: captions, layout: layout.map(({box, ...issue}) => issue)};
      await writeJSON(`${output}.report.json`, report);
      await fs.rm(sheet, {recursive: true, force: true});
      // Check what a viewer would notice; every issue comes with a time and a frame to look at.
      if (options.check !== false) {
        const {issues, folder} = await checkFilm(report);
        Object.assign(report, {issues, checkFolder: folder});
        mark('inspection');
      }
      report.timings = timings;
      report.elapsedSeconds = +((performance.now() - started) / 1000).toFixed(1);
      await writeJSON(`${output}.report.json`, report);
      return report;
    } finally { await fs.rm(scratch, {recursive: true, force: true}); }
  } finally { server.closeAllConnections(); server.close(); }
}
