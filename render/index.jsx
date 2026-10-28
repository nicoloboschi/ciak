import React from 'react';
import {registerRoot, Composition} from 'remotion';
import {Demo, demoFrames} from './parts.jsx';
import {Film} from './film.jsx';

registerRoot(() => <><Composition id="Demo" component={Demo} width={1920} height={1080} fps={30} durationInFrames={30}
  calculateMetadata={({props}) => ({...props.project.export, durationInFrames: demoFrames(props.project)})}/>
  <Composition id="Film" component={Film} width={1920} height={1080} fps={60} durationInFrames={60}
    calculateMetadata={({props}) => ({width: props.film.width, height: props.film.height, fps: props.film.fps, durationInFrames: props.film.frames})}/></>);
