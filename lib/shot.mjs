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

// The default wallpaper behind new shots and recordings (ciak shot background <name|auto|none>), aurora unless set;
// none: the bare shot, square corners. And the padding around it (ciak shot padding small|medium|large).
const setting = (name, fallback) => run('defaults', ['read', 'com.ciak.app', name]).then(value => value.trim() || fallback, () => fallback);
export const savedBackground = () => setting('background', 'aurora');
export const savedPadding = () => setting('padding', 'medium');
// A shot's padding: a share of its longest side, so a small region and a full Retina screen look alike. Same in picker.swift.
const paddings = {small: 0.035, medium: 0.07, large: 0.12};
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
// The image's (or a video's first frame's) average color, [r, g, b] 0–255: ffmpeg shrinks it to one pixel.
async function averageColor(file) {
  const pixel = path.join(os.tmpdir(), `ciak-pixel-${process.pid}-${Date.now()}.raw`);
  await run('ffmpeg', ['-v', 'error', '-y', '-i', file, '-frames:v', '1', '-vf', 'scale=1:1:flags=area', '-f', 'rawvideo', '-pix_fmt', 'rgb24', pixel]);
  const bytes = await fs.readFile(pixel);
  await fs.rm(pixel);
  return [...bytes.subarray(0, 3)];
}
// auto: the wallpaper that stands out most from the shot: light/dark contrast first, then how different the color is.
// picker.swift (⌘1) has the same rule: change both.
const luminance = rgb => rgb.map(value => { value /= 255; return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4; })
  .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
export function contrasting(shot, tones) {
  const score = tone => {
    const [first, second] = [luminance(shot), luminance(tone)].sort((a, b) => b - a);
    return (first + 0.05) / (second + 0.05) + Math.hypot(...tone.map((value, index) => value - shot[index])) / 255;
  };
  return Object.entries(tones).sort((a, b) => score(b[1]) - score(a[1]))[0][0];
}
// A background name (auto: the one that stands out from the image or video) as a wallpaper name, or the CSS given.
export const chooseBackground = async (name, file) => name === 'auto' ? contrasting(await averageColor(file), await drawWallpapers()) : name;

// ciak shot [--from image] [--background auto|none|<name>|<css>] [--padding small|medium|large] [--plain] [--out file] [--no-copy]
//   | list | copy <file> | remove <file> | background [auto|none|name] | padding [small|medium|large] | edit <file> [--background b] [--padding p]
export async function shotCommand(args) {
  if (args[0] === 'background') {
    if (args[1] && !['auto', 'none'].includes(args[1]) && !backgrounds[args[1]]) throw new Error(`Usage: ciak shot background [auto|none|${Object.keys(backgrounds).join('|')}]`);
    if (args[1]) await run('defaults', ['write', 'com.ciak.app', 'background', '-string', args[1]]);
    return {background: await savedBackground(), padding: await savedPadding(), choices: backgrounds};
  }
  if (args[0] === 'padding') {
    if (args[1] && !paddings[args[1]]) throw new Error('Usage: ciak shot padding [small|medium|large]');
    if (args[1]) await run('defaults', ['write', 'com.ciak.app', 'padding', '-string', args[1]]);
    return {padding: await savedPadding()};
  }
  if (args[0] === 'list') {
    const names = (await fs.readdir(shotsDir).catch(() => [])).filter(name => /\.png$/i.test(name));
    const shots = await Promise.all(names.map(async name => ({name, file: path.join(shotsDir, name), created: (await fs.stat(path.join(shotsDir, name))).mtimeMs})));
    return shots.sort((first, second) => second.created - first.created);
  }
  if (args[0] === 'edit') {
    const file = await findShot(args[1]), raw = path.join(rawDir, path.basename(file));
    const option = flag => { const index = args.indexOf(flag); return index < 0 ? undefined : args[index + 1]; };
    if (option('--padding') && !paddings[option('--padding')] || option('--layout') && !layouts.includes(option('--layout'))) {
      throw new Error(`Usage: ciak shot edit <file> [--background auto|none|<name>|<css>] [--padding small|medium|large] [--layout ${layouts.join('|')}]`);
    }
    const saved = JSON.parse(await fs.readFile(sidecar(file), 'utf8').catch(() => '{}'));
    // Older shots don't say their background: unknown until edited; their padding was medium.
    if (!option('--background') && !option('--padding') && !option('--layout')) return {output: file, background: saved.background ?? null, padding: saved.padding ?? 'medium', layout: saved.layout};
    if (saved.parts) {
      const parts = saved.parts.map(name => path.join(partsDir(file), name));
      return {output: file, ...await collage(parts, file, option('--background') || saved.background, option('--padding') || saved.padding, option('--layout') || saved.layout)};
    }
    const work = await fs.mkdtemp(path.join(os.tmpdir(), 'ciak-shot-'));
    try {
      if (!await fs.access(raw).then(() => true, () => false)) await unframe(file, raw);
      const background = option('--background') || saved.background || await savedBackground();
      return {output: file, ...await place(raw, file, background, option('--padding') || saved.padding || 'medium', work)};
    } finally { await fs.rm(work, {recursive: true, force: true}); }
  }
  if (args[0] === 'collage') {
    const files = args.slice(1).filter((arg, index, all) => !arg.startsWith('--') && !all[index - 1]?.startsWith('--'));
    const option = flag => { const index = args.indexOf(flag); return index < 0 ? undefined : args[index + 1]; };
    if (files.length < 2 || option('--padding') && !paddings[option('--padding')] || option('--layout') && !layouts.includes(option('--layout'))) {
      throw new Error(`Usage: ciak shot collage <file> <file>… [--background b] [--padding small|medium|large] [--layout ${layouts.join('|')}]`);
    }
    // A shot from shots/ goes in unframed (its .raw copy); any other image as it is.
    const parts = await Promise.all(files.map(async name => {
      const inShots = path.join(shotsDir, path.basename(name)), raw = path.join(rawDir, path.basename(name));
      if (await fs.access(raw).then(() => true, () => false) && await fs.access(inShots).then(() => true, () => false)) return raw;
      if (await fs.access(inShots).then(() => true, () => false) && !await fs.access(path.resolve(name)).then(() => true, () => false)) return inShots;
      return path.resolve(name);
    }));
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const out = path.join(shotsDir, `collage-${stamp}.png`);
    // Its own copy of each part, so edits still work after the originals are deleted.
    await fs.mkdir(partsDir(out), {recursive: true});
    const copies = [];
    for (const [index, part] of parts.entries()) {
      copies.push(path.join(partsDir(out), `${index + 1}.png`));
      await fs.copyFile(part, copies.at(-1));
    }
    const result = await collage(copies, out, option('--background') || await savedBackground(), option('--padding') || await savedPadding(), option('--layout') || 'auto');
    if (!args.includes('--no-copy')) await copy(out);
    return {output: out, ...result};
  }
  if (args[0] === 'copy') { const file = await findShot(args[1]); await copy(file); return {copied: file}; }
  if (args[0] === 'remove') {
    const file = await findShot(args[1]);
    const extra = [path.join(rawDir, path.basename(file)), sidecar(file), partsDir(file)];
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
    const background = args.includes('--plain') ? 'none' : option('--background') || await savedBackground();
    if (option('--padding') && !paddings[option('--padding')]) throw new Error('--padding takes small, medium or large');
    await place(raw, out, background, option('--padding') || await savedPadding(), work);
    if (!args.includes('--no-copy')) await copy(out);
    return {output: out, copied: !args.includes('--no-copy')};
  } finally { await fs.rm(work, {recursive: true, force: true}); }
}

// Each shot in shots/ keeps its unframed copy and how it was framed (.raw/<name>.png and .json, ⌘1 too), so
// ciak shot edit can change the background or padding afterwards.
const rawDir = path.join(shotsDir, '.raw');
const sidecar = file => path.join(rawDir, path.basename(file).replace(/\.png$/i, '.json'));
// A collage: several shots on one wallpaper (a poster that a feed shows whole, not a thin strip it crops).
// Its parts live in .raw/<name>/; the sidecar says their order and the layout, so edit re-renders it.
const partsDir = file => path.join(rawDir, path.basename(file).replace(/\.png$/i, ''));
const layouts = ['auto', 'row', 'column', 'grid'];
async function collage(parts, out, background, padding, layout) {
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'ciak-shot-'));
  try {
    // auto looks at the first part (none: no wallpaper, the parts still sit apart on white).
    background = await chooseBackground(background, parts[0]);
    await frame(parts, out, background === 'none' ? '#fff' : backgrounds[background] || background, work, paddings[padding], layout);
    await fs.writeFile(sidecar(out), JSON.stringify({background, padding, layout, parts: parts.map(part => path.basename(part))}));
    return {background, padding, layout};
  } finally { await fs.rm(work, {recursive: true, force: true}); }
}
// Which parts share a row: each row is as tall as needed for all rows to be equally wide. row: one row;
// column: one per row; grid: about as many rows as columns; auto: the row count whose picture is closest to 4:3.
export function arrange(aspects, layout) {
  const split = count => Array.from({length: count}, (_, row) =>
    aspects.map((_, index) => index).slice(Math.round(row * aspects.length / count), Math.round((row + 1) * aspects.length / count)));
  const ratio = rows => 1 / rows.reduce((sum, row) => sum + 1 / row.reduce((width, index) => width + aspects[index], 0), 0);
  if (layout === 'row') return split(1);
  if (layout === 'column') return split(aspects.length);
  if (layout === 'grid') return split(Math.round(Math.sqrt(aspects.length)));
  const options = aspects.map((_, index) => split(index + 1));
  return options.sort((a, b) => Math.abs(Math.log(ratio(a) / (4 / 3))) - Math.abs(Math.log(ratio(b) / (4 / 3))))[0];
}
async function place(raw, out, background, padding, work) {
  background = await chooseBackground(background, raw);
  if (background === 'none') await fs.copyFile(raw, out);
  else await frame(raw, out, backgrounds[background] || background, work, paddings[padding]);
  if (path.dirname(out) !== shotsDir) return {background, padding};
  await fs.mkdir(rawDir, {recursive: true});
  const copy = path.join(rawDir, path.basename(out));
  if (raw !== copy) await fs.copyFile(raw, copy);
  await fs.writeFile(sidecar(out), JSON.stringify({background, padding}));
  return {background, padding};
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

async function frame(raws, out, background, work, share, layout = 'row') {
  raws = [raws].flat();
  const sizes = await Promise.all(raws.map(async raw => { const {width, height} = (await probe(raw)).streams[0]; return {width, height}; }));
  const aspects = sizes.map(size => size.width / size.height), rows = arrange(aspects, layout);
  const rowAspect = row => row.reduce((sum, index) => sum + aspects[index], 0);
  // As wide as the widest row's parts side by side at their own size (one shot: its own size).
  const width = Math.min(4000, Math.max(...rows.map(row => row.reduce((sum, index) => sum + sizes[index].width, 0))));
  const padding = Math.round(Math.max(width, rows.reduce((sum, row) => sum + width / rowAspect(row), 0)) * share);
  const gap = Math.round(padding / 2);
  const heights = rows.map(row => Math.round((width - gap * (row.length - 1)) / rowAspect(row)));
  const height = heights.reduce((sum, value) => sum + value, 0) + gap * (rows.length - 1);
  const shadow = Math.round(padding * 0.5);
  const images = rows.map((row, line) => `<div>${row.map(index => {
    const [w, h] = [Math.round(heights[line] * aspects[index]), heights[line]];
    return `<img src="${index}.png" style="width:${w}px;height:${h}px;border-radius:${Math.max(10, Math.round(Math.min(w, h) * 0.018))}px">`;
  }).join('')}</div>`).join('');
  for (const [index, raw] of raws.entries()) await fs.copyFile(raw, path.join(work, `${index}.png`));
  await fs.writeFile(path.join(work, 'frame.html'), `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;width:${width + 2 * padding}px;height:${height + 2 * padding}px;overflow:hidden}
body{background:${background};display:flex;flex-direction:column;align-items:center;justify-content:center;gap:${gap}px}
div{display:flex;gap:${gap}px}
img{display:block;box-shadow:0 ${Math.round(shadow * 0.4)}px ${shadow}px #0009}
</style></head><body>${images}</body></html>`);
  await fs.writeFile(out, await capturePage(`file://${path.join(work, 'frame.html')}`, width + 2 * padding, height + 2 * padding));
}
