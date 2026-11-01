// Songs: lyrics + a style in, an mp3 out, made on this Mac by ACE-Step 1.5 (MIT, ~10 GB of models).
// Its own singer, not your voice: the cloned voice speaks, it doesn't sing.
// ACE-Step has its own environment (torch + mlx), kept in ~/.ciak/ace-step, installed on first use.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {root, run, tool, outputDir} from './common.mjs';

const home = path.join(os.homedir(), '.ciak/ace-step');
const commit = 'ca1e85f';
const exists = file => fs.access(file).then(() => true, () => false);

const helper = `
import json, os, sys
job = json.loads(sys.argv[1])
sys.path.insert(0, job["home"])
from acestep.handler import AceStepHandler
from acestep.llm_inference import LLMHandler
from acestep.inference import GenerationParams, GenerationConfig, generate_music
dit = AceStepHandler()
status, ok = dit.initialize_service(project_root=job["home"], config_path="acestep-v15-turbo", device="auto", offload_to_cpu=False)
assert ok, status
lm = LLMHandler()
status, ok = lm.initialize(checkpoint_dir=os.path.join(job["home"], "checkpoints"), lm_model_path="acestep-5Hz-lm-1.7B", backend="mlx", device="auto", offload_to_cpu=False, dtype=None)
assert ok, status
params = GenerationParams(task_type="text2music", thinking=True, caption=job["style"], lyrics=job["lyrics"], vocal_language=job["lang"],
                          duration=job["seconds"], inference_steps=8, guidance_scale=1.0, seed=job["seed"])
result = generate_music(dit, lm, params=params, config=GenerationConfig(batch_size=1, audio_format="mp3"), save_dir=job["dir"])
assert result.success, result.status_message
print(json.dumps(result.audios[0]["path"]))
`;

async function install() {
  if (await exists(path.join(home, '.venv'))) return;
  console.error('First song: installing ACE-Step 1.5 (models download on the first run, ~10 GB)...');
  if (!await exists(home)) await run('git', ['clone', 'https://github.com/ACE-Step/ACE-Step-1.5.git', home]);
  await run('git', ['-C', home, 'checkout', commit]);
  await run(path.join(path.dirname(await tool('uvx')), 'uv'), ['sync'], {cwd: home, timeout: 1800000});
}

// ciak voice song "<style>" --lyrics <file|text> [--seconds 90] [--lang it] [--seed n] [--out song.mp3]
export async function song(rest) {
  const option = flag => { const index = rest.indexOf(flag); return index < 0 ? undefined : rest.splice(index, 2)[1]; };
  const lyricsArg = option('--lyrics'), out = option('--out'), seconds = Number(option('--seconds') || 90);
  const lang = option('--lang') || 'it', seed = Number(option('--seed') ?? -1);
  const style = rest.join(' ');
  if (!style || !lyricsArg) throw new Error('Usage: ciak voice song "<style>" --lyrics <file|text> [--seconds 90] [--lang it] [--out song.mp3]');
  const lyrics = await exists(lyricsArg) ? await fs.readFile(lyricsArg, 'utf8') : lyricsArg;
  await install();
  const file = path.join(root, '.build/ciak_song.py');
  await fs.mkdir(path.dirname(file), {recursive: true});
  await fs.writeFile(file, helper);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ciak-song-'));
  try {
    const stdout = await run(path.join(home, '.venv/bin/python'), [file, JSON.stringify({home, style, lyrics, lang, seconds, seed, dir})],
      {cwd: home, timeout: 1800000, env: {...process.env, ACESTEP_LM_BACKEND: 'mlx', TOKENIZERS_PARALLELISM: 'false'}});
    const made = JSON.parse(stdout.trim().split('\n').at(-1));
    const output = path.resolve(out || path.join(outputDir, `song-${Date.now().toString(36)}.mp3`));
    await fs.mkdir(path.dirname(output), {recursive: true});
    await fs.copyFile(made, output);
    return {output, seconds};
  } finally { await fs.rm(dir, {recursive: true, force: true}); }
}
