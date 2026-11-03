// Screenshots that look good: pick a region or window (macOS's own picker), then the shot is
// placed on a wallpaper with rounded corners and a shadow, saved, and copied to the clipboard.
// The frame is drawn by the ciak browser (off-screen), so it uses the same backgrounds as the videos.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {outputDir, run, probe} from './common.mjs';
import {backgrounds} from './project.mjs';
import {capturePage} from './render.mjs';

export const shotsDir = path.join(outputDir, 'shots');
const copy = file => run('osascript', ['-e', `set the clipboard to (read (POSIX file "${file}") as «class PNGf»)`]);
// A shot by file name (or path) inside shots/, nothing outside it.
async function findShot(name) {
  const file = path.join(shotsDir, path.basename(String(name || '')));
  if (!/\.png$/i.test(file) || !await fs.access(file).then(() => true, () => false)) throw new Error(`No screenshot ${name} in ${shotsDir}`);
  return file;
}

// The faint light edge around a framed shot: on unless turned off (ciak shot outline off). ⌘1 reads it too.
const outlineOn = () => run('defaults', ['read', 'com.ciak.app', 'outline']).then(value => value.trim() !== 'off', () => true);

// The default wallpaper behind new shots (ciak shot background <name|auto>), aurora unless set.
const savedBackground = () => run('defaults', ['read', 'com.ciak.app', 'background']).then(value => value.trim() || 'aurora', () => 'aurora');
// ⌘1 can't draw CSS: every wallpaper is drawn once as a PNG in ~/.ciak/wallpapers (redrawn when its CSS changes),
// with its average color in wallpapers.json for auto. The picker stretches the chosen one behind each shot.
export const wallpapersDir = path.join(os.homedir(), '.ciak/wallpapers');
export async function drawWallpapers() {
  const index = path.join(wallpapersDir, 'wallpapers.json');
  const saved = JSON.parse(await fs.readFile(index, 'utf8').catch(() => '{"css":{},"tones":{}}'));
  await fs.mkdir(wallpapersDir, {recursive: true});
  for (const [name, css] of Object.entries(backgrounds)) {
    const file = path.join(wallpapersDir, `${name}.png`);
    if (saved.css[name] === css && await fs.access(file).then(() => true, () => false)) continue;
    await fs.writeFile(file, await capturePage(`data:text/html,${encodeURIComponent(`<body style="margin:0;height:100vh;background:${css}">`)}`, 2880, 1800));
    [saved.css[name], saved.tones[name]] = [css, await averageColor(file)];
  }
  await fs.writeFile(index, JSON.stringify(saved));
  return saved.tones;
}
// The image's average color, [r, g, b] 0–255: ffmpeg shrinks it to one pixel.
async function averageColor(file) {
  const pixel = path.join(os.tmpdir(), `ciak-pixel-${process.pid}-${Date.now()}.raw`);
  await run('ffmpeg', ['-v', 'error', '-y', '-i', file, '-vf', 'scale=1:1:flags=area', '-f', 'rawvideo', '-pix_fmt', 'rgb24', pixel]);
  const bytes = await fs.readFile(pixel);
  await fs.rm(pixel);
  return [...bytes.subarray(0, 3)];
}
// auto: the wallpaper that stands out most from the shot: light/dark contrast first, then how different the color is.
// picker.swift (⌘1) has the same rule: change both.
export function contrasting(shot, tones) {
  const luminance = rgb => rgb.map(value => { value /= 255; return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4; })
    .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
  const score = tone => {
    const [first, second] = [luminance(shot), luminance(tone)].sort((a, b) => b - a);
    return (first + 0.05) / (second + 0.05) + Math.hypot(...tone.map((value, index) => value - shot[index])) / 255;
  };
  return Object.entries(tones).sort((a, b) => score(b[1]) - score(a[1]))[0][0];
}

// ciak shot [--from image] [--background aurora|<css>] [--plain] [--no-outline] [--out file] [--no-copy] | list | copy <file> | remove <file> | outline [on|off] | background [auto|name] | edit <file> [--background b] [--outline on|off]
export async function shotCommand(args) {
  if (args[0] === 'background') {
    if (args[1] && args[1] !== 'auto' && !backgrounds[args[1]]) throw new Error(`Usage: ciak shot background [auto|${Object.keys(backgrounds).join('|')}]`);
    if (args[1]) await run('defaults', ['write', 'com.ciak.app', 'background', '-string', args[1]]);
    return {background: await savedBackground(), choices: backgrounds};
  }
  if (args[0] === 'outline') {
    if (args[1] && !['on', 'off'].includes(args[1])) throw new Error('Usage: ciak shot outline [on|off]');
    if (args[1]) await run('defaults', ['write', 'com.ciak.app', 'outline', '-string', args[1]]);
    return {outline: await outlineOn()};
  }
  if (args[0] === 'list') {
    const names = (await fs.readdir(shotsDir).catch(() => [])).filter(name => /\.png$/i.test(name));
    const shots = await Promise.all(names.map(async name => ({name, file: path.join(shotsDir, name), created: (await fs.stat(path.join(shotsDir, name))).mtimeMs})));
    return shots.sort((first, second) => second.created - first.created);
  }
  if (args[0] === 'edit') {
    const file = await findShot(args[1]), raw = path.join(rawDir, path.basename(file));
    const option = flag => { const index = args.indexOf(flag); return index < 0 ? undefined : args[index + 1]; };
    if (option('--outline') && !['on', 'off'].includes(option('--outline'))) throw new Error('Usage: ciak shot edit <file> [--background auto|<name>|<css>] [--outline on|off]');
    const saved = JSON.parse(await fs.readFile(sidecar(file), 'utf8').catch(() => '{}'));
    // Older shots don't say how they were framed: then it's unknown until edited.
    if (!option('--background') && !option('--outline')) return {output: file, background: saved.background ?? null, outline: saved.outline ?? await outlineOn()};
    const work = await fs.mkdtemp(path.join(os.tmpdir(), 'ciak-shot-'));
    try {
      if (!await fs.access(raw).then(() => true, () => false)) await unframe(file, raw);
      const outline = option('--outline') ? option('--outline') === 'on' : saved.outline ?? await outlineOn();
      return {output: file, ...await place(raw, file, option('--background') || saved.background || await savedBackground(), outline, work)};
    } finally { await fs.rm(work, {recursive: true, force: true}); }
  }
  if (args[0] === 'copy') { const file = await findShot(args[1]); await copy(file); return {copied: file}; }
  if (args[0] === 'remove') {
    const file = await findShot(args[1]);
    const extra = [path.join(rawDir, path.basename(file)), sidecar(file)];
    await run('trash', [file, ...(await Promise.all(extra.map(name => fs.access(name).then(() => name, () => null)))).filter(Boolean)]);
    return {trashed: file};
  }
  const option = flag => { const index = args.indexOf(flag); return index < 0 ? undefined : args[index + 1]; };
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'ciak-shot-'));
  try {
    let raw = option('--from') && path.resolve(option('--from'));
    if (!raw) {
      raw = path.join(work, 'raw.png');
      // -i: drag a region, or space for a window; -o: no window shadow (we draw our own).
      await run('screencapture', ['-i', '-o', '-x', raw]).catch(() => {});
      if (!await fs.access(raw).then(() => true, () => false)) return {cancelled: true};
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const out = path.resolve(option('--out') || path.join(shotsDir, `shot-${stamp}.png`));
    await fs.mkdir(path.dirname(out), {recursive: true});
    if (args.includes('--plain')) await fs.copyFile(raw, out);
    else {
      await place(raw, out, option('--background') || await savedBackground(), !args.includes('--no-outline') && await outlineOn(), work);
    }
    if (!args.includes('--no-copy')) await copy(out);
    return {output: out, copied: !args.includes('--no-copy')};
  } finally { await fs.rm(work, {recursive: true, force: true}); }
}

// Each shot in shots/ keeps its unframed copy and how it was framed (.raw/<name>.png and .json, ⌘1 too), so
// ciak shot edit can change the background or outline afterwards.
const rawDir = path.join(shotsDir, '.raw');
const sidecar = file => path.join(rawDir, path.basename(file).replace(/\.png$/i, '.json'));
async function place(raw, out, background, outline, work) {
  if (background === 'auto') background = contrasting(await averageColor(raw), await drawWallpapers());
  await frame(raw, out, backgrounds[background] || background, work, outline);
  if (path.dirname(out) !== shotsDir) return {background, outline};
  await fs.mkdir(rawDir, {recursive: true});
  const copy = path.join(rawDir, path.basename(out));
  if (raw !== copy) await fs.copyFile(raw, copy);
  await fs.writeFile(sidecar(out), JSON.stringify({background, outline}));
  return {background, outline};
}
// Shots from before .raw: the shot is cut back out of its frame. The padding is 7% of the shot's longest side,
// so the framed size gives the shot's size; the old corners vanish under the new rounded ones.
async function unframe(file, raw) {
  const {width, height} = (await probe(file)).streams[0];
  for (let side = Math.floor(Math.max(width, height) / 1.14) - 3, last = side + 6; side <= last; side++) {
    const padding = Math.round(side * 0.07), [inner, innerHeight] = [width - 2 * padding, height - 2 * padding];
    if (Math.max(inner, innerHeight) !== side) continue;
    await fs.mkdir(rawDir, {recursive: true});
    await run('ffmpeg', ['-v', 'error', '-y', '-i', file, '-vf', `crop=${inner}:${innerHeight}:${padding}:${padding}`, raw]);
    return;
  }
  throw new Error(`Can't find the shot inside ${path.basename(file)}: was it framed by ciak?`);
}

async function frame(raw, out, background, work, outline) {
  const video = (await probe(raw)).streams[0];
  const [width, height] = [video.width, video.height];
  // Sizes scale with the shot, so a small region and a full Retina screen look alike.
  const padding = Math.round(Math.max(width, height) * 0.07);
  const radius = Math.max(10, Math.round(Math.min(width, height) * 0.018));
  const shadow = Math.round(padding * 0.5);
  await fs.copyFile(raw, path.join(work, 'shot.png'));
  await fs.writeFile(path.join(work, 'frame.html'), `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;width:${width + 2 * padding}px;height:${height + 2 * padding}px;overflow:hidden}
body{background:${background};display:flex;align-items:center;justify-content:center}
img{display:block;width:${width}px;height:${height}px;border-radius:${radius}px;box-shadow:0 ${Math.round(shadow * 0.4)}px ${shadow}px #0009${outline ? ',0 0 0 1px #ffffff1f' : ''}}
</style></head><body><img src="shot.png"></body></html>`);
  await fs.writeFile(out, await capturePage(`file://${path.join(work, 'frame.html')}`, width + 2 * padding, height + 2 * padding));
}
