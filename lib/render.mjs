import fs from 'node:fs/promises';
import fsSync, {createReadStream} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {createHash} from 'node:crypto';
import {bundle} from '@remotion/bundler';
import {renderMedia, renderStill, selectComposition, ensureBrowser, openBrowser} from '@remotion/renderer';
import {root, outputDir, run, probe, readJSON, writeJSON, stepLog, launch} from './common.mjs';
import {loadProject, cursorEvents} from './project.mjs';
import {cleanVoice} from './clean.mjs';

const types = {html: 'text/html', js: 'application/javascript', css: 'text/css', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', svg: 'image/svg+xml', gif: 'image/gif', json: 'application/json', wav: 'audio/wav', m4a: 'audio/mp4', mp3: 'audio/mpeg', aac: 'audio/aac'};

// routes: POST handlers ({"/save": async body => result}), for the live editor.
export async function assetServer(files, routes = {}) {
  const server = http.createServer(async (req, res) => {
    if (req.method === 'POST' && routes[req.url]) {
      res.setHeader('Content-Type', 'application/json');
      try {
        let body = ''; for await (const chunk of req) { body += chunk; if (body.length > 4e6) throw new Error('too large'); }
        res.end(JSON.stringify(await routes[req.url](JSON.parse(body || '{}'), req)));
      } catch (error) { res.writeHead(400); res.end(JSON.stringify({error: error.message})); }
      return;
    }
    const file = files.get(req.url);
    if (!file) { res.writeHead(404); res.end(); return; }
    try {
      const {size} = await fs.stat(file);
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Content-Type', types[path.extname(file).slice(1).toLowerCase()] || 'video/mp4');
      const range = req.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
      const start = range ? Number(range[1]) : 0;
      const end = range?.[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      if (start >= size || end < start) { res.writeHead(416); res.end(); return; }
      if (range) { res.statusCode = 206; res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`); }
      res.setHeader('Content-Length', end - start + 1);
      const stream = createReadStream(file, {start, end});
      stream.on('error', () => res.destroy());
      res.on('close', () => stream.destroy());
      stream.pipe(res);
    } catch { res.writeHead(500); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {server, origin: `http://127.0.0.1:${server.address().port}`};
}

// Bundle the Remotion code once per version of it, and serve it next to the media.
// customs: [{name, file}] — custom scene components from a film's folder, registered by a
// generated entry. "ciak" (and "justrec", its old name) resolves to render/kit.jsx; react/remotion to this repo's copies.
export async function serveBundle(files, customs = []) {
  // Rebuild when any renderer file, a custom scene or a dependency changes.
  const digest = createHash('sha256').update(await fs.readFile(path.join(root, 'package-lock.json')));
  for (const name of (await fs.readdir(path.join(root, 'render'))).sort()) digest.update(name).update(await fs.readFile(path.join(root, 'render', name)));
  for (const item of customs) digest.update(item.name).update(await fs.readFile(item.file));
  const hash = digest.digest('hex').slice(0, 16);
  const bundleDirectory = path.join(root, '.build', `bundle-${hash}`);
  if (!(await fs.stat(path.join(bundleDirectory, 'index.html')).catch(() => null))) {
    const entry = await customEntry(customs, path.join(root, '.build', `entry-${hash}.jsx`), path.join(root, 'render/index.jsx'));
    // No webpack cache: each bundle is kept above (by its inputs), and the cache grew to 8 GB in node_modules/.cache.
    await bundle({entryPoint: entry, outDir: bundleDirectory, publicDir: null, ignoreRegisterRootWarning: true, enableCaching: false, webpackOverride: config => ({
      ...config, resolve: {...config.resolve, alias: {...config.resolve?.alias, ciak: path.join(root, 'render/kit.jsx'), justrec: path.join(root, 'render/kit.jsx')},
        modules: [...(config.resolve?.modules || ['node_modules']), path.join(root, 'node_modules')]},
    })});
  }
  // Each code change makes a new bundle (~40 MB): forget the ones not used for two weeks.
  const now = new Date();
  await fs.utimes(bundleDirectory, now, now);
  for (const name of await fs.readdir(path.join(root, '.build'))) {
    const old = path.join(root, '.build', name);
    if (name.startsWith('bundle-') && now - (await fs.stat(old)).mtimeMs > 14 * 864e5) await fs.rm(old, {recursive: true, force: true});
  }
  for (const name of await fs.readdir(bundleDirectory)) files.set(`/${name}`, path.join(bundleDirectory, name));
  files.set('/', path.join(bundleDirectory, 'index.html'));
}

// An entry that loads `base` and registers each custom scene under its film.json name.
export async function customEntry(customs, file, base) {
  if (!customs.length) return base;
  const lines = [`import ${JSON.stringify(base)};`, `import {registerScene} from ${JSON.stringify(path.join(root, 'render/film.jsx'))};`];
  customs.forEach((item, index) => lines.push(`import Scene${index} from ${JSON.stringify(item.file)};`, `registerScene(${JSON.stringify(item.name)}, Scene${index});`));
  await fs.mkdir(path.dirname(file), {recursive: true});
  await fs.writeFile(file, lines.join('\n') + '\n');
  return file;
}

// Remotion keeps its headless Chrome next to the nearest package.json above the current folder: started from "/"
// (the menu bar app) it failed to create /.remotion, started inside another project it downloaded Chrome there.
// So it is set up once in ciak's own folder, and every render is given its path.
let chromePath;
export async function chrome() {
  if (chromePath) return chromePath;
  const cwd = process.cwd();
  process.chdir(root);
  try { chromePath = (await ensureBrowser()).path; } finally { process.chdir(cwd); }
  return chromePath;
}
// Chrome for Testing, kept in the same place: the ciak browser on a Mac without a Chrome-like browser of its own.
// (It can render too, but drew a 22 s video in 240 s against the headless shell's 42.)
export async function windowedChrome() {
  const cwd = process.cwd();
  process.chdir(root);
  try { return (await ensureBrowser({chromeMode: 'chrome-for-testing'})).path; } finally { process.chdir(cwd); }
}

// A page as a PNG at exactly width × height, drawn by the same headless Chrome (framed screenshots, the menu bar
// app's wallpaper): no window, and no browser of the user's needed. (Its --screenshot flag hung on macOS.)
export async function capturePage(url, width, height) {
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'ciak-page-'));
  const {child} = launch(await chrome(), ['--headless', '--remote-debugging-port=0', `--user-data-dir=${work}`, '--hide-scrollbars', 'about:blank']);
  try {
    let port;
    for (let tries = 0; !port && tries < 100; tries++) {
      await new Promise(resolve => setTimeout(resolve, 100));
      port = (await fs.readFile(path.join(work, 'DevToolsActivePort'), 'utf8').catch(() => '')).split('\n')[0];
    }
    if (!port) throw new Error('The headless Chrome did not start');
    return await (await import('./browser.mjs')).screenshotPage(`http://127.0.0.1:${port}`, url, width, height);
  } finally { child.kill(); await fs.rm(work, {recursive: true, force: true, maxRetries: 5}); }
}

// Measured on an 8 s clip: frames are drawn at ~28/s and more workers don't help (the page itself is the cost:
// 12 s without the recording); veryfast x264 and Chrome's GPU drawing (angle) shave ~10%.
export const renderOptions = {codec: 'h264', crf: 20, x264Preset: 'veryfast', muted: true, concurrency: 4, chromiumOptions: {gl: 'angle'}};
// The panel's button tap ('press' in ui/index.html): a 520→420 Hz triangle and a faint 1250→900 Hz sine, both fading out.
// A key press: a short, bright tap; each one a little louder or softer, like a real keyboard.
const keySound = level => `anoisesrc=d=0.035:c=pink:a=${level.toFixed(2)}:s=48000,highpass=f=1800,lowpass=f=7000,afade=t=out:d=0.035:curve=exp,volume=7dB,aformat=channel_layouts=stereo`;
export const tick = "aevalsrc=exprs='0.56*0.6366*asin(sin(611.9*(1-pow(0.8077,t/0.04))))*exp(-t*184)+0.175*sin(478.2*(1-pow(0.72,t/0.02)))*exp(-t*311)':d=0.06:s=48000,aformat=channel_layouts=stereo";

export function progress() {
  let last = -1;
  return ({progress}) => { const percent = Math.floor(progress * 10) * 10; if (percent !== last) { console.error(`Rendering ${percent}%`); last = percent; } };
}

// The sound: the recording's track, or with the mic or the Mac sound switched off (audio.mic / audio.system),
// the other one saved apart (audio.stems), or none (heard: null). on: the kinds left in.
export function heardTrack(project, directory) {
  const sound = project.audio || {};
  const recorded = ['mic', 'system'].filter(kind => kind in sound), on = recorded.filter(kind => sound[kind] !== false);
  return {on, heard: on.length === recorded.length ? path.resolve(directory, project.source) : on.length ? path.resolve(directory, sound.stems[on[0]]) : null};
}

// What the Demo composition draws from: the project, cursor, captions and camera parts. url(file) is the address
// the page loads a media file from (the render's own server, or the panel's).
export async function projectProps(project, directory, url) {
  const source = path.resolve(directory, project.source);
  const transcriptFile = project.transcript ? path.resolve(directory, project.transcript) : source.replace(/\.[^.]+$/, '.json');
  const transcript = await readJSON(transcriptFile).catch(error => { if (project.transcript) throw error; return {segments: []}; });
  const events = await cursorEvents(project, directory);
  let offset = 0;
  const webcams = (project.webcam?.enabled === false ? [] : project.webcam?.segments || []).map(segment => {
    const item = {start: offset, end: offset + segment.duration, sourceOffset: segment.sourceOffset || 0, url: url(path.resolve(directory, segment.source))};
    offset += segment.duration;
    return item;
  });
  return {project, sourceUrl: url(source), events, clicks: events.filter(event => event.type === 'click'), transcript: transcript.segments || [], webcams};
}

export async function renderProject(file, options = {}) {
  const started = performance.now();
  const {directory, project} = await loadProject(file);
  // The finished video goes to the user's folder; older projects (no id) render next to themselves.
  const output = path.resolve(options.output || (project.id ? path.join(outputDir, `${project.name || 'recording'}-${project.id}.mp4`) : file.replace(/\.project\.json$/, '.edited.mp4')));
  const source = path.resolve(directory, project.source);
  if (output === source || output === path.resolve(file)) throw new Error('Render output must not overwrite the source or project');
  await fs.mkdir(path.dirname(output), {recursive: true});
  const scratch = await fs.mkdtemp(path.join(root, '.build/render-'));
  const files = new Map();
  const {server, origin} = await assetServer(files);
  // Steps with timings for the panel (projects only, and not for a single preview frame).
  const step = stepLog(project.id && options.frame === undefined ? directory : null, 'render');
  // One Chrome for measuring the edit and drawing it (each call starting its own cost a second or two).
  const browser = openBrowser('chrome', {browserExecutable: await chrome(), chromiumOptions: renderOptions.chromiumOptions});
  try {
    await step('Load the renderer', () => serveBundle(files));
    const {inputProps, composition} = await step('Prepare the edit', async update => {
      const inputProps = await projectProps(project, directory, file => { const endpoint = `/${files.size}${path.extname(file)}`; files.set(endpoint, file); return origin + endpoint; });
      const composition = await selectComposition({puppeteerInstance: await browser, serveUrl: origin, id: 'Demo', inputProps});
      update(`${composition.durationInFrames} frames, ${composition.width}×${composition.height}, ${project.zooms.length} zooms, ${project.clips.length} clips`);
      return {inputProps, composition};
    });
    if (options.frame !== undefined) {
      const frame = Number(options.frame);
      if (!Number.isInteger(frame) || frame < 0 || frame >= composition.durationInFrames) throw new Error('Preview frame is outside the composition');
      await renderStill({puppeteerInstance: await browser, serveUrl: origin, composition, inputProps, output, frame, imageFormat: 'png'});
      return {output, frame, elapsedSeconds: (performance.now() - started) / 1000};
    }
    const video = path.join(scratch, 'video.mp4');
    const shown = progress();
    const {heard, on} = heardTrack(project, directory);
    const hasAudio = Boolean(heard) && (await probe(heard)).streams.some(stream => stream.codec_type === 'audio');
    // The mic's background noise is removed before the loudness step lifts it (audio.denoise, on unless the
    // Mac sound is heard: the speech model would remove music too). Made once, kept in the project.
    // It runs while the frames are drawn: one after the other it doubled the render time.
    let voice = heard || source, cleaning = Promise.resolve();
    if (hasAudio && (project.audio?.denoise ?? !on.includes('system'))) {
      voice = path.join(directory, path.basename(heard).replace(/\.[^.]+$/, '.clean.wav'));
      const fresh = await fs.stat(voice).then(clean => clean.mtimeMs > fsSync.statSync(heard).mtimeMs, () => false);
      cleaning = step('Clean the voice: background noise', () => fresh ? 'done before, reused' : cleanVoice(heard, voice).then(() => 'DeepFilterNet'));
      cleaning.catch(() => {});
    }
    await step('Render the frames', async update => renderMedia({puppeteerInstance: await browser, serveUrl: origin, composition, inputProps, outputLocation: video, ...renderOptions,
      onProgress: report => { shown(report); update(`${report.renderedFrames} / ${composition.durationInFrames} frames`); }}).then(() => `${composition.durationInFrames} frames`));
    await cleaning;
    // Lifting a track with nobody talking to speech loudness turns a key press or a bump into a thump: only normalize
    // when at least 2 seconds sound like speech (a cleaned silent mic sits near -75 dB, its bursts last under a second).
    const seconds = hasAudio && project.audio?.normalize ? (await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', voice, '-af', 'asetnsamples=48000,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-', '-f', 'null', '-']))
      .match(/RMS_level=\S+/g)?.map(item => Number(item.split('=')[1])) || [] : [];
    const normalize = project.audio?.normalize && seconds.filter(level => level > -35).length >= 2;
    const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', video, '-i', voice];
    const fps = project.export.fps;
    const duration = composition.durationInFrames / fps;
    const filters = [];
    const labels = [];
    if (!hasAudio) args.push('-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo');
    if (project.intro) {
      filters.push(`anullsrc=r=48000:cl=stereo,atrim=duration=${Math.round(project.intro.duration * fps) / fps}[intro]`); labels.push('[intro]');
    }
    // A part's speed as render/parts.jsx speedOf: its own, the whole video's, or 1. atempo keeps the voice's pitch.
    const speedOf = clip => clip.speed || project.speed || 1;
    project.clips.forEach((clip, index) => {
      const length = Math.max(1, Math.round((clip.end - clip.start) * fps / speedOf(clip))) / fps;
      filters.push(`[${hasAudio ? '1:a:0' : '2:a:0'}]atrim=start=${hasAudio ? clip.start : 0}:duration=${length * speedOf(clip)},asetpts=PTS-STARTPTS${speedOf(clip) !== 1 ? `,atempo=${speedOf(clip)}` : ''},aresample=48000,apad,atrim=duration=${length}[clip${index}]`);
      labels.push(`[clip${index}]`);
    });
    if (project.outro) {
      filters.push(`anullsrc=r=48000:cl=stereo,atrim=duration=${Math.round(project.outro.duration * fps) / fps}[outro]`); labels.push('[outro]');
    }
    filters.push(`${labels.join('')}concat=n=${labels.length}:v=0:a=1${normalize ? ',loudnorm=I=-16:TP=-1.5:LRA=11' : ''}[voice]`);
    // A soft tick on every click (and a tap on every typed key, with audio.keys) that survives the cuts,
    // placed on the output timeline. Keys sped up past 2x stay silent: a buzz, not typing.
    const ticks = [];
    const keys = [];
    const keyEvents = project.audio?.keys ? inputProps.events.filter(event => event.type === 'key') : [];
    let start = project.intro ? Math.round(project.intro.duration * fps) / fps : 0;
    for (const clip of project.clips) {
      const at = event => start + (event.t - clip.start) / speedOf(clip);
      const inside = event => event.visible !== false && event.t >= clip.start && event.t < clip.end;
      if (project.audio?.clicks !== false) ticks.push(...inputProps.clicks.filter(inside).map(at));
      if (speedOf(clip) <= 2) keys.push(...keyEvents.filter(inside).map(at));
      start += Math.max(1, Math.round((clip.end - clip.start) * fps / speedOf(clip))) / fps;
    }
    const sounds = [...ticks.map(time => ({time, source: tick})), ...keys.map((time, index) => ({time, source: keySound(0.8 + 0.2 * Math.sin(index * 2.7))}))];
    if (sounds.length) {
      sounds.forEach(({time, source}, index) => filters.push(`${source},adelay=${Math.round(time * 1000)}:all=1[click${index}]`));
      filters.push(`[voice]${sounds.map((_, index) => `[click${index}]`).join('')}amix=inputs=${sounds.length + 1}:duration=first:normalize=0[audio]`);
    } else filters.push('[voice]anull[audio]');
    const final = path.join(scratch, 'final.mp4');
    args.push('-filter_complex', filters.join(';'), '-map', '0:v:0', '-map', '[audio]', '-c:v', 'copy', '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-b:a', '192k', '-t', String(duration), '-movflags', '+faststart', final);
    await step('Audio: cut to the edit, loudness, click sounds', () => run('ffmpeg', args).then(() => `${ticks.length} click sound${ticks.length === 1 ? '' : 's'}${keys.length ? `, ${keys.length} key sounds` : ''}${normalize ? ', normalized' : project.audio?.normalize ? ', too quiet to normalize (no speech)' : ''}`));
    await step('Check and save', async () => {
      const metadata = await probe(final);
      if (metadata.streams.filter(stream => stream.codec_type === 'audio').length !== 1 || metadata.streams.filter(stream => stream.codec_type === 'video').length !== 1) throw new Error('Export track verification failed');
      if (Math.abs(Number(metadata.format.duration) - duration) > 0.15) throw new Error('Export duration verification failed');
      await fs.copyFile(final, output);
      return `1 video + 1 audio track, ${duration.toFixed(1)} s → ${path.basename(output)}`;
    });
    const result = {output, duration, width: composition.width, height: composition.height, frames: composition.durationInFrames, elapsedSeconds: (performance.now() - started) / 1000};
    // A render to --out is a test: the project's finished video (what the panel shows) stays the same.
    if (!options.output) await writeJSON(file.replace(/\.project\.json$/, '.render.json'), result);
    return result;
  } finally {
    await browser.then(instance => instance.close({silent: true})).catch(() => {});
    server.closeAllConnections(); server.close();
    await fs.rm(scratch, {recursive: true, force: true});
  }
}
