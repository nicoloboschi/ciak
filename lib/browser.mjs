// The ciak browser: a second Brave on a copy of the user's profile (so it is logged in),
// started so it keeps drawing when covered, driven and recorded over Chrome's debugging port.
import fs from 'node:fs/promises';
import path from 'node:path';
import {run, sleep, limit, readJSON, writeJSON, x264, launch} from './common.mjs';

const port = Number(process.env.CIAK_BROWSER_PORT || 9333);
const app = process.env.CIAK_BROWSER_APP || '/Applications/Brave Browser.app';
const sourceProfile = process.env.CIAK_BROWSER_SOURCE || path.join(process.env.HOME, 'Library/Application Support/BraveSoftware/Brave-Browser');
const profile = process.env.CIAK_BROWSER_PROFILE || path.join(process.env.HOME, 'Library/Application Support/ciak/browser');
const base = `http://127.0.0.1:${port}`;

const running = () => fetch(`${base}/json/version`, {signal: AbortSignal.timeout(1000)}).then(() => true, () => false);

async function copyProfile() {
  await fs.rm(profile, {recursive: true, force: true, maxRetries: 20});  // the closing browser can still be writing to it
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
  const tab = await (await fetch(`${base}/json/new?${encodeURIComponent(url)}`, {method: 'PUT'})).json();
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
  const list = await (await fetch(`${base}/json/list`).catch(() => { throw new Error('The ciak browser is not running: ciak record open <url>'); })).json();
  return list.filter(target => target.type === 'page' && !target.url.startsWith('chrome-extension://') && !target.url.startsWith('devtools://'));
}

// The tab ciak drives and records: the most recently activated page.
async function currentPage(match) {
  const list = await pages();
  const page = match ? list.find(item => item.id === match || item.url.includes(match) || item.title.includes(match)) : list[0];
  if (!page) throw new Error(match ? `No tab matches ${match}` : 'The ciak browser has no open tab');
  return page;
}

async function cdp(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = () => reject(new Error('Cannot connect to the ciak browser')); });
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

// Render a page to PNG off-screen (screenshot frames): a background tab that is never activated,
// so a running recording does not jump to it.
export async function capturePage(url, width, height) {
  if (!await running()) await openBrowser();
  const browser = await cdp((await (await fetch(`${base}/json/version`)).json()).webSocketDebuggerUrl);
  const {targetId} = await browser.send('Target.createTarget', {url: 'about:blank', background: true});
  try {
    const target = (await (await fetch(`${base}/json/list`)).json()).find(item => item.id === targetId);
    const page = await cdp(target.webSocketDebuggerUrl);
    await page.send('Emulation.setDeviceMetricsOverride', {width, height, deviceScaleFactor: 1, mobile: false});
    await page.send('Page.enable');
    const loaded = new Promise(resolve => page.on(message => message.method === 'Page.loadEventFired' && resolve()));
    await page.send('Page.navigate', {url});
    await Promise.race([loaded, limit(10000)]);
    const {data} = await page.send('Page.captureScreenshot', {format: 'png', clip: {x: 0, y: 0, width, height, scale: 1}, captureBeyondViewport: true});
    page.close();
    return Buffer.from(data, 'base64');
  } finally { await browser.send('Target.closeTarget', {targetId}).catch(() => {}); browser.close(); }
}

async function evaluate(page, expression) {
  const result = await page.send('Runtime.evaluate', {expression, awaitPromise: true, returnByValue: true, userGesture: true});
  // The message, without the page's stack trace.
  if (result.exceptionDetails) throw new Error((result.exceptionDetails.exception?.description || result.exceptionDetails.text).split('\n')[0].replace(/^Error: /, ''));
  return result.result.value;
}

const keys = {Enter: 13, Tab: 9, Escape: 27, Backspace: 8, ArrowDown: 40, ArrowUp: 38, ArrowLeft: 37, ArrowRight: 39, Space: 32};

// Find an element by CSS selector, or by its visible text; scroll it into view; return its center.
const locate = (target, field) => `(async () => {
  const wanted = ${JSON.stringify(target)};
  // A page can have many "Save changes" (or a hidden copy of a search box): prefer enabled ones, then the ones on screen.
  const rank = item => { const box = item.getBoundingClientRect(); return (item.disabled ? 0 : 2) + (box.bottom > 0 && box.top < innerHeight && box.width > 0 ? 1 : 0); };
  const best = items => [...items].sort((a, b) => rank(b) - rank(a));
  let element = null;
  // A number is what \`ciak record look\` showed for it.
  if (/^\\d+$/.test(wanted)) {
    element = document.querySelector('[data-ciak="' + wanted + '"]');
    if (!element) throw new Error('No item ' + wanted + ' on the page now: run ciak record look again');
  }
  try { element ||= best(document.querySelectorAll(wanted))[0]; } catch {}
  if (!element) {
    const all = best(document.querySelectorAll('a, button, input, textarea, select, [role=button], [role=link], [role=tab], [role=menuitem], label, summary, [onclick]'));
    const names = item => [item.innerText, item.value, item.getAttribute('aria-label'), item.placeholder].filter(Boolean).map(name => name.trim());
    element = all.find(item => names(item).includes(wanted))
      || all.find(item => names(item).some(name => name.toLowerCase().includes(wanted.toLowerCase())));
  }
  // Rows and cards are often clickable through script handlers: any visible element with that
  // exact text, the smallest one.
  if (!element) element = [...document.querySelectorAll('body *')].filter(item => item.offsetParent !== null && (item.innerText || '').trim() === wanted)
    .sort((a, b) => a.innerText.length - b.innerText.length || b.querySelectorAll('*').length - a.querySelectorAll('*').length).at(0);
  if (!element) throw new Error('Nothing on the page matches: ' + wanted);
  // select and upload act on the element found last.
  document.querySelector('[data-ciak-last]')?.removeAttribute('data-ciak-last'); element.setAttribute('data-ciak-last', '');
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
  return {x: box.x + (field ? Math.min(box.width / 2, 60) : box.width / 2), y: box.y + (field ? Math.min(box.height / 2, 22) : box.height / 2), from: window.__ciakMouse || {x: innerWidth / 2, y: innerHeight / 2}};
})()`;

// Glide the mouse like a hand: longer moves take longer (0.25–0.8 s), the path bows a little and slows into
// the target, one step per 60 fps frame. A fixed-time straight line reads as a robot.
async function glide(page, from, {x, y}, buttons = 0) {
  const distance = Math.hypot(x - from.x, y - from.y);
  const steps = Math.round(Math.min(48, Math.max(15, 15 + distance / 30)));
  const bow = Math.min(60, distance * 0.12) * (x >= from.x ? 1 : -1);
  for (let step = 1; step <= steps; step++) {
    const amount = step / steps; const smooth = 1 - Math.pow(1 - amount, 3);
    const side = Math.sin(Math.PI * smooth) * bow;
    const [nx, ny] = distance ? [-(y - from.y) / distance, (x - from.x) / distance] : [0, 0];
    await page.send('Input.dispatchMouseEvent', {type: 'mouseMoved', x: from.x + (x - from.x) * smooth + nx * side, y: from.y + (y - from.y) * smooth + ny * side, ...(buttons && {button: 'left', buttons})});
    await sleep(16);
  }
  await evaluate(page, `window.__ciakMouse = ${JSON.stringify({x, y})}`).catch(() => {});
}

async function hover(page, target, field = false) {
  const {x, y, from} = await evaluate(page, locate(target, field));
  await glide(page, from, {x, y});
  return {x, y};
}

async function click(page, target, field = false) {
  const {x, y} = await hover(page, target, field);
  await sleep(150);
  await page.send('Input.dispatchMouseEvent', {type: 'mousePressed', x, y, button: 'left', clickCount: 1});
  await sleep(60);
  await page.send('Input.dispatchMouseEvent', {type: 'mouseReleased', x, y, button: 'left', clickCount: 1});
  return {clicked: target, x: Math.round(x), y: Math.round(y)};
}

// What an agent can act on: visible buttons, links and fields, numbered (click 12, type 7 "…"), and the page's text.
const lookScript = `(() => {
  for (const old of document.querySelectorAll('[data-ciak]')) old.removeAttribute('data-ciak');
  const items = [];
  for (const item of document.querySelectorAll('a[href], button, input:not([type=hidden]), textarea, select, summary, [onclick], [contenteditable=""], [contenteditable=true], [role=button], [role=link], [role=tab], [role=menuitem], [role=checkbox], [role=radio], [role=switch], [role=option], [role=textbox], [role=combobox]')) {
    const box = item.getBoundingClientRect();
    if (!box.width || !box.height || getComputedStyle(item).visibility === 'hidden' || items.length >= 300) continue;
    const ref = String(items.length + 1); item.setAttribute('data-ciak', ref);
    const field = /^(INPUT|TEXTAREA|SELECT)$/.test(item.tagName);
    items.push({ref, kind: item.getAttribute('role') || (item.tagName === 'INPUT' ? 'input ' + item.type : item.tagName.toLowerCase()),
      name: (item.getAttribute('aria-label') || (field ? item.labels?.[0]?.innerText : item.innerText) || item.placeholder || item.title || item.getAttribute('alt') || '').trim().replace(/\\s+/g, ' ').slice(0, 80),
      ...(field && item.value && item.type !== 'password' && {value: String(item.value).slice(0, 80)}),
      ...(item.tagName === 'SELECT' && {options: [...item.options].slice(0, 30).map(option => option.text)}),
      ...(item.checked && {checked: true}), ...(item.disabled && {disabled: true}), ...((box.bottom < 0 || box.top > innerHeight) && {offscreen: true})});
  }
  return {url: location.href, title: document.title, items, text: (document.body?.innerText || '').replace(/\\n{3,}/g, '\\n\\n').slice(0, 4000)};
})()`;

async function loaded(page) {
  for (let tries = 0; tries < 150; tries++) {
    await sleep(100);
    if (tries >= 3 && await evaluate(page, 'document.readyState').catch(() => null) === 'complete') return;
  }
}

// Click a field and select what it holds, so the new text replaces it (as a person would).
async function focusField(page, target) {
  await click(page, target, true);
  await page.send('Input.dispatchKeyEvent', {type: 'keyDown', key: 'a', code: 'KeyA', commands: ['selectAll']});
  await page.send('Input.dispatchKeyEvent', {type: 'keyUp', key: 'a', code: 'KeyA'});
}

// ciak record <action> ...: small, predictable commands that drive the ciak browser like a person.
export async function browserCommand(args) {
  const [action, ...rest] = args;
  if (action === 'open') return openBrowser({url: rest.find(item => !item.startsWith('--')), refresh: rest.includes('--refresh-login')});
  if (action === 'tabs') return (await pages()).map(({id, url, title}) => ({id, url, title}));
  if (action === 'switch') { const tab = await currentPage(rest[0]); await fetch(`${base}/json/activate/${tab.id}`); return {switched: tab.url}; }
  if (action === 'wait') {
    // Until the text (or a CSS selector) shows on the page, or with --gone until it goes.
    const gone = rest.includes('--gone'), at = rest.indexOf('--timeout');
    const seconds = at >= 0 ? Number(rest[at + 1]) : 15;
    const wanted = rest.filter((item, index) => item !== '--gone' && (at < 0 || index !== at && index !== at + 1)).join(' ');
    if (!wanted) throw new Error('Usage: ciak record wait "text or CSS selector" [--gone] [--timeout seconds]');
    const test = `(() => { const wanted = ${JSON.stringify(wanted)}; if ((document.body?.innerText || '').includes(wanted)) return true; try { return [...document.querySelectorAll(wanted)].some(item => item.getClientRects().length); } catch { return false; } })()`;
    // The tab in front each time: a click can open a new one.
    for (const deadline = Date.now() + seconds * 1000; Date.now() < deadline; await sleep(200)) {
      const front = await cdp((await currentPage()).webSocketDebuggerUrl).catch(() => null);
      const found = front && await evaluate(front, test).catch(() => false);
      front?.close();
      if (found !== null && Boolean(found) !== gone) return {waited: wanted, gone};
    }
    throw new Error(`Still ${gone ? 'there' : 'not there'} after ${seconds} s: ${wanted}`);
  }
  const target = await currentPage();
  const page = await cdp(target.webSocketDebuggerUrl);
  try {
    if (action === 'go') {
      await page.send('Page.enable');
      const loaded = new Promise(resolve => page.on(message => message.method === 'Page.loadEventFired' && resolve()));
      await page.send('Page.navigate', {url: rest[0]});
      await Promise.race([loaded, limit(15000)]);
      return {url: rest[0]};
    }
    if (action === 'look') return await evaluate(page, lookScript);
    if (action === 'click') return await click(page, rest.join(' '));
    if (action === 'hover') { await hover(page, rest.join(' ')); return {hovered: rest.join(' ')}; }
    if (action === 'back' || action === 'forward') { await evaluate(page, `history.${action}()`); await loaded(page); return {[action]: await evaluate(page, 'location.href')}; }
    if (action === 'drag') {
      const [from, to] = rest;
      if (!to) throw new Error('Usage: ciak record drag <from> <to>');
      const start = await hover(page, from);
      await page.send('Input.dispatchMouseEvent', {type: 'mousePressed', ...start, button: 'left', buttons: 1, clickCount: 1});
      const end = await evaluate(page, locate(to, false));
      await glide(page, start, end, 1);
      await sleep(100);
      await page.send('Input.dispatchMouseEvent', {type: 'mouseReleased', x: end.x, y: end.y, button: 'left', clickCount: 1});
      return {dragged: from, to};
    }
    if (action === 'select') {
      // A native dropdown's menu is drawn by macOS, outside the page: move there, then pick the option.
      const [into, ...words] = rest; const option = words.join(' ');
      await hover(page, into);
      return {selected: await evaluate(page, `(() => { const select = document.querySelector('[data-ciak-last]');
        if (select?.tagName !== 'SELECT') throw new Error('Not a dropdown (<select>): click it, then click the option');
        const wanted = ${JSON.stringify(option)}, options = [...select.options];
        const found = options.find(item => item.text.trim() === wanted || item.value === wanted) || options.find(item => item.text.toLowerCase().includes(wanted.toLowerCase()));
        if (!found) throw new Error('No option ' + wanted + ': ' + options.map(item => item.text.trim()).join(', '));
        select.value = found.value; select.dispatchEvent(new Event('input', {bubbles: true})); select.dispatchEvent(new Event('change', {bubbles: true}));
        return found.text.trim(); })()`)};
    }
    if (action === 'upload') {
      // Sets the file on the page's file field directly: the Mac's file dialog would not be in the recording.
      const [file, ...target] = rest;
      if (!file) throw new Error('Usage: ciak record upload <file> [<the upload button or field>]');
      await fs.access(path.resolve(file));
      if (target.length) await evaluate(page, locate(target.join(' '), false));
      const {result} = await page.send('Runtime.evaluate', {expression: `(() => { const near = document.querySelector('[data-ciak-last]');
        return near?.matches('input[type=file]') ? near : near?.querySelector('input[type=file]') || near?.closest('form, label, div')?.querySelector('input[type=file]') || document.querySelector('input[type=file]'); })()`});
      if (!result.objectId) throw new Error('No file field on the page');
      await page.send('DOM.setFileInputFiles', {files: [path.resolve(file)], objectId: result.objectId});
      return {uploaded: path.resolve(file)};
    }
    if (action === 'type') {
      const [into, ...words] = rest.length > 1 ? rest : [null, ...rest];
      if (into) await focusField(page, into);
      // An uneven rhythm, a beat longer after a space or punctuation; \n is a new line in a text area.
      const text = words.join(' ').replace(/\\n/g, '\n');
      for (const character of text) { await page.send('Input.insertText', {text: character}); await sleep(35 + Math.random() * 50 + (/[\s.,?!]/.test(character) ? 60 : 0)); }
      return {typed: text};
    }
    if (action === 'paste') {
      // Long text arrives at once, like ⌘V: a person never types five lines in a demo.
      const [into, ...words] = rest.length > 1 ? rest : [null, ...rest];
      if (into) await focusField(page, into);
      await sleep(250);
      const text = words.join(' ').replace(/\\n/g, '\n');
      await page.send('Input.insertText', {text});
      return {pasted: text};
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
    throw new Error(`Unknown browser action: ${action} (ciak record help)`);
  } finally { page.close(); }
}

// Keep secrets and internal things out of a recording: blur text matching a pattern (API keys,
// balances) and hide the row holding some text (an internal model). Re-applied as the page changes.
export function maskScript({hide = [], blur = []}) {
  if (!hide.length && !blur.length) return null;
  return `(() => {
    // Each distinct mask runs once per page; several can stack (the recording's, then a later one).
    const key = ${JSON.stringify(JSON.stringify({hide, blur}))};
    window.__ciakMasks ??= new Set(); if (window.__ciakMasks.has(key)) return; window.__ciakMasks.add(key);
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
      for (const pattern of blur) for (const element of deepest(text => pattern.test(text.trim()))) {
        element.style.setProperty('filter', 'blur(9px)', 'important');
        // A blurred name's avatar: the pictures in the nearest few ancestors.
        for (let node = element.parentElement, up = 0; node && node !== document.body && up < 3; node = node.parentElement, up++) {
          if (node.textContent.length > element.textContent.length + 80) break;  // past the name's own little box (e.g. a whole sidebar with the logo)
          const pictures = node.querySelectorAll('img, svg image, [style*="background-image"]');
          if (pictures.length) { for (const picture of pictures) picture.style.setProperty('filter', 'blur(9px)', 'important'); break; }
        }
      }
      for (const field of document.querySelectorAll('input, textarea')) if (blur.some(pattern => pattern.test(field.value))) field.style.setProperty('filter', 'blur(9px)', 'important');
    };
    apply(); setInterval(apply, 200);
  })()`;
}

// Recorder process for one segment; speaks the same JSON-lines protocol as rec.swift.
async function record(configFile) {
  const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
  const options = await readJSON(configFile);
  const frames = `${options.output}.frames`;
  await fs.mkdir(frames, {recursive: true});
  const cursor = await fs.open(options.cursor, 'w');
  const list = [];
  let startedAt = null;
  let size;
  let first;
  const firstFrame = new Promise(resolve => { first = resolve; });
  // Report pointer moves and clicks from inside the page, whoever causes them.
  const probe = `(() => { if (window.__ciakProbe || !window.__ciak) return; window.__ciakProbe = true; let last = 0;
    let x = 0.5, y = 0.5;
    const send = (type, event) => { if (event.clientX !== undefined) [x, y] = [event.clientX / innerWidth, event.clientY / innerHeight]; window.__ciak(JSON.stringify({type, x, y})); };
    addEventListener('pointermove', event => { const now = performance.now(); if (now - last > 16) { last = now; send('move', event); } }, true);
    addEventListener('pointerdown', event => send('click', event), true);
    addEventListener('keydown', event => send('key', event), true);
    addEventListener('input', event => send('key', event), true); })()`;
  const mask = maskScript(options.mask || {});
  // Screencast one tab: frames, pointer probe and masks.
  async function attach(target) {
    const page = await cdp(target.webSocketDebuggerUrl);
    page.on(async message => {
      if (message.method === 'Page.screencastFrame') {
        const {data, metadata, sessionId} = message.params;
        page.send('Page.screencastFrameAck', {sessionId}).catch(() => {});
        if (page !== current?.page) return; // a tab we just left
        const now = Date.now() / 1000;
        startedAt ??= now;
        size ??= {width: metadata.deviceWidth, height: metadata.deviceHeight, scale: metadata.pageScaleFactor || 1};
        const file = path.join(frames, `${String(list.length).padStart(6, '0')}.jpg`);
        list.push({file, t: now - startedAt});
        await fs.writeFile(file, Buffer.from(data, 'base64'));
        first();
      } else if (message.method === 'Runtime.bindingCalled' && message.params.name === '__ciak' && startedAt && page === current?.page) {
        const event = JSON.parse(message.params.payload);
        await cursor.write(JSON.stringify({...event, t: Date.now() / 1000 - startedAt, visible: true}) + '\n');
      }
    });
    await page.send('Runtime.enable');
    await page.send('Runtime.addBinding', {name: '__ciak'});
    await page.send('Page.enable');
    await page.send('Page.addScriptToEvaluateOnNewDocument', {source: probe});
    await page.send('Runtime.evaluate', {expression: probe});
    if (mask) { await page.send('Page.addScriptToEvaluateOnNewDocument', {source: mask}); await page.send('Runtime.evaluate', {expression: mask}); await sleep(150); }
    await page.send('Page.startScreencast', {format: 'jpeg', quality: 92, maxWidth: options.maxWidth, maxHeight: 4320});
    // Nudge a repaint so a static page still sends its first frame.
    await page.send('Runtime.evaluate', {expression: 'document.documentElement.style.outline = "0px solid transparent"; requestAnimationFrame(() => document.documentElement.style.outline = "")'});
    return {id: target.id, page};
  }
  let current = null;
  current = await attach(await currentPage(options.browser.tab));
  const page = current.page;
  if (await Promise.race([firstFrame.then(() => true), sleep(10000).then(() => false)]) === false) { emit({event: 'error', message: 'The browser tab sent no frames; is the tab open and loaded?'}); process.exit(1); }
  // Follow the active tab (a sign-in page opening, `ciak record switch`), like a person's screen.
  let following = true;
  const follow = (async () => {
    while (following) {
      await sleep(300);
      const active = await currentPage().catch(() => null);
      if (!following || !active || active.id === current.id) continue;
      const previous = current;
      current = await attach(active).catch(() => previous);
      if (current !== previous) { previous.page.send('Page.stopScreencast').catch(() => {}); previous.page.close(); }
    }
  })();
  const audio = (options.systemAudio || options.microphone) && await recordAudio(page, options).catch(error => { emit({event: 'error', message: error.message}); process.exit(1); });
  emit({event: 'recording', startedAt});
  emit({event: 'capture', width: size.width * 2, height: size.height * 2, fps: options.fps, bounds: [0, 0, size.width, size.height]});
  await new Promise(resolve => { process.once('SIGTERM', resolve); process.once('SIGINT', resolve); });
  const end = Date.now() / 1000 - startedAt;
  following = false; await follow;
  await current.page.send('Page.stopScreencast').catch(() => {});
  current.page.close();
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

// Only when run as the recorder process (`ciak record` imports this file too).
if (process.argv[1] === new URL(import.meta.url).pathname && process.argv[2] === 'record') await record(process.argv[3]);
