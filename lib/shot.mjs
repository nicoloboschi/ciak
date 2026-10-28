// Screenshots that look good: pick a region or window (macOS's own picker), then the shot is
// placed on a wallpaper with rounded corners and a shadow, saved, and copied to the clipboard.
// The frame is drawn by the ciak browser (off-screen), so it uses the same backgrounds as the videos.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {outputDir, run, probe} from './common.mjs';
import {backgrounds} from './project.mjs';
import {capturePage} from './browser.mjs';

export const shotsDir = path.join(outputDir, 'shots');
const copy = file => run('osascript', ['-e', `set the clipboard to (read (POSIX file "${file}") as «class PNGf»)`]);
// A shot by file name (or path) inside shots/, nothing outside it.
async function findShot(name) {
  const file = path.join(shotsDir, path.basename(String(name || '')));
  if (!/\.png$/i.test(file) || !await fs.access(file).then(() => true, () => false)) throw new Error(`No screenshot ${name} in ${shotsDir}`);
  return file;
}

// ciak shot [--from image] [--background aurora|<css>] [--plain] [--out file] [--no-copy] | list | copy <file> | remove <file>
export async function shotCommand(args) {
  if (args[0] === 'list') {
    const names = (await fs.readdir(shotsDir).catch(() => [])).filter(name => /\.png$/i.test(name));
    const shots = await Promise.all(names.map(async name => ({name, file: path.join(shotsDir, name), created: (await fs.stat(path.join(shotsDir, name))).mtimeMs})));
    return shots.sort((first, second) => second.created - first.created);
  }
  if (args[0] === 'copy') { const file = await findShot(args[1]); await copy(file); return {copied: file}; }
  if (args[0] === 'remove') { const file = await findShot(args[1]); await run('trash', [file]); return {trashed: file}; }
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
    else await frame(raw, out, backgrounds[option('--background')] || option('--background') || backgrounds.aurora, work);
    if (!args.includes('--no-copy')) await copy(out);
    return {output: out, copied: !args.includes('--no-copy')};
  } finally { await fs.rm(work, {recursive: true, force: true}); }
}

async function frame(raw, out, background, work) {
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
img{display:block;width:${width}px;height:${height}px;border-radius:${radius}px;box-shadow:0 ${Math.round(shadow * 0.4)}px ${shadow}px #0009,0 0 0 1px #ffffff1f}
</style></head><body><img src="shot.png"></body></html>`);
  await fs.writeFile(out, await capturePage(`file://${path.join(work, 'frame.html')}`, width + 2 * padding, height + 2 * padding));
}
