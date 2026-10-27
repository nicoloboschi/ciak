import fs from 'node:fs/promises';
import path from 'node:path';
import {probe, readJSON, writeJSON, run, execute, projectsDir} from './common.mjs';

const finite = (value, minimum, maximum) => typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum;
export const presets = {landscape: [1920, 1080], vertical: [1080, 1920], square: [1080, 1080]};
// Wallpapers behind the recording (any CSS background works too: edit --background '<css>').
export const backgrounds = {
  aurora: 'radial-gradient(60% 80% at 15% 20%, #6d4aff 0%, transparent 60%), radial-gradient(55% 70% at 85% 85%, #13c2b4 0%, transparent 60%), radial-gradient(50% 60% at 80% 10%, #ff5fa2 0%, transparent 55%), #0f1226',
  sunset: 'radial-gradient(70% 90% at 10% 100%, #ff7a3d 0%, transparent 60%), radial-gradient(60% 80% at 90% 0%, #a43dff 0%, transparent 60%), linear-gradient(135deg, #ff4f7b, #4b1d8f)',
  ocean: 'radial-gradient(60% 80% at 20% 0%, #3ac7ff 0%, transparent 60%), radial-gradient(60% 80% at 100% 100%, #2b4cff 0%, transparent 60%), linear-gradient(160deg, #0a2a5c, #06142e)',
  meadow: 'radial-gradient(60% 80% at 0% 0%, #b6f36a 0%, transparent 60%), radial-gradient(60% 80% at 100% 100%, #1fa37a 0%, transparent 60%), linear-gradient(135deg, #2f8f5b, #0f3d3a)',
  graphite: 'radial-gradient(80% 80% at 50% 0%, #3a3f4b 0%, transparent 70%), linear-gradient(180deg, #1c1f26, #0d0f13)',
  midnight: '#141829',
};
// 1080p; a screen wider than 16:9 (an ultrawide) keeps its shape: squeezed into 16:9 its text was too small to read.
export const exportSize = (width, height) => width / height > 16 / 9 ? {width: Math.min(7680, Math.round(1080 * width / height / 2) * 2), height: 1080} : {width: 1920, height: 1080};
export const defaultStyle = () => ({background: backgrounds.aurora, padding: 64, radius: 20, shadow: true, cursorSize: 32, clickColor: '#8b9dff'});

export function validate(project) {
  if (project.version !== 1 || typeof project.source !== 'string') throw new Error('Expected a version 1 project with a source video');
  if (!finite(project.duration, 0.01, 86400)) throw new Error('Project duration must be 0.01–86400 seconds');
  if (![project.width, project.height].every(value => Number.isInteger(value) && value >= 2 && value <= 16384)) throw new Error('Invalid source dimensions');
  if (!Array.isArray(project.clips) || !project.clips.length) throw new Error('At least one clip is required');
  for (const clip of project.clips) {
    if (!finite(clip.start, 0, project.duration) || !finite(clip.end, clip.start + 0.001, project.duration + 0.05)) throw new Error('Clip times must be within the source duration and end after start');
  }
  for (const zoom of project.zooms || []) {
    if (!finite(zoom.start, 0, project.duration) || !finite(zoom.end, zoom.start + 0.01, project.duration + 0.05) || !finite(zoom.x, 0, 1) || !finite(zoom.y, 0, 1) || !finite(zoom.scale, 1, 5)) throw new Error('Invalid zoom: use source times, normalized x/y and scale 1–5');
  }
  const output = project.export;
  if (!output || ![24, 30, 60].includes(output.fps) || ![output.width, output.height].every(value => Number.isInteger(value) && value >= 240 && value <= 7680 && value % 2 === 0)) throw new Error('Export requires even dimensions (240–7680) and fps 24, 30 or 60');
  const style = project.style;
  if (!style || !finite(style.padding, 0, Math.min(output.width, output.height) / 3) || !finite(style.radius, 0, 200) || !finite(style.cursorSize, 0, 200)) throw new Error('Invalid project style');
  const sound = project.audio || {};
  if ('mic' in sound && 'system' in sound && sound.mic !== sound.system && !sound.stems) throw new Error('This recording has the mic and the Mac sound in one track: they can only be on or off together');
  for (const title of ['intro', 'outro']) {
    if (project[title] && (typeof project[title].text !== 'string' || !finite(project[title].duration, 0.1, 60))) throw new Error(`Invalid ${title}`);
  }
  return project;
}

// A project by id (what stop prints), by path (project JSON or recording mp4), or by --name (newest wins).
export async function findProject(ref, directory = process.cwd()) {
  const exists = file => fs.access(file).then(() => true, () => false);
  const stored = path.join(projectsDir, String(ref), 'recording.project.json');
  if (/^[\w-]+$/.test(ref) && await exists(stored)) return stored;
  const absolute = path.resolve(directory, ref);
  const candidate = absolute.endsWith('.json') ? absolute : absolute.replace(/(\.edited)?\.mp4$/, '.project.json');
  if (await exists(candidate)) return candidate;
  // Older recordings sat side by side as <name>-<id>.project.json.
  const folder = path.dirname(absolute);
  const named = (await fs.readdir(folder).catch(() => [])).filter(name => name.startsWith(`${path.basename(ref)}-`) && name.endsWith('.project.json')).sort();
  if (named.length) return path.join(folder, named.at(-1));
  const found = [];
  for (const id of await fs.readdir(projectsDir).catch(() => [])) {
    const project = await readJSON(path.join(projectsDir, id, 'recording.project.json')).catch(() => null);
    if (project?.name === ref) found.push([project.created || 0, path.join(projectsDir, id, 'recording.project.json')]);
  }
  if (!found.length) throw new Error(`Recording not found: ${ref} (use the project id, the --name you recorded with, or a .project.json path)`);
  return found.sort((first, second) => first[0] - second[0]).at(-1)[1];
}

// A stored project's folder, refusing one that is still recording (its worker writes there).
export async function storedProject(id) {
  const folder = path.join(projectsDir, String(id));
  if (!/^[\w-]+$/.test(id) || !await fs.access(folder).then(() => true, () => false)) throw new Error(`No project ${id}`);
  const session = await readJSON(path.join(folder, 'session.json')).catch(() => null);
  if (['starting', 'recording', 'paused', 'finalizing'].includes(session?.state)) throw new Error(`Project ${id} is still recording: stop it first`);
  return folder;
}

// Renames the project and its finished video (<name>-<id>.mp4), so both keep matching.
export async function renameProject(id, name) {
  name = String(name || '').trim();
  if (!name || name.length > 80 || /[/\\:]/.test(name)) throw new Error('Give a name of up to 80 characters, without / \\ or :');
  const folder = await storedProject(id);
  for (const file of ['recording.project.json', 'config.json']) {
    const data = await readJSON(path.join(folder, file)).catch(() => null);
    if (data) await writeJSON(path.join(folder, file), {...data, name});
  }
  const report = await readJSON(path.join(folder, 'recording.render.json')).catch(() => null);
  if (report && path.basename(report.output).endsWith(`-${id}.mp4`) && await fs.access(report.output).then(() => true, () => false)) {
    const output = path.join(path.dirname(report.output), `${name}-${id}.mp4`);
    await fs.rename(report.output, output);
    await writeJSON(path.join(folder, 'recording.render.json'), {...report, output});
  }
  return {id, name};
}

// Moves the project folder and its finished video to the Trash (recoverable), never a hard delete.
export async function removeProject(id) {
  const folder = await storedProject(id);
  const report = await readJSON(path.join(folder, 'recording.render.json')).catch(() => null);
  const files = [folder];
  if (report && await fs.access(report.output).then(() => true, () => false)) files.push(report.output);
  await run('trash', files);
  return {removed: id, trashed: files};
}

export async function loadProject(file) {
  const absolute = path.resolve(file);
  return {file: absolute, directory: path.dirname(absolute), project: validate(await readJSON(absolute))};
}

export async function createProject(source, destination) {
  source = path.resolve(source);
  const metadata = await probe(source);
  const video = metadata.streams.find(stream => stream.codec_type === 'video');
  if (!video) throw new Error('Source has no video');
  destination = path.resolve(destination || source.replace(/\.[^.]+$/, '.project.json'));
  const base = source.replace(/\.[^.]+$/, '');
  const exists = async file => fs.access(file).then(() => true, () => false);
  const duration = Number(metadata.format.duration);
  const [numerator, denominator] = video.r_frame_rate.split('/').map(Number);
  const fps = [24, 30, 60].find(value => Math.abs(value - numerator / denominator) < 1) || 30;
  const project = {
    version: 1, source: path.relative(path.dirname(destination), source), duration, width: video.width, height: video.height, fps,
    clips: [{start: 0, end: duration}], zooms: [], markers: [],
    cursor: await exists(`${base}.cursor.jsonl`) ? path.relative(path.dirname(destination), `${base}.cursor.jsonl`) : null,
    cursorBaked: true, transcript: await exists(`${base}.json`) ? path.relative(path.dirname(destination), `${base}.json`) : null,
    style: defaultStyle(),
    audio: {normalize: true, clicks: true}, captions: {enabled: true}, export: {...exportSize(video.width, video.height), fps}, webcam: null,
  };
  await fs.access(destination).then(() => { throw new Error(`Project already exists: ${destination}`); }, () => {});
  await writeJSON(destination, validate(project));
  return {project: destination};
}

export function removeInterval(clips, start, end) {
  return clips.flatMap(clip => {
    if (end <= clip.start || start >= clip.end) return [clip];
    return [{start: clip.start, end: Math.min(start, clip.end)}, {start: Math.max(end, clip.start), end: clip.end}].filter(item => item.end - item.start >= 0.04);
  });
}

// Intervals ffmpeg reports as <kind>_start/<kind>_end (silencedetect, freezedetect).
async function detect(source, filter, kind, duration) {
  const {stderr} = await execute('ffmpeg', ['-hide_banner', '-i', source, ...filter, '-f', 'null', '-'], {maxBuffer: 16 * 1024 * 1024});
  const intervals = [];
  for (const [, edge, time] of stderr.matchAll(new RegExp(`${kind}_(start|end): ([\\d.]+)`, 'g'))) {
    if (edge === 'start') intervals.push([Number(time), duration]); else if (intervals.length) intervals.at(-1)[1] = Number(time);
  }
  return intervals;
}

export function intersect(first, second) {
  return first.flatMap(([a, b]) => second.map(([c, d]) => [Math.max(a, c), Math.min(b, d)])).filter(([start, end]) => end > start);
}

export async function cursorEvents(project, directory) {
  if (!project.cursor) return [];
  return (await fs.readFile(path.resolve(directory, project.cursor), 'utf8')).split('\n').filter(Boolean).map(JSON.parse).filter(event => finite(event.t, 0, project.duration + 1) && Number.isFinite(event.x) && Number.isFinite(event.y)).sort((first, second) => first.t - second.t);
}

export async function editProject(file, args) {
  const {directory, project} = await loadProject(file);
  for (let index = 0; index < args.length; index++) {
    const option = args[index];
    if (option === '--auto-zoom') {
      const events = [...(await cursorEvents(project, directory)).filter(event => event.type === 'click' && event.visible !== false), ...(project.markers || []).filter(marker => Number.isFinite(marker.x))].sort((first, second) => first.t - second.t);
      const zooms = [];
      // A gentle zoom (≤ 1.3x, a recorded pixel ≤ 1.5 video pixels): 1.7x felt like being shoved into the screen.
      const [width, height] = [project.export.width, project.export.height].map(side => side - 2 * project.style.padding);
      const scale = Math.min(1.3, 1.5 / Math.min(2, width / project.width, height / project.height));
      if (scale >= 1.15) for (const event of events) {
        const start = Math.max(0, event.t - 0.35);
        const last = zooms.at(-1);
        if (last && start - last.start < 0.6) continue;
        // Actions under ~2.5 s apart chain: the zoom stays in and pans (no in-out-in jumps); further apart it lets go,
        // so a recording with regular clicks isn't zoomed in from start to end.
        if (last && start < last.end + 0.6) last.end = start;
        zooms.push({start, end: Math.min(project.duration, event.t + 1.6), x: event.x, y: event.y, scale});
      }
      project.zooms = zooms;
    } else if (option === '--cut-silence' || option === '--cut-idle') {
      const source = path.resolve(directory, project.source);
      let gaps = await detect(source, ['-vn', '-af', 'silencedetect=noise=-40dB:d=0.6'], 'silence', project.duration);
      // Idle = the picture is still and nobody talks: agent think-time, waiting for pages.
      if (option === '--cut-idle') {
        gaps = intersect(gaps, await detect(source, ['-an', '-vf', 'scale=640:-2,freezedetect=n=0.001:d=1'], 'freeze', project.duration));
        // Small changes (typing, the cursor drawn later) don't register as motion: keep time around any activity.
        const activity = [...await cursorEvents(project, directory), ...(project.markers || [])].map(event => event.t);
        gaps = gaps.flatMap(([start, end]) => activity.reduce((pieces, t) => removeInterval(pieces, t - 0.6, t + 1), [{start, end}]).map(piece => [piece.start, piece.end]));
      }
      // Idle cuts keep 1.2 s after the picture settles (the viewer must see the result of an
      // action) and only remove a second or more (shorter cuts read as glitches).
      const [after, before, least] = option === '--cut-idle' ? [1.2, 0.4, 1] : [0.3, 0.3, 0];
      for (const [start, end] of gaps) if (end - start - after - before > least) project.clips = removeInterval(project.clips, start + after, end - before);
    } else if (option === '--reset') {
      project.clips = [{start: 0, end: project.duration}];
      project.zooms = [];
    } else if (option === '--preset') {
      const preset = presets[args[++index]];
      if (!preset) throw new Error('Preset must be landscape, vertical or square');
      [project.export.width, project.export.height] = preset;
    } else if (option === '--background') {
      const value = args[++index];
      if (!value) throw new Error(`Background must be one of ${Object.keys(backgrounds).join(', ')} or a CSS background`);
      project.style.background = backgrounds[value] || value;
    } else if (option === '--transcript') project.transcript = path.relative(directory, path.resolve(args[++index]));
    else if (option === '--cut') {
      const [start, end] = (args[++index] || '').split(',').map(Number);
      if (!finite(start, 0, project.duration) || !finite(end, start + 0.001, project.duration)) throw new Error('Cut must be start,end in source seconds');
      project.clips = removeInterval(project.clips, start, end);
    } else if (['--mic', '--system-audio', '--webcam'].includes(option)) {
      // What the recording had can be left out of the video and put back: on | off.
      const value = args[++index];
      if (!['on', 'off'].includes(value)) throw new Error(`${option} takes on or off`);
      const kind = {'--mic': 'mic', '--system-audio': 'system'}[option];
      if (kind ? !(kind in (project.audio || {})) : !project.webcam) throw new Error(`This recording has no ${{mic: 'microphone', system: 'Mac sound'}[kind] || 'webcam'}`);
      if (kind) project.audio[kind] = value === 'on'; else project.webcam.enabled = value === 'on';
    } else if (option === '--clicks' || option === '--zooms') {
      const value = args[++index];
      if (!['on', 'off'].includes(value)) throw new Error(`${option} takes on or off`);
      if (option === '--clicks') project.audio = {...project.audio, clicks: value === 'on'};
      else if (value === 'off') project.zooms = [];
      else args.splice(index + 1, 0, '--auto-zoom');  // on = the automatic zooms again
    } else throw new Error(`Unknown edit option: ${option}`);
  }
  validate(project);
  await writeJSON(path.resolve(file), project);
  return {project: path.resolve(file), clips: project.clips.length, zooms: project.zooms.length};
}
