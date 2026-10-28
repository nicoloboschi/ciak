// What a custom scene can import ("ciak"): ciak's building blocks plus Remotion.
// A custom scene is a default-exported component; it receives its "props" from film.json, and
// {scene, theme, frames, reserve, recordings, images}. Mark readable text with data-check="text"
// so the layout check can see it (Text below does that), and keep `reserve` px free at the bottom
// for the captions.
import React from 'react';
export {AbsoluteFill, Sequence, Img, Audio, useCurrentFrame, useVideoConfig, interpolate, spring, Easing} from 'remotion';
export {Rich, Heading, Pill, Label, Note, Counter, LinePanel, Recording, counted, appear, font, headingFont, monoFont} from './film.jsx';
export {clamp, ease} from './parts.jsx';

export function Text({children, style, ...rest}) {
  return <div data-check="text" style={style} {...rest}>{children}</div>;
}
