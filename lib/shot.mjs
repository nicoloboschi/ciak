// Screenshots that look good: pick a region or window (macOS's own picker), then the shot is
// placed on a wallpaper with rounded corners and a shadow, saved, and copied to the clipboard.
// The frame is drawn by the justrec browser (off-screen), so it uses the same backgrounds as the videos.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {root, outputDir, run, probe, build} from './common.mjs';
import {backgrounds} from './project.mjs';
import {capturePage} from './browser.mjs';

// justrec shot [--from image] [--background aurora|<css>] [--plain] [--out file] [--no-copy]
export async function shotCommand(args) {
  const option = flag => { const index = args.indexOf(flag); return index < 0 ? undefined : args[index + 1]; };
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'justrec-shot-'));
  try {
    let raw = option('--from') && path.resolve(option('--from'));
    if (!raw) {
      raw = path.join(work, 'raw.png');
      // -i: drag a region, or space for a window; -o: no window shadow (we draw our own).
      await run('screencapture', ['-i', '-o', '-x', raw]).catch(() => {});
      if (!await fs.access(raw).then(() => true, () => false)) return {cancelled: true};
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const out = path.resolve(option('--out') || path.join(outputDir, 'shots', `shot-${stamp}.png`));
    await fs.mkdir(path.dirname(out), {recursive: true});
    if (args.includes('--plain')) await fs.copyFile(raw, out);
    else await frame(raw, out, backgrounds[option('--background')] || option('--background') || backgrounds.aurora, work);
    if (!args.includes('--no-copy')) await run('osascript', ['-e', `set the clipboard to (read (POSIX file "${out}") as «class PNGf»)`]);
    if (args.includes('--notify')) await run('osascript', ['-e', `display notification "${path.basename(out)}" with title "Screenshot copied"`]).catch(() => {});
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

// justrec shortcut [--key cmd+shift+6] | stop: a global shortcut for `justrec shot`. It is a login
// item (launchd agent), so it keeps working after a restart. The first shot asks for Screen Recording.
const label = 'com.justrec.shortcut';
const agent = path.join(os.homedir(), `Library/LaunchAgents/${label}.plist`);
const log = path.join(os.homedir(), '.justrec/shortcut.log');
export async function shortcutCommand(args) {
  const domain = `gui/${process.getuid()}`;
  await run('launchctl', ['bootout', `${domain}/${label}`]).catch(() => {});
  if (args[0] === 'stop') { await fs.rm(agent, {force: true}); return {stopped: true}; }
  const key = args.includes('--key') ? args[args.indexOf('--key') + 1] : 'cmd+shift+6';
  const command = [await build('hotkey'), key, path.join(root, 'justrec'), 'shot', '--notify'];
  const xml = text => text.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  await fs.mkdir(path.dirname(log), {recursive: true});
  await fs.mkdir(path.dirname(agent), {recursive: true});
  await fs.writeFile(log, '');
  await fs.writeFile(agent, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array>${command.map(part => `<string>${xml(part)}</string>`).join('')}</array>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(process.env.PATH)}</string></dict>
<key>RunAtLoad</key><true/>
<key>StandardOutPath</key><string>${xml(log)}</string>
<key>StandardErrorPath</key><string>${xml(log)}</string>
</dict></plist>
`);
  await run('launchctl', ['bootstrap', domain, agent]);
  // Wait for "ready" (or the reason it failed, e.g. the shortcut is taken).
  for (let tries = 0; tries < 30; tries++) {
    const said = await fs.readFile(log, 'utf8');
    if (said.includes('ready')) return {shortcut: key, runs: 'justrec shot', atLogin: true, stop: 'justrec shortcut stop'};
    if (said.trim()) { await shortcutCommand(['stop']); throw new Error(said.trim()); }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(`The shortcut did not start; see ${log}`);
}
