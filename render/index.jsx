import React, {useEffect, useState} from 'react';
import {registerRoot, Composition, AbsoluteFill, Sequence, Img, useCurrentFrame, useVideoConfig, delayRender, continueRender} from 'remotion';
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
function Clip({project, clip, sourceUrl, events, clicks, transcript, webcams, box, rate = 1}) {
  const frame = useCurrentFrame();
  const {fps, width, height} = useVideoConfig();
  const time = clip.start + frame * rate / fps;
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
        <Video src={sourceUrl} muted playbackRate={rate} trimBefore={Math.round(clip.start * fps)} objectFit="fill" style={{width: screenWidth, height: screenHeight}}/>
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
// Is a #rrggbb color light? (to pick dark or light text on top of it)
const light = hex => { const [r, g, b] = (hex.match(/^#(..)(..)(..)/) || [0, 'ff', 'ff', 'ff']).slice(1).map(part => parseInt(part, 16)); return 0.299 * r + 0.587 * g + 0.114 * b > 150; };

// Rich text: *muted words* and [accent words]; words reveal one by one.
function parseRich(text = '') {
  const words = [];
  for (const [, muted, accent, plain] of String(text).matchAll(/\*([^*]+)\*|\[([^\]]+)\]|([^*[]+)/g)) {
    const kind = muted ? 'muted' : accent ? 'accent' : 'plain';
    for (const word of (muted || accent || plain).split(/(\s+)/)) if (word) words.push({word, kind});
  }
  return words;
}

function Rich({text, theme, frame = 1000, delay = 0, stagger = 2, onDark}) {
  let index = 0;
  return <>{parseRich(text).map((item, key) => {
    if (!item.word.trim()) return <span key={key}>{item.word}</span>;
    const shown = appear(frame, delay + stagger * index++, 14);
    const color = item.kind === 'muted' ? (onDark ? '#ffffffa0' : theme.muted) : item.kind === 'accent' ? undefined : undefined;
    const accent = item.kind === 'accent' ? {backgroundImage: theme.accentGradient || `linear-gradient(90deg, ${theme.accent}, ${theme.accent})`, WebkitBackgroundClip: 'text', backgroundClip: 'text', color: 'transparent'} : {};
    return <span key={key} style={{display: 'inline-block', color, ...accent, opacity: shown, transform: `translateY(${(1 - shown) * 18}px)`, filter: `blur(${(1 - shown) * 6}px)`}}>{item.word}</span>;
  })}</>;
}

// Footage or a still behind a scene, slowly pushing in, darkened so text stays readable.
function Background({scene, frames}) {
  const frame = useCurrentFrame();
  if (!scene.backgroundUrl) return null;
  const zoom = 1.04 + 0.06 * frame / Math.max(1, frames);
  const style = {position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', transform: `scale(${zoom})`};
  return <AbsoluteFill>
    {scene.backgroundVideo ? <Video src={scene.backgroundUrl} muted loop objectFit="cover" style={style}/> : <Img src={scene.backgroundUrl} style={style}/>}
    <AbsoluteFill style={{background: `linear-gradient(180deg, #000000${scene.dim ?? '55'} 0%, #00000022 45%, #000000${scene.dim ?? '66'} 100%)`}}/>
  </AbsoluteFill>;
}

function Recording({recording, box, frames, rate = 1}) {
  const {fps} = useVideoConfig();
  const {project} = recording;
  let offset = 0;
  const sequences = project.clips.map((clip, index) => {
    const duration = Math.max(1, Math.round((clip.end - clip.start) * fps / rate));
    const sequence = <Sequence key={index} from={offset} durationInFrames={duration} premountFor={fps}>
      <Clip {...recording} project={{...project, captions: {enabled: false}}} transcript={[]} clip={clip} box={box} rate={rate}/>
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
      <Img src={recording.lastFrameUrl} style={{width: project.width * ratio, height: project.height * ratio, borderRadius: project.style.radius, boxShadow: '0 24px 70px #0005, 0 0 0 1px #0000000f'}}/>
    </AbsoluteFill></Sequence>}
  </AbsoluteFill>;
}

function Label({children, theme, frame, delay = 6}) {
  return <div data-check="text" style={{display: 'inline-block', padding: '10px 22px', borderRadius: 999, background: theme.accent, color: theme.accentText, fontFamily: font, fontWeight: 700, fontSize: 28, letterSpacing: 1, opacity: appear(frame, delay), transform: `translateY(${(1 - appear(frame, delay)) * 12}px)`}}>{children}</div>;
}

function Heading({text, theme, frame, size = 64, onDark, align}) {
  return <div data-check="text" style={{fontFamily: font, fontWeight: 700, fontSize: size, color: onDark ? '#fff' : theme.text, letterSpacing: -size / 36, lineHeight: 1.1, textAlign: align, textShadow: onDark ? '0 2px 30px #0008' : undefined}}><Rich text={text} theme={theme} frame={frame} onDark={onDark}/></div>;
}

function Pill({children, theme, frame, delay, onDark, size = 30}) {
  const shown = appear(frame, delay, 16);
  return <div data-check="text" style={{display: 'inline-flex', alignItems: 'center', gap: 10, padding: '12px 26px', borderRadius: 999, background: onDark ? '#ffffffe8' : theme.panel, color: theme.text, fontFamily: font, fontWeight: 600, fontSize: size,
    boxShadow: '0 10px 40px #0003, 0 0 0 1px #0000000d', opacity: shown, transform: `translateY(${(1 - shown) * 16}px) scale(${0.96 + 0.04 * shown})`}}>{children}</div>;
}

// Counts like a meter: fast at first, then settling on the final value.
function counted(value, progress) {
  const match = String(value).match(/^(\D*)([\d.,]+)(.*)$/);
  if (!match) return value;
  const target = Number(match[2].replace(/,/g, ''));
  const decimals = match[2].includes('.') ? match[2].split('.')[1].length : 0;
  return `${match[1]}${(target * progress).toLocaleString('en-US', {minimumFractionDigits: decimals, maximumFractionDigits: decimals})}${match[3]}`;
}

function Counter({counter, theme, frame, frames, onDark}) {
  const from = Number(String(counter.from ?? 0).replace(/,/g, ''));
  const to = Number(String(counter.to).replace(/,/g, ''));
  const progress = clamp((frame - 10) / Math.max(1, frames * 0.8 - 10), 0, 1);
  const value = Math.round(from * Math.pow(to / Math.max(1, from), progress)); // exponential: memory grows
  return <Pill theme={theme} frame={frame} delay={8} onDark={onDark} size={40}><b style={{fontVariantNumeric: 'tabular-nums'}}>{value.toLocaleString('en-US')}</b><span style={{color: theme.muted, fontWeight: 500, fontSize: 28}}>{counter.label}</span></Pill>;
}

function TitleScene({scene, theme, frames}) {
  const frame = useCurrentFrame();
  const onDark = Boolean(scene.backgroundUrl);
  const top = scene.align === 'top';
  // Chips: small "done" notifications that pop in around the frame, one after another.
  const spots = [[0.58, 0.58], [0.28, 0.72], [0.68, 0.38], [0.18, 0.5], [0.5, 0.82], [0.75, 0.66]];
  return <AbsoluteFill>
    <Background scene={scene} frames={frames}/>
    <AbsoluteFill style={{alignItems: top ? 'flex-start' : 'center', justifyContent: top ? 'flex-start' : 'center', textAlign: top ? 'left' : 'center', padding: top ? '80px 110px' : 140, gap: 30}}>
      {scene.kicker && <div data-check="text" style={{fontFamily: font, fontWeight: 600, fontSize: 28, letterSpacing: 6, color: onDark ? '#ffffffd0' : theme.muted, opacity: appear(frame, 0)}}>{scene.kicker}</div>}
      <div data-check="text" style={{fontFamily: font, fontWeight: 700, fontSize: scene.size || (top ? 76 : 112), color: onDark ? '#fff' : theme.text, letterSpacing: -3, lineHeight: 1.04, textShadow: onDark ? '0 2px 40px #0009' : undefined}}>
        <Rich text={scene.text} theme={theme} frame={frame} delay={4} stagger={3} onDark={onDark}/>
      </div>
      {scene.subtitle && <div data-check="text" style={{fontFamily: font, fontSize: 40, color: onDark ? '#ffffffe0' : theme.muted, maxWidth: 1300, lineHeight: 1.35, opacity: appear(frame, 18), textShadow: onDark ? '0 2px 20px #0009' : undefined}}>{scene.subtitle}</div>}
      {scene.pill && <Pill theme={theme} frame={frame} delay={30} onDark={onDark}><Rich text={scene.pill} theme={theme}/></Pill>}
      {scene.counter && <Counter counter={scene.counter} theme={theme} frame={frame} frames={frames} onDark={onDark}/>}
    </AbsoluteFill>
    {(scene.chips || []).map((chip, index) => {
      const [x, y] = spots[index % spots.length];
      const shown = appear(frame, 20 + index * 14, 12);
      return <div key={index} data-check="text" style={{position: 'absolute', left: `${x * 100}%`, top: `${y * 100}%`, transform: `translate(-50%, -50%) scale(${0.8 + 0.2 * shown})`, opacity: shown,
        padding: '12px 22px', borderRadius: 14, background: '#ffffffee', fontFamily: font, fontSize: 26, color: theme.text, boxShadow: '0 12px 40px #0005', whiteSpace: 'nowrap'}}>
        <Rich text={chip} theme={theme}/> <span style={{color: '#16a34a', fontWeight: 700}}>✓</span>
      </div>;
    })}
  </AbsoluteFill>;
}

function ImageScene({scene, theme, frames}) {
  const frame = useCurrentFrame();
  const zoom = 1 + 0.06 * frame / Math.max(1, frames);
  return <AbsoluteFill style={{alignItems: 'center', justifyContent: 'center', padding: '70px 120px 110px', gap: 30}}>
    {scene.heading && <Heading text={scene.heading} theme={theme} frame={frame} size={56}/>}
    <div style={{flex: 1, minHeight: 0, width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: appear(frame, 4, 20)}}>
      <div data-check="media" style={{maxWidth: '100%', maxHeight: '100%', borderRadius: 22, overflow: 'hidden', boxShadow: '0 30px 80px #0005, 0 0 0 1px #0000000f', display: 'flex'}}>
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
      {bullets.map((bullet, index) => <div key={index} data-check="text" style={{display: 'flex', gap: 22, alignItems: 'baseline', fontFamily: font, fontSize: 40, color: theme.text, lineHeight: 1.3, opacity: appear(frame, 12 + index * step), transform: `translateX(${(1 - appear(frame, 12 + index * step)) * -30}px)`}}>
        <span style={{width: 16, height: 16, borderRadius: 4, background: theme.accent, flex: 'none', transform: 'translateY(-6px)'}}/><span><Rich text={bullet} theme={theme}/></span></div>)}
    </div>
    {scene.url && <div style={{flex: 1.5, display: 'flex', justifyContent: 'center', opacity: appear(frame, 8, 22)}}>
      <Img data-check="media" src={scene.url} style={{maxWidth: '100%', maxHeight: 780, borderRadius: 22, boxShadow: '0 30px 80px #0005, 0 0 0 1px #0000000f', transform: `translateY(${(1 - appear(frame, 8, 22)) * 30}px)`}}/>
    </div>}
  </AbsoluteFill>;
}

function StatsScene({scene, theme, frames}) {
  const frame = useCurrentFrame();
  const onDark = Boolean(scene.backgroundUrl);
  return <AbsoluteFill>
    <Background scene={scene} frames={frames}/>
    <AbsoluteFill style={{alignItems: 'center', justifyContent: onDark ? 'flex-end' : 'center', gap: 80, padding: onDark ? '0 120px 150px' : 120}}>
      {scene.heading && <Heading text={scene.heading} theme={theme} frame={frame} onDark={onDark}/>}
      <div style={{display: 'flex', gap: 60, justifyContent: 'center'}}>
        {scene.items.map((item, index) => {
          const shown = appear(frame, 4 + index * 8);
          return <div key={index} data-check="text" style={{minWidth: 380, padding: '40px 56px', borderRadius: 28, textAlign: 'center', opacity: shown, transform: `translateY(${(1 - shown) * 30}px)`,
            background: onDark ? '#ffffffe6' : theme.panel, boxShadow: onDark ? '0 20px 60px #0006' : '0 0 0 1px #0000000d, 0 20px 50px #0000000f', backdropFilter: 'blur(20px)'}}>
            <div style={{fontFamily: font, fontWeight: 700, fontSize: 120, color: theme.text, letterSpacing: -4, fontVariantNumeric: 'tabular-nums', lineHeight: 1}}>{counted(item.value, appear(frame, 6 + index * 8, 36))}</div>
            <div style={{fontFamily: font, fontSize: 30, color: theme.muted, marginTop: 14}}>{item.label}</div>
          </div>;
        })}
      </div>
    </AbsoluteFill>
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
          <div data-check="text" style={{fontFamily: font, fontWeight: 800, fontSize: 44, color: theme.text, opacity: grow}}>{Math.round(bar.value * grow).toLocaleString('en-US')}{scene.unit || ''}</div>
          <div style={{width: '70%', height: `${78 * bar.value / highest * grow}%`, borderRadius: '14px 14px 0 0', background: bar.highlight ? theme.accent : `${theme.muted}88`}}/>
          <div data-check="text" style={{fontFamily: font, fontSize: 32, color: theme.muted, position: 'absolute', bottom: -58, whiteSpace: 'nowrap'}}>{bar.label}</div>
        </div>;
      })}
    </div>
  </AbsoluteFill>;
}

// Line charts: each series draws left to right; "projected" points are dashed; the last
// point gets a dot and a label. Each series uses its own scale unless "shared" is set.
function LinePanel({panel, theme, frame, frames, width, height}) {
  const left = 60; const right = panel.series.some(item => item.label) ? 250 : 40; const top = 30; const bottom = 60;
  const plotWidth = width - left - right; const plotHeight = height - top - bottom;
  const shared = panel.shared ? Math.max(...panel.series.flatMap(item => item.values)) : null;
  const draw = clamp((frame - 12) / Math.max(1, frames * 0.55), 0, 1);
  const colors = [theme.text, theme.muted, theme.accent];
  const yOf = (series, value) => top + plotHeight * (1 - 0.92 * value / (series.top ?? shared ?? Math.max(...series.values)));
  // End labels: keep them at least 40px apart so they never overlap.
  const labels = panel.series.map((series, index) => ({index, y: yOf(series, series.values.at(-1))})).sort((a, b) => a.y - b.y);
  labels.forEach((label, order) => { if (order) label.y = Math.max(label.y, labels[order - 1].y + 40); });
  const labelY = Object.fromEntries(labels.map(label => [label.index, label.y]));
  return <svg width={width} height={height} style={{overflow: 'visible'}}>
    {[0, 1, 2, 3].map(line => <line key={line} x1={left} x2={left + plotWidth} y1={top + plotHeight * line / 3} y2={top + plotHeight * line / 3} stroke={theme.muted} strokeOpacity={line === 3 ? 0.4 : 0.15}/>)}
    {panel.x.map((label, index) => <text key={index} data-check="text" x={left + plotWidth * index / (panel.x.length - 1)} y={height - 18} textAnchor="middle" fontFamily={font} fontSize={24} fill={theme.muted} opacity={draw * (panel.x.length - 1) >= index - 0.5 ? 1 : 0.3}>{label}</text>)}
    {panel.series.map((series, index) => {
      const points = series.values.map((value, step) => [left + plotWidth * step / (series.values.length - 1), yOf(series, value)]);
      const reach = draw * (points.length - 1);
      const visible = points.filter((_, step) => step <= reach);
      const whole = Math.floor(reach); const part = reach - whole;
      if (whole < points.length - 1) visible.push([points[whole][0] + (points[whole + 1][0] - points[whole][0]) * part, points[whole][1] + (points[whole + 1][1] - points[whole][1]) * part]);
      const color = series.color || colors[index % colors.length];
      const projected = series.projectedFrom ?? points.length;
      const solid = visible.slice(0, projected + 1); const dashed = visible.slice(Math.max(0, projected));
      const path = list => list.map(([x, y], step) => `${step ? 'L' : 'M'}${x},${y}`).join(' ');
      const end = points.at(-1);
      return <g key={index}>
        {solid.length > 1 && <path d={path(solid)} fill="none" stroke={color} strokeWidth={5} strokeLinejoin="round" strokeLinecap="round"/>}
        {dashed.length > 1 && <path d={path(dashed)} fill="none" stroke={color} strokeWidth={5} strokeDasharray="14 10" strokeLinecap="round"/>}
        {draw >= 1 && <><circle cx={end[0]} cy={end[1]} r={10} fill={color}/>
          {series.label && <text data-check="text" x={end[0] + 22} y={labelY[index] + 9} fontFamily={font} fontWeight={700} fontSize={28} fill={color} opacity={appear(frame, 12 + frames * 0.55, 12)}>{series.label}</text>}</>}
      </g>;
    })}
  </svg>;
}

function LinesScene({scene, theme, frames}) {
  const frame = useCurrentFrame();
  const {width} = useVideoConfig();
  const panels = scene.panels;
  const panelWidth = (width - 220 - (panels.length - 1) * 40) / panels.length;
  return <AbsoluteFill style={{alignItems: 'center', padding: '80px 110px 150px', gap: 26}}>
    <Heading text={scene.heading} theme={theme} frame={frame} size={68} align="center"/>
    {scene.legend && <div data-check="text" style={{display: 'flex', gap: 36, fontFamily: font, fontSize: 26, color: theme.muted, opacity: appear(frame, 10)}}>
      {scene.legend.map((item, index) => <span key={index} style={{display: 'flex', alignItems: 'center', gap: 10}}><span style={{width: 16, height: 16, borderRadius: 8, background: item.color || [theme.text, theme.muted, theme.accent][index % 3]}}/>{item.label}</span>)}
    </div>}
    <div style={{display: 'flex', gap: 40, flex: 1, minHeight: 0, width: '100%'}}>
      {panels.map((panel, index) => <div key={index} style={{flex: 1, borderRadius: 26, background: theme.card, boxShadow: '0 0 0 1px #0000000c, 0 24px 60px #0000000d', padding: '30px 34px', display: 'flex', flexDirection: 'column', opacity: appear(frame, 6 + index * 6, 20)}}>
        {panel.title && <div data-check="text" style={{fontFamily: font, fontWeight: 700, fontSize: 32, color: theme.text}}>{panel.title}</div>}
        <div style={{flex: 1}}><LinePanel panel={panel} theme={theme} frame={frame} frames={frames} width={panelWidth - 68} height={panels.length > 1 ? 470 : 560}/></div>
        {panel.footer && <div data-check="text" style={{textAlign: 'center', fontFamily: font, fontWeight: 700, fontSize: 40, color: theme.text, opacity: appear(frame, 12 + frames * 0.6, 14)}}><Rich text={panel.footer} theme={theme}/></div>}
        {panel.note && <div data-check="text" style={{textAlign: 'center', fontFamily: font, fontSize: 20, color: theme.muted, marginTop: 6}}>{panel.note}</div>}
      </div>)}
    </div>
  </AbsoluteFill>;
}

function RecordingScene({scene, theme, frames, reserve}) {
  const frame = useCurrentFrame();
  const {width, height} = useVideoConfig();
  const top = scene.heading ? 170 : 40;
  // Leave the caption band at the bottom free.
  const boxHeight = height - top - reserve;
  return <AbsoluteFill>
    {scene.heading && <div style={{position: 'absolute', top: 60, width: '100%'}}><Heading text={scene.heading} theme={theme} frame={frame} size={60} align="center"/></div>}
    <div data-check="media" style={{position: 'absolute', top, left: 0, width, height: boxHeight}}><Recording recording={scene.recording} frames={frames} rate={scene.speed || 1} box={{width, height: boxHeight, padding: 40}}/></div>
    {scene.label && !scene.heading && <div style={{position: 'absolute', top: 22, width: '100%', textAlign: 'center'}}><Label theme={theme} frame={frame}>{scene.label}</Label></div>}
  </AbsoluteFill>;
}

function CompareScene({scene, theme, frames}) {
  const frame = useCurrentFrame();
  const {width} = useVideoConfig();
  // Each side gets half the width; its box is exactly as tall as the screen inside it, so labels sit right above.
  const padding = 34;
  return <AbsoluteFill style={{alignItems: 'center', justifyContent: 'center', paddingBottom: 60, gap: 40}}>
    {scene.heading && <Heading text={scene.heading} theme={theme} frame={frame} size={60} align="center"/>}
    <div style={{display: 'flex'}}>
      {[scene.before, scene.after].map((side, index) => {
        const {project} = side.recording;
        const box = {width: width / 2, height: (width / 2 - 2 * padding) * project.height / project.width + 2 * padding, padding};
        return <div key={index} style={{width: box.width, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, opacity: appear(frame, index * 8, 20)}}>
          <div data-check="text" style={{padding: '10px 26px', borderRadius: 999, fontFamily: font, fontWeight: 700, fontSize: 30, letterSpacing: 0.5,
            background: index ? theme.accent : theme.panel, color: index ? theme.accentText : theme.muted, boxShadow: '0 0 0 1px #0000000f'}}>{side.label || (index ? 'After' : 'Before')}</div>
          <div data-check="media" style={{position: 'relative', width: box.width, height: box.height}}><Recording recording={side.recording} frames={frames} rate={scene.speed || 1} box={box}/></div>
        </div>;
      })}
    </div>
  </AbsoluteFill>;
}

// Closing card: columns with a title, kicker, text and stats; buttons underneath.
function EndScene({scene, theme}) {
  const frame = useCurrentFrame();
  return <AbsoluteFill style={{justifyContent: 'center', padding: '0 140px 80px', gap: 70}}>
    <div style={{display: 'flex'}}>
      {scene.columns.map((column, index) => {
        const delay = index * 16;
        return <div key={index} style={{flex: 1, padding: index ? '0 0 0 90px' : '0 90px 0 0', borderLeft: index ? `2px solid ${theme.muted}33` : undefined, display: 'flex', flexDirection: 'column', gap: 22}}>
          <div data-check="text" style={{fontFamily: font, fontWeight: 800, fontSize: 92, letterSpacing: -3, color: theme.text, lineHeight: 1}}><Rich text={column.title} theme={theme} frame={frame} delay={delay} stagger={3}/></div>
          {column.kicker && <div data-check="text" style={{fontFamily: font, fontWeight: 600, fontSize: 24, letterSpacing: 4, color: theme.muted, opacity: appear(frame, delay + 10)}}>{column.kicker}</div>}
          {column.text && <div data-check="text" style={{fontFamily: font, fontSize: 36, lineHeight: 1.35, color: theme.muted, opacity: appear(frame, delay + 14)}}><Rich text={column.text} theme={theme}/></div>}
          <div style={{display: 'flex', gap: 56, marginTop: 14}}>
            {(column.stats || []).map((stat, step) => <div key={step} data-check="text" style={{opacity: appear(frame, delay + 22 + step * 6)}}>
              <div style={{fontFamily: font, fontWeight: 800, fontSize: 64, letterSpacing: -2, color: theme.text}}>{stat.value}</div>
              <div style={{fontFamily: font, fontSize: 22, color: theme.muted}}>{stat.label}</div>
            </div>)}
          </div>
        </div>;
      })}
    </div>
    {scene.buttons && <div style={{display: 'flex', gap: 22, justifyContent: 'center', opacity: appear(frame, 50)}}>
      {scene.buttons.map((button, index) => <div key={index} data-check="text" style={{padding: '20px 40px', borderRadius: 14, fontFamily: font, fontWeight: 700, fontSize: 30,
        background: index === scene.buttons.length - 1 ? theme.text : 'transparent', color: index === scene.buttons.length - 1 ? (light(theme.text) ? '#0b0d14' : '#ffffff') : theme.text,
        boxShadow: `0 0 0 2px ${theme.text}`}}>{button}</div>)}
    </div>}
  </AbsoluteFill>;
}

const scenes = {title: TitleScene, image: ImageScene, slide: SlideScene, stats: StatsScene, chart: ChartScene, lines: LinesScene, recording: RecordingScene, compare: CompareScene, end: EndScene};

function Captions({captions}) {
  const frame = useCurrentFrame();
  const {fps, width} = useVideoConfig();
  const time = frame / fps;
  const caption = captions.find(item => time >= item.start && time < item.end);
  if (!caption) return null;
  const fade = Math.min(ease((time - caption.start) / 0.12), ease((caption.end - time) / 0.12));
  return <div style={{position: 'absolute', bottom: 36, width: '100%', display: 'flex', justifyContent: 'center', opacity: fade}}>
    <div data-check="caption" style={{maxWidth: width * 0.8, padding: '12px 28px', borderRadius: 14, background: '#0b0d14e0', color: '#fff', fontFamily: font, fontWeight: 600, fontSize: 38, lineHeight: 1.3, textAlign: 'center', boxShadow: '0 8px 30px #0006'}}>{caption.text}</div>
  </div>;
}

// Check mode only: measure what is really on screen in this frame and log layout problems.
function LayoutProbe() {
  const frame = useCurrentFrame();
  const {width, height} = useVideoConfig();
  const [handle] = useState(() => delayRender('layout probe'));
  useEffect(() => {
    const measure = () => {
      const visible = element => {
        for (let node = element; node && node !== document.body; node = node.parentElement) {
          const style = getComputedStyle(node);
          if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) < 0.6) return false;
        }
        return true;
      };
      const items = [...document.querySelectorAll('[data-check]')].filter(visible).map(element => {
        const box = element.getBoundingClientRect();
        return {kind: element.dataset.check, element, text: (element.textContent || '').trim().slice(0, 50), box: {left: box.left, top: box.top, right: box.right, bottom: box.bottom}};
      }).filter(item => item.box.right > item.box.left && item.box.bottom > item.box.top);
      const issues = [];
      const overlap = (a, b) => Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
      const texts = items.filter(item => item.kind === 'text');
      for (const item of texts) {
        const {box} = item;
        if (box.left < -2 || box.top < -2 || box.right > width + 2 || box.bottom > height + 2) issues.push({kind: 'off-frame', text: item.text, box});
        if (item.element.scrollWidth > item.element.clientWidth + 2 && getComputedStyle(item.element).overflow !== 'visible') issues.push({kind: 'clipped', text: item.text, box});
      }
      // Contrast: text color against the first solid background behind it (WCAG ratio).
      const rgb = value => (value.match(/[\d.]+/g) || []).map(Number);
      const luminance = ([r, g, b]) => [r, g, b].map(channel => { channel /= 255; return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4; }).reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
      const contrast = element => {
        const style = getComputedStyle(element);
        const color = rgb(style.color);
        if (color[3] === 0 || style.backgroundClip === 'text' || style.webkitBackgroundClip === 'text') return null; // gradient text
        let background = null;
        for (let node = element; node; node = node.parentElement) {
          const computed = getComputedStyle(node);
          const solid = rgb(computed.backgroundColor);
          if (solid.length && (solid[3] === undefined || solid[3] > 0.8)) { background = solid; break; }
          // A gradient background: judge against its first color.
          const stop = computed.backgroundImage.includes('gradient') && computed.backgroundImage.match(/rgba?\([^)]*\)/);
          if (stop) { background = rgb(stop[0]); break; }
        }
        if (!background) return null;
        const [a, b] = [luminance(color), luminance(background)].sort((x, y) => y - x);
        return (a + 0.05) / (b + 0.05);
      };
      for (const item of texts) {
        // Judge the elements that actually hold the words, not their container.
        const holders = [item.element, ...item.element.querySelectorAll('*')].filter(element => [...element.childNodes].some(node => node.nodeType === 3 && node.textContent.trim()) && visible(element));
        const ratios = holders.map(contrast).filter(ratio => ratio !== null);
        if (ratios.length && Math.min(...ratios) < 3) issues.push({kind: 'contrast', text: `${item.text} (contrast ${Math.min(...ratios).toFixed(1)}:1)`, box: item.box});
      }
      // Text on text (ignoring an element inside another), and text under media.
      for (let a = 0; a < texts.length; a++) for (let b = a + 1; b < texts.length; b++) {
        if (texts[a].element.contains(texts[b].element) || texts[b].element.contains(texts[a].element)) continue;
        if (overlap(texts[a].box, texts[b].box) > 40) issues.push({kind: 'overlap', text: `${texts[a].text} ⟷ ${texts[b].text}`, box: texts[a].box});
      }
      // Captions sit in a fixed band at the bottom: nothing important may live there.
      const band = {left: width * 0.1, right: width * 0.9, top: height - 125, bottom: height - 25};
      for (const item of items.filter(item => item.kind !== 'caption')) {
        const shared = overlap(item.box, band);
        if (shared > 400 && (item.kind === 'text' || shared > 0.03 * (item.box.right - item.box.left) * (item.box.bottom - item.box.top))) issues.push({kind: 'caption-zone', text: item.kind === 'media' ? '(recording or image)' : item.text, box: item.box});
      }
      console.log('JUSTREC_LAYOUT ' + JSON.stringify({frame, issues}));
      continueRender(handle);
    };
    // Wait two frames so fonts and layout have settled.
    requestAnimationFrame(() => requestAnimationFrame(measure));
  }, [frame]);
  return null;
}

function Film({film}) {
  const {fps} = useVideoConfig();
  const theme = film.theme;
  return <AbsoluteFill style={{background: theme.background}}>
    {film.scenes.map((scene, index) => {
      const Scene = scenes[scene.type];
      const last = index === film.scenes.length - 1;
      // Crossfade: each scene runs on under the next one while it fades in, so the picture
      // never passes through the bare background between two scenes.
      const overlap = last ? 0 : Math.round(fps / 3);
      return <Sequence key={index} from={scene.from} durationInFrames={scene.frames + overlap} premountFor={fps}>
        <Crossfade frames={scene.frames} fade={Math.round(fps / 3)} last={last} background={theme.background}>
          <Scene scene={scene} theme={theme} frames={scene.frames} reserve={film.captions ? 140 : 30}/>
        </Crossfade>
      </Sequence>;
    })}
    {film.captions && <Captions captions={film.captions}/>}
    {film.probe && <LayoutProbe/>}
  </AbsoluteFill>;
}

function Crossfade({frames, fade, last, background, children}) {
  const frame = useCurrentFrame();
  const opacity = Math.min(ease(frame / fade), last ? ease((frames - frame) / fade) : 1);
  return <AbsoluteFill style={{opacity, background}}>{children}</AbsoluteFill>;
}

registerRoot(() => <><Composition id="Demo" component={Demo} width={1920} height={1080} fps={30} durationInFrames={30}
  calculateMetadata={({props}) => ({...props.project.export, durationInFrames: props.project.clips.reduce((total, clip) => total + Math.max(1, Math.round((clip.end - clip.start) * props.project.export.fps)), 0) + Math.round(((props.project.intro?.duration || 0) + (props.project.outro?.duration || 0)) * props.project.export.fps)})}/>
  <Composition id="Film" component={Film} width={1920} height={1080} fps={60} durationInFrames={60}
    calculateMetadata={({props}) => ({width: props.film.width, height: props.film.height, fps: props.film.fps, durationInFrames: props.film.frames})}/></>);
