// The ciak terminal: the user's own zsh (their .zshrc, prompt and theme) in a real
// pseudo-terminal, rendered by xterm.js with their iTerm2 colors and font, in the ciak
// browser. It is recorded like any browser recording (ciak record terminal … stop).
// `ciak record run "<cmd>"` types the command into the shell key by key, waits for it to
// finish and returns its output and exit code. Text matching --blur is masked on screen.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {spawn, execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomBytes} from 'node:crypto';
import {root, outputDir, readJSON, writeJSON, sleep, run} from './common.mjs';

const stateFile = path.join(outputDir, '.terminal.json');
const typing = 0.035; // seconds per typed character
const longestTyping = 2.5; // long commands type faster, never longer than this
const done = /\x1b\]777;ciak-done;(\d+)\x07/; // printed by zsh before every prompt

// A pseudo-terminal from Python's standard library (no native Node modules). Input starting
// with \0RESIZE<cols>x<rows>\n resizes the terminal; everything else is typed into it.
const ptyHelper = `
import os, pty, sys, select, fcntl, termios, struct, signal
cols, rows = int(sys.argv[1]), int(sys.argv[2])
pid, fd = pty.fork()
if pid == 0:
    fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
    os.execvp(sys.argv[3], sys.argv[3:])
pending = b''
while True:
    ready, _, _ = select.select([fd, 0], [], [])
    if fd in ready:
        try: data = os.read(fd, 65536)
        except OSError: break
        if not data: break
        os.write(1, data)
    if 0 in ready:
        data = os.read(0, 65536)
        if not data: break
        pending += data
        while pending:
            if pending.startswith(b'\\0RESIZE'):
                if b'\\n' not in pending: break
                line, pending = pending.split(b'\\n', 1)
                c, r = map(int, line[7:].split(b'x'))
                fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', r, c, 0, 0))
                os.kill(pid, signal.SIGWINCH)
            else:
                cut = pending.find(b'\\0RESIZE')
                chunk, pending = (pending, b'') if cut < 0 else (pending[:cut], pending[cut:])
                os.write(fd, chunk)
`;

// The user's iTerm2 default profile (dark-mode colors when macOS is dark), or a plain dark theme.
async function itermTheme() {
  const fallback = {font: 'Menlo', fontSize: 22, lineHeight: 1.15, theme: {background: '#15191f', foreground: '#dcdcdc', cursor: '#dcdcdc'}};
  const script = `
import plistlib, os, json, subprocess
p = os.path.expanduser('~/Library/Preferences/com.googlecode.iterm2.plist')
d = plistlib.load(open(p, 'rb'))
prof = next(b for b in d['New Bookmarks'] if b['Guid'] == d.get('Default Bookmark Guid'))
dark = subprocess.run(['defaults', 'read', '-g', 'AppleInterfaceStyle'], capture_output=True, text=True).stdout.strip() == 'Dark'
def col(key):
    c = (dark and prof.get('Use Separate Colors for Light and Dark Mode') and prof.get(key + ' (Dark)')) or prof.get(key)
    return '#%02x%02x%02x' % tuple(round(c[k] * 255) for k in ('Red Component', 'Green Component', 'Blue Component')) if c else None
names = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white']
theme = {'background': col('Background Color'), 'foreground': col('Foreground Color'), 'cursor': col('Foreground Color'), 'selectionBackground': col('Selection Color')}
for i, name in enumerate(names):
    theme[name] = col('Ansi %d Color' % i); theme['bright' + name.capitalize()] = col('Ansi %d Color' % (i + 8))
font = (prof.get('Normal Font') or 'Menlo 12').rsplit(' ', 1)[0]
print(json.dumps({'font': font, 'theme': {k: v for k, v in theme.items() if v}, 'lineHeight': prof.get('Vertical Spacing', 1) * 1.15}))
`;
  try {
    const {stdout} = await promisify(execFile)('python3', ['-c', script]);
    return {...fallback, ...JSON.parse(stdout)};
  } catch { return fallback; }
}

// zsh with the user's own config, plus: an empty history (so autosuggestions can't show past
// commands), no oh-my-zsh update prompts, and an invisible "done" marker with the exit code.
async function shellDirectory() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ciak-zsh-'));
  const home = os.homedir();
  await fs.writeFile(path.join(directory, '.zshenv'), `[ -f "${home}/.zshenv" ] && source "${home}/.zshenv"\n`);
  await fs.writeFile(path.join(directory, '.zshrc'), `export DISABLE_AUTO_UPDATE=true ZSH_DISABLE_COMPFIX=true
[ -f "${home}/.zshrc" ] && ZDOTDIR="${home}" source "${home}/.zshrc"
HISTFILE="${directory}/.history"; fc -p "${directory}/.history"
__ciak_done() { local code=$?; printf '\\e]777;ciak-done;%s\\a' $code }
precmd_functions+=(__ciak_done)
`);
  return directory;
}

async function serve(configFile) {
  const config = await readJSON(configFile);
  const patterns = config.blur.map(pattern => new RegExp(pattern, 'g'));
  const mask = text => patterns.reduce((result, pattern) => result.replace(pattern, match => '•'.repeat(match.length)), text);
  // Not "pty.py": that name would shadow Python's own pty module.
  const helper = path.join(root, '.build/ciak_pty.py');
  await fs.mkdir(path.dirname(helper), {recursive: true});
  await fs.writeFile(helper, ptyHelper);
  const zdotdir = await shellDirectory();
  const shell = spawn('python3', ['-I', helper, '100', '28', 'zsh', '-i'], {cwd: config.cwd, env: {...process.env, ZDOTDIR: zdotdir, TERM: 'xterm-256color', COLORTERM: 'truecolor', PAGER: 'cat', GIT_PAGER: 'cat'}, stdio: ['pipe', 'pipe', 'inherit']});
  const history = []; // everything shown so far, replayed to a page that connects later
  const viewers = new Set();
  let waiter = null; // resolves on the next "done" marker
  let collected = ''; let ready = false;
  let size = ''; // the page's last size; applied again before each command, since one sent while zsh starts can be lost
  shell.stdout.on('data', chunk => {
    const raw = chunk.toString('utf8');
    const shown = mask(raw.replace(new RegExp(done.source, 'g'), ''));
    const data = Buffer.from(shown).toString('base64');
    history.push(data);
    for (const response of viewers) response.write(`data: ${JSON.stringify({data})}\n\n`);
    collected += shown;
    const finished = raw.match(done);
    if (finished) { ready = true; if (waiter) { const resolve = waiter; waiter = null; resolve(Number(finished[1])); } }
  });
  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/') {
      res.setHeader('Content-Type', 'text/html');
      res.end(`<!doctype html><html><head><meta charset="utf-8"><title>${config.title}</title><style>${config.css}
html,body{margin:0;height:100%;background:#0c0f14}
.stage{height:100%;display:flex;align-items:center;justify-content:center}
.window{width:96%;height:92%;border-radius:12px;overflow:hidden;box-shadow:0 30px 80px #000c,0 0 0 1px #ffffff1f;display:flex;flex-direction:column;background:${config.theme.theme.background}}
.bar{height:38px;flex:none;display:flex;align-items:center;justify-content:center;position:relative;background:#2b2d31;color:#c9ccd1;font:600 15px -apple-system,sans-serif;border-bottom:1px solid #00000066}
.lights{position:absolute;left:16px;display:flex;gap:9px}.lights span{width:13px;height:13px;border-radius:50%}
#screen{flex:1;padding:10px 14px;min-height:0}</style></head><body><div class="stage"><div class="window">
<div class="bar"><div class="lights"><span style="background:#ff5f57"></span><span style="background:#febc2e"></span><span style="background:#28c840"></span></div><span id="title"></span></div>
<div id="screen"></div></div></div><script>window.CIAK_TERMINAL=${JSON.stringify({title: config.title, ...config.theme})}</script><script src="/terminal.js"></script></body></html>`);
      return;
    }
    if (req.method === 'GET' && req.url === '/terminal.js') { res.setHeader('Content-Type', 'application/javascript'); res.end(await fs.readFile(path.join(root, '.build/terminal/terminal.js'))); return; }
    if (req.url === '/events') {
      res.writeHead(200, {'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store'});
      for (const data of history) res.write(`data: ${JSON.stringify({data})}\n\n`);
      viewers.add(res); req.on('close', () => viewers.delete(res)); return;
    }
    if (req.method === 'POST' && req.url === '/resize') {
      let body = ''; for await (const chunk of req) body += chunk;
      const {cols, rows} = JSON.parse(body);
      if (Number.isInteger(cols) && Number.isInteger(rows)) shell.stdin.write(size = `\0RESIZE${cols}x${rows}\n`);
      res.end('{}'); return;
    }
    if (req.method !== 'POST' || req.url !== '/api' || req.headers.authorization !== `Bearer ${config.token}`) { res.writeHead(403); res.end('{}'); return; }
    let body = ''; for await (const chunk of req) body += chunk;
    const {action, command, timeout = 120} = JSON.parse(body || '{}');
    res.setHeader('Content-Type', 'application/json');
    if (action === 'close') { res.end('{"closed":true}'); shell.kill(); await fs.rm(zdotdir, {recursive: true, force: true}); server.close(); process.exit(0); }
    if (action === 'ready') { for (let tries = 0; !ready && tries < 600; tries++) await sleep(50); res.end(JSON.stringify({ready})); return; }
    if (action !== 'run' || waiter) { res.writeHead(400); res.end(JSON.stringify({error: waiter ? 'a command is still running' : 'unknown action'})); return; }
    for (let tries = 0; !ready && tries < 600; tries++) await sleep(50); // the first prompt (a big .zshrc took 13 s)
    if (!ready) { res.writeHead(500); res.end(JSON.stringify({error: `the shell did not start; see ${path.join(outputDir, '.terminal.log')}`})); return; }
    if (size) shell.stdin.write(size);
    // Type it key by key (newlines become Enter, so continuations show zsh's own "> " prompt).
    const delay = Math.min(typing, longestTyping / Math.max(1, command.length));
    for (const character of command) { shell.stdin.write(character === '\n' ? '\r' : character); await sleep(delay * 1000); }
    await sleep(300);
    const finished = new Promise(resolve => { waiter = resolve; });
    collected = '';
    shell.stdin.write('\r');
    // A command that never returns (a prompt, a server) is stopped with Ctrl-C, like a person would.
    let code = await Promise.race([finished, sleep(timeout * 1000).then(() => 'timeout')]);
    const timedOut = code === 'timeout';
    if (timedOut) { shell.stdin.write('\x03'); code = await Promise.race([finished, sleep(5000).then(() => null)]); }
    // What the agent gets back: the output as plain text (no colors, no prompt).
    const plain = collected.replace(/\x1b\][^\x07]*\x07/g, '').replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '').replace(/\x1b[()][0-9A-Za-z]/g, '').replace(/\x1b[@-Z\\-_=>78]/g, '').replace(/\r/g, '');
    res.end(JSON.stringify({code, ...(timedOut ? {timedOut: true, error: `still running after ${timeout} s: stopped with Ctrl-C`} : {}), output: plain.replace(/^\n/, '').split('\n').slice(0, -1).join('\n')}));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  await writeJSON(stateFile, {port: server.address().port, token: config.token, pid: process.pid, title: config.title});
}

const state = () => readJSON(stateFile).catch(() => { throw new Error('No ciak terminal is open: ciak record open terminal'); });
// The open terminal, if its server still runs.
export const terminalState = () => readJSON(stateFile).then(saved => { process.kill(saved.pid, 0); return saved; }).catch(() => null);
const call = async (body) => {
  const {port, token} = await state();
  const response = await fetch(`http://127.0.0.1:${port}/api`, {method: 'POST', headers: {Authorization: `Bearer ${token}`}, body: JSON.stringify(body)});
  const result = await response.json();
  if (!response.ok) throw new Error(result.error);
  return result;
};

// ciak record open terminal | run | close terminal
export async function terminalCommand(args) {
  const [action, ...rest] = args;
  if (action === 'open') {
    const value = name => rest.includes(name) ? rest[rest.indexOf(name) + 1] : undefined;
    if (await readJSON(stateFile).catch(() => null)) await call({action: 'close'}).catch(() => {});
    // Build the page script (xterm.js + fit add-on) when it changed.
    const bundle = path.join(root, '.build/terminal/terminal.js');
    const [source, built] = await Promise.all([fs.stat(path.join(root, 'render/terminal-page.js')), fs.stat(bundle).catch(() => null)]);
    if (!built || source.mtimeMs > built.mtimeMs) {
      await run(path.join(root, 'node_modules/.bin/esbuild'), [path.join(root, 'render/terminal-page.js'), '--bundle', '--minify', '--format=iife', `--outfile=${bundle}`]);
    }
    const theme = await itermTheme();
    if (value('--font-size')) theme.fontSize = Number(value('--font-size'));
    const config = path.join(outputDir, '.terminal-config.json');
    await writeJSON(config, {title: value('--title') || '-zsh', theme, css: await fs.readFile(path.join(root, 'node_modules/@xterm/xterm/css/xterm.css'), 'utf8'),
      blur: rest.flatMap((item, index) => item === '--blur' ? [rest[index + 1]] : []), cwd: path.resolve(value('--cwd') || os.homedir()), token: randomBytes(24).toString('hex')});
    await fs.rm(stateFile, {force: true});
    const log = await fs.open(path.join(outputDir, '.terminal.log'), 'w');
    const child = spawn(process.execPath, [new URL(import.meta.url).pathname, 'serve', config], {detached: true, stdio: ['ignore', log.fd, log.fd], env: process.env});
    await log.close();
    child.unref();
    for (let tries = 0; tries < 100 && !await fs.access(stateFile).then(() => true, () => false); tries++) await sleep(50);
    const {port, title} = await state();
    const {browserCommand} = await import('./browser.mjs');
    await browserCommand(['open', `http://127.0.0.1:${port}/`]);
    await call({action: 'ready'});  // the first prompt: a big .zshrc takes seconds, which a recording would show as a blank screen
    return {terminal: `http://127.0.0.1:${port}/`, title, font: theme.font, record: 'ciak record terminal --name <name>'};
  }
  if (action === 'run') {
    if (!rest.length) throw new Error('Usage: ciak record run "<command>" [--timeout seconds]');
    const at = rest.indexOf('--timeout');
    const timeout = at >= 0 ? Number(rest.splice(at, 2)[1]) : undefined;
    return call({action: 'run', command: rest.join(' '), timeout});
  }
  if (action === 'close') { const result = await call({action: 'close'}).catch(() => ({closed: true})); await fs.rm(stateFile, {force: true}); return result; }
  throw new Error('Usage: ciak record open terminal [--title text] [--blur regex]... [--cwd dir] [--font-size n] | run "<command>" | close terminal');
}

if (process.argv[2] === 'serve') await serve(process.argv[3]);
