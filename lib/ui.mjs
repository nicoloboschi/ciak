// justrec ui: the recording panel (menu bar: Record…). Projects on the left, a new recording with camera and mic
// preview, and each project's page: its video, the steps that made it with their timings, and its id for an agent.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {root, run, projectsDir, readJSON} from './common.mjs';

// A fixed address, so the browser remembers the camera and mic permission between runs.
const port = Number(process.env.JUSTREC_UI_PORT || 9341);
const types = {'.mp4': 'video/mp4', '.jpg': 'image/jpeg'};

// What the panel shows for one project: state, times, the edit in numbers, the finished video, the steps.
async function summary(id) {
  const folder = path.join(projectsDir, id);
  const [config, session, project, render, steps] = await Promise.all(['config.json', 'session.json', 'recording.project.json', 'recording.render.json', 'steps.json']
    .map(name => readJSON(path.join(folder, name)).catch(() => null)));
  if (!config && !project) return null;
  const created = project?.created || (await fs.stat(folder)).birthtimeMs;
  const final = render && await fs.access(render.output).then(() => true, () => false) ? render : null;
  const kept = project ? project.clips.reduce((total, clip) => total + clip.end - clip.start, 0) : null;
  // A step without an end is running; "rendering" covers a render an agent started too.
  const running = (steps || []).some(step => !step.ended);
  const state = session && session.state !== 'saved' ? session.state : running ? 'rendering' : final ? 'ready' : project ? 'saved' : 'unknown';
  return {id, name: project?.name || config?.name || id, created, state, error: session?.error, startedAt: session?.startedAt, elapsed: session?.elapsed,
    duration: project?.duration ?? null, kept, zooms: project?.zooms.length ?? null, clips: project?.clips.length ?? null,
    size: project && `${project.width}×${project.height}`, fps: project?.fps, final, folder, recording: project && path.join(folder, project.source),
    steps: steps || [], prompt: `Use /justrec to edit project ${id}: `};
}

async function projects() {
  const ids = (await fs.readdir(projectsDir).catch(() => [])).filter(name => /^[\w-]+$/.test(name));
  return (await Promise.all(ids.map(id => summary(id).catch(() => null)))).filter(Boolean).sort((first, second) => second.created - first.created);
}

// A small picture of the recording for the list, made once.
async function thumbnail(id) {
  const folder = path.join(projectsDir, id), file = path.join(folder, 'thumb.jpg');
  if (await fs.access(file).then(() => true, () => false)) return file;
  const project = await readJSON(path.join(folder, 'recording.project.json'));
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-ss', String(Math.min(1, project.duration / 2)), '-i', path.join(folder, project.source),
    '-frames:v', '1', '-vf', 'scale=480:-2', file]);
  return file;
}

function serveFile(req, res, file, size) {
  const [, from, to] = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '') || [];
  const start = Number(from || 0), end = to ? Number(to) : size - 1;
  res.writeHead(req.headers.range ? 206 : 200, {'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Accept-Ranges': 'bytes',
    'Content-Length': end - start + 1, ...(req.headers.range && {'Content-Range': `bytes ${start}-${end}/${size}`})});
  createReadStream(file, {start, end}).pipe(res);
}

export async function serveUI({open = true} = {}) {
  const token = randomBytes(24).toString('hex');
  const origin = `http://127.0.0.1:${port}`;
  const cli = async args => JSON.parse(await run(process.execPath, [path.join(root, 'lib/cli.mjs'), ...args]));
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (req.headers.host !== new URL(origin).host) { res.writeHead(403); res.end(); return; }
    const url = new URL(req.url, origin);
    if (req.method === 'GET' && url.pathname === '/') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      const html = await fs.readFile(path.join(root, 'ui/index.html'), 'utf8');
      res.end(html.replace('__TOKEN__', token)); return;
    }
    // Pictures and videos for <img>/<video>, which can't send a header: the token comes in the address.
    if (req.method === 'GET' && url.searchParams.get('token') === token) {
      try {
        // By project id: /thumb, /media?kind=final (the rendered video) or kind=raw (the recording).
        const id = url.searchParams.get('id') || '';
        const project = /^[\w-]+$/.test(id) && url.pathname === '/media' ? await summary(id) : null;
        const file = !/^[\w-]+$/.test(id) ? '' : url.pathname === '/thumb' ? await thumbnail(id)
          : project ? (url.searchParams.get('kind') === 'final' ? project.final?.output : project.recording) : '';
        const stat = file && /\.(mp4|jpg)$/.test(file) ? await fs.stat(file).catch(() => null) : null;
        if (stat) return serveFile(req, res, file, stat.size);
      } catch {}
      res.writeHead(404); res.end(); return;
    }
    res.setHeader('Content-Type', 'application/json');
    if (req.method !== 'POST' || req.headers.authorization !== `Bearer ${token}` || (req.headers.origin && req.headers.origin !== origin)) {
      res.writeHead(403); res.end(JSON.stringify({error: 'Unauthorized'})); return;
    }
    try {
      let data = '';
      for await (const chunk of req) { data += chunk; if (data.length > 16384) throw new Error('Request too large'); }
      const body = JSON.parse(data || '{}');
      if (body.id !== undefined && !/^[\w-]+$/.test(body.id)) throw new Error('Invalid project ID');
      let result;
      if (url.pathname === '/sources') result = await cli(['sources']);
      else if (url.pathname === '/projects') result = await projects();
      else if (url.pathname === '/project') result = await summary(body.id) || (() => { throw new Error('No such project'); })();
      else if (url.pathname === '/start') {
        const args = ['start'];
        if (body.window) args.push('--window', String(body.window));
        else args.push('--display', String(body.display ?? 0));
        if (body.region) args.push('--region', String(body.region));
        if (body.microphone) args.push('--mic', String(body.microphone)); else args.push('--no-mic');
        if (body.systemAudio) args.push('--system-audio');
        if (body.camera) args.push('--camera', String(body.camera));
        args.push('--fps', String(body.fps || 30), '--name', String(body.name || 'demo'));
        result = await cli(args);
      } else if (url.pathname === '/render') result = await cli(['render', body.id]);
      else if (['/stop', '/pause', '/resume', '/status'].includes(url.pathname)) {
        if (!body.id) throw new Error('Project ID is required');
        result = await cli([url.pathname.slice(1), body.id]);
      } else if (url.pathname === '/reveal') {
        // A project's finished video, or its folder (the recording selected).
        const project = await summary(body.id || '');
        const file = body.kind === 'final' ? project?.final?.output : project?.recording || project?.folder;
        if (!file) throw new Error('Nothing to show yet');
        await run('open', ['-R', file]); result = {ok: true};
      } else throw new Error('Unknown request');
      res.end(JSON.stringify(result));
    } catch (error) {
      // A failed justrec command ends its stderr with {"error": …}: show that, not the whole command line.
      let message = error.message;
      try { message = JSON.parse(error.stderr.trim().split('\n').at(-1)).error || message; } catch {}
      res.writeHead(400); res.end(JSON.stringify({error: message}));
    }
  });
  const listening = await new Promise(resolve => server.once('error', error => resolve(error)).listen(port, '127.0.0.1', () => resolve(null)));
  // Already running (opened from the menu earlier): show that one.
  if (listening?.code === 'EADDRINUSE') {
    console.log(JSON.stringify({url: origin, existing: true}));
    if (open) await run('open', [origin]);
    return null;
  }
  if (listening) throw listening;
  console.log(JSON.stringify({url: origin, pid: process.pid}));
  if (open) await run('open', [origin]);
  const close = () => { server.closeAllConnections(); server.close(); };
  process.once('SIGINT', close); process.once('SIGTERM', close);
  return server;
}
