import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {root, outputDir, projectsDir, build, run, readJSON, writeJSON, request, sleep, trace, traceFile} from './common.mjs';

const [command = 'help', ...args] = process.argv.slice(2);
if (command !== 'help') trace('cli', [command, ...args].join(' '));
const print = value => console.log(JSON.stringify(value, null, 2));
const latestFile = path.join(projectsDir, 'latest.json');
const help = `justrec — record, then edit with an agent

  install [--key cmd+1] | uninstall  Set up this Mac once: justrec.app in the menu bar (⌘1 screenshots,
                                 Record… panel; starts at login), the command, the skill for agents

  sources                         List displays, windows, microphones and cameras (JSON)
  start [options]                 Start a background recording; returns its session ID
  status [id]                     Read recording state (JSON)
  pause [id] / resume [id]         Pause or resume without including the gap
  stop [id]                       Finalize the recording: its project id and project folder
  mark <label> [--at x,y | --page x,y,innerWidth,innerHeight] [--id id]
                                 Add a timed action marker (auto-zoom target). --at is 0–1
                                 inside the capture; --page is a point in a recorded browser page
  rec [display-index] [options]   Record until Enter or Ctrl-C
  captions <project|video>        Local transcript, SRT and word timestamps
  project <video>                 Create an editable project JSON
  project rename <id> <name> | remove <id>   Rename a project (and its video), or move it to the Trash
  edit <project> [options]        --reset --auto-zoom --cut-silence --cut-idle --cut start,end --mic|--system-audio|--webcam|--clicks|--zooms on|off
                                 --preset landscape|vertical|square --transcript file
  render <project> [--out file]   Render and verify a polished MP4 (default: ~/Documents/justrec/<name>-<id>.mp4)
  preview <project> [--frame n] [--out file.png]  Render one preview frame
  film <film.json> [--preview]    Build a launch video from a storyboard: narration, captions, music;
                                 ends with a check listing problems (times + frames). --no-check skips it
  film <film.json> --live         Play it in the browser now (no export); reloads when files change
  frames <film.json> [--scene n | --from s --to s | --at s,s] [--every s]   Labelled frames in one image
  schema [--path]                 The film.json schema (fields, types, descriptions)
  styles                          Film styles: built-in (styles/) and yours (~/.justrec/styles)
  terminal open [--title t] [--blur re]   A real shell shown in the justrec browser (record: start --terminal)
  shot [--background b] [--plain] [--from f]  Pick a region/window: framed on a wallpaper, saved, copied
  shot list | copy <file> | remove <file>     The screenshots in ~/Documents/justrec/shots (remove = to the Trash)
  voice add <name> [--from file] | list | say <name> "t" [--out f] | remove <name>
                                 Your own voices for narration (a 15 s sample each; film "voice": {"name": "<name>"})
  terminal run "<cmd>" | clear | close     Type and run a command there; returns output and exit code
  check <film.json>               Check an already rendered film again
  ui [--no-open] [--project id]   Open the recording panel (on a project's page)
  browser [url]                   Open the justrec browser: your Brave logins, keeps drawing when covered
  browser go|click|type|key|scroll|eval|shot|tabs ...   Drive its current tab (justrec browser help)

Capture options:
  --display <index> (or --display-id <id>)  --window <id>  --region <x,y,width,height> (source-relative points)
  --browser [tab]    Record the justrec browser's current tab (or one whose URL/title matches)
  --mic <name-or-id|default> (no mic unless given)    --system-audio    --no-zoom (no auto zoom on clicks)    --camera <name-or-id|default>
  --fps <24|30|60>   --max-width <pixels>   --native-cursor
  --name <name>      --countdown <seconds>
  --url <url|file>   --run <js>   --for <seconds>   (with --browser: open, trigger, record N s, stop)
  --hide <text>      --blur <regex>   (with --browser, repeatable: hide the row holding the text,
                                      blur text matching the pattern, e.g. API keys)
`;

function captureOptions(values) {
  const capture = {display: 0, microphone: null, systemAudio: false, cursorVisible: false, fps: 60, maxWidth: 2560};
  let name = 'rec';
  let countdown = 0;
  const then = {};
  for (let index = 0; index < values.length; index++) {
    const option = values[index];
    if (option === '--no-mic') capture.microphone = null;
    else if (option === '--system-audio') capture.systemAudio = true;
    else if (option === '--no-zoom') capture.noZoom = true;
    else if (option === '--native-cursor') capture.cursorVisible = true;
    else if (option === '--browser') capture.browser = {tab: values[index + 1] && !values[index + 1].startsWith('--') ? values[++index] : null};
    else if (option === '--terminal') capture.browser = {terminal: true};
    else {
      const value = values[++index];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${option}`);
      if (option === '--display') capture.display = Number(value);
      else if (option === '--display-id') capture.displayID = Number(value);
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
      else if (option === '--hide') ((capture.mask ||= {hide: [], blur: []}).hide).push(value);
      else if (option === '--blur') { new RegExp(value); ((capture.mask ||= {hide: [], blur: []}).blur).push(value); }
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
    if (!values.includes('--max-width')) capture.maxWidth = 3840;
  }
  if ((then.url || then.run) && !capture.browser) throw new Error('--url and --run need --browser');
  if (then.seconds !== undefined && !(then.seconds > 0 && then.seconds <= 3600)) throw new Error('--for must be 1–3600 seconds');
  return {capture, name, countdown, then};
}

async function getSession(id) {
  if (!id) ({id} = await readJSON(latestFile));
  if (!/^[\w-]+$/.test(id)) throw new Error('Invalid session ID');
  return readJSON(path.join(projectsDir, id, 'session.json'));
}

async function start(values) {
  // ponytail: the trace keeps one old file; 5 MB is weeks of recordings.
  await fs.stat(traceFile).then(stat => stat.size > 5e6 && fs.rename(traceFile, traceFile.replace(/\.log$/, '.old.log')), () => {});
  const {capture, name, countdown, then} = captureOptions(values);
  // Scripted captures are timed on purpose (waiting can be the point): no idle cuts.
  if (then.seconds) capture.scripted = true;
  // A terminal recording is a browser recording of the justrec terminal's page. Its pauses
  // are reading time (no idle cuts) and it has no mouse (no pointer drawn).
  if (capture.browser?.terminal) {
    Object.assign(capture, {scripted: true, terminal: true});
    const terminal = await readJSON(path.join(outputDir, '.terminal.json')).catch(() => { throw new Error('Open the terminal first: justrec terminal open'); });
    capture.browser = {tab: `127.0.0.1:${terminal.port}`};
  }
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
  trace('cli', `start, ${(performance.now() / 1000).toFixed(2)} s after node began`);
  const binary = capture.browser ? process.execPath : await build();
  const binaryArgs = capture.browser ? [path.join(root, 'lib/browser.mjs'), 'record'] : [];
  if (capture.browser && (capture.systemAudio || capture.microphone)) capture.recBinary = await build();
  // A short id the user can hand to an agent ("edit project 3f9a1c2e"); every file of the recording lives in its folder.
  const id = randomUUID().slice(0, 8);
  trace('cli', `${id} recorder ready (${path.basename(binary)}), starting the session`);
  const directory = path.join(projectsDir, id);
  await fs.mkdir(directory, {recursive: true, mode: 0o700});
  const output = path.join(directory, 'recording.mp4');
  const configFile = path.join(directory, 'config.json');
  await writeJSON(configFile, {id, name, output, capture, binary, binaryArgs, requested: performance.timeOrigin / 1000});
  if (countdown) { console.error(`Recording begins in ${countdown} seconds`); await sleep(countdown * 1000); }
  const log = await fs.open(path.join(directory, 'worker.log'), 'a');
  const child = spawn(process.execPath, [path.join(root, 'lib/session.mjs'), configFile], {detached: true, stdio: ['ignore', log.fd, log.fd]});
  child.unref(); await log.close();
  const deadline = Date.now() + 50000;
  while (Date.now() < deadline) {
    const state = await readJSON(path.join(directory, 'session.json')).catch(() => null);
    if (state?.state === 'error') { trace('cli', `${id} failed: ${state.error}`); throw new Error(state.error); }
    if (state?.state === 'recording') {
      trace('cli', `${id} recording, ${(performance.now() / 1000).toFixed(2)} s after node began`);
      await writeJSON(latestFile, {id});
      return {...state, token: undefined};
    }
    await sleep(100);
  }
  trace('cli', `${id} gave up waiting`);
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
    if (state.state === 'error') throw new Error(`Recording failed: ${state.error}. Partial files: ${path.join(projectsDir, state.id)}`);
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
    if (!args[0]) throw new Error('Usage: justrec captions <project|video>');
    const {findProject, loadProject} = await import('./project.mjs');
    const input = await fs.access(path.resolve(args[0])).then(() => path.resolve(args[0]), async () => {
      const {directory, project} = await loadProject(await findProject(args[0]));
      return path.resolve(directory, project.source);
    });
    const base = path.basename(input, path.extname(input));
    await run('uvx', ['--from', 'mlx-whisper', 'mlx_whisper', input, '--model', process.env.JUSTREC_WHISPER_MODEL || 'mlx-community/whisper-large-v3-turbo', '--output-format', 'all', '--word-timestamps', 'True', '--output-dir', path.dirname(input), '--output-name', base]);
    print({srt: path.join(path.dirname(input), `${base}.srt`), transcript: path.join(path.dirname(input), `${base}.json`)});
  } else if (command === 'film') {
    if (!args[0]) throw new Error('Usage: justrec film <film.json> [--preview | --live] [--out file.mp4] [--no-check]');
    if (args.includes('--live')) await (await import('./film.mjs')).serveLive(args[0], {open: !args.includes('--no-open')});
    else {
      const options = {preview: args.includes('--preview'), check: !args.includes('--no-check')};
      if (args.includes('--out')) options.output = args[args.indexOf('--out') + 1];
      print(await (await import('./film.mjs')).renderFilm(args[0], options));
    }
  } else if (command === 'frames') {
    // Look at a film frame by frame, before or after export: one labelled image.
    if (!args[0]) throw new Error('Usage: justrec frames <film.json> [--scene n | --from s --to s | --at s,s,...] [--every s] [--out file.png]');
    const value = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
    const frames = {scene: value('--scene') && Number(value('--scene')), from: value('--from') && Number(value('--from')), to: value('--to') && Number(value('--to')),
      every: value('--every') && Number(value('--every')), at: value('--at')?.split(',').map(Number), output: value('--out') && path.resolve(value('--out'))};
    print(await (await import('./film.mjs')).renderFilm(args[0], {frames}));
  } else if (command === 'install') {
    print(await (await import('./app.mjs')).installCommand(args));
  } else if (command === 'uninstall') {
    print(await (await import('./app.mjs')).uninstallCommand());
  } else if (command === 'shot') {
    print(await (await import('./shot.mjs')).shotCommand(args));
  } else if (command === 'voice') {
    print(await (await import('./voice.mjs')).voiceCommand(args));
  } else if (command === 'terminal') {
    print(await (await import('./terminal.mjs')).terminalCommand(args));
  } else if (command === 'styles') {
    print(await (await import('./style.mjs')).listStyles());
  } else if (command === 'schema') {
    const {schemaFile} = await import('./film.mjs');
    console.log(args.includes('--path') ? schemaFile : await fs.readFile(schemaFile, 'utf8'));
  } else if (command === 'check') {
    // Re-check a rendered film without rendering again.
    if (!args[0]) throw new Error('Usage: justrec check <film.json>');
    const {readJSON: read} = await import('./common.mjs');
    const film = path.resolve(args[0]);
    const film_ = await read(film);
    const output = path.resolve(path.dirname(film), film_.output || path.basename(film).replace(/(\.film)?\.json$/, '.mp4'));
    const report = await read(`${output}.report.json`).catch(() => { throw new Error(`Render the film first: justrec film ${args[0]}`); });
    print(await (await import('./check.mjs')).checkFilm(report));
  } else if (command === 'browser') print(await (await import('./browser.mjs')).browserCommand(args));
  else if (command === 'ui') {
    await (await import('./ui.mjs')).serveUI({open: !args.includes('--no-open'), project: args.includes('--project') ? args[args.indexOf('--project') + 1] : null});
  } else if (command === 'project') {
    if (!args[0]) throw new Error('Usage: justrec project <video> | rename <id> <name> | remove <id>');
    const {createProject, renameProject, removeProject} = await import('./project.mjs');
    if (args[0] === 'rename') print(await renameProject(args[1], args.slice(2).join(' ')));
    else if (args[0] === 'remove') print(await removeProject(args[1]));
    else print(await createProject(args[0]));
  } else if (command === 'edit') {
    if (!args[0]) throw new Error('Usage: justrec edit <project> [options]');
    const {editProject, findProject} = await import('./project.mjs');
    print(await editProject(await findProject(args[0]), args.slice(1)));
  } else if (command === 'render' || command === 'preview') {
    if (!args[0]) throw new Error(`Usage: justrec ${command} <project>`);
    const file = await (await import('./project.mjs')).findProject(args[0]);
    const options = command === 'preview' ? {frame: 0, output: file.replace(/\.json$/, '.preview.png')} : {};
    for (let index = 1; index < args.length; index += 2) {
      if (args[index] === '--out') options.output = args[index + 1];
      else if (args[index] === '--frame' && command === 'preview') options.frame = Number(args[index + 1]);
      else throw new Error(`Unknown render option: ${args[index]}`);
    }
    print(await (await import('./render.mjs')).renderProject(file, options));
  } else throw new Error(`Unknown command: ${command}\n${help}`);
} catch (error) { console.error(JSON.stringify({error: error.message})); process.exitCode = 1; }
