// The justrec browser: a second Brave on a copy of the user's profile (so it is logged in),
// started so it keeps drawing when covered, driven and recorded over Chrome's debugging port.
import fs from 'node:fs/promises';
import path from 'node:path';
import {run, sleep, readJSON, writeJSON, x264, launch} from './common.mjs';

const port = Number(process.env.JUSTREC_BROWSER_PORT || 9333);
const app = process.env.JUSTREC_BROWSER_APP || '/Applications/Brave Browser.app';
const sourceProfile = process.env.JUSTREC_BROWSER_SOURCE || path.join(process.env.HOME, 'Library/Application Support/BraveSoftware/Brave-Browser');
const profile = process.env.JUSTREC_BROWSER_PROFILE || path.join(process.env.HOME, 'Library/Application Support/justrec/browser');
const base = `http://127.0.0.1:${port}`;

const running = () => fetch(`${base}/json/version`, {signal: AbortSignal.timeout(1000)}).then(() => true, () => false);

async function copyProfile() {
  await fs.rm(profile, {recursive: true, force: true});
  await fs.mkdir(profile, {recursive: true, mode: 0o700});
  // -c clones files (APFS): instant and takes no extra space.
  await run('cp', ['-cR', path.join(sourceProfile, 'Default'), path.join(profile, 'Default')]);
  await run('cp', ['-c', path.join(sourceProfile, 'Local State'), profile]);
  for (const name of ['Sessions', 'Current Session', 'Current Tabs', 'Last Session', 'Last Tabs', 'Cache', 'Code Cache', 'Service Worker/CacheStorage', 'Service Worker/ScriptCache']) {
    await fs.rm(path.join(profile, 'Default', name), {recursive: true, force: true});
  }
  const preferences = path.join(profile, 'Default/Preferences');
  const values = await readJSON(preferences);
  Object.assign(values.profile ||= {}, {exit_type: 'Normal', exited_cleanly: true});
  await writeJSON(preferences, values);
}

export async function openBrowser({url = 'about:blank', refresh = false} = {}) {
  if (refresh && await running()) {
    await cdp((await (await fetch(`${base}/json/version`)).json()).webSocketDebuggerUrl).then(browser => browser.send('Browser.close')).catch(() => {});
    for (let tries = 0; tries < 50 && await running(); tries++) await sleep(100);
  }
  if (!await running()) {
    if (refresh || !await fs.access(path.join(profile, 'Default')).then(() => true, () => false)) await copyProfile();
    await run('open', ['-g', '-n', '-a', app, '--args', `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`,
      '--no-first-run', '--no-default-browser-check', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
      // 2x drawing keeps text sharp on non-Retina monitors and when zoomed in.
      '--disable-background-timer-throttling', '--disable-features=MacWebContentsOcclusion', '--force-device-scale-factor=2', '--autoplay-policy=no-user-gesture-required', '--window-size=1440,900', 'about:blank']);
    for (let tries = 0; !await running(); tries++) { if (tries > 150) throw new Error(`Browser did not start: ${app}`); await sleep(100); }
  }
  const tab = await (await fetch(`${base}/json/new?${encodeURI(url)}`, {method: 'PUT'})).json();
  await fetch(`${base}/json/activate/${tab.id}`);
  for (const other of await pages()) if (other.id !== tab.id && other.url === 'about:blank') await fetch(`${base}/json/close/${other.id}`);
  // Return only once the page has loaded, so the next command (eval, click) finds it ready.
  const page = await cdp(tab.webSocketDebuggerUrl);
  try {
    for (let tries = 0; tries < 150; tries++) {
      const ready = await evaluate(page, 'document.readyState').catch(() => null);
      if (ready === 'complete') break;
      await sleep(100);
    }
  } finally { page.close(); }
  return {port, tab: {id: tab.id, url: tab.url}, profile};
}

async function pages() {
  const list = await (await fetch(`${base}/json/list`).catch(() => { throw new Error('justrec browser is not running; start it with: justrec browser <url>'); })).json();
  return list.filter(target => target.type === 'page' && !target.url.startsWith('chrome-extension://') && !target.url.startsWith('devtools://'));
}

// The tab justrec drives and records: the most recently activated page.
async function currentPage(match) {
  const list = await pages();
  const page = match ? list.find(item => item.id === match || item.url.includes(match) || item.title.includes(match)) : list[0];
  if (!page) throw new Error(match ? `No tab matches ${match}` : 'The justrec browser has no open tab');
  return page;
}

async function cdp(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = () => reject(new Error('Cannot connect to the justrec browser')); });
  let counter = 0;
  const waiting = new Map();
  const listeners = [];
  socket.onmessage = ({data}) => {
    const message = JSON.parse(data);
    if (message.id && waiting.has(message.id)) {
      const {resolve, reject} = waiting.get(message.id); waiting.delete(message.id);
      message.error ? reject(new Error(message.error.message)) : resolve(message.result);
    } else for (const listener of listeners) listener(message);
  };
  return {
    send: (method, params = {}) => new Promise((resolve, reject) => { waiting.set(++counter, {resolve, reject}); socket.send(JSON.stringify({id: counter, method, params})); }),
    on: listener => listeners.push(listener),
    close: () => socket.close(),
  };
}

async function evaluate(page, expression) {
  const result = await page.send('Runtime.evaluate', {expression, awaitPromise: true, returnByValue: true, userGesture: true});
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result.value;
}

const keys = {Enter: 13, Tab: 9, Escape: 27, Backspace: 8, ArrowDown: 40, ArrowUp: 38, ArrowLeft: 37, ArrowRight: 39, Space: 32};

// Find an element by CSS selector, or by its visible text; scroll it into view; return its center.
const locate = (target, field) => `(async () => {
  const wanted = ${JSON.stringify(target)};
  let element = null;
  try { element = document.querySelector(wanted); } catch {}
  if (!element) {
    // A page can have many "Save changes": prefer enabled ones, then the ones on screen.
    const rank = item => { const box = item.getBoundingClientRect(); return (item.disabled ? 0 : 2) + (box.bottom > 0 && box.top < innerHeight && box.width > 0 ? 1 : 0); };
    const all = [...document.querySelectorAll('a, button, input, textarea, select, [role=button], [role=link], [role=tab], [role=menuitem], label, summary, [onclick]')]
      .sort((a, b) => rank(b) - rank(a));
    element = all.find(item => (item.innerText || item.value || item.getAttribute('aria-label') || item.placeholder || '').trim() === wanted)
      || all.find(item => (item.innerText || item.value || item.getAttribute('aria-label') || item.placeholder || '').toLowerCase().includes(wanted.toLowerCase()));
  }
  // Rows and cards are often clickable through script handlers: any visible element with that
  // exact text, the smallest one.
  if (!element) element = [...document.querySelectorAll('body *')].filter(item => item.offsetParent !== null && (item.innerText || '').trim() === wanted)
    .sort((a, b) => a.innerText.length - b.innerText.length || b.querySelectorAll('*').length - a.querySelectorAll('*').length).at(0);
  if (!element) throw new Error('Nothing on the page matches: ' + wanted);
  element.scrollIntoView({block: 'center', inline: 'center', behavior: 'smooth'});
  // Long smooth scrolls take a while: wait until the element stops moving (at most 2 s).
  let box = element.getBoundingClientRect();
  for (let tries = 0; tries < 20; tries++) {
    await new Promise(resolve => setTimeout(resolve, 100));
    const next = element.getBoundingClientRect();
    if (tries >= 3 && next.top === box.top && next.left === box.left) break;
    box = next;
  }
  // A text field is clicked near its start, where the typed text shows (and the zoom lands).
  const field = ${field ? 'true' : 'false'};
  return {x: box.x + (field ? Math.min(box.width / 2, 60) : box.width / 2), y: box.y + (field ? Math.min(box.height / 2, 22) : box.height / 2), from: window.__justrecMouse || {x: innerWidth / 2, y: innerHeight / 2}};
})()`;

async function click(page, target, field = false) {
  const {x, y, from} = await evaluate(page, locate(target, field));
  // Glide the mouse there so the recording shows a natural cursor path.
  const steps = 20;
  for (let step = 1; step <= steps; step++) {
    const amount = step / steps; const smooth = amount * amount * (3 - 2 * amount);
    await page.send('Input.dispatchMouseEvent', {type: 'mouseMoved', x: from.x + (x - from.x) * smooth, y: from.y + (y - from.y) * smooth});
    await sleep(16);
  }
  await sleep(150);
  await page.send('Input.dispatchMouseEvent', {type: 'mousePressed', x, y, button: 'left', clickCount: 1});
  await sleep(60);
  await page.send('Input.dispatchMouseEvent', {type: 'mouseReleased', x, y, button: 'left', clickCount: 1});
  await evaluate(page, `window.__justrecMouse = ${JSON.stringify({x, y})}`).catch(() => {});
  return {clicked: target, x: Math.round(x), y: Math.round(y)};
}

// justrec browser <action> ...: small, predictable driving commands for agents.
export async function browserCommand(args) {
  const [action, ...rest] = args;
  if (!action || /^(https?|file):/.test(action) || action === 'open') return openBrowser({url: action === 'open' ? rest[0] : action, refresh: args.includes('--refresh-login')});
  if (action === '--refresh-login') return openBrowser({url: rest[0], refresh: true});
  if (action === 'tabs') return (await pages()).map(({id, url, title}) => ({id, url, title}));
  const target = await currentPage();
  const page = await cdp(target.webSocketDebuggerUrl);
  try {
    if (action === 'go') {
      await page.send('Page.enable');
      const loaded = new Promise(resolve => page.on(message => message.method === 'Page.loadEventFired' && resolve()));
      await page.send('Page.navigate', {url: rest[0]});
      await Promise.race([loaded, sleep(15000)]);
      return {url: rest[0]};
    }
    if (action === 'click') return await click(page, rest.join(' '));
    if (action === 'type') {
      const [into, ...words] = rest.length > 1 ? rest : [null, ...rest];
      if (into) await click(page, into, true);
      for (const character of words.join(' ')) { await page.send('Input.insertText', {text: character}); await sleep(45); }
      return {typed: words.join(' ')};
    }
    if (action === 'key') {
      const key = rest[0];
      if (!keys[key]) throw new Error(`Key must be one of ${Object.keys(keys).join(', ')}`);
      const event = {key: key === 'Space' ? ' ' : key, code: key, windowsVirtualKeyCode: keys[key], text: key === 'Enter' ? '\r' : key === 'Space' ? ' ' : undefined};
      await page.send('Input.dispatchKeyEvent', {...event, type: 'keyDown'});
      await page.send('Input.dispatchKeyEvent', {...event, type: 'keyUp'});
      return {pressed: key};
    }
    if (action === 'scroll') {
      await evaluate(page, `window.scrollBy({top: ${Number(rest[0] || 600)}, behavior: 'smooth'})`);
      await sleep(600);
      return {scrolled: Number(rest[0] || 600)};
    }
    if (action === 'eval') return {value: await evaluate(page, rest.join(' '))};
    if (action === 'mask') {
      // Mask the current page (e.g. before a screenshot): --hide <text> and --blur <pattern>, repeatable.
      const mask = {hide: [], blur: []};
      for (let index = 0; index < rest.length; index += 2) mask[rest[index].replace(/^--/, '')]?.push(rest[index + 1]);
      await evaluate(page, maskScript(mask) || 'null');
      await sleep(150);
      return {masked: mask};
    }
    if (action === 'shot') {
      const output = path.resolve(rest[0] || 'browser.png');
      const {data} = await page.send('Page.captureScreenshot', {format: 'png'});
      await fs.writeFile(output, Buffer.from(data, 'base64'));
      return {screenshot: output, url: target.url, title: target.title};
    }
    throw new Error('Usage: justrec browser [url | open <url> | tabs | go <url> | click <selector or text> | type [<selector or text>] <text> | key <name> | scroll [px] | eval <js> | shot [file.png]] [--refresh-login]');
  } finally { page.close(); }
}

// Keep secrets and internal things out of a recording: blur text matching a pattern (API keys,
// balances) and hide the row holding some text (an internal model). Re-applied as the page changes.
export function maskScript({hide = [], blur = []}) {
  if (!hide.length && !blur.length) return null;
  return `(() => {
    if (window.__justrecMask) return; window.__justrecMask = true;
    const hide = ${JSON.stringify(hide)};
    const blur = ${JSON.stringify(blur)}.map(pattern => new RegExp(pattern));
    // The nearest repeated row: a list item, a table row, or an element with an identical sibling.
    const row = element => {
      for (let node = element; node && node !== document.body; node = node.parentElement) {
        if (/^(LI|TR)$/.test(node.tagName) || /row|option|listitem|tab/.test(node.getAttribute('role') || '')) return node;
        const twins = [...(node.parentElement?.children || [])].filter(other => other !== node && other.tagName === node.tagName && other.className === node.className);
        if (twins.length && node.textContent.length < 600) return node;
      }
      return element;
    };
    // Match on an element's whole text (sites split words into several text nodes, e.g. with
    // <wbr>), using the deepest element that still contains the match.
    const deepest = test => [...document.body.querySelectorAll('*')].filter(element => !/^(SCRIPT|STYLE)$/.test(element.tagName) && test(element.textContent) && ![...element.children].some(child => test(child.textContent)));
    const apply = () => {
      if (!document.body) return;
      for (const item of hide) for (const element of deepest(text => text.includes(item))) row(element).style.setProperty('display', 'none', 'important');
      for (const pattern of blur) for (const element of deepest(text => pattern.test(text.trim()))) element.style.setProperty('filter', 'blur(9px)', 'important');
      for (const field of document.querySelectorAll('input, textarea')) if (blur.some(pattern => pattern.test(field.value))) field.style.setProperty('filter', 'blur(9px)', 'important');
    };
    apply(); setInterval(apply, 200);
  })()`;
}

// Recorder process for one segment; speaks the same JSON-lines protocol as rec.swift.
async function record(configFile) {
  const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
  const options = await readJSON(configFile);
  const page = await cdp((await currentPage(options.browser.tab)).webSocketDebuggerUrl);
  const frames = `${options.output}.frames`;
  await fs.mkdir(frames, {recursive: true});
  const cursor = await fs.open(options.cursor, 'w');
  const list = [];
  let startedAt = null;
  let size;
  let first;
  const firstFrame = new Promise(resolve => { first = resolve; });
  page.on(async message => {
    if (message.method === 'Page.screencastFrame') {
      const {data, metadata, sessionId} = message.params;
      page.send('Page.screencastFrameAck', {sessionId}).catch(() => {});
      const now = Date.now() / 1000;
      startedAt ??= now;
      size ??= {width: metadata.deviceWidth, height: metadata.deviceHeight, scale: metadata.pageScaleFactor || 1};
      const file = path.join(frames, `${String(list.length).padStart(6, '0')}.jpg`);
      list.push({file, t: now - startedAt});
      await fs.writeFile(file, Buffer.from(data, 'base64'));
      first();
    } else if (message.method === 'Runtime.bindingCalled' && message.params.name === '__justrec' && startedAt) {
      const event = JSON.parse(message.params.payload);
      await cursor.write(JSON.stringify({...event, t: Date.now() / 1000 - startedAt, visible: true}) + '\n');
    }
  });
  // Report pointer moves and clicks from inside the page, whoever causes them.
  const probe = `(() => { if (window.__justrecProbe || !window.__justrec) return; window.__justrecProbe = true; let last = 0;
    let x = 0.5, y = 0.5;
    const send = (type, event) => { if (event.clientX !== undefined) [x, y] = [event.clientX / innerWidth, event.clientY / innerHeight]; window.__justrec(JSON.stringify({type, x, y})); };
    addEventListener('pointermove', event => { const now = performance.now(); if (now - last > 16) { last = now; send('move', event); } }, true);
    addEventListener('pointerdown', event => send('click', event), true);
    addEventListener('keydown', event => send('key', event), true);
    addEventListener('input', event => send('key', event), true); })()`;
  await page.send('Runtime.enable');
  await page.send('Runtime.addBinding', {name: '__justrec'});
  await page.send('Page.enable');
  await page.send('Page.addScriptToEvaluateOnNewDocument', {source: probe});
  await page.send('Runtime.evaluate', {expression: probe});
  const mask = maskScript(options.mask || {});
  if (mask) { await page.send('Page.addScriptToEvaluateOnNewDocument', {source: mask}); await page.send('Runtime.evaluate', {expression: mask}); await sleep(150); }
  await page.send('Page.startScreencast', {format: 'jpeg', quality: 92, maxWidth: options.maxWidth, maxHeight: 4320});
  // Nudge a repaint so a static page still sends its first frame.
  await page.send('Runtime.evaluate', {expression: 'document.documentElement.style.outline = "0px solid transparent"; requestAnimationFrame(() => document.documentElement.style.outline = "")'});
  if (await Promise.race([firstFrame.then(() => true), sleep(10000).then(() => false)]) === false) { emit({event: 'error', message: 'The browser tab sent no frames; is the tab open and loaded?'}); process.exit(1); }
  const audio = (options.systemAudio || options.microphone) && await recordAudio(page, options).catch(error => { emit({event: 'error', message: error.message}); process.exit(1); });
  emit({event: 'recording', startedAt});
  emit({event: 'capture', width: size.width * 2, height: size.height * 2, fps: options.fps, bounds: [0, 0, size.width, size.height]});
  await new Promise(resolve => { process.once('SIGTERM', resolve); process.once('SIGINT', resolve); });
  const end = Date.now() / 1000 - startedAt;
  await page.send('Page.stopScreencast').catch(() => {});
  page.close();
  await cursor.close();
  if (audio) { audio.child.kill('SIGTERM'); await audio.finished; }
  await sleep(100); // let pending frame writes finish
  // A frame lasts until the next one; the last until stop. Odd sizes are evened for H.264.
  const concat = list.map((frame, index) => `file '${frame.file}'\nduration ${((list[index + 1]?.t ?? end) - frame.t).toFixed(4)}`).join('\n') + `\nfile '${list.at(-1).file}'\n`;
  await fs.writeFile(`${frames}/list.txt`, concat);
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', `${frames}/list.txt`,
    '-vf', `scale=trunc(iw/2)*2:trunc(ih/2)*2,fps=${options.fps}`, '-fps_mode', 'cfr', '-t', String(end),
    ...x264, audio ? `${frames}/video.mp4` : options.output]);
  if (audio) {
    // Line the audio up with the first video frame; keep every audio track (the worker mixes them into one).
    const offset = audio.startedAt - startedAt;
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', `${frames}/video.mp4`,
      ...(offset >= 0 ? ['-itsoffset', String(offset)] : ['-ss', String(-offset)]), '-i', audio.file,
      '-map', '0:v', '-map', '1:a', '-c', 'copy', '-t', String(end), options.output]);
    await fs.rm(audio.file, {force: true});
  }
  await fs.rm(frames, {recursive: true, force: true});
  emit({event: 'finished', output: options.output});
}

// Sound of this browser only (not the rest of the Mac), plus the mic, via rec.swift in audio-only mode.
async function recordAudio(page, options) {
  // Brave starts its audio process on first use: open a stream once so it exists before capture starts.
  await page.send('Runtime.evaluate', {expression: '(async () => { const context = new AudioContext(); await context.resume(); await new Promise(resolve => setTimeout(resolve, 300)); await context.close(); })()', awaitPromise: true, userGesture: true});
  const own = (await run('pgrep', ['-f', '--', `--user-data-dir=${profile}`])).split('\n').filter(Boolean).map(Number);
  const processes = (await run('ps', ['-axo', 'pid=,ppid='])).trim().split('\n').map(line => line.trim().split(/\s+/).map(Number));
  const pids = [...new Set([...own, ...processes.filter(([, parent]) => own.includes(parent)).map(([pid]) => pid)])];
  const file = `${options.output}.audio.mp4`;
  const config = `${options.output}.audio.json`;
  await writeJSON(config, {output: file, cursor: `${options.output}.audio.cursor.jsonl`, display: 0, microphone: options.microphone, systemAudio: options.systemAudio,
    cursorVisible: false, fps: 24, maxWidth: 320, audioApps: pids});
  const recorder = launch(options.recBinary, [config]);
  const startedAt = await new Promise((resolve, reject) => {
    let buffer = '';
    recorder.child.stdout.on('data', chunk => {
      buffer += chunk;
      for (const line of buffer.split('\n').slice(0, -1)) {
        const event = JSON.parse(line);
        if (event.event === 'recording') resolve(event.startedAt);
        if (event.event === 'error') reject(new Error(event.message));
      }
      buffer = buffer.split('\n').at(-1);
    });
    recorder.finished.catch(reject);
  });
  return {...recorder, startedAt, file};
}

if (process.argv[2] === 'record') await record(process.argv[3]);
