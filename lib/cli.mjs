import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {root, outputDir, projectsDir, build, run, readJSON, writeJSON, request, sleep, trace, traceFile, stepLog, python} from './common.mjs';

// Old commands (before record / project / app) still work: the panel, the ⌘1/⌘2 helper and ciak.app call some of them.
const moved = {
  start: rest => ['record', ...rest],
  ...Object.fromEntries(['stop', 'pause', 'resume', 'status', 'mark', 'sources'].map(name => [name, rest => ['record', name, ...rest]])),
  ...Object.fromEntries(['edit', 'render', 'preview', 'captions', 'frames', 'check', 'schema', 'styles'].map(name => [name, rest => ['project', name, ...rest]])),
  film: rest => ['project', rest.includes('--live') ? 'live' : rest.includes('--preview') ? 'preview' : 'render', ...rest.filter(item => !['--live', '--preview'].includes(item))],
  browser: rest => ['record', ...(!rest[0] || rest[0].startsWith('--') || /^(https?|file):/.test(rest[0]) ? ['open'] : []), ...rest],
  terminal: rest => ['record', ...(['open', 'close'].includes(rest[0]) ? [rest[0], 'terminal', ...rest.slice(1)] : rest)],
  ui: rest => ['app', 'panel', ...rest], install: rest => ['app', 'install', ...rest], update: rest => ['app', 'update', ...rest], uninstall: rest => ['app', 'uninstall', ...rest],
};
let [command = 'help', ...args] = process.argv.slice(2);
if (moved[command]) [command, ...args] = moved[command](args);
const [action, ...rest] = args;
if (command !== 'help') trace('cli', [command, ...args].join(' '));
const print = value => console.log(JSON.stringify(value, null, 2));
const latestFile = path.join(projectsDir, 'latest.json');
const value = (list, name) => list.includes(name) ? list[list.indexOf(name) + 1] : undefined;

const helps = {
  help: `🎬 ciak — record your screen, then let an agent edit it. Every command prints JSON.

  ciak record    make a video: the screen, a window, the ciak browser or a terminal, and act in it
  ciak project   what you made: list, edit, render. A project is one recording or a film of many scenes
  ciak shot      framed screenshots
  ciak voice     your own voices, for narration
  ciak app       the menu bar app (⌘1 screenshot, ⌘2 record) and the panel

  ciak <word> help    each one in full, with examples. This help is the documentation: read it first.

How it fits: \`record … stop\` makes a project and prints its id. Recordings are cut (idle time) and zoomed (on
clicks) when they stop, so \`ciak project render <id>\` already gives a good video. A film is a project too: its
film.json lists scenes (recordings, titles, pictures, numbers) with narration. Projects live in
~/.ciak/projects/<id>/, finished videos in ~/Documents/ciak/<name>-<id>.mp4. The user watches it all in the panel
and names projects by id ("edit project 3f9a1c2e: …").

Before saying done: look at 2–3 frames of the result; when someone talked, check the sound
(ffmpeg -i <video> -vn -af volumedetect -f null - → mean_volume well above -60 dB). Report the video's path.
If a capture says the user declined, the Screen Recording or Microphone permission is missing: say which app
needs it, don't work around it. Every ciak process logs what it does, with times, to ~/.ciak/trace.log.
`,
  record: `ciak record — make a video. Each recording becomes a project: stop prints its id.

Start one (the options below work with each):
  ciak record screen [index]          a whole display (ciak record sources lists displays, windows, mics, cameras)
  ciak record window <id>             one window; keep it visible, a covered window stops updating
  ciak record region x,y,w,h          part of a display, in points
  ciak record browser [url]           the ciak browser: a copy of your browser with your logins, recorded inside the page,
                                      so it records fine while covered. The best way for an agent to record itself
  ciak record terminal [--blur re]    your own zsh in the ciak browser; --blur hides matching text (API keys),
                                      --color 'word=#5bb0ff,#22d3c5' paints a word (a brand) in one color or a gradient

  --name <name>   --mic <name|default>   --system-audio (the browser: only its sound)   --camera <name|default>
  --fps 24|30|60  --countdown <s>   --no-zoom (no zoom on clicks)   --max-width <px>   --native-cursor
  browser only:   --hide <text> (hides the row holding it)  --blur <regex>  (both repeatable)
                  --run <js> --for <s> (one step: run a trigger, record s seconds, stop)

While it records:
  ciak record stop | pause | resume | status [id]
  ciak record mark <label> [--at x,y]     a moment to zoom on (x,y from 0 to 1); browser clicks mark themselves

Act in the ciak browser. It all works without recording too, to set a page up first.
The mouse glides and text is typed like a person, so the video looks real:
  ciak record open <url>                  a new tab (starts the browser; --refresh-login copies your logins again)
  ciak record look                        the page's buttons, links and fields, numbered, and its text
  ciak record click <target>              target = a number from look, visible text, or a CSS selector
  ciak record type [<target>] "text"      click a field, replace what it holds, type (\\n = new line)
  ciak record paste [<target>] "text"     long text at once, like ⌘V
  ciak record key Enter                   Enter Tab Escape Backspace Space ArrowUp/Down/Left/Right
  ciak record wait "text" [--gone] [--timeout s]   until the text (or a CSS selector) shows up, or goes
  ciak record scroll [px] | hover <target> | drag <from> <to> | select <target> <option> | upload <file> [<target>]
  ciak record go <url> | back | forward | tabs | switch <tab> | shot [file.png] | eval <js>
  ciak record mask --hide <text> --blur <regex>   hide things on the page (before a shot)

Act in the terminal:
  ciak record open terminal [--blur re] [--cwd dir] [--title t]   (record terminal opens it too)
  ciak record run "<command>" [--timeout s]   types it key by key, waits, returns output and exit code
  ciak record send "text"                 types into what runs now (claude, a prompt), no wait; \n = Enter
  ciak record close terminal

Rules:
  - An agent records itself in the ciak browser (record browser), never the user's own browser. It starts with the
    user's logins. When a site still asks to log in, ask the user to do it in the ciak browser's window (never
    type a password yourself): the ciak browser keeps it. open --refresh-login copies their logins again.
  - Look before you act: look, then click or type by number. After an action that loads something, wait "text",
    not sleep. Numbers expire when the page changes: look again.
  - Look like a person: viewers spot an agent at once (text that appears without typing, a jumping mouse, a page
    that snaps). Act only with click/type/paste/scroll/select/drag, never with eval. Short text: type; long: paste.
    Give the viewer a beat (sleep 1) after each result.
  - Keep secrets out: --hide/--blur when starting, mask before a shot. Terminal: --blur, and pass keys through the
    environment (KEY=$(cat f) ciak record terminal --blur 'hsk_\\w+'), never type them.
  - Screen and window recordings show the real screen: anything on it ends up in the video.

Example:
  ciak record browser https://en.wikipedia.org --name wiki
  ciak record look; ciak record type 3 "Clapperboard"; ciak record key Enter; ciak record wait "Clapperboard"
  ciak record stop                        → {"id": "3f9a1c2e", …}: ciak project render 3f9a1c2e
`,
  project: `ciak project — what you made. A project is a video: one recording, or a film of many scenes
(recordings, titles, pictures, numbers) narrated in a voice. Give a project by id or by name (newest wins).

  ciak project list                        every project, newest first
  ciak project show <id>                   its kind, files and finished video
  ciak project render <id> [--out file]    the finished video, checked → ~/Documents/ciak/<name>-<id>.mp4
  ciak project preview <id> [--frame n]    a recording: one frame. A film: a picture per scene + a layout check
  ciak project rename <id> <name> | remove <id>   (remove moves it to the Trash)

A recording (it is cut and zoomed when it stops; change it with edit):
  ciak project edit <id> [options]   several options in one call, then render:
    --cut-idle (still picture, nobody talks)  --cut-silence (pauses in speech)  --cut start,end  --reset
    --auto-zoom  --zooms on|off  --clicks on|off  --keys on|off (typing sounds; on for terminals)  --mic|--system-audio|--webcam on|off
    --speed 1.5 (whole video, 0.5–4) | --speed 2,start,end (one part)    --preset landscape|vertical|square
    --background aurora|sunset|ocean|meadow|graphite|midnight|<css>     --camera round=on,size=0.22,position=bottom-right
  ciak project captions <id>               a transcript with word times (only when someone talks)
  Times are in the recording's own seconds; anything else is a direct edit of its recording.project.json.

A film:
  ciak project new <name> [--with <id>,<id>]   a new film; --with starts it with those recordings as scenes
  ciak project schema [--path]             every film.json field, described: read it before writing a film
  ciak project styles                      looks for films (yours: ~/.ciak/styles)
  ciak project live <id>                   play it in the browser now, no export; reloads on every save
  ciak project frames <id> [--scene n | --from s --to s | --at s,s] [--every s]   labelled frames in one picture
  ciak project check <id>                  the check of the last render again (render runs it)

Rules:
  - Times the user says ("at 1:20") are in the rendered video: map them back to the recording's own seconds
    through clips (and their speed) before editing.
  - Test renders take --out <file>, so the user's finished video isn't replaced.
  - vertical fits a wide recording into a thin strip with small text: zoom on what matters, and tell the user.
  - Films: the schema is the reference (unknown fields are errors with a "did you mean"). In text, *muted words*
    render grey and [accent words] in the accent color. Write "say" as plain spoken sentences, numbers spelled as
    they are read, and only real numbers. "voice": {"name": "me"} speaks in the user's voice (ciak voice list);
    "pronounce" fixes names. Record enough: a scene longer than its recording freezes on the last frame. Keep
    browser recordings at speed 1–1.25. Never slowly zoom into a recording or a screenshot: it looks cheap.
    A scene with its own layout is a React + Remotion component ("type": "custom", see the schema).
  - Loop: preview (~20 s), then render. Always read the check at the end of a render: each issue has a time, a
    scene and a frame to look at. Fix and render again until it is empty.

Example:
  ciak project new launch --with wiki      → {"id": "7c1e09aa", "film": "…/film.json"}: write the scenes, then
  ciak project preview launch; ciak project render launch
`,
  app: `ciak app — this Mac.

  ciak app install [--key cmd+1]   once: ciak.app in the menu bar (⌘1 screenshot, ⌘2 quick recording, Record…),
                                    starts at login; links the ciak command and the skill for agents
  ciak app update                  the latest ciak from GitHub, then install again
  ciak app uninstall               (keeps your projects, voices and videos)
  ciak app panel [--no-open] [--project <id> | --shots]   the panel: projects, screenshots, voices
`,
};
helps.shot = `ciak shot — framed screenshots (⌘1 does the same).

  ciak shot [--background b] [--plain] [--from file.png] [--no-copy]   pick an area or a window: framed, saved, copied
  ciak shot list | copy <file> | remove <file>                          the ones in ~/Documents/ciak/shots
  An agent's own: ciak record shot page.png, then ciak shot --from page.png --no-copy. Remove only when the user asks.
`;
helps.voice = `ciak voice — your own voices, made on this Mac from a 15 second sample.

  ciak voice add <name> [--from file]   read a text aloud (or give a recording); first use downloads a ~4 GB model
  ciak voice list | remove <name>
  ciak voice say <name> "text" [--out file.wav]
  A film speaks in one with "voice": {"name": "<name>"}.
  voice add records the mic: ask the user first and tell them when to start reading.
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
  // A terminal recording is a browser recording of the ciak terminal's page. Its pauses
  // are reading time (no idle cuts) and it has no mouse (no pointer drawn).
  if (capture.browser?.terminal) {
    Object.assign(capture, {scripted: true, terminal: true});
    const terminal = await readJSON(path.join(outputDir, '.terminal.json')).catch(() => { throw new Error('Open the terminal first: ciak record open terminal'); });
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

const browserActions = ['open', 'look', 'click', 'type', 'paste', 'key', 'wait', 'scroll', 'hover', 'drag', 'select', 'upload', 'go', 'back', 'forward', 'tabs', 'switch', 'shot', 'mask', 'eval'];
const terminalOptions = ['--blur', '--color', '--cwd', '--title', '--font-size'];

// ciak record <place> [value] [options]: the place becomes the capture options start() reads.
async function record() {
  const values = [...rest];
  const next = () => values[0] && !values[0].startsWith('--') ? values.shift() : undefined;
  if (action === 'screen') return start(['--display', next() ?? '0', ...values]);
  if (action === 'window' || action === 'region') {
    const where = next();
    if (!where) throw new Error(`Usage: ciak record ${action} ${action === 'window' ? '<id> (ciak record sources)' : 'x,y,width,height'}`);
    return start([`--${action}`, where, ...values]);
  }
  if (action === 'browser') { const url = next(); return start(['--browser', ...(url ? ['--url', url] : []), ...values]); }
  if (action === 'terminal') {
    // Its own options open a fresh terminal; otherwise the open one is recorded (or a new one opened).
    const own = values.flatMap((item, index) => terminalOptions.includes(item) ? [item, values[index + 1]] : []);
    const others = values.filter((item, index) => !terminalOptions.includes(item) && !terminalOptions.includes(values[index - 1]));
    const {terminalCommand, terminalState} = await import('./terminal.mjs');
    if (own.length || !await terminalState()) await terminalCommand(['open', ...own]);
    return start(['--terminal', ...others]);
  }
  // The panel and the ⌘2 helper pass the capture options themselves.
  if (!action || action.startsWith('--')) return start(args);
  throw new Error(`Unknown: ciak record ${action}\n${helps.record}`);
}

async function project() {
  const projects = await import('./project.mjs');
  if (action === 'list') return projects.listProjects();
  if (action === 'new') return projects.newFilm(rest.filter((item, index) => item !== '--with' && rest[index - 1] !== '--with').join(' '), value(rest, '--with')?.split(',') || []);
  if (action === 'schema') { const {schemaFile} = await import('./film.mjs'); return rest.includes('--path') ? schemaFile : JSON.parse(await fs.readFile(schemaFile, 'utf8')); }
  if (action === 'styles') return (await import('./style.mjs')).listStyles();
  if (!rest[0]) throw new Error(`Usage: ciak project ${action || '<command>'} <id>\n${helps.project}`);
  if (action === 'rename') return projects.renameProject((await projects.openProject(rest[0])).id, rest.slice(1).join(' '));
  if (action === 'remove') return projects.removeProject((await projects.openProject(rest[0])).id);
  const found = await projects.openProject(rest[0]);
  const options = rest.slice(1);
  const film = found.kind === 'film';
  const only = kind => { if (found.kind !== kind) throw new Error(`ciak project ${action} is for a ${kind}; ${rest[0]} is a ${found.kind}${film ? ': edit its film.json, ' + found.file : ''}`); };
  if (action === 'show') return found.id ? {...await projects.describeProject(found.id), folder: found.folder} : found;
  if (action === 'edit') { only('recording'); return projects.editProject(found.file, options); }
  if (action === 'captions') {
    only('recording');
    const {directory, project: loaded} = await projects.loadProject(found.file);
    const input = path.resolve(directory, loaded.source), base = path.basename(input, path.extname(input));
    await python(['-m', 'mlx_whisper.cli', input, '--model', process.env.CIAK_WHISPER_MODEL || 'mlx-community/whisper-large-v3-turbo', '--output-format', 'all', '--word-timestamps', 'True', '--output-dir', path.dirname(input), '--output-name', base]);
    return {srt: path.join(path.dirname(input), `${base}.srt`), transcript: path.join(path.dirname(input), `${base}.json`)};
  }
  if (action === 'render' || action === 'preview') {
    const output = value(options, '--out');
    if (!film) {
      const settings = action === 'preview' ? {frame: Number(value(options, '--frame') || 0), output: output || found.file.replace(/\.json$/, '.preview.png')} : {output};
      return (await import('./render.mjs')).renderProject(found.file, settings);
    }
    const make = () => import('./film.mjs').then(({renderFilm}) => renderFilm(found.file, {preview: action === 'preview', output, check: !options.includes('--no-check')}));
    if (action === 'preview' || !found.id || output) return make();
    // The panel shows the render running, and the finished video.
    return stepLog(found.folder, 'render')('Render the film', async () => projects.publishFilm(found.id, await make()));
  }
  only('film');
  if (action === 'live') return (await import('./film.mjs')).serveLive(found.file, {open: !options.includes('--no-open')});
  if (action === 'frames') {
    const number = name => value(options, name) && Number(value(options, name));
    const frames = {scene: number('--scene'), from: number('--from'), to: number('--to'), every: number('--every'), at: value(options, '--at')?.split(',').map(Number), output: value(options, '--out') && path.resolve(value(options, '--out'))};
    return (await import('./film.mjs')).renderFilm(found.file, {frames});
  }
  if (action === 'check') {
    const {output} = await (await import('./film.mjs')).filmOutput(found.file);
    const report = await readJSON(`${output}.report.json`).catch(() => { throw new Error(`Render it first: ciak project render ${rest[0]}`); });
    return (await import('./check.mjs')).checkFilm(report);
  }
  throw new Error(`Unknown: ciak project ${action}\n${helps.project}`);
}

try {
  if (['help', '--help', '-h'].includes(command)) console.log(helps.help);
  else if (helps[command] && (action === 'help' || args.includes('--help') || args.includes('-h'))) console.log(helps[command]);
  else if (command === 'record') {
    if (!action) console.log(helps.record);
    else if (action === 'sources') print(JSON.parse(await run(await build(), ['sources'])));
    else if (['status', 'stop', 'pause', 'resume'].includes(action)) {
      const state = await getSession(rest[0]);
      if (state.state === 'error') throw new Error(`Recording failed: ${state.error}. Partial files: ${path.join(projectsDir, state.id)}`);
      if (state.state === 'saved') print({...state, token: undefined});
      else print(await request(state, action));
    } else if (action === 'mark') {
      const [label, ...options] = rest;
      let id; const body = {label};
      for (let index = 0; index < options.length; index += 2) {
        if (options[index] === '--id') id = options[index + 1];
        else if (options[index] === '--at') [body.x, body.y] = options[index + 1].split(',').map(Number);
        else if (options[index] === '--page') body.page = options[index + 1].split(',').map(Number);
        else throw new Error(`Unknown marker option: ${options[index]}`);
      }
      print(await request(await getSession(id), 'mark', body));
    } else if (action === 'open' && rest[0] === 'terminal') print(await (await import('./terminal.mjs')).terminalCommand(['open', ...rest.slice(1)]));
    else if (action === 'close' && rest[0] === 'terminal') print(await (await import('./terminal.mjs')).terminalCommand(['close']));
    else if (action === 'run' || action === 'send') print(await (await import('./terminal.mjs')).terminalCommand(args));
    else if (browserActions.includes(action)) print(await (await import('./browser.mjs')).browserCommand(args));
    else print(await record());
  } else if (command === 'project') {
    if (!action) console.log(helps.project);
    else if (action === 'live') await project();
    else print(await project());
  } else if (command === 'app') {
    if (action === 'install') print(await (await import('./app.mjs')).installCommand(rest));
    else if (action === 'uninstall') print(await (await import('./app.mjs')).uninstallCommand());
    else if (action === 'update') print(await (await import('./app.mjs')).updateCommand());
    else if (action === 'panel') await (await import('./ui.mjs')).serveUI({open: !rest.includes('--no-open'), project: value(rest, '--project') || null, shots: rest.includes('--shots')});
    else console.log(helps.app);
  } else if (command === 'shot') print(await (await import('./shot.mjs')).shotCommand(args));
  else if (command === 'voice') print(await (await import('./voice.mjs')).voiceCommand(args));
  else throw new Error(`Unknown command: ${command}\n${helps.help}`);
} catch (error) { console.error(JSON.stringify({error: error.message})); process.exitCode = 1; }
