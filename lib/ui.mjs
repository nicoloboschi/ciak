import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {root, run, outputDir} from './common.mjs';

export async function serveUI({open = true} = {}) {
  const token = randomBytes(24).toString('hex');
  let origin;
  const cli = async args => JSON.parse(await run(process.execPath, [path.join(root, 'lib/cli.mjs'), ...args]));
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (req.headers.host !== new URL(origin).host) { res.writeHead(403); res.end(); return; }
    if (req.method === 'GET' && req.url === '/') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      const html = await fs.readFile(path.join(root, 'ui/index.html'), 'utf8');
      res.end(html.replace('__TOKEN__', token)); return;
    }
    // The finished video, for the preview player (with ranges, so it can seek).
    const media = new URL(req.url, origin);
    if (req.method === 'GET' && media.pathname === '/media' && media.searchParams.get('token') === token) {
      const file = path.resolve(media.searchParams.get('file') || '');
      const stat = file.startsWith(outputDir + path.sep) && file.endsWith('.mp4') ? await fs.stat(file).catch(() => null) : null;
      if (!stat) { res.writeHead(404); res.end(); return; }
      const [, from, to] = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '') || [];
      const start = Number(from || 0), end = to ? Number(to) : stat.size - 1;
      res.writeHead(req.headers.range ? 206 : 200, {'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1,
        ...(req.headers.range && {'Content-Range': `bytes ${start}-${end}/${stat.size}`})});
      createReadStream(file, {start, end}).pipe(res);
      return;
    }
    res.setHeader('Content-Type', 'application/json');
    if (req.method !== 'POST' || req.headers.authorization !== `Bearer ${token}` || (req.headers.origin && req.headers.origin !== origin)) {
      res.writeHead(403); res.end(JSON.stringify({error: 'Unauthorized'})); return;
    }
    try {
      let data = '';
      for await (const chunk of req) { data += chunk; if (data.length > 16384) throw new Error('Request too large'); }
      const body = JSON.parse(data || '{}');
      let result;
      if (req.url === '/sources') result = await cli(['sources']);
      else if (req.url === '/start') {
        const args = ['start'];
        if (body.window) args.push('--window', String(body.window));
        else args.push('--display', String(body.display ?? 0));
        if (body.region) args.push('--region', String(body.region));
        if (body.microphone) args.push('--mic', String(body.microphone)); else args.push('--no-mic');
        if (body.systemAudio) args.push('--system-audio');
        if (body.camera) args.push('--camera', String(body.camera));
        args.push('--fps', String(body.fps || 30), '--name', String(body.name || 'demo'));
        result = await cli(args);
      } else if (req.url === '/render') {
        if (!body.id || !/^[\w-]+$/.test(body.id)) throw new Error('Project ID is required');
        result = await cli(['render', body.id]);
      } else if (['/stop', '/pause', '/resume', '/status'].includes(req.url)) {
        if (!body.id || !/^[\w-]+$/.test(body.id)) throw new Error('Session ID is required');
        result = await cli([req.url.slice(1), body.id]);
      } else if (req.url === '/reveal') {
        const file = path.resolve(body.file || '');
        if (!file.startsWith(outputDir + path.sep)) throw new Error('Only recordings can be revealed');
        await fs.access(file);
        await run('open', ['-R', file]); result = {ok: true};
      } else throw new Error('Unknown request');
      res.end(JSON.stringify(result));
    } catch (error) { res.writeHead(400); res.end(JSON.stringify({error: error.message})); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  console.log(JSON.stringify({url: origin, pid: process.pid}));
  if (open) await run('open', [origin]);
  const close = () => { server.closeAllConnections(); server.close(); };
  process.once('SIGINT', close); process.once('SIGTERM', close);
  return server;
}
