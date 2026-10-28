// ciak film <film.json>: one storyboard file in, one finished launch video out.
// Narration, captions, music, scene timing and checks are all derived here, so the
// agent only writes what each scene shows and what the narrator says.
// One preparation step (prepareFilm) feeds four outputs: the export, a contact-sheet
// preview, frames at chosen times, and a live player in the browser.
import fs from 'node:fs/promises';
import {watch} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {renderMedia, renderStill, selectComposition} from '@remotion/renderer';
import {root, run, execute, probe, readJSON, writeJSON} from './common.mjs';
import {loadProject, cursorEvents, findProject} from './project.mjs';
import {assetServer, serveBundle, customEntry, renderOptions, tick, progress, chrome} from './render.mjs';
import {checkFilm} from './check.mjs';
import {validate} from './schema.mjs';

export const schemaFile = path.join(root, 'lib/film.schema.json');
const themes = {
  dark: {background: 'radial-gradient(ellipse at 30% 20%, #1d2440 0%, #0d1020 70%)', text: '#f5f6fb', muted: '#a3a9bf', accent: '#7aa2ff', accentText: '#0b1020', panel: '#ffffff0d', card: '#ffffff0a'},
  // Keynote style: off-white, near-black type, grey for the second half of a headline.
  light: {background: '#f4f5f6', text: '#111214', muted: '#9a9ca3', accent: '#0f9494', accentText: '#ffffff', panel: '#ffffff', card: '#fbfcfc'},
};
// Old field names, so older films get a precise fix.
const renamed = {speed: 'voice.speed (a scene\'s "speed" is playback speed)', pronounce: 'voice.pronounce', musicVolume: 'music.volume',
  heading: '"title"', text: '"title"', src: '"image"', items: '"stats"', project: '"recording"'};
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

// The schema catches shape errors (typos, wrong types, renamed fields); this catches the rest.
async function check(film, directory) {
  const errors = validate(await readJSON(schemaFile), film, renamed);
  if (errors.length) throw new Error(`film.json does not match the schema (${schemaFile}):\n- ${errors.join('\n- ')}`);
  for (const [index, scene] of film.scenes.entries()) {
    for (const panel of scene.panels || []) for (const series of panel.series) {
      if (series.values.length !== panel.x.length) fail(index, `a series has ${series.values.length} values but the panel has ${panel.x.length} x labels`);
    }
    if (scene.counter && !Number.isFinite(Number(String(scene.counter.to).replace(/,/g, '')))) fail(index, 'counter "to" must be a number');
    for (const file of [scene.image, scene.background, scene.component, ...Object.values(scene.images || {})].filter(Boolean)) {
      if (!await exists(path.resolve(directory, file))) fail(index, `file not found: ${file}`);
    }
  }
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
  // A voice recorded with `ciak voice add` is cloned; any other name is a Kokoro voice.
  const {findVoice, speakAs} = await import('./voice.mjs');
  const own = await findVoice(voice);
  let engine = own ? 'clone' : 'kokoro';
  const target = line => path.join(cache, `say-${hash(`${engine === 'clone' ? `clone|${own.text}|${process.env.CIAK_VOICE_LANG || 'english'}` : 'kokoro'}|${voice}|${speed}|${spoken(line)}`)}.wav`);
  const missing = [];
  for (const line of new Set(lines)) if (!await exists(target(line))) missing.push(line);
  if (missing.length) {
    const temporary = await fs.mkdtemp(path.join(cache, 'tts-'));
    try {
      if (own) {
        const made = missing.map((line, index) => ({text: spoken(line), out: path.join(temporary, `line-${index}.wav`)}));
        await speakAs(own, made);
        // The cloned voice has no speed setting: change the tempo, keep the pitch.
        for (const [index, line] of missing.entries()) await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', made[index].out, ...(speed !== 1 ? ['-af', `atempo=${speed}`] : []), target(line)]);
      } else {
        await run('uvx', ['--with', 'misaki[en]', '--from', 'mlx-audio', 'mlx_audio.tts.generate', '--model', 'mlx-community/Kokoro-82M-bf16',
          '--voice', voice, '--speed', String(speed), '--text', missing.map(spoken).join('\n'), '--output_path', temporary, '--file_prefix', 'line'], {timeout: 600000});
        const made = (await fs.readdir(temporary)).filter(name => name.endsWith('.wav')).sort();
        if (made.length !== missing.length) throw new Error(`expected ${missing.length} narration files, got ${made.length}`);
        for (const [index, line] of missing.entries()) await fs.rename(path.join(temporary, made[index]), target(line));
      }
    } catch (error) {
      // Always produce a film: fall back to the built-in macOS voice.
      console.error(`${engine === 'clone' ? 'Cloned voice' : 'Kokoro'} narration failed (${error.message.split('\n')[0]}); using macOS say`);
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

// Generated music, so a film always has some without licensing questions (see lib/music.mjs).
async function generatedMusic() {
  return (await import('./music.mjs')).music(path.join(root, '.build'));
}

// Any song becomes the same quiet bed (-32 LUFS at volume 1, voice is -16), whatever its mastering.
export const musicLoudness = (volume = 1) => Math.max(-50, Math.min(-18, -32 + 20 * Math.log10(volume))).toFixed(1);

// Everything a render, preview, frames or live view needs: validated film, prepared
// recordings and images on a local asset server, narration, and the timeline.
export async function prepareFilm(file, {output, server: shared} = {}) {
  file = path.resolve(file);
  const directory = path.dirname(file);
  const film = await readJSON(file);
  await check(film, directory);
  const fps = film.fps || 60;
  const [width, height] = [film.width || 1920, film.height || 1080];
  const cache = path.join(directory, '.ciak-cache');
  await fs.mkdir(cache, {recursive: true});
  const {files, server, origin} = shared || await (async () => { const files = new Map(); return {files, ...await assetServer(files)}; })();
  const recordings = new Map();
  const recording = async name => {
    const key = await findProject(name, directory);
    if (!recordings.has(key)) recordings.set(key, await prepareRecording(key, files, origin, fps, cache));
    return recordings.get(key);
  };
  const asset = name => { const absolute = path.resolve(directory, name); const url = `/asset-${hash(absolute)}${path.extname(absolute)}`; files.set(url, absolute); return origin + url; };

  // Narration for every sentence of every scene, in one batch.
  const said = film.scenes.map(scene => sentences(scene.say));
  const voice = await narrate(said.flat(), film.voice?.name || 'af_heart', film.voice?.speed || 1, cache, film.voice?.pronounce);

  // Timeline: each scene lasts as long as its content or its narration, whichever is longer.
  const scenes = []; const narration = []; const captions = []; const ticks = []; const customs = new Map(); const holds = [];
  let from = 0;
  for (const [index, scene] of film.scenes.entries()) {
    const item = {...scene};
    let content = minimum[scene.type] || 0;
    if (scene.type === 'slide') content += (scene.bullets?.length || 0) * 0.8;
    if (scene.image) item.url = asset(scene.image);
    if (scene.background) { item.backgroundUrl = asset(scene.background); item.backgroundVideo = /\.(mp4|mov|m4v|webm)$/i.test(scene.background); }
    const sounds = [];
    // "speed": 1.5 plays a recording 1.5x faster (zooms, cursor and click sounds follow).
    const rate = scene.speed || 1;
    let recorded = 0;  // seconds of moving recording this scene shows
    if (scene.type === 'recording') {
      const prepared = await recording(scene.recording).catch(error => fail(index, error.message));
      item.recording = prepared.recording; content = recorded = prepared.seconds / rate; sounds.push(...prepared.ticks.map(at => at / rate));
    }
    if (scene.type === 'custom') {
      // A component from the film's folder; its recordings and images arrive as props by name.
      customs.set(scene.component, path.resolve(directory, scene.component));
      item.imageUrls = Object.fromEntries(Object.entries(scene.images || {}).map(([name, file]) => [name, asset(file)]));
      item.recordingsReady = {};
      for (const [name, value] of Object.entries(scene.recordings || {})) {
        const prepared = await recording(value).catch(error => fail(index, error.message));
        item.recordingsReady[name] = prepared.recording; recorded = Math.max(recorded, prepared.seconds / rate); content = Math.max(content, recorded); sounds.push(...prepared.ticks.map(at => at / rate));
      }
    }
    if (scene.type === 'compare') {
      for (const side of ['before', 'after']) {
        const prepared = await recording(scene[side].recording).catch(error => fail(index, error.message));
        item[side] = {...scene[side], recording: prepared.recording}; recorded = Math.max(recorded, prepared.seconds / rate); content = Math.max(content, recorded);
        if (side === 'after') sounds.push(...prepared.ticks.map(at => at / rate));
      }
    }
    const lines = said[index];
    const spoken = lines.reduce((sum, line) => sum + voice.durations.get(line), 0) + gap * Math.max(0, lines.length - 1);
    const seconds = Math.max(scene.duration || 0, content, spoken ? lead + spoken + tail : 0);
    const frames = Math.round(seconds * fps);
    const start = from / fps;
    // A recording that ends early holds its last frame: under a zoom or a moving frame it reads as a screenshot.
    if (recorded && seconds - recorded > 1) holds.push({kind: 'frozen', time: +(start + recorded).toFixed(2), scene: index,
      message: `the recording ends at ${recorded.toFixed(1)} s and its last frame holds still for ${(seconds - recorded).toFixed(1)} s: record longer, play it slower (speed), or shorten the scene`});
    let time = start + lead;
    for (const line of lines) {
      const length = voice.durations.get(line);
      narration.push({file: voice.file(line), start: time, end: time + length, scene: index, text: line});
      captions.push(...captionLines(line, time, length));
      time += length + gap;
    }
    if (film.clicks) for (const at of sounds) if (at < seconds) ticks.push(start + at);
    scenes.push({...item, from, frames});
    from += frames;
  }
  const music = film.music === false ? null : typeof film.music === 'string' ? path.resolve(directory, film.music)
    : film.music?.file ? path.resolve(directory, film.music.file) : await generatedMusic();
  if (music && !await exists(music)) throw new Error(`music file not found: ${music}`);
  // A style (built-in or ~/.ciak/styles) sets the look; "theme" fine-tunes on top.
  const style = film.style ? await (await import('./style.mjs')).loadStyle(film.style, directory) : {};
  const theme = {...themes[film.theme?.base || 'dark'], ...style, ...film.theme};
  const inputProps = {film: {width, height, fps, frames: from, theme, scenes, captions: film.captions === false ? null : captions}};
  return {file, film, directory, cache, fps, width, height, files, server, origin, scenes, narration, captions, ticks, voice, music, inputProps, holds,
    customs: [...customs].map(([name, file]) => ({name, file})),
    duration: from / fps, output: path.resolve(directory, output || film.output || path.basename(file).replace(/(\.film)?\.json$/, '.mp4')),
    close: () => { if (!shared) { server.closeAllConnections(); server.close(); } }};
}

const summary = (prepared) => prepared.scenes.map(scene => ({type: scene.type, start: +(scene.from / prepared.fps).toFixed(2), seconds: +(scene.frames / prepared.fps).toFixed(2)}));

// Layout probe: one still per scene, once everything in it has appeared, measured in the browser.
async function probeLayout(prepared, folder) {
  const {origin, fps, scenes, inputProps} = prepared;
  const probeProps = {film: {...inputProps.film, probe: true}};
  // Remotion renders the props baked into the composition, so the probe needs its own.
  const composition = await selectComposition({browserExecutable: await chrome(), serveUrl: origin, id: 'Film', inputProps: probeProps});
  const layout = [];
  const words = {'off-frame': 'runs off the frame', clipped: 'is cut off', overlap: 'overlaps other text', 'caption-zone': 'sits where the captions appear', contrast: 'is hard to read: too little contrast with what is behind it'};
  for (const [index, scene] of scenes.entries()) {
    const frame = scene.from + Math.max(0, scene.frames - Math.round(fps * 0.4));
    const logs = [];
    await renderStill({browserExecutable: await chrome(), serveUrl: origin, composition, inputProps: probeProps, frame, output: path.join(folder, `scene-${String(index).padStart(3, '0')}.png`), imageFormat: 'png', onBrowserLog: log => logs.push(log.text)});
    for (const issue of logs.filter(text => text.startsWith('CIAK_LAYOUT ')).flatMap(text => JSON.parse(text.slice(12)).issues)) {
      layout.push({kind: `layout-${issue.kind}`, time: +(frame / fps).toFixed(2), scene: index, message: `"${issue.text}" ${words[issue.kind] || issue.kind}`});
    }
  }
  return layout;
}

// Frames at chosen times, labelled with their timecode and scene, tiled into one image.
async function renderFrames(prepared, times, output) {
  const {origin, fps} = prepared;
  // The film itself stamps each frame with its timecode and scene number.
  const inputProps = {film: {...prepared.inputProps.film, stamp: true}};
  const composition = await selectComposition({browserExecutable: await chrome(), serveUrl: origin, id: 'Film', inputProps});
  const folder = await fs.mkdtemp(path.join(prepared.cache, 'frames-'));
  try {
    for (const [index, time] of times.entries()) {
      const frame = Math.min(composition.durationInFrames - 1, Math.max(0, Math.round(time * fps)));
      await renderStill({browserExecutable: await chrome(), serveUrl: origin, composition, inputProps, frame, output: path.join(folder, `frame-${String(index).padStart(3, '0')}.png`), imageFormat: 'png'});
    }
    const columns = Math.min(4, times.length);
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-framerate', '1', '-i', path.join(folder, 'frame-%03d.png'),
      '-vf', `scale=640:-2,pad=iw+6:ih+6:3:3:black,tile=${columns}x${Math.ceil(times.length / columns)}`, '-frames:v', '1', output]);
  } finally { await fs.rm(folder, {recursive: true, force: true}); }
  return output;
}

// Which times to show: a whole scene, a range, or a list, one frame every `every` seconds.
export function frameTimes(prepared, {scene, from, to, at, every}) {
  if (at) return at;
  let [start, end] = [from ?? 0, to ?? prepared.duration];
  if (scene !== undefined) {
    const item = prepared.scenes[scene - 1];
    if (!item) throw new Error(`There is no scene ${scene} (the film has ${prepared.scenes.length})`);
    [start, end] = [item.from / prepared.fps, (item.from + item.frames) / prepared.fps];
  }
  const step = every || Math.max(0.25, (end - start) / 12);
  const times = [];
  for (let time = start; time < end - 1e-6 && times.length < 48; time += step) times.push(+time.toFixed(3));
  return times;
}

export async function renderFilm(file, options = {}) {
  const started = performance.now();
  // Seconds spent in each stage, reported so slow steps are visible.
  const timings = {};
  let lap = started;
  const mark = stage => { const now = performance.now(); timings[stage] = +((now - lap) / 1000).toFixed(1); lap = now; };
  const prepared = await prepareFilm(file, {output: options.output});
  const {files, origin, fps, scenes, narration, captions, ticks, duration, output, inputProps, music, voice} = prepared;
  mark('prepare + narration');
  try {
    await serveBundle(files, prepared.customs);
    const composition = await selectComposition({browserExecutable: await chrome(), serveUrl: origin, id: 'Film', inputProps});

    if (options.frames) {
      const target = options.frames.output || output.replace(/\.mp4$/, '.frames.png');
      await renderFrames(prepared, frameTimes(prepared, options.frames), target);
      mark('frames');
      return {frames: target, times: frameTimes(prepared, options.frames), duration, scenes: summary(prepared), timings};
    }

    const sheet = await fs.mkdtemp(path.join(prepared.cache, 'probe-'));
    try {
      const layout = [...prepared.holds, ...await probeLayout(prepared, sheet)];
      mark('layout check');
      if (options.preview) {
        const preview = output.replace(/\.mp4$/, '.preview.png');
        const columns = Math.min(3, scenes.length);
        await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-framerate', '1', '-i', path.join(sheet, 'scene-%03d.png'),
          '-vf', `scale=640:-2,pad=iw+8:ih+8:4:4:black,tile=${columns}x${Math.ceil(scenes.length / columns)}`, '-frames:v', '1', preview]);
        return {preview, duration, scenes: summary(prepared), narration: voice.engine, issues: layout, timings};
      }

      const scratch = await fs.mkdtemp(path.join(root, '.build/film-'));
      try {
        const video = path.join(scratch, 'video.mp4');
        await renderMedia({browserExecutable: await chrome(), serveUrl: origin, composition, inputProps, outputLocation: video, ...renderOptions, onProgress: progress()});
        mark('video render');
        const final = path.join(scratch, 'final.mp4');
        await mixAudio({prepared, video, scratch, final});
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
        const time = seconds => new Date(seconds * 1000).toISOString().slice(11, 23).replace('.', ',');
        await fs.writeFile(srt, captions.map((caption, index) => `${index + 1}\n${time(caption.start)} --> ${time(caption.end)}\n${caption.text}\n`).join('\n'));
        const report = {output, captions: srt, duration, width: prepared.width, height: prepared.height, fps, narration: voice.engine, music: music ? path.basename(music) : null, meanVolume: loudness,
          scenes: summary(prepared), lines: narration.map(({file, ...line}) => line), captionLines: captions, layout};
        await writeJSON(`${output}.report.json`, report);
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
    } finally { await fs.rm(sheet, {recursive: true, force: true}); }
  } finally { prepared.close(); }
}

// Audio in small steps with fixed-length inputs (one big graph with a looped input and a
// sidechain deadlocked): narration + clicks, music bed, duck and mix, then two-pass loudness.
async function mixAudio({prepared, video, scratch, final}) {
  const {narration, ticks, duration, music, film} = prepared;
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
  // Narration at -16 LUFS keeps it ~16 dB above the music bed (-32 LUFS), whatever the voice engine outputs.
  voiceFilters.push(`${parts.join('')}amix=inputs=${parts.length}:normalize=0:duration=first,loudnorm=I=-16:TP=-2:LRA=11,${pad}[out]`);
  await run('ffmpeg', [...voiceArgs, '-filter_complex', voiceFilters.join(';'), '-map', '[out]', spoken]);

  const mixed = path.join(scratch, 'mixed.wav');
  const inputs = ['-hide_banner', '-loglevel', 'error', '-y', '-i', spoken];
  let graph = '[0:a]anull[audio]';
  if (music) {
    const bed = path.join(scratch, 'music.wav');
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-stream_loop', '-1', '-i', music, '-t', String(duration),
      '-af', `aresample=48000,aformat=channel_layouts=stereo,loudnorm=I=${musicLoudness(film.music?.volume)}:TP=-8:LRA=7,afade=t=in:d=1.5,afade=t=out:st=${Math.max(0, duration - 2.5)}:d=2.5`, bed]);
    inputs.push('-i', bed);
    graph = '[0:a]asplit=2[spoken][key];[1:a][key]sidechaincompress=threshold=0.02:ratio=12:attack=20:release=450[ducked];[spoken][ducked]amix=inputs=2:normalize=0:duration=first[audio]';
  }
  await run('ffmpeg', [...inputs, '-filter_complex', graph, '-map', '[audio]', mixed]);
  // Two-pass loudness: measure the mix, then apply one linear gain. (Dynamic loudnorm lifts
  // quiet stretches, which brought the music back up between sentences.)
  const target = 'I=-14:TP=-1.5:LRA=20';
  const {stderr: measured} = await execute('ffmpeg', ['-hide_banner', '-i', mixed, '-af', `loudnorm=${target}:print_format=json`, '-f', 'null', '-'], {maxBuffer: 16 * 1024 * 1024});
  const level = JSON.parse(measured.match(/\{[^{}]*"target_offset"[^{}]*\}/)[0]);
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', video, '-i', mixed, '-map', '0:v:0', '-map', '1:a:0',
    // A silent film (no voice, no music) measures -inf: keep the silence as it is.
    ...(Number.isFinite(Number(level.input_i)) ? ['-af', `loudnorm=${target}:measured_I=${level.input_i}:measured_TP=${level.input_tp}:measured_LRA=${level.input_lra}:measured_thresh=${level.input_thresh}:offset=${level.target_offset}:linear=true`] : []),
    '-c:v', 'copy', '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-b:a', '192k', '-t', String(duration), '-movflags', '+faststart', final]);
}

// ciak film --live: play the film in the browser right away (no export), with narration
// and music, and reload when film.json or a recording changes. For humans to watch and comment.
export async function serveLive(file, {open = true} = {}) {
  file = path.resolve(file);
  const files = new Map();
  // Edits come from the page with this token (so other web pages can't write the film).
  const token = (await import('node:crypto')).randomBytes(18).toString('hex');
  const schema = await readJSON(schemaFile);
  const routes = {
    '/save': async ({film}, req) => {
      if (req.headers.authorization !== `Bearer ${token}`) throw new Error('not allowed');
      const errors = validate(schema, film, renamed);
      if (errors.length) return {errors};
      await fs.writeFile(file, JSON.stringify(film, null, 2) + '\n');
      return {saved: true};
    },
  };
  const {server, origin} = await assetServer(files, routes);
  const playerDirectory = path.join(root, '.build/player');
  await fs.mkdir(playerDirectory, {recursive: true});
  // The page script: player + editor + this film's custom scenes ("ciak" = render/kit.jsx).
  const {build} = await import('esbuild');
  const buildPlayer = async customs => {
    const entry = await customEntry(customs, path.join(playerDirectory, 'entry.jsx'), path.join(root, 'render/player.jsx'));
    const result = await build({entryPoints: [entry], bundle: true, minify: true, format: 'iife', jsx: 'automatic', loader: {'.jsx': 'jsx', '.js': 'jsx'},
      define: {'process.env.NODE_ENV': '"production"'}, alias: {ciak: path.join(root, 'render/kit.jsx'), justrec: path.join(root, 'render/kit.jsx')}, nodePaths: [path.join(root, 'node_modules')],
      outfile: path.join(playerDirectory, 'player.js'), write: true, metafile: false, logLevel: 'silent'});
    return result;
  };
  await fs.writeFile(path.join(playerDirectory, 'index.html'), `<!doctype html><html><head><meta charset="utf-8"><title>ciak live</title>
<style>html,body{margin:0;background:#0b0d12;color:#cfd3dc;font:14px -apple-system,sans-serif}#app{margin:0}#status{margin:10px 0;color:#8a90a0}</style></head>
<body><div id="app"></div><script>window.CIAK_LIVE = ${JSON.stringify({token: '__TOKEN__'})}</script><script src="/player/player.js"></script></body></html>`.replace('__TOKEN__', token));
  files.set('/', path.join(playerDirectory, 'index.html'));
  files.set('/player/player.js', path.join(playerDirectory, 'player.js'));
  files.set('/schema.json', schemaFile);
  files.set('/film.json', file);
  let version = 0; let props = null; let error = null; let bundle = null;
  const refresh = async () => {
    try {
      const prepared = await prepareFilm(file, {server: {files, server, origin}});
      await buildPlayer(prepared.customs);
      bundle = (await import('node:crypto')).createHash('sha1').update(await fs.readFile(path.join(playerDirectory, 'player.js'))).digest('hex');
      // Narration and music as plain audio in the player (the export mixes them properly).
      prepared.inputProps.film.audio = {
        narration: prepared.narration.map(line => { const url = `/say-${path.basename(line.file)}`; files.set(url, line.file); return {url: origin + url, from: Math.round(line.start * prepared.fps)}; }),
        music: prepared.music ? (files.set('/music' + path.extname(prepared.music), prepared.music), `${origin}/music${path.extname(prepared.music)}`) : null,
      };
      props = prepared.inputProps; error = null;
    } catch (failure) { error = failure.message; }
    version++;
    await fs.writeFile(path.join(playerDirectory, 'state.json'), JSON.stringify({version, props, error, bundle}));
    files.set('/state.json', path.join(playerDirectory, 'state.json'));
    console.error(error ? `film has errors:\n${error}` : `film ready (version ${version})`);
  };
  await refresh();
  let timer;
  watch(path.dirname(path.resolve(file)), {recursive: true}, (event, name) => {
    // Film, recordings' projects, custom scene code and assets; not ciak's own outputs.
    if (!name || name.split('/')[0].startsWith('.') || /\.check\//.test(name) || /\.(mp4|srt)$/.test(name) && !/project|cursor/.test(name) || /\.(preview|frames)\.png$/.test(name)) return;
    clearTimeout(timer); timer = setTimeout(refresh, 300);
  });
  console.log(JSON.stringify({url: origin, film: path.resolve(file)}));
  if (open) await run('open', [origin]);
  return server;
}
