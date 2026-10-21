import fs from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {createHash} from 'node:crypto';
import {bundle} from '@remotion/bundler';
import {renderMedia, renderStill, selectComposition} from '@remotion/renderer';
import {root, run, probe, readJSON, writeJSON} from './common.mjs';
import {loadProject, cursorEvents} from './project.mjs';

async function assetServer(files) {
  const server = http.createServer(async (req, res) => {
    const file = files.get(req.url);
    if (!file) { res.writeHead(404); res.end(); return; }
    try {
      const {size} = await fs.stat(file);
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Content-Type', file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'application/javascript' : file.endsWith('.css') ? 'text/css' : 'video/mp4');
      const range = req.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
      const start = range ? Number(range[1]) : 0;
      const end = range?.[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      if (start >= size || end < start) { res.writeHead(416); res.end(); return; }
      if (range) { res.statusCode = 206; res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`); }
      res.setHeader('Content-Length', end - start + 1);
      const stream = createReadStream(file, {start, end});
      stream.on('error', () => res.destroy());
      res.on('close', () => stream.destroy());
      stream.pipe(res);
    } catch { res.writeHead(500); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {server, origin: `http://127.0.0.1:${server.address().port}`};
}

export async function renderProject(file, options = {}) {
  const started = performance.now();
  const {directory, project} = await loadProject(file);
  const output = path.resolve(options.output || file.replace(/\.project\.json$/, '.edited.mp4'));
  const source = path.resolve(directory, project.source);
  if (output === source || output === path.resolve(file)) throw new Error('Render output must not overwrite the source or project');
  await fs.mkdir(path.dirname(output), {recursive: true});
  const scratch = await fs.mkdtemp(path.join(root, '.build/render-'));
  const files = new Map([['/source.mp4', source]]);
  let cameraOffset = 0;
  const webcams = (project.webcam?.segments || []).map((segment, index) => {
    const endpoint = `/camera-${index}.mp4`;
    files.set(endpoint, path.resolve(directory, segment.source));
    const item = {start: cameraOffset, end: cameraOffset + segment.duration, sourceOffset: segment.sourceOffset || 0, endpoint};
    cameraOffset += segment.duration;
    return item;
  });
  const {server, origin} = await assetServer(files);
  try {
    const code = await fs.readFile(path.join(root, 'render/index.jsx'));
    const lock = await fs.readFile(path.join(root, 'package-lock.json'));
    const hash = createHash('sha256').update(code).update(lock).digest('hex').slice(0, 16);
    const bundleDirectory = path.join(root, '.build', `bundle-${hash}`);
    if (!(await fs.stat(path.join(bundleDirectory, 'index.html')).catch(() => null))) {
      await bundle({entryPoint: path.join(root, 'render/index.jsx'), outDir: bundleDirectory, publicDir: null});
    }
    for (const name of await fs.readdir(bundleDirectory)) files.set(`/${name}`, path.join(bundleDirectory, name));
    files.set('/', path.join(bundleDirectory, 'index.html'));
    const transcriptFile = project.transcript ? path.resolve(directory, project.transcript) : source.replace(/\.[^.]+$/, '.json');
    const transcript = await readJSON(transcriptFile).catch(error => { if (project.transcript) throw error; return {segments: []}; });
    const events = await cursorEvents(project, directory);
    const inputProps = {project, sourceUrl: `${origin}/source.mp4`, events, clicks: events.filter(event => event.type === 'click'), transcript: transcript.segments || [], webcams: webcams.map(item => ({...item, url: origin + item.endpoint}))};
    const composition = await selectComposition({serveUrl: origin, id: 'Demo', inputProps});
    if (options.frame !== undefined) {
      const frame = Number(options.frame);
      if (!Number.isInteger(frame) || frame < 0 || frame >= composition.durationInFrames) throw new Error('Preview frame is outside the composition');
      await renderStill({serveUrl: origin, composition, inputProps, output, frame, imageFormat: 'png'});
      return {output, frame, elapsedSeconds: (performance.now() - started) / 1000};
    }
    const video = path.join(scratch, 'video.mp4');
    let lastProgress = -1;
    await renderMedia({serveUrl: origin, composition, inputProps, outputLocation: video,
      codec: 'h264', hardwareAcceleration: 'if-possible', videoBitrate: '10M', muted: true,
      concurrency: Math.max(1, Math.min(4, Math.floor(os.availableParallelism() / 2))),
      onProgress: ({progress}) => { const percent = Math.floor(progress * 10) * 10; if (percent !== lastProgress) { console.error(`Rendering ${percent}%`); lastProgress = percent; } },
    });
    const sourceMetadata = await probe(source);
    const hasAudio = sourceMetadata.streams.some(stream => stream.codec_type === 'audio');
    const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', video, '-i', source];
    const fps = project.export.fps;
    const duration = composition.durationInFrames / fps;
    const filters = [];
    const labels = [];
    if (!hasAudio) args.push('-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo');
    if (project.intro) {
      filters.push(`anullsrc=r=48000:cl=stereo,atrim=duration=${Math.round(project.intro.duration * fps) / fps}[intro]`); labels.push('[intro]');
    }
    project.clips.forEach((clip, index) => {
      const length = Math.max(1, Math.round((clip.end - clip.start) * fps)) / fps;
      filters.push(`[${hasAudio ? '1:a:0' : '2:a:0'}]atrim=start=${hasAudio ? clip.start : 0}:duration=${length},asetpts=PTS-STARTPTS,aresample=48000,apad,atrim=duration=${length}[clip${index}]`);
      labels.push(`[clip${index}]`);
    });
    if (project.outro) {
      filters.push(`anullsrc=r=48000:cl=stereo,atrim=duration=${Math.round(project.outro.duration * fps) / fps}[outro]`); labels.push('[outro]');
    }
    filters.push(`${labels.join('')}concat=n=${labels.length}:v=0:a=1${project.audio?.normalize ? ',loudnorm=I=-16:TP=-1.5:LRA=11' : ''}[audio]`);
    const final = path.join(scratch, 'final.mp4');
    args.push('-filter_complex', filters.join(';'), '-map', '0:v:0', '-map', '[audio]', '-c:v', 'copy', '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-b:a', '192k', '-t', String(duration), '-movflags', '+faststart', final);
    await run('ffmpeg', args);
    const metadata = await probe(final);
    if (metadata.streams.filter(stream => stream.codec_type === 'audio').length !== 1 || metadata.streams.filter(stream => stream.codec_type === 'video').length !== 1) throw new Error('Export track verification failed');
    if (Math.abs(Number(metadata.format.duration) - duration) > 0.15) throw new Error('Export duration verification failed');
    await fs.copyFile(final, output);
    const result = {output, duration, width: composition.width, height: composition.height, frames: composition.durationInFrames, elapsedSeconds: (performance.now() - started) / 1000};
    await writeJSON(`${output}.report.json`, result);
    return result;
  } finally {
    server.closeAllConnections(); server.close();
    await fs.rm(scratch, {recursive: true, force: true});
  }
}
