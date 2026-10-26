import {execFile, spawn} from 'node:child_process';
import {promisify} from 'node:util';
import fs from 'node:fs/promises';
import {appendFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// Finished videos (and screenshots) for the user; everything a recording is made of stays in its project folder.
export const outputDir = path.resolve(process.env.JUSTREC_DIR || path.join(process.env.HOME, 'Documents/justrec'));
export const projectsDir = path.resolve(process.env.JUSTREC_PROJECTS || path.join(process.env.HOME, '.justrec/projects'));
export const execute = promisify(execFile);
// One timeline of what every justrec process did, with times (picker, cli, session, recorder, panel), to see where a
// slow or failed start waited: tail -f ~/.justrec/trace.log
export const traceFile = path.join(process.env.HOME, '.justrec/trace.log');
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
export async function run(command, args, options = {}) {
  const {stdout} = await execute(command, args, {maxBuffer: 16 * 1024 * 1024, ...options});
  return stdout;
}
export async function probe(file) {
  return JSON.parse(await run('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file]));
}
export async function build(name = 'rec') {
  const binary = path.join(root, `.build/justrec-${name}`);
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
