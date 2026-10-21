// The justrec terminal: a real, persistent shell shown in a terminal page in the justrec
// browser, so it records exactly like any browser recording (start --terminal … stop).
// `justrec terminal run "<cmd>"` types the command on screen, runs it in the shell, streams
// the output live and returns it with the exit code. Text matching --blur is masked first.
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {outputDir, readJSON, writeJSON, sleep} from './common.mjs';

const stateFile = path.join(outputDir, '.terminal.json');
const typing = 0.035; // seconds per typed character
const longestTyping = 2.5; // long commands type faster, never longer than this

const page = (title) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>
html,body{margin:0;height:100%;background:#0b0e14;font-family:"SF Mono",ui-monospace,Menlo,monospace}
.stage{height:100%;display:flex;align-items:center;justify-content:center;background:radial-gradient(ellipse at 30% 20%,#18233a,#0a0d14 70%)}
.window{width:96%;height:92%;background:#0f131b;border-radius:16px;box-shadow:0 30px 80px #000a,0 0 0 1px #ffffff14;display:flex;flex-direction:column;overflow:hidden}
.bar{height:44px;display:flex;align-items:center;gap:9px;padding:0 18px;background:#161b25;color:#8b93a5;font:600 15px -apple-system,sans-serif}
.dot{width:13px;height:13px;border-radius:50%}.title{margin-left:12px}
pre{flex:1;margin:0;padding:22px 30px;color:#d8dee9;font-size:27px;line-height:1.4;white-space:pre-wrap;word-break:break-word;overflow:hidden}
.prompt{color:#5fd4a8}.cmd{color:#fff}.key{color:#7cc4ff}.str{color:#a5e28c}.num{color:#ffb86b}.err{color:#ff8a8a}
.caret{display:inline-block;width:14px;height:29px;background:#d8dee9;vertical-align:-3px;animation:b 1s steps(1) infinite}@keyframes b{50%{opacity:0}}
</style></head><body><div class="stage"><div class="window"><div class="bar"><span class="dot" style="background:#ff5f57"></span><span class="dot" style="background:#febc2e"></span><span class="dot" style="background:#28c840"></span><span class="title">${title}</span></div><pre id="screen"></pre></div></div>
<script>
const screen = document.getElementById('screen');
const escape = text => text.replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'})[c]);
// Light JSON colouring for output: keys, strings, numbers.
const colour = text => escape(text).replace(/("(?:[^"\\\\]|\\\\.)*")(\\s*:)?|\\b(-?\\d+(?:\\.\\d+)?(?:e[-+]?\\d+)?)\\b/g, (m, string, colon, number) => string ? (colon ? '<span class="key">' + string + '</span>' + colon : '<span class="str">' + string + '</span>') : '<span class="num">' + number + '</span>');
let html = '<span class="prompt">$ </span>';
const render = () => { screen.innerHTML = html + '<span class="caret"></span>'; screen.scrollTop = screen.scrollHeight; };
render();
new EventSource('/events').onmessage = message => {
  const event = JSON.parse(message.data);
  if (event.kind === 'type') [...event.text].forEach((character, index) => setTimeout(() => { html += '<span class="cmd">' + escape(character) + '</span>'; render(); }, index * event.delay * 1000));
  if (event.kind === 'enter') { html += '\\n'; render(); }
  if (event.kind === 'out') { html += colour(event.text); render(); }
  if (event.kind === 'done') { html += (event.code ? '<span class="err">[exit ' + event.code + ']</span>\\n' : '') + '\\n<span class="prompt">$ </span>'; render(); }
  if (event.kind === 'clear') { html = '<span class="prompt">$ </span>'; render(); }
};
</script></body></html>`;

// The server process: one bash, one page, commands over HTTP.
async function serve(configFile) {
  const config = await readJSON(configFile);
  const patterns = config.blur.map(pattern => new RegExp(pattern, 'g'));
  const mask = text => patterns.reduce((result, pattern) => result.replace(pattern, match => '•'.repeat(Math.min(12, match.length))), text);
  const shell = spawn('bash', ['--noprofile', '--norc', '-s'], {cwd: config.cwd, env: process.env, stdio: ['pipe', 'pipe', 'pipe']});
  const viewers = new Set();
  const send = event => { for (const response of viewers) response.write(`data: ${JSON.stringify(event)}\n\n`); };
  let pending = null; // the command being run: {marker, raw, shown, resolve}
  const emit = text => { if (text) { pending.output += mask(text); send({kind: 'out', text: mask(text)}); } };
  const take = chunk => {
    if (!pending) return;
    pending.raw += chunk.toString();
    // The marker (and its exit code) can arrive split across chunks: look in everything so far,
    // and only show text that cannot be the start of the marker yet.
    const found = pending.raw.match(new RegExp(`\\n?${pending.marker}:(\\d+)\\n?`));
    if (found) {
      emit(pending.raw.slice(pending.shown, found.index));
      const code = Number(found[1]);
      send({kind: 'done', code});
      pending.resolve({code, output: pending.output}); pending = null;
      return;
    }
    const safe = Math.max(pending.shown, pending.raw.length - pending.marker.length - 2);
    emit(pending.raw.slice(pending.shown, safe)); pending.shown = safe;
  };
  shell.stdout.on('data', take); shell.stderr.on('data', take);
  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/') { res.setHeader('Content-Type', 'text/html'); res.end(page(config.title)); return; }
    if (req.url === '/events') { res.writeHead(200, {'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store'}); viewers.add(res); req.on('close', () => viewers.delete(res)); return; }
    if (req.method !== 'POST' || req.url !== '/api' || req.headers.authorization !== `Bearer ${config.token}`) { res.writeHead(403); res.end('{}'); return; }
    let body = ''; for await (const chunk of req) body += chunk;
    const {action, command} = JSON.parse(body || '{}');
    res.setHeader('Content-Type', 'application/json');
    if (action === 'close') { res.end('{"closed":true}'); shell.kill(); server.close(); process.exit(0); }
    if (action === 'clear') { send({kind: 'clear'}); res.end('{"cleared":true}'); return; }
    if (action !== 'run' || pending) { res.writeHead(400); res.end(JSON.stringify({error: pending ? 'a command is still running' : 'unknown action'})); return; }
    // Type it on screen, then run it; the marker after it tells us it finished and its exit code.
    const shown = mask(command);
    const delay = Math.min(typing, longestTyping / Math.max(1, shown.length));
    send({kind: 'type', text: shown, delay});
    await sleep(shown.length * delay * 1000 + 350);
    send({kind: 'enter'});
    // `clear` clears the screen, as in a real terminal (bash here has no terminal to clear).
    if (command.trim() === 'clear') { send({kind: 'clear'}); res.end('{"code":0,"output":""}'); return; }
    const marker = `__justrec_${randomBytes(6).toString('hex')}__`;
    const result = await new Promise(resolve => { pending = {marker, raw: '', shown: 0, output: '', resolve}; shell.stdin.write(`${command}\nprintf '\\n${marker}:%s\\n' $?\n`); });
    res.end(JSON.stringify(result));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  await writeJSON(stateFile, {port: server.address().port, token: config.token, pid: process.pid, title: config.title});
}

const state = () => readJSON(stateFile).catch(() => { throw new Error('No justrec terminal is open: justrec terminal open'); });
const call = async (body) => {
  const {port, token} = await state();
  const response = await fetch(`http://127.0.0.1:${port}/api`, {method: 'POST', headers: {Authorization: `Bearer ${token}`}, body: JSON.stringify(body)});
  const result = await response.json();
  if (!response.ok) throw new Error(result.error);
  return result;
};

// justrec terminal open|run|clear|close
export async function terminalCommand(args) {
  const [action, ...rest] = args;
  if (action === 'open') {
    const value = name => rest.includes(name) ? rest[rest.indexOf(name) + 1] : undefined;
    const old = await readJSON(stateFile).catch(() => null);
    if (old) await call({action: 'close'}).catch(() => {});
    const config = path.join(outputDir, '.terminal-config.json');
    await writeJSON(config, {title: value('--title') || 'Terminal', blur: rest.flatMap((item, index) => item === '--blur' ? [rest[index + 1]] : []),
      cwd: path.resolve(value('--cwd') || process.cwd()), token: randomBytes(24).toString('hex')});
    await fs.rm(stateFile, {force: true});
    const child = spawn(process.execPath, [new URL(import.meta.url).pathname, 'serve', config], {detached: true, stdio: 'ignore', env: process.env});
    child.unref();
    for (let tries = 0; tries < 100 && !await fs.access(stateFile).then(() => true, () => false); tries++) await sleep(50);
    const {port, title} = await state();
    // Show it in the justrec browser, where it is recorded like any page.
    const {browserCommand} = await import('./browser.mjs');
    await browserCommand(['open', `http://127.0.0.1:${port}/`]);
    return {terminal: `http://127.0.0.1:${port}/`, title, record: 'justrec start --terminal --name <name>'};
  }
  if (action === 'run') {
    if (!rest.length) throw new Error('Usage: justrec terminal run "<command>"');
    return call({action: 'run', command: rest.join(' ')});
  }
  if (action === 'clear') return call({action: 'clear'});
  if (action === 'close') { const result = await call({action: 'close'}).catch(() => ({closed: true})); await fs.rm(stateFile, {force: true}); return result; }
  throw new Error('Usage: justrec terminal open [--title text] [--blur regex]... [--cwd dir] | run "<command>" | clear | close');
}

if (process.argv[2] === 'serve') await serve(process.argv[3]);
