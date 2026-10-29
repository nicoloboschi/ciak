import {execFile, spawn} from 'node:child_process';
import os from 'node:os';
import {promisify} from 'node:util';
import fs from 'node:fs/promises';
import {appendFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// Finished videos (and screenshots) for the user; everything a recording is made of stays in its project folder.
export const outputDir = path.resolve(process.env.CIAK_DIR || path.join(process.env.HOME, 'Documents/ciak'));
export const projectsDir = path.resolve(process.env.CIAK_PROJECTS || path.join(process.env.HOME, '.ciak/projects'));
const execFileAsync = promisify(execFile);
// ffmpeg, uvx and deep-filter come from tool(): installed ones first, otherwise downloaded on first use.
export const execute = async (command, args, options) => execFileAsync(await tool(command), args, options);
// One timeline of what every ciak process did, with times (picker, cli, session, recorder, panel), to see where a
// slow or failed start waited: tail -f ~/.ciak/trace.log
export const traceFile = path.join(process.env.HOME, '.ciak/trace.log');
export function trace(source, message) {
  const now = new Date();
  try { appendFileSync(traceFile, `${now.toTimeString().slice(0, 8)}.${String(now.getMilliseconds()).padStart(3, '0')} ${source}[${process.pid}] ${message}\n`); } catch {}
}
// Visually lossless for screen content and ~10x smaller than the hardware encoder at the same quality (measured).
export const x264 = ['-c:v', 'libx264', '-crf', '18', '-preset', 'veryfast', '-pix_fmt', 'yuv420p'];
export const sleep = (milliseconds) => new Promise(resolve => setTimeout(resolve, milliseconds));
// A time limit for Promise.race that does not keep the process alive once the race is won.
export const limit = (milliseconds) => new Promise(resolve => setTimeout(resolve, milliseconds).unref());
export const readJSON = async (file) => JSON.parse(await fs.readFile(file, 'utf8'));
export async function writeJSON(file, value) {
  await fs.mkdir(path.dirname(file), {recursive: true});
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(value, null, 2) + '\n', {mode: 0o600});
  await fs.rename(temporary, file);
}
// Tools ciak gets by itself the first time it needs one that isn't installed, into ~/.ciak/bin: nothing to
// set up beforehand, and only what a feature needs (no captions, no Python).
export const binDir = path.join(process.env.HOME, '.ciak/bin');
const downloads = {
  ffmpeg: {url: 'https://ffmpeg.martin-riedl.de/redirect/latest/macos/arm64/release/ffmpeg.zip', zip: true},  // the static macOS builds ffmpeg.org links to
  ffprobe: {url: 'https://ffmpeg.martin-riedl.de/redirect/latest/macos/arm64/release/ffprobe.zip', zip: true},
  uvx: {url: 'https://github.com/astral-sh/uv/releases/download/0.13.6/uv-aarch64-apple-darwin.tar.gz', tar: ['uv', 'uvx']},
  // The noise remover: DeepFilterNet's own program (its model built in), no Python or PyTorch.
  'deep-filter': {url: 'https://github.com/Rikorose/DeepFilterNet/releases/download/v0.5.6/deep-filter-0.5.6-aarch64-apple-darwin'},
};
const tools = new Map();
export function tool(name) {
  if (!downloads[name]) return name;
  if (!tools.has(name)) tools.set(name, (async () => {
    const usable = file => fs.access(file, fs.constants.X_OK).then(() => true, () => false);
    // launchd starts the app (and what it runs) with a short PATH: look where Homebrew puts things too.
    for (const folder of [...(process.env.PATH || '').split(':').filter(Boolean), '/opt/homebrew/bin', '/usr/local/bin', path.join(process.env.HOME, '.local/bin'), binDir]) {
      if (await usable(path.join(folder, name))) return path.join(folder, name);
    }
    const {url, zip, tar} = downloads[name];
    trace('tool', `downloading ${name} (first use): ${url}`);
    console.error(`ciak: downloading ${name}, once`);
    const work = await fs.mkdtemp(path.join(os.tmpdir(), 'ciak-tool-'));
    try {
      const file = path.join(work, 'download');
      await execFileAsync('curl', ['-fsSL', '--retry', '2', '-o', file, url]);
      if (zip) await execFileAsync('unzip', ['-oq', file, '-d', work]);
      if (tar) await execFileAsync('tar', ['-xzf', file, '-C', work, '--strip-components', '1']);
      await fs.mkdir(binDir, {recursive: true});
      for (const part of tar || [name]) {
        const source = zip || tar ? path.join(work, part) : file;
        await fs.chmod(source, 0o755);
        await fs.rename(source, path.join(binDir, part));
      }
    } finally { await fs.rm(work, {recursive: true, force: true}); }
    return path.join(binDir, name);
  })().catch(error => { tools.delete(name); throw error; }));
  return tools.get(name);
}

// One Python for every model ciak runs (speech to text, the narrator, your own voice), made by uv on first use.
const pythonSpec = ['--python', '3.12', '--from', 'mlx-audio==0.6.3', '--with', 'mlx-whisper==0.4.3', '--with', 'misaki[en]==0.9.4'];
export const python = (args, options) => run('uvx', [...pythonSpec, 'python', '-I', ...args], options);

export async function run(command, args, options = {}) {
  const {stdout} = await execute(command, args, {maxBuffer: 16 * 1024 * 1024, ...options});
  return stdout;
}
export async function probe(file) {
  return JSON.parse(await run('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file]));
}
export async function build(name = 'rec') {
  const binary = path.join(root, `.build/ciak-${name}`);
  const source = path.join(root, `${name}.swift`);
  const [sourceStat, binaryStat] = await Promise.all([fs.stat(source), fs.stat(binary).catch(() => null)]);
  if (!binaryStat || sourceStat.mtimeMs > binaryStat.mtimeMs) {
    await fs.mkdir(path.dirname(binary), {recursive: true});
    const temporary = `${binary}.${process.pid}`;
    await run('swiftc', ['-O', ...(name === 'rec' ? ['-parse-as-library'] : []), '-o', temporary, source]);
    await fs.rename(temporary, binary);
  }
  return binary;
}
export function launch(command, args, options = {}) {
  const child = spawn(command, args, {stdio: ['ignore', 'pipe', 'pipe'], ...options});
  let stderr = '';
  child.stderr?.on('data', chunk => { stderr = (stderr + chunk).slice(-16000); });
  const finished = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code, signal) => code === 0 ? resolve() : reject(new Error(`${command} failed (${code ?? signal}): ${stderr}`)));
  });
  finished.catch(() => {});
  return {child, finished};
}
export async function request(session, action, body = {}) {
  const response = await fetch(`http://127.0.0.1:${session.port}/${action}`, {
    method: 'POST', headers: {'Authorization': `Bearer ${session.token}`, 'Content-Type': 'application/json'},
    body: JSON.stringify(body), signal: AbortSignal.timeout(action === 'stop' ? 180000 : 60000),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `Request failed: ${response.status}`);
  return result;
}

// What a project is doing, step by step with timings: <project folder>/steps.json, for the recording panel.
// step(name, async update => …) runs one step; update(detail) shows progress ("120/600 frames"). A new run of a
// phase ("record", "render") replaces that phase's old steps. Without a folder it just runs the work.
export function stepLog(directory, phase) {
  if (!directory) return (name, work) => work(() => {});
  const file = path.join(directory, 'steps.json');
  let steps = [], writing = Promise.resolve(), last = 0;
  const save = () => (writing = writing.then(() => writeJSON(file, steps)).catch(() => {}));
  const ready = readJSON(file).then(old => { steps = old.filter(item => item.phase !== phase); }, () => {});
  return async (name, work) => {
    await ready;
    const step = {phase, name, started: Date.now()};
    trace(phase, `${path.basename(directory)} ${name}…`);
    steps.push(step);
    await save();
    const update = detail => { step.detail = detail; if (Date.now() - last > 250) { last = Date.now(); save(); } };
    try {
      const result = await work(update);
      if (typeof result === 'string') step.detail = result;
      return result;
    } catch (error) { step.error = error.message; throw error; }
    finally {
      step.ended = Date.now();
      trace(phase, `${path.basename(directory)} ${name}: ${step.error ? 'failed: ' + step.error : 'done'} in ${((step.ended - step.started) / 1000).toFixed(2)} s`);
      await save();
    }
  };
}
