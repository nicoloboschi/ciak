// Film styles: a named set of theme fields (fonts, colors, surfaces, radius, backdrop) in a
// JSON file. Built-in styles live in styles/ in this repo; your own in ~/.justrec/styles
// (or $JUSTREC_STYLES). A film picks one with "style"; its "theme" fine-tunes on top.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {root, readJSON} from './common.mjs';

export const styleDirectories = [process.env.JUSTREC_STYLES || path.join(os.homedir(), '.justrec/styles'), path.join(root, 'styles')];

export async function listStyles() {
  const styles = [];
  for (const directory of styleDirectories) {
    for (const name of (await fs.readdir(directory).catch(() => [])).filter(item => item.endsWith('.json'))) {
      const style = await readJSON(path.join(directory, name)).catch(() => ({}));
      if (!styles.some(item => item.id === name.slice(0, -5))) styles.push({id: name.slice(0, -5), name: style.name, description: style.description, file: path.join(directory, name)});
    }
  }
  return styles;
}

export async function loadStyle(name, directory) {
  if (name.endsWith('.json')) return readJSON(path.resolve(directory, name));
  const found = (await listStyles()).find(style => style.id === name);
  if (!found) throw new Error(`Style not found: ${name}. Available: ${(await listStyles()).map(style => style.id).join(', ')} (or a path to a style .json)`);
  const {name: _, description, ...theme} = await readJSON(found.file);
  return theme;
}
