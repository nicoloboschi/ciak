// justrec install [--key cmd+1] [--background aurora] | uninstall: sets justrec up on this Mac, once.
// - justrec.app (app.swift) in ~/Applications: menu bar icon, ⌘1 screenshots (picker.swift), Record… (the panel);
//   starts at login (a launchd agent) and holds Screen Recording + Microphone permission for what it starts.
// - the justrec command in ~/.local/bin, and the skill in ~/.claude/skills, so every agent finds it.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {root, outputDir, run, build} from './common.mjs';
import {backgrounds} from './project.mjs';
import {capturePage} from './browser.mjs';

const home = os.homedir();
const label = 'com.justrec.app';
const bundle = path.join(home, 'Applications/justrec.app');
const agent = path.join(home, `Library/LaunchAgents/${label}.plist`);
const log = path.join(home, '.justrec/app.log');
const links = [[path.join(root, 'justrec'), path.join(home, '.local/bin/justrec')], [path.join(root, '.claude/skills/justrec'), path.join(home, '.claude/skills/justrec')]];
const xml = text => text.replace(/&/g, '&amp;').replace(/</g, '&lt;');

// Replaces the app only when app.swift changed: macOS ties the permission to this exact build (and two builds
// of the same source differ). app.swift is a thin shell that rarely changes; features live in what it starts.
async function app() {
  const inside = path.join(bundle, 'Contents/MacOS/justrec');
  const stamp = path.join(bundle, 'Contents/Resources/source.sha256');
  const source = createHash('sha256').update(await fs.readFile(path.join(root, 'app.swift'))).digest('hex');
  if (await fs.readFile(stamp, 'utf8').catch(() => '') === source && await fs.access(inside).then(() => true, () => false)) return inside;
  const binary = await build('app');
  await fs.mkdir(path.dirname(inside), {recursive: true});
  await fs.mkdir(path.dirname(stamp), {recursive: true});
  await fs.copyFile(binary, inside);
  await fs.writeFile(stamp, source);
  await fs.writeFile(path.join(bundle, 'Contents/Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${label}</string>
<key>CFBundleName</key><string>justrec</string>
<key>CFBundleExecutable</key><string>justrec</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>LSUIElement</key><true/>
<key>NSMicrophoneUsageDescription</key><string>justrec records your voice with the screen.</string>
<key>NSCameraUsageDescription</key><string>justrec can record your camera with the screen.</string>
</dict></plist>
`);
  await run('codesign', ['--force', '--sign', '-', '--identifier', label, bundle]);
  return inside;
}

async function stopAgents() {
  const domain = `gui/${process.getuid()}`;
  // com.justrec.shortcut: the screenshot helper before the app existed.
  for (const name of [label, 'com.justrec.shortcut']) await run('launchctl', ['bootout', `${domain}/${name}`]).catch(() => {});
  // A copy opened from Finder isn't launchd's: stop it too, or the new one sees it and steps aside.
  await run('pkill', ['-f', 'justrec.app/Contents/MacOS/justrec']).catch(() => {});
  await run('pkill', ['-f', `${root}/lib/cli.mjs ui`]).catch(() => {});  // its recording panel outlives it
  await fs.rm(path.join(home, 'Library/LaunchAgents/com.justrec.shortcut.plist'), {force: true});
  await fs.rm(path.join(root, '.build/justrec Shot.app'), {recursive: true, force: true});
  await fs.rm(path.join(home, '.justrec/shortcut.log'), {force: true});
}

// Links only where nothing else lives; reports what it left alone.
async function link(target, place) {
  const current = await fs.readlink(place).catch(error => error.code === 'ENOENT' ? null : 'other');
  if (current === target) return 'linked';
  if (current !== null) return `left alone (${place} already exists)`;
  await fs.mkdir(path.dirname(place), {recursive: true});
  await fs.symlink(target, place);
  return 'linked';
}

export async function installCommand(args) {
  const option = flag => { const index = args.indexOf(flag); return index < 0 ? undefined : args[index + 1]; };
  await stopAgents();
  const key = option('--key') || 'cmd+1';
  // The screenshot wallpaper is drawn once here (CSS gradient → PNG); the app stretches it behind each shot.
  const wallpaper = path.join(home, '.justrec/shot-wallpaper.png');
  const background = backgrounds[option('--background')] || option('--background') || backgrounds.aurora;
  await fs.mkdir(path.dirname(wallpaper), {recursive: true});
  await fs.writeFile(wallpaper, await capturePage(`data:text/html,${encodeURIComponent(`<body style="margin:0;height:100vh;background:${background}">`)}`, 2880, 1800));
  const settings = {key, wallpaper, shots: path.join(outputDir, 'shots'), recordings: outputDir, cli: path.join(root, 'justrec'), picker: await build('picker')};
  // Saved in the app's own settings, so it works the same when opened from Finder or Spotlight.
  for (const [name, value] of Object.entries(settings)) await run('defaults', ['write', label, name, value]);
  const command = [await app()];
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
  await run('launchctl', ['bootstrap', `gui/${process.getuid()}`, agent]);
  // The first launch of a new build waits for macOS to check it (seconds).
  for (let tries = 0; tries < 150 && !(await fs.readFile(log, 'utf8')).includes('ready'); tries++) await new Promise(resolve => setTimeout(resolve, 200));
  const said = (await fs.readFile(log, 'utf8')).trim();
  if (!said.includes('ready')) throw new Error(said || `justrec.app did not start; see ${log}`);
  const linked = {};
  for (const [target, place] of links) linked[place] = await link(target, place);
  return {app: bundle, screenshot: key, atLogin: true, linked, ...(said.includes('taken') && {warning: said.split('\n')[0]}),
    firstUse: 'macOS asks once for Screen Recording (and Microphone when you record): allow justrec.'};
}

export async function uninstallCommand() {
  await stopAgents();
  await run('defaults', ['delete', label]).catch(() => {});
  await fs.rm(agent, {force: true});
  await fs.rm(bundle, {recursive: true, force: true});
  for (const [target, place] of links) if (await fs.readlink(place).catch(() => null) === target) await fs.rm(place);
  return {removed: [bundle, agent, ...links.map(([, place]) => place)], kept: 'recordings, voices and settings in ~/.justrec'};
}
