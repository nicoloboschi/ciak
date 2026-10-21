import React from 'react';
import {registerRoot, Composition, AbsoluteFill, Sequence, useCurrentFrame, useVideoConfig} from 'remotion';
import {Video} from '@remotion/media';

const clamp = (value, lower, upper) => Math.min(upper, Math.max(lower, value));
const ease = value => { value = clamp(value, 0, 1); return value * value * (3 - 2 * value); };

function lastAt(events, time) {
  let lower = 0; let upper = events.length - 1; let found = -1;
  while (lower <= upper) {
    const middle = (lower + upper) >> 1;
    if (events[middle].t <= time) { found = middle; lower = middle + 1; } else upper = middle - 1;
  }
  return found;
}

// Glide toward the next event so the cursor lands on a click exactly when it happens.
function cursorAt(events, time) {
  const found = lastAt(events, time);
  if (found < 0) return null;
  const current = events[found];
  const next = events[found + 1];
  if (!next) return current;
  const travel = Math.min(0.6, next.t - current.t);
  const amount = ease((time - (next.t - travel)) / travel);
  return {...current, x: current.x + (next.x - current.x) * amount, y: current.y + (next.y - current.y) * amount};
}

function Cursor({events, clicks, time, width, height, style}) {
  const cursor = cursorAt(events, time);
  if (!cursor || cursor.visible === false) return null;
  const recent = clicks[lastAt(clicks, time)];
  const click = recent && time - recent.t < 0.5 ? recent : null;
  const pulse = click ? (time - click.t) / 0.5 : 1;
  return <>
    {click && <div style={{position: 'absolute', left: click.x * width, top: click.y * height, width: 24 + pulse * 60, height: 24 + pulse * 60, borderRadius: '50%', border: `3px solid ${style.clickColor}`, opacity: 1 - pulse, transform: 'translate(-50%, -50%)'}}/>}
    <svg width={style.cursorSize} height={style.cursorSize * 1.35} viewBox="0 0 24 32" style={{position: 'absolute', left: cursor.x * width, top: cursor.y * height, filter: 'drop-shadow(0 2px 3px #0008)'}}>
      <path d="M2 2 L2 25 L8 19 L13 30 L18 28 L13 17 L22 17 Z" fill="white" stroke="#171923" strokeWidth="1.8" strokeLinejoin="round"/>
    </svg>
  </>;
}

function Clip({project, clip, sourceUrl, events, clicks, transcript, webcams}) {
  const frame = useCurrentFrame();
  const {fps, width, height} = useVideoConfig();
  const time = clip.start + frame / fps;
  const padding = project.style.padding;
  const ratio = Math.min((width - 2 * padding) / project.width, (height - 2 * padding) / project.height);
  const screenWidth = project.width * ratio;
  const screenHeight = project.height * ratio;
  const index = project.zooms.findIndex(item => time >= item.start && time <= item.end);
  const zoom = project.zooms[index];
  // Zooms that touch are chained: no zoom out/in between them, just a pan.
  const previous = index > 0 && Math.abs(project.zooms[index - 1].end - zoom.start) < 0.05 ? project.zooms[index - 1] : null;
  const next = zoom && project.zooms[index + 1] && Math.abs(project.zooms[index + 1].start - zoom.end) < 0.05;
  const strength = zoom ? Math.min(previous ? 1 : ease((time - zoom.start) / 0.4), next ? 1 : ease((zoom.end - time) / 0.4)) : 0;
  const pan = previous ? ease((time - zoom.start) / 0.6) : 1;
  const focus = zoom && ['x', 'y', 'scale'].reduce((values, key) => ({...values, [key]: previous ? previous[key] + (zoom[key] - previous[key]) * pan : zoom[key]}), {});
  const scale = zoom ? 1 + (focus.scale - 1) * strength : 1;
  const targetX = zoom ? clamp(screenWidth / 2 - focus.x * screenWidth * focus.scale, screenWidth * (1 - focus.scale), 0) : 0;
  const targetY = zoom ? clamp(screenHeight / 2 - focus.y * screenHeight * focus.scale, screenHeight * (1 - focus.scale), 0) : 0;
  const caption = project.captions?.enabled ? transcript.find(item => time >= item.start && time < item.end) : null;
  const webcam = webcams?.find(item => time >= item.start && time < item.end);
  return <AbsoluteFill style={{justifyContent: 'center', alignItems: 'center'}}>
    <div style={{width: screenWidth, height: screenHeight, overflow: 'hidden', position: 'relative', borderRadius: project.style.radius, boxShadow: project.style.shadow ? '0 24px 70px #0008, 0 0 0 1px #ffffff18' : undefined}}>
      <div style={{width: screenWidth, height: screenHeight, transformOrigin: '0 0', transform: `translate(${targetX * strength}px, ${targetY * strength}px) scale(${scale})`}}>
        <Video src={sourceUrl} muted trimBefore={Math.round(clip.start * fps)} objectFit="fill" style={{width: screenWidth, height: screenHeight}}/>
        {!project.cursorBaked && <Cursor events={events} clicks={clicks} time={time} width={screenWidth} height={screenHeight} style={project.style}/>}
      </div>
    </div>
    {webcam && <div style={{position: 'absolute', bottom: padding, [project.webcam.position === 'bottom-left' ? 'left' : 'right']: padding, width: width * project.webcam.size, height: width * project.webcam.size, borderRadius: '50%', overflow: 'hidden', boxShadow: '0 12px 40px #0009', border: '4px solid #ffffffcc'}}>
      <Sequence from={Math.max(0, Math.round((webcam.start - clip.start) * fps))} layout="none" premountFor={fps}>
        <Video src={webcam.url} muted trimBefore={Math.round((Math.max(0, clip.start - webcam.start) + (webcam.sourceOffset || 0)) * fps)} objectFit="cover" style={{width: '100%', height: '100%'}}/>
      </Sequence>
    </div>}
    {caption && <div style={{position: 'absolute', bottom: height * 0.07, maxWidth: width * 0.8, padding: '14px 24px', background: '#10121ee8', color: 'white', fontFamily: 'Arial, sans-serif', fontWeight: 600, fontSize: Math.round(width / 40), borderRadius: 12, textAlign: 'center', lineHeight: 1.35}}>{caption.text.trim()}</div>}
  </AbsoluteFill>;
}

function Title({text}) {
  const frame = useCurrentFrame();
  return <AbsoluteFill style={{alignItems: 'center', justifyContent: 'center', color: 'white', fontFamily: 'Arial, sans-serif', fontSize: 72, fontWeight: 700, textAlign: 'center', padding: 100, opacity: ease(frame / 12), transform: `translateY(${(1 - ease(frame / 18)) * 20}px)`}}>{text}</AbsoluteFill>;
}

function Demo(props) {
  const {project} = props;
  const {fps} = useVideoConfig();
  let offset = project.intro ? Math.round(project.intro.duration * fps) : 0;
  const sequences = project.clips.map((clip, index) => {
    const duration = Math.max(1, Math.round((clip.end - clip.start) * fps));
    const sequence = <Sequence key={index} from={offset} durationInFrames={duration} premountFor={fps}><Clip {...props} clip={clip}/></Sequence>;
    offset += duration;
    return sequence;
  });
  return <AbsoluteFill style={{background: project.style.background}}>
    {project.intro && <Sequence durationInFrames={Math.round(project.intro.duration * fps)} premountFor={fps}><Title text={project.intro.text}/></Sequence>}
    {sequences}
    {project.outro && <Sequence from={offset} durationInFrames={Math.round(project.outro.duration * fps)} premountFor={fps}><Title text={project.outro.text}/></Sequence>}
  </AbsoluteFill>;
}

registerRoot(() => <Composition id="Demo" component={Demo} width={1920} height={1080} fps={30} durationInFrames={30}
  calculateMetadata={({props}) => ({...props.project.export, durationInFrames: props.project.clips.reduce((total, clip) => total + Math.max(1, Math.round((clip.end - clip.start) * props.project.export.fps)), 0) + Math.round(((props.project.intro?.duration || 0) + (props.project.outro?.duration || 0)) * props.project.export.fps)})}/>);
