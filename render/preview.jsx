// The panel's live preview: a project's edit playing in the browser (Remotion player), redrawn as soon as the
// project changes, so a switch shows without a render. 30 fps, with the sound the render keeps (unmixed: no click ticks or cleanup).
import React from 'react';
import {createRoot} from 'react-dom/client';
import {Player} from '@remotion/player';
import {Demo, demoFrames} from './parts.jsx';

let root;
const player = React.createRef();
window.justrecPreviewPause = () => player.current?.pause();
window.justrecPreview = (element, props) => {
  root ||= createRoot(element);
  const {width, height} = props.project.export;
  root.render(<Player ref={player} component={Demo} inputProps={props} durationInFrames={Math.max(1, demoFrames(props.project, 30))} fps={30}
    compositionWidth={width} compositionHeight={height} controls clickToPlay style={{width: '100%', aspectRatio: `${width} / ${height}`}}/>);
};
