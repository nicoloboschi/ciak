import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import {randomBytes} from 'node:crypto';
import {createInterface} from 'node:readline';
import {readJSON, writeJSON, run, probe, launch, sleep, stepLog} from './common.mjs';
import {editProject, defaultStyle} from './project.mjs';

const configFile = process.argv[2];
const config = await readJSON(configFile);
const directory = path.dirname(configFile);
const stateFile = path.join(directory, 'session.json');
const state = {id: config.id, pid: process.pid, state: 'starting', output: config.output,
  project: config.output.replace(/\.mp4$/, '.project.json'), token: randomBytes(24).toString('hex'), segments: []};
let active;
let busy = false;
let server;
const save = () => writeJSON(stateFile, state);

async function startSegment() {
  const number = state.segments.length;
  const segment = {output: path.join(directory, `part-${number}.mp4`), cursor: path.join(directory, `part-${number}.cursor.jsonl`),
    cameraOutput: path.join(directory, `part-${number}.camera.mov`)};
  const nativeConfig = {...config.capture, ...segment};
  const nativeFile = path.join(directory, `part-${number}.json`);
  await writeJSON(nativeFile, nativeConfig);
  const recording = launch(config.binary, [...(config.binaryArgs || []), nativeFile]);
  active = {...recording, segment};
  let started = false;
  let failure;
  const lines = createInterface({input: recording.child.stdout});
  lines.on('line', line => {
    try {
      const event = JSON.parse(line);
      if (event.event === 'error') failure = event.message;
      if (event.event === 'recording') { segment.startedAt = event.startedAt; started = true; }
      if (event.event === 'capture') segment.capture = event;
      if (event.event === 'camera') segment.cameraStartedAt = event.startedAt;
      if (event.event === 'stems') segment.stems = event.stems;
    } catch {}
  });
  recording.finished.catch(error => { failure = error.message; });
  recording.child.once('exit', () => { segment.endedAt ??= Date.now() / 1000; });
  const deadline = Date.now() + 45000;
  while (!started || !segment.capture) {
    if (failure || recording.child.exitCode !== null) throw new Error(failure || 'Recorder exited before starting');
    if (Date.now() > deadline) { recording.child.kill('SIGTERM'); throw new Error('Capture startup timed out; check macOS permissions'); }
    await sleep(50);
  }
  state.state = 'recording';
  // Seconds from the start command to recording (first part only): to see a slow start afterwards.
  if (!number && config.requested) state.startup = Math.round((Date.now() / 1000 - config.requested) * 100) / 100;
  state.startedAt = segment.startedAt;
  state.capture = segment.capture;
  await save();
}

async function finishSegment() {
  if (!active) return;
  const segment = active.segment;
  const elapsed = (segment.endedAt ?? Date.now() / 1000) - segment.startedAt;
  active.child.kill('SIGTERM');
  // A crashed recorder still leaves a readable file; keep it unless it can't be read.
  const crash = await active.finished.then(() => null, error => error);
  const metadata = await probe(segment.output).catch(error => { throw crash || error; });
  segment.duration = Math.max(elapsed, Number(metadata.format.duration));
  if (!(segment.duration > 0)) throw new Error('Capture produced no video');
  state.segments.push(segment);
  active = null;
  state.elapsed = state.segments.reduce((total, item) => total + item.duration, 0);
  await save();
}

async function mixSegment(segment, index) {
  const metadata = await probe(segment.output);
  const tracks = metadata.streams.filter(stream => stream.codec_type === 'audio');
  const destination = path.join(directory, `mixed-${index}.mp4`);
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', segment.output];
  if (tracks.length === 0) args.push('-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo');
  if (tracks.length > 1) {
    const inputs = tracks.map((_, track) => `[0:a:${track}]`).join('');
    args.push('-filter_complex', `${inputs}amix=inputs=${tracks.length}:duration=longest:normalize=0,alimiter=limit=0.95:latency=1,apad[a]`, '-map', '0:v:0', '-map', '[a]');
  } else args.push('-map', '0:v:0', '-map', tracks.length ? '0:a:0' : '1:a:0', '-af', 'apad');
  // The recorder's video is kept as it is (copied, not encoded again): encoding took about as long as the recording
  // (8.8 s for 10 s of a full screen) and Stop waited for it. It only has frames when the screen changed; the render
  // reads frames by time, so that's fine.
  args.push('-c:v', 'copy', '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-b:a', '192k', '-t', String(segment.duration), '-movflags', '+faststart', destination);
  await run('ffmpeg', args);
  return destination;
}

// The mic or the Mac sound alone, for an edit that leaves the other out: each part's sound placed at its time in the
// part (offset: when its first sound came, measured within ~30 ms) and cut or padded to the part's length.
async function joinStem(kind, destination) {
  const args = ['-hide_banner', '-loglevel', 'error', '-y'], filters = [];
  state.segments.forEach((segment, index) => {
    const stem = segment.stems?.[kind], offset = stem?.offset || 0;
    args.push(...(stem ? ['-i', stem.file] : ['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo']));
    filters.push(`[${index}:a]aformat=sample_rates=48000:channel_layouts=stereo,${offset > 0 ? `adelay=${Math.round(offset * 1000)}:all=1` : `atrim=start=${-offset},asetpts=PTS-STARTPTS`},apad,atrim=duration=${segment.duration}[a${index}]`);
  });
  filters.push(`${state.segments.map((_, index) => `[a${index}]`).join('')}concat=n=${state.segments.length}:v=0:a=1[out]`);
  await run('ffmpeg', [...args, '-filter_complex', filters.join(';'), '-map', '[out]', '-c:a', 'aac', '-b:a', '160k', destination]);
  return path.basename(destination);
}

async function finalize() {
  state.state = 'finalizing';
  await save();
  const step = stepLog(directory, 'record');
  await step('Stop the recorder', async () => { await finishSegment(); return `${state.segments.length} part${state.segments.length === 1 ? '' : 's'}, ${state.elapsed.toFixed(1)} s`; });
  const metadata = await step('Mix the audio into one track', async () => {
    const mixed = [];
    for (const [index, segment] of state.segments.entries()) mixed.push(await mixSegment(segment, index));
    if (!mixed.length) throw new Error('No recorded segments');
    const temporary = path.join(directory, 'final.mp4');
    if (mixed.length === 1) await fs.rename(mixed[0], temporary);
    else {
      const list = path.join(directory, 'concat.txt');
      await fs.writeFile(list, mixed.map(file => `file '${file.replaceAll("'", "'\\''")}'`).join('\n'));
      await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', temporary]);
    }
    const metadata = await probe(temporary);
    if (metadata.streams.filter(stream => stream.codec_type === 'video').length !== 1 || metadata.streams.filter(stream => stream.codec_type === 'audio').length !== 1) throw new Error('Final recording must contain exactly one video and one audio track');
    await fs.rename(temporary, state.output);
    return metadata;
  });
  const base = state.output.slice(0, -4);
  if (config.capture.camera) {
    for (const [index, segment] of state.segments.entries()) {
      const destination = `${base}.camera-${index}.mov`;
      await fs.rename(segment.cameraOutput, destination);
      segment.cameraOutput = destination;
    }
  }
  // Saved apart only when both were recorded: with one, leaving it out is silence.
  const stems = state.segments.some(segment => segment.stems) ? await step('Keep the mic and the Mac sound apart too', async () =>
    ({mic: await joinStem('mic', `${base}.mic.m4a`), system: await joinStem('system', `${base}.system.m4a`)})) : null;
  const events = [];
  await step('Mouse moves and clicks', async () => {
    let offset = 0;
    for (const segment of state.segments) {
      const lines = (await fs.readFile(segment.cursor, 'utf8')).trim().split('\n').filter(Boolean);
      for (const line of lines) {
        const event = JSON.parse(line);
        if (event.t <= segment.duration) events.push(JSON.stringify({...event, t: event.t + offset}));
      }
      offset += segment.duration;
    }
    await fs.writeFile(`${base}.cursor.jsonl`, events.join('\n') + '\n');
    return `${events.filter(line => line.includes('"click"')).length} clicks`;
  });
  const video = metadata.streams.find(stream => stream.codec_type === 'video');
  const duration = Number(metadata.format.duration);
  const project = {
    version: 1, id: config.id, name: config.name, created: Date.now(), source: path.basename(state.output), duration, width: video.width, height: video.height, fps: config.capture.fps,
    cursor: config.capture.terminal ? null : path.basename(`${base}.cursor.jsonl`), cursorBaked: config.capture.cursorVisible,
    markers: state.markers || [], clips: [{start: 0, end: duration}], zooms: [],
    style: defaultStyle(),
    captions: {enabled: true}, audio: {normalize: true, clicks: true,
      ...(config.capture.microphone && {mic: true}), ...(config.capture.systemAudio && {system: true}), ...(stems && {stems})}, export: {width: 1920, height: 1080, fps: config.capture.fps},
    webcam: config.capture.camera ? {enabled: true, segments: state.segments.map(segment => ({source: path.relative(path.dirname(state.output), segment.cameraOutput), duration: segment.duration, sourceOffset: Math.max(0, segment.startedAt - (segment.cameraStartedAt || segment.startedAt))})), size: 0.22, position: 'bottom-right'} : null,
  };
  await writeJSON(state.project, project);
  // Recordings come out ready to use: idle time cut (browser) and zooms on the actions.
  // The edit only changes clips/zooms in the project; the recording itself is untouched.
  state.edits = config.capture.browser && !config.capture.scripted ? ['--cut-idle', '--auto-zoom'] : ['--auto-zoom'];
  await step('Auto edit: zooms on clicks' + (state.edits.includes('--cut-idle') ? ', idle time cut' : ''), async () => {
    const edited = await editProject(state.project, state.edits).catch(error => { state.editError = error.message; return null; });
    return edited ? `${edited.zooms} zoom${edited.zooms === 1 ? '' : 's'}, ${edited.clips} clip${edited.clips === 1 ? '' : 's'} kept` : `skipped: ${state.editError}`;
  });
  state.state = 'saved';
  state.duration = duration;
  delete state.startedAt;
  await save();
  for (const name of await fs.readdir(directory)) {
    if (/^(part-\d+\.(mp4|json|cursor\.jsonl|mic\.m4a|system\.m4a)|mixed-\d+\.mp4|concat\.txt)$/.test(name)) await fs.unlink(path.join(directory, name)).catch(() => {});
  }
}

async function action(name, body) {
  if (name === 'status') return {...state, token: undefined};
  if (busy) throw new Error('A recording operation is already in progress');
  busy = true;
  try {
    if (name === 'pause') {
      if (state.state !== 'recording') throw new Error('Recording is not running');
      await finishSegment(); state.state = 'paused'; await save();
    } else if (name === 'resume') {
      if (state.state !== 'paused') throw new Error('Recording is not paused');
      delete state.warning;
      await startSegment();
    } else if (name === 'mark') {
      if (state.state !== 'recording') throw new Error('Recording is not running');
      if (typeof body.label !== 'string' || !body.label.trim()) throw new Error('Marker label is required');
      const marker = {t: (state.elapsed || 0) + Date.now() / 1000 - state.startedAt, label: body.label};
      if (body.page) {
        // Point inside a browser page: the page fills the bottom of the captured window, below the toolbar.
        const [x, y, pageWidth, pageHeight] = body.page;
        const [, , width, height] = state.capture.bounds;
        [body.x, body.y] = [((width - pageWidth) / 2 + x) / width, (height - pageHeight + y) / height];
      }
      if (body.x !== undefined || body.y !== undefined) {
        if (![body.x, body.y].every(value => Number.isFinite(value) && value >= 0 && value <= 1)) throw new Error('Marker coordinates must be between 0 and 1');
        Object.assign(marker, {x: body.x, y: body.y});
      }
      (state.markers ||= []).push(marker); await save();
    } else if (name === 'stop') {
      await finalize();
      setTimeout(() => server.close(() => process.exit(0)), 100);
    } else throw new Error('Unknown operation');
    return {...state, token: undefined};
  } finally { busy = false; }
}

try {
  server = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.method !== 'POST' || req.headers.authorization !== `Bearer ${state.token}`) { res.writeHead(403); res.end('{}'); return; }
    try {
      let data = '';
      for await (const chunk of req) { data += chunk; if (data.length > 16384) throw new Error('Request too large'); }
      const result = await action(req.url.slice(1), JSON.parse(data || '{}'));
      res.end(JSON.stringify(result));
    } catch (error) { res.writeHead(400); res.end(JSON.stringify({error: error.message})); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  state.port = server.address().port;
  await save();
  await startSegment();
  const shutdown = () => action('stop', {}).catch(async error => { state.state = 'error'; state.error = error.message; await save(); process.exit(1); });
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  setInterval(async () => {
    if (!busy && state.state === 'recording' && active?.segment.endedAt) {
      busy = true;
      try {
        await finishSegment();
        state.state = 'paused';
        state.warning = 'Recorder stopped unexpectedly; recording so far is kept. Resume or stop.';
        await save();
      } catch (error) { state.state = 'error'; state.error = error.message; await save(); }
      finally { busy = false; }
    }
  }, 1000).unref();
} catch (error) {
  active?.child.kill('SIGTERM');
  state.state = 'error'; state.error = error.message; await save();
  server?.close(); process.exitCode = 1;
}
