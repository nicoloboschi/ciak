import React from 'react';
import {registerRoot, Composition, AbsoluteFill, Sequence, Img, useCurrentFrame, useVideoConfig} from 'remotion';
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

// box: the area the screen is fitted into (the whole video, or half of it in a comparison).
function Clip({project, clip, sourceUrl, events, clicks, transcript, webcams, box}) {
  const frame = useCurrentFrame();
  const {fps, width, height} = useVideoConfig();
  const time = clip.start + frame / fps;
  const padding = box?.padding ?? project.style.padding;
  const ratio = Math.min(((box?.width ?? width) - 2 * padding) / project.width, ((box?.height ?? height) - 2 * padding) / project.height);
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

// ---- Films: a sequence of scenes (titles, images, slides, figures, recordings) with captions.

const font = '-apple-system, "SF Pro Display", "Helvetica Neue", Arial, sans-serif';
const appear = (frame, delay = 0, length = 18) => ease((frame - delay) / length);

function Recording({recording, box, frames}) {
  const {fps} = useVideoConfig();
  const {project} = recording;
  let offset = 0;
  const sequences = project.clips.map((clip, index) => {
    const duration = Math.max(1, Math.round((clip.end - clip.start) * fps));
    const sequence = <Sequence key={index} from={offset} durationInFrames={duration} premountFor={fps}>
      <Clip {...recording} project={{...project, captions: {enabled: false}}} transcript={[]} clip={clip} box={box}/>
    </Sequence>;
    offset += duration;
    return sequence;
  });
  // If the narration runs longer than the recording, hold its last frame.
  const padding = box.padding;
  const ratio = Math.min((box.width - 2 * padding) / project.width, (box.height - 2 * padding) / project.height);
  return <AbsoluteFill>
    {sequences}
    {frames > offset && <Sequence from={offset}><AbsoluteFill style={{justifyContent: 'center', alignItems: 'center'}}>
      <Img src={recording.lastFrameUrl} style={{width: project.width * ratio, height: project.height * ratio, borderRadius: project.style.radius, boxShadow: '0 24px 70px #0008, 0 0 0 1px #ffffff18'}}/>
    </AbsoluteFill></Sequence>}
  </AbsoluteFill>;
}

function Label({children, theme, frame, delay = 6}) {
  return <div style={{display: 'inline-block', padding: '10px 22px', borderRadius: 999, background: theme.accent, color: theme.accentText, fontFamily: font, fontWeight: 700, fontSize: 30, letterSpacing: 1, opacity: appear(frame, delay), transform: `translateY(${(1 - appear(frame, delay)) * 12}px)`}}>{children}</div>;
}

function Heading({text, theme, frame, size = 64}) {
  return <div style={{fontFamily: font, fontWeight: 800, fontSize: size, color: theme.text, letterSpacing: -1.5, lineHeight: 1.1, opacity: appear(frame), transform: `translateY(${(1 - appear(frame)) * 24}px)`}}>{text}</div>;
}

function TitleScene({scene, theme}) {
  const frame = useCurrentFrame();
  return <AbsoluteFill style={{alignItems: 'center', justifyContent: 'center', textAlign: 'center', padding: 140, gap: 34}}>
    {scene.kicker && <Label theme={theme} frame={frame} delay={0}>{scene.kicker}</Label>}
    <div style={{fontFamily: font, fontWeight: 800, fontSize: 104, color: theme.text, letterSpacing: -3, lineHeight: 1.04, opacity: appear(frame, 4, 22), transform: `scale(${0.94 + 0.06 * appear(frame, 4, 22)})`}}>{scene.text}</div>
    {scene.subtitle && <div style={{fontFamily: font, fontSize: 40, color: theme.muted, maxWidth: 1300, lineHeight: 1.35, opacity: appear(frame, 16)}}>{scene.subtitle}</div>}
  </AbsoluteFill>;
}

function ImageScene({scene, theme, frames}) {
  const frame = useCurrentFrame();
  const zoom = 1 + 0.06 * frame / Math.max(1, frames);
  return <AbsoluteFill style={{alignItems: 'center', justifyContent: 'center', padding: '70px 120px 110px', gap: 30}}>
    {scene.heading && <Heading text={scene.heading} theme={theme} frame={frame} size={52}/>}
    <div style={{flex: 1, minHeight: 0, width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: appear(frame, 4, 20)}}>
      <div style={{maxWidth: '100%', maxHeight: '100%', borderRadius: 22, overflow: 'hidden', boxShadow: '0 30px 80px #0009, 0 0 0 1px #ffffff1a', display: 'flex'}}>
        <Img src={scene.url} style={{maxWidth: '100%', maxHeight: scene.heading ? 760 : 880, objectFit: 'contain', transform: `scale(${zoom})`}}/>
      </div>
    </div>
  </AbsoluteFill>;
}

function SlideScene({scene, theme, frames}) {
  const frame = useCurrentFrame();
  const bullets = scene.bullets || [];
  // Bullets appear one by one across the first two thirds of the scene.
  const step = Math.max(10, Math.floor(frames * 0.6 / Math.max(1, bullets.length)));
  return <AbsoluteFill style={{flexDirection: 'row', alignItems: 'center', padding: '0 110px 60px', gap: 70}}>
    <div style={{flex: 1, display: 'flex', flexDirection: 'column', gap: 40}}>
      {scene.kicker && <div><Label theme={theme} frame={frame} delay={0}>{scene.kicker}</Label></div>}
      <Heading text={scene.heading} theme={theme} frame={frame}/>
      {bullets.map((bullet, index) => <div key={index} style={{display: 'flex', gap: 22, alignItems: 'baseline', fontFamily: font, fontSize: 40, color: theme.text, lineHeight: 1.3, opacity: appear(frame, 12 + index * step), transform: `translateX(${(1 - appear(frame, 12 + index * step)) * -30}px)`}}>
        <span style={{width: 16, height: 16, borderRadius: 4, background: theme.accent, flex: 'none', transform: 'translateY(-6px)'}}/>{bullet}</div>)}
    </div>
    {scene.url && <div style={{flex: 1.5, display: 'flex', justifyContent: 'center', opacity: appear(frame, 8, 22)}}>
      <Img src={scene.url} style={{maxWidth: '100%', maxHeight: 780, borderRadius: 22, boxShadow: '0 30px 80px #0009, 0 0 0 1px #ffffff1a', transform: `translateY(${(1 - appear(frame, 8, 22)) * 30}px)`}}/>
    </div>}
  </AbsoluteFill>;
}

function StatsScene({scene, theme}) {
  const frame = useCurrentFrame();
  return <AbsoluteFill style={{alignItems: 'center', justifyContent: 'center', gap: 80, padding: 120}}>
    {scene.heading && <Heading text={scene.heading} theme={theme} frame={frame}/>}
    <div style={{display: 'flex', gap: 70, justifyContent: 'center'}}>
      {scene.items.map((item, index) => {
        // Count up the number inside the value ("55M+" counts 0 → 55).
        const match = String(item.value).match(/^(\D*)([\d.,]+)(.*)$/);
        const progress = appear(frame, 8 + index * 8, 40);
        const target = match ? Number(match[2].replace(/,/g, '')) : 0;
        const decimals = match?.[2].includes('.') ? match[2].split('.')[1].length : 0;
        const shown = match ? `${match[1]}${(target * progress).toLocaleString('en-US', {minimumFractionDigits: decimals, maximumFractionDigits: decimals})}${match[3]}` : item.value;
        return <div key={index} style={{minWidth: 360, padding: '48px 40px', borderRadius: 28, background: theme.panel, boxShadow: '0 0 0 1px #ffffff14', textAlign: 'center', opacity: appear(frame, 4 + index * 8), transform: `translateY(${(1 - appear(frame, 4 + index * 8)) * 30}px)`}}>
          <div style={{fontFamily: font, fontWeight: 800, fontSize: 110, color: theme.accent, letterSpacing: -3, fontVariantNumeric: 'tabular-nums'}}>{shown}</div>
          <div style={{fontFamily: font, fontSize: 34, color: theme.muted, marginTop: 12}}>{item.label}</div>
        </div>;
      })}
    </div>
  </AbsoluteFill>;
}

function ChartScene({scene, theme}) {
  const frame = useCurrentFrame();
  const highest = Math.max(...scene.bars.map(bar => bar.value));
  return <AbsoluteFill style={{padding: '90px 160px 230px', gap: 60}}>
    <Heading text={scene.heading} theme={theme} frame={frame} size={56}/>
    <div style={{flex: 1, display: 'flex', alignItems: 'flex-end', gap: 50, borderBottom: `3px solid ${theme.muted}55`}}>
      {scene.bars.map((bar, index) => {
        const grow = appear(frame, 10 + index * 6, 36);
        return <div key={index} style={{position: 'relative', flex: 1, height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', alignItems: 'center', gap: 16}}>
          <div style={{fontFamily: font, fontWeight: 800, fontSize: 44, color: theme.text, opacity: grow}}>{Math.round(bar.value * grow).toLocaleString('en-US')}{scene.unit || ''}</div>
          <div style={{width: '70%', height: `${78 * bar.value / highest * grow}%`, borderRadius: '14px 14px 0 0', background: bar.highlight ? theme.accent : `${theme.muted}88`}}/>
          <div style={{fontFamily: font, fontSize: 32, color: theme.muted, position: 'absolute', bottom: -58, whiteSpace: 'nowrap'}}>{bar.label}</div>
        </div>;
      })}
    </div>
  </AbsoluteFill>;
}

function RecordingScene({scene, theme, frames}) {
  const frame = useCurrentFrame();
  const {width, height} = useVideoConfig();
  return <AbsoluteFill>
    <Recording recording={scene.recording} frames={frames} box={{width, height: height - 40, padding: 70}}/>
    {scene.label && <div style={{position: 'absolute', top: 22, width: '100%', textAlign: 'center'}}><Label theme={theme} frame={frame}>{scene.label}</Label></div>}
  </AbsoluteFill>;
}

function CompareScene({scene, theme, frames}) {
  const frame = useCurrentFrame();
  const {width} = useVideoConfig();
  // Each side gets half the width; its box is exactly as tall as the screen inside it, so labels sit right above.
  const padding = 34;
  return <AbsoluteFill style={{flexDirection: 'row', alignItems: 'center', paddingBottom: 60}}>
    {[scene.before, scene.after].map((side, index) => {
      const {project} = side.recording;
      const box = {width: width / 2, height: (width / 2 - 2 * padding) * project.height / project.width + 2 * padding, padding};
      return <div key={index} style={{width: box.width, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, opacity: appear(frame, index * 8, 20)}}>
        <div style={{padding: '10px 26px', borderRadius: 999, fontFamily: font, fontWeight: 700, fontSize: 32, letterSpacing: 1,
          background: index ? theme.accent : theme.panel, color: index ? theme.accentText : theme.muted, boxShadow: '0 0 0 1px #ffffff1a'}}>{side.label || (index ? 'After' : 'Before')}</div>
        <div style={{position: 'relative', width: box.width, height: box.height}}><Recording recording={side.recording} frames={frames} box={box}/></div>
      </div>;
    })}
  </AbsoluteFill>;
}

const scenes = {title: TitleScene, image: ImageScene, slide: SlideScene, stats: StatsScene, chart: ChartScene, recording: RecordingScene, compare: CompareScene};

function Captions({captions, theme}) {
  const frame = useCurrentFrame();
  const {fps, width} = useVideoConfig();
  const time = frame / fps;
  const caption = captions.find(item => time >= item.start && time < item.end);
  if (!caption) return null;
  const fade = Math.min(ease((time - caption.start) / 0.12), ease((caption.end - time) / 0.12));
  return <div style={{position: 'absolute', bottom: 36, width: '100%', display: 'flex', justifyContent: 'center', opacity: fade}}>
    <div style={{maxWidth: width * 0.8, padding: '12px 28px', borderRadius: 14, background: '#0b0d14e6', color: '#fff', fontFamily: font, fontWeight: 600, fontSize: 40, lineHeight: 1.3, textAlign: 'center', boxShadow: '0 8px 30px #0008'}}>{caption.text}</div>
  </div>;
}

function Film({film}) {
  const {fps} = useVideoConfig();
  const theme = film.theme;
  return <AbsoluteFill style={{background: theme.background}}>
    {film.scenes.map((scene, index) => {
      const Scene = scenes[scene.type];
      return <Sequence key={index} from={scene.from} durationInFrames={scene.frames} premountFor={fps}>
        <FadeInOut frames={scene.frames}><Scene scene={scene} theme={theme} frames={scene.frames}/></FadeInOut>
      </Sequence>;
    })}
    {film.captions && <Captions captions={film.captions} theme={theme}/>}
  </AbsoluteFill>;
}

function FadeInOut({frames, children}) {
  const frame = useCurrentFrame();
  return <AbsoluteFill style={{opacity: Math.min(ease(frame / 10), ease((frames - frame) / 10))}}>{children}</AbsoluteFill>;
}

registerRoot(() => <><Composition id="Demo" component={Demo} width={1920} height={1080} fps={30} durationInFrames={30}
  calculateMetadata={({props}) => ({...props.project.export, durationInFrames: props.project.clips.reduce((total, clip) => total + Math.max(1, Math.round((clip.end - clip.start) * props.project.export.fps)), 0) + Math.round(((props.project.intro?.duration || 0) + (props.project.outro?.duration || 0)) * props.project.export.fps)})}/>
  <Composition id="Film" component={Film} width={1920} height={1080} fps={60} durationInFrames={60}
    calculateMetadata={({props}) => ({width: props.film.width, height: props.film.height, fps: props.film.fps, durationInFrames: props.film.frames})}/></>);
