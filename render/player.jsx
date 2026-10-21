// The live preview page: plays the film with Remotion's player and reloads when it changes.
import React, {useEffect, useRef, useState} from 'react';
import {createRoot} from 'react-dom/client';
import {Player} from '@remotion/player';
import {Film} from './film.jsx';

function App() {
  const [state, setState] = useState(null);
  const player = useRef(null);
  useEffect(() => {
    let current = -1;
    const poll = async () => {
      const next = await fetch('/state.json', {cache: 'no-store'}).then(response => response.json()).catch(() => null);
      if (next && next.version !== current) {
        current = next.version;
        // Keep the playhead where it was when the film reloads.
        const frame = player.current?.getCurrentFrame?.() ?? 0;
        setState(next);
        setTimeout(() => player.current?.seekTo?.(frame), 50);
      }
    };
    poll();
    const timer = setInterval(poll, 1000);
    return () => clearInterval(timer);
  }, []);
  if (!state) return <div id="status">Preparing the film…</div>;
  const film = state.props?.film;
  return <>
    {state.error && <pre style={{background: '#3a1d1d', color: '#ffb4b4', padding: 12, borderRadius: 8, whiteSpace: 'pre-wrap'}}>{state.error}</pre>}
    {film && <Player ref={player} component={Film} inputProps={state.props} durationInFrames={film.frames} fps={film.fps}
      compositionWidth={film.width} compositionHeight={film.height} controls style={{width: '100%', borderRadius: 10, overflow: 'hidden'}}/>}
    <div id="status">Version {state.version} · {film ? `${(film.frames / film.fps).toFixed(1)} s · ${film.scenes.length} scenes` : ''} · reloads when the film or a recording changes</div>
  </>;
}

createRoot(document.getElementById('app')).render(<App/>);
