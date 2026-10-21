import fs from 'node:fs/promises';
import path from 'node:path';
import {probe, readJSON, writeJSON, run, execute} from './common.mjs';

const finite = (value, minimum, maximum) => typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum;
export const presets = {landscape: [1920, 1080], vertical: [1080, 1920], square: [1080, 1080]};

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
  for (const title of ['intro', 'outro']) {
    if (project[title] && (typeof project[title].text !== 'string' || !finite(project[title].duration, 0.1, 60))) throw new Error(`Invalid ${title}`);
  }
  return project;
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
  const project = {
    version: 1, source: path.relative(path.dirname(destination), source), duration, width: video.width, height: video.height, fps: 30,
    clips: [{start: 0, end: duration}], zooms: [], markers: [],
    cursor: await exists(`${base}.cursor.jsonl`) ? path.relative(path.dirname(destination), `${base}.cursor.jsonl`) : null,
    cursorBaked: true, transcript: await exists(`${base}.json`) ? path.relative(path.dirname(destination), `${base}.json`) : null,
    style: {background: '#141829', padding: 64, radius: 20, shadow: true, cursorSize: 32, clickColor: '#8b9dff'},
    audio: {normalize: true}, captions: {enabled: true}, export: {width: 1920, height: 1080, fps: 30}, webcam: null,
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
      for (const event of events) {
        const start = Math.max(0, event.t - 0.35);
        const last = zooms.at(-1);
        if (last && start - last.start < 0.6) continue;
        // Close actions chain: the zoom stays in and pans to the next point.
        if (last && start < last.end + 0.3) last.end = start;
        zooms.push({start, end: Math.min(project.duration, event.t + 2), x: event.x, y: event.y, scale: 1.7});
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
      // Short idle cuts read as glitches; only remove a second or more.
      const shortest = option === '--cut-idle' ? 1.6 : 0.6;
      for (const [start, end] of gaps) if (end - start > shortest) project.clips = removeInterval(project.clips, start + 0.3, end - 0.3);
    } else if (option === '--preset') {
      const preset = presets[args[++index]];
      if (!preset) throw new Error('Preset must be landscape, vertical or square');
      [project.export.width, project.export.height] = preset;
    } else if (option === '--transcript') project.transcript = path.relative(directory, path.resolve(args[++index]));
    else if (option === '--cut') {
      const [start, end] = (args[++index] || '').split(',').map(Number);
      if (!finite(start, 0, project.duration) || !finite(end, start + 0.001, project.duration)) throw new Error('Cut must be start,end in source seconds');
      project.clips = removeInterval(project.clips, start, end);
    } else throw new Error(`Unknown edit option: ${option}`);
  }
  validate(project);
  await writeJSON(path.resolve(file), project);
  return {project: path.resolve(file), clips: project.clips.length, zooms: project.zooms.length};
}
