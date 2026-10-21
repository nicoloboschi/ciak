// Films use Giotto styles: one design system for diagrams, pages and videos. A style is a
// name from Giotto's style folder (~/.giotto/styles, or $GIOTTO_DIR/styles) or a path to a
// style JSON. Giotto resolves it (defaults, dark mode); this maps it onto the film theme.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {resolveStyle} from 'giotto/styles';
import {readJSON} from './common.mjs';

export const stylesDirectory = path.join(process.env.GIOTTO_DIR || path.join(os.homedir(), '.giotto'), 'styles');

export async function loadStyle(spec, directory) {
  const {name, mode} = typeof spec === 'string' ? {name: spec} : spec;
  const file = name.endsWith('.json') ? path.resolve(directory, name) : path.join(stylesDirectory, `${name}.json`);
  const raw = await readJSON(file).catch(async () => {
    const known = (await fs.readdir(stylesDirectory).catch(() => [])).filter(item => item.endsWith('.json')).map(item => item.slice(0, -5));
    throw new Error(`Style not found: ${name}. Giotto styles here: ${known.join(', ') || 'none'} (or give a path to a style .json)`);
  });
  // Videos default to the style's dark variant when it has one.
  const style = resolveStyle(raw, (mode || (raw.dark ? 'dark' : 'light')) === 'dark');
  return {
    name: raw.name || name,
    background: style.background, text: style.text, muted: style.chatWho || style.tagText, accent: style.accent, accentText: style.packetText,
    panel: style.cardFill, card: style.fill, border: style.stroke, radius: style.radius, cardShadow: style.shadow,
    font: style.font, headingFont: style.textFont || style.labelFont || style.font, monoFont: style.codeFont, fontUrl: style.fontUrl, fontWeight: style.fontWeight,
    tones: style.tones,
  };
}
