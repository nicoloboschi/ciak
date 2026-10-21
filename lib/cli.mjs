import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {root, outputDir, build, run, readJSON, writeJSON, request, sleep} from './common.mjs';

const [command = 'help', ...args] = process.argv.slice(2);
const print = value => console.log(JSON.stringify(value, null, 2));
const latestFile = path.join(outputDir, '.sessions/latest.json');
const help = `justrec — record, then edit with an agent

  sources                         List displays, windows, microphones and cameras (JSON)
  start [options]                 Start a background recording; returns its session ID
  status [id]                     Read recording state (JSON)
  pause [id] / resume [id]         Pause or resume without including the gap
  stop [id]                       Finalize one MP4 and its project JSON
  mark <label> [--at x,y | --page x,y,innerWidth,innerHeight] [--id id]
                                 Add a timed action marker (auto-zoom target). --at is 0–1
                                 inside the capture; --page is a point in a recorded browser page
  rec [display-index] [options]   Record until Enter or Ctrl-C
  captions <video>                Local transcript, SRT and word timestamps
  project <video>                 Create an editable project JSON
  edit <project> [options]        --reset --auto-zoom --cut-silence --cut-idle --cut start,end
                                 --preset landscape|vertical|square --transcript file
  render <project> [--out file]   Render and verify a polished MP4
  preview <project> [--frame n] [--out file.png]  Render one preview frame
  film <film.json> [--preview]    Build a launch video from a storyboard: narration, captions, music
  ui [--no-open]                  Open the simple local recording panel
  browser [url]                   Open the justrec browser: your Brave logins, keeps drawing when covered
  browser go|click|type|key|scroll|eval|shot|tabs ...   Drive its current tab (justrec browser help)

Capture options:
  --display <index>  --window <id>  --region <x,y,width,height> (source-relative points)
  --browser [tab]    Record the justrec browser's current tab (or one whose URL/title matches)
  --mic <name-or-id> | --no-mic    --system-audio    --camera <name-or-id|default>
  --fps <24|30|60>   --max-width <pixels>   --native-cursor
  --name <name>      --countdown <seconds>
  --url <url|file>   --run <js>   --for <seconds>   (with --browser: open, trigger, record N s, stop)
`;

function captureOptions(values) {
  const capture = {display: 0, microphone: 'default', systemAudio: false, cursorVisible: false, fps: 60, maxWidth: 2560};
  let name = 'rec';
  let countdown = 0;
  const then = {};
  for (let index = 0; index < values.length; index++) {
    const option = values[index];
    if (option === '--no-mic') capture.microphone = null;
    else if (option === '--system-audio') capture.systemAudio = true;
    else if (option === '--native-cursor') capture.cursorVisible = true;
    else if (option === '--browser') capture.browser = {tab: values[index + 1] && !values[index + 1].startsWith('--') ? values[++index] : null};
    else {
      const value = values[++index];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${option}`);
      if (option === '--display') capture.display = Number(value);
      else if (option === '--window') capture.window = Number(value);
      else if (option === '--region') capture.region = value.split(',').map(Number);
      else if (option === '--mic') capture.microphone = value;
      else if (option === '--camera') capture.camera = value;
      else if (option === '--fps') capture.fps = Number(value);
      else if (option === '--max-width') capture.maxWidth = Number(value);
      else if (option === '--name') name = value;
      else if (option === '--countdown') countdown = Number(value);
      else if (option === '--url') then.url = value;
      else if (option === '--run') then.run = value;
      else if (option === '--for') then.seconds = Number(value);
      else throw new Error(`Unknown capture option: ${option}`);
    }
  }
  if (!/^[\w -]{1,80}$/.test(name)) throw new Error('Name must contain 1–80 letters, numbers, spaces, underscores or hyphens');
  if (![24, 30, 60].includes(capture.fps)) throw new Error('FPS must be 24, 30 or 60');
  if (!Number.isInteger(capture.display) || capture.display < 0) throw new Error('Display index must be a nonnegative integer');
  if (capture.window !== undefined && (!Number.isInteger(capture.window) || capture.window < 1)) throw new Error('Window ID must be a positive integer');
  if (!Number.isInteger(capture.maxWidth) || capture.maxWidth < 320 || capture.maxWidth > 7680) throw new Error('Maximum width must be 320–7680');
  if (capture.region && (capture.region.length !== 4 || !capture.region.every(Number.isFinite))) throw new Error('Region must be x,y,width,height');
  if (!Number.isFinite(countdown) || countdown < 0 || countdown > 30) throw new Error('Countdown must be 0–30 seconds');
  if (capture.browser) {
    if (capture.camera) throw new Error('--browser does not support --camera yet');
    if (!values.includes('--mic')) capture.microphone = null;
    if (!values.includes('--max-width')) capture.maxWidth = 3840;
  }
  if ((then.url || then.run) && !capture.browser) throw new Error('--url and --run need --browser');
  if (then.seconds !== undefined && !(then.seconds > 0 && then.seconds <= 3600)) throw new Error('--for must be 1–3600 seconds');
  return {capture, name, countdown, then};
}

async function getSession(id) {
  if (!id) ({id} = await readJSON(latestFile));
  if (!/^[\w-]+$/.test(id)) throw new Error('Invalid session ID');
  return readJSON(path.join(outputDir, '.sessions', id, 'session.json'));
}

async function start(values) {
  const {capture, name, countdown, then} = captureOptions(values);
  // Scripted captures are timed on purpose (waiting can be the point): no idle cuts.
  if (then.seconds) capture.scripted = true;
  if (then.url) await (await import('./browser.mjs')).browserCommand(['open', then.url]);
  const state = await startSession(capture, name, countdown);
  // One step for agents: run a trigger in the page, wait, stop, return the saved recording.
  if (then.run) await (await import('./browser.mjs')).browserCommand(['eval', then.run]);
  if (!then.seconds) return state;
  await sleep(then.seconds * 1000);
  const saved = await request(await getSession(state.id), 'stop');
  return {...saved, token: undefined};
}

async function startSession(capture, name, countdown) {
  const binary = capture.browser ? process.execPath : await build();
  const binaryArgs = capture.browser ? [path.join(root, 'lib/browser.mjs'), 'record'] : [];
  if (capture.browser && (capture.systemAudio || capture.microphone)) capture.recBinary = await build();
  const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
  const directory = path.join(outputDir, '.sessions', id);
  await fs.mkdir(directory, {recursive: true, mode: 0o700});
  const output = path.join(outputDir, `${name}-${id}.mp4`);
  const configFile = path.join(directory, 'config.json');
  await writeJSON(configFile, {id, output, capture, binary, binaryArgs});
  if (countdown) { console.error(`Recording begins in ${countdown} seconds`); await sleep(countdown * 1000); }
  const log = await fs.open(path.join(directory, 'worker.log'), 'a');
  const child = spawn(process.execPath, [path.join(root, 'lib/session.mjs'), configFile], {detached: true, stdio: ['ignore', log.fd, log.fd]});
  child.unref(); await log.close();
  const deadline = Date.now() + 50000;
  while (Date.now() < deadline) {
    const state = await readJSON(path.join(directory, 'session.json')).catch(() => null);
    if (state?.state === 'error') throw new Error(state.error);
    if (state?.state === 'recording') {
      await writeJSON(latestFile, {id});
      return {...state, token: undefined};
    }
    await sleep(100);
  }
  throw new Error(`Recording startup timed out; inspect ${directory}`);
}

try {
  if (['help', '--help', '-h'].includes(command)) console.log(help);
  else if (command === 'sources') print(JSON.parse(await run(await build(), ['sources'])));
  else if (command === 'start') print(await start(args));
  else if (command === 'rec') {
    if (args[0] && !args[0].startsWith('--')) args.unshift('--display');
    const state = await start(args); print(state);
    console.error('Recording. Press Enter or Ctrl-C to stop.');
    await new Promise(resolve => { process.once('SIGINT', resolve); process.stdin.once('data', resolve); process.stdin.resume(); });
    process.stdin.pause();
    print(await request(await getSession(state.id), 'stop'));
  } else if (['status', 'stop', 'pause', 'resume'].includes(command)) {
    const state = await getSession(args[0]);
    if (state.state === 'error') throw new Error(`Recording failed: ${state.error}. Partial files: ${path.join(outputDir, '.sessions', state.id)}`);
    if (state.state === 'saved') print({...state, token: undefined});
    else print(await request(state, command));
  } else if (command === 'mark') {
    const [label, ...options] = args;
    let id; const body = {label};
    for (let index = 0; index < options.length; index += 2) {
      if (options[index] === '--id') id = options[index + 1];
      else if (options[index] === '--at') [body.x, body.y] = options[index + 1].split(',').map(Number);
      else if (options[index] === '--page') body.page = options[index + 1].split(',').map(Number);
      else throw new Error(`Unknown marker option: ${options[index]}`);
    }
    print(await request(await getSession(id), 'mark', body));
  } else if (command === 'captions') {
    if (!args[0]) throw new Error('Usage: justrec captions <video>');
    const input = path.resolve(args[0]);
    const base = path.basename(input, path.extname(input));
    await run('uvx', ['--from', 'mlx-whisper', 'mlx_whisper', input, '--model', process.env.JUSTREC_WHISPER_MODEL || 'mlx-community/whisper-large-v3-turbo', '--output-format', 'all', '--word-timestamps', 'True', '--output-dir', path.dirname(input), '--output-name', base]);
    print({srt: path.join(path.dirname(input), `${base}.srt`), transcript: path.join(path.dirname(input), `${base}.json`)});
  } else if (command === 'film') {
    if (!args[0]) throw new Error('Usage: justrec film <film.json> [--preview] [--out file.mp4]');
    const options = {preview: args.includes('--preview')};
    if (args.includes('--out')) options.output = args[args.indexOf('--out') + 1];
    print(await (await import('./film.mjs')).renderFilm(args[0], options));
  } else if (command === 'browser') print(await (await import('./browser.mjs')).browserCommand(args));
  else if (command === 'ui') {
    await (await import('./ui.mjs')).serveUI({open: !args.includes('--no-open')});
  } else if (command === 'project') {
    if (!args[0]) throw new Error('Usage: justrec project <video>');
    print(await (await import('./project.mjs')).createProject(args[0]));
  } else if (command === 'edit') {
    if (!args[0]) throw new Error('Usage: justrec edit <project> [options]');
    print(await (await import('./project.mjs')).editProject(args[0], args.slice(1)));
  } else if (command === 'render' || command === 'preview') {
    if (!args[0]) throw new Error(`Usage: justrec ${command} <project>`);
    const options = command === 'preview' ? {frame: 0, output: args[0].replace(/\.json$/, '.preview.png')} : {};
    for (let index = 1; index < args.length; index += 2) {
      if (args[index] === '--out') options.output = args[index + 1];
      else if (args[index] === '--frame' && command === 'preview') options.frame = Number(args[index + 1]);
      else throw new Error(`Unknown render option: ${args[index]}`);
    }
    print(await (await import('./render.mjs')).renderProject(args[0], options));
  } else throw new Error(`Unknown command: ${command}\n${help}`);
} catch (error) { console.error(JSON.stringify({error: error.message})); process.exitCode = 1; }
