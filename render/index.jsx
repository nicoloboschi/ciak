import React from 'react';
import {registerRoot, Composition, AbsoluteFill, Sequence, useCurrentFrame, useVideoConfig} from 'remotion';
import {ease, Clip} from './parts.jsx';
import {Film} from './film.jsx';

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

registerRoot(() => <><Composition id="Demo" component={Demo} width={1920} height={1080} fps={30} durationInFrames={30}
  calculateMetadata={({props}) => ({...props.project.export, durationInFrames: props.project.clips.reduce((total, clip) => total + Math.max(1, Math.round((clip.end - clip.start) * props.project.export.fps)), 0) + Math.round(((props.project.intro?.duration || 0) + (props.project.outro?.duration || 0)) * props.project.export.fps)})}/>
  <Composition id="Film" component={Film} width={1920} height={1080} fps={60} durationInFrames={60}
    calculateMetadata={({props}) => ({width: props.film.width, height: props.film.height, fps: props.film.fps, durationInFrames: props.film.frames})}/></>);
