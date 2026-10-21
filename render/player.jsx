// The live page: the film playing (Remotion player) next to a scene list and a form for the
// selected scene, generated from film.schema.json so every field shows its description.
// Saving writes film.json (validated by the server); the film then reloads by itself.
import React, {useEffect, useMemo, useRef, useState} from 'react';
import {createRoot} from 'react-dom/client';
import {Player} from '@remotion/player';
import {Film} from './film.jsx';

const ink = '#d6dae3'; const muted = '#8a91a3'; const line = '#262b36'; const panel = '#12151c'; const accent = '#5fb3ff';
const css = `
body{margin:0;background:#0b0d12;color:${ink};font:14px/1.45 -apple-system,BlinkMacSystemFont,sans-serif}
.layout{display:grid;grid-template-columns:280px 1fr;gap:18px;padding:18px;max-width:1700px;margin:0 auto}
.list{background:${panel};border:1px solid ${line};border-radius:12px;padding:8px;align-self:start;position:sticky;top:18px}
.scene{padding:9px 10px;border-radius:8px;cursor:pointer;display:flex;gap:8px;align-items:baseline}
.scene:hover{background:#1a1e27}.scene.on{background:#1d2a3d;outline:1px solid #2f4b70}
.num{color:${muted};font-variant-numeric:tabular-nums;width:18px}.kind{color:${accent};font-size:11px;text-transform:uppercase;letter-spacing:.06em}
.name{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.time{color:${muted};font-size:12px;font-variant-numeric:tabular-nums}
.tools{display:flex;gap:6px;padding:8px 4px 2px;border-top:1px solid ${line};margin-top:6px}
button,select,input,textarea{font:inherit;color:${ink};background:#0d1016;border:1px solid #2b3140;border-radius:7px}
button{padding:6px 10px;cursor:pointer}button:disabled{opacity:.4;cursor:default}button:hover{border-color:${accent}}button.primary{background:#1f6feb;border-color:#1f6feb;color:#fff}
.editor{background:${panel};border:1px solid ${line};border-radius:12px;padding:16px 18px;margin-top:16px}
.head{display:flex;align-items:center;gap:10px;margin-bottom:12px}.head h2{margin:0;font-size:16px;flex:1}
.field{display:grid;grid-template-columns:150px 1fr;gap:4px 14px;padding:9px 0;border-top:1px solid ${line}}
.field label{font-weight:600}.field .hint{grid-column:2;color:${muted};font-size:12px}
.field input[type=text],.field input[type=number],.field textarea,.field select{width:100%;box-sizing:border-box;padding:7px 9px}
.field textarea{min-height:54px;resize:vertical}.field textarea.json{font:12px ui-monospace,Menlo,monospace;min-height:110px}
.bad{border-color:#e5534b !important}.unset{opacity:.55}.req{color:#e5a14b}
.errors{background:#3a1d1d;color:#ffb4b4;padding:10px 12px;border-radius:8px;white-space:pre-wrap;margin:10px 0}
.status{color:${muted};margin-top:8px;font-size:12px}`;

const plain = text => String(text ?? '').replace(/[*[\]]/g, '');
const clock = seconds => `${Math.floor(seconds / 60)}:${(seconds % 60).toFixed(1).padStart(4, '0')}`;

function resolve(schema, node) {
  while (node?.$ref) node = node.$ref.slice(2).split('/').reduce((value, key) => value[key], schema);
  return node || {};
}

// One input for one schema property; `value === undefined` means "not set".
function Field({name, spec: declared, value, required, onChange}) {
  // Follow $ref (e.g. to the shared "rich" text type) before choosing the input.
  const spec = {...resolve(window.__schema, declared), ...(declared.description ? {description: declared.description} : {})};
  const rich = declared.$ref === '#/$defs/rich';
  const type = spec.enum ? 'enum' : [].concat(spec.type || 'json')[0];
  const [text, setText] = useState(null);
  const [bad, setBad] = useState(false);
  const unset = value === undefined;
  const lines = spec.type === 'array' && resolve(window.__schema, spec.items).type === 'string';
  let input;
  if (spec.enum) input = <select value={value ?? ''} onChange={event => onChange(event.target.value === '' ? undefined : spec.enum.find(option => String(option) === event.target.value))}>
    <option value="">—</option>{spec.enum.map(option => <option key={String(option)} value={String(option)}>{String(option)}</option>)}</select>;
  else if (type === 'boolean') input = <input type="checkbox" checked={!!value} onChange={event => onChange(event.target.checked)}/>;
  else if (type === 'number' || type === 'integer') input = <input type="number" step="any" value={value ?? ''} onChange={event => onChange(event.target.value === '' ? undefined : Number(event.target.value))}/>;
  else if (type === 'string') {
    const long = ['say', 'subtitle', 'text', 'note'].includes(name);
    input = long ? <textarea value={value ?? ''} onChange={event => onChange(event.target.value || undefined)}/> : <input type="text" value={value ?? ''} onChange={event => onChange(event.target.value || undefined)}/>;
  } else if (lines) input = <textarea value={(value || []).join('\n')} placeholder="one per line" onChange={event => onChange(event.target.value ? event.target.value.split('\n') : undefined)}/>;
  else input = <textarea className={`json ${bad ? 'bad' : ''}`} value={text ?? (unset ? '' : JSON.stringify(value, null, 2))}
    onChange={event => { setText(event.target.value); try { onChange(event.target.value.trim() ? JSON.parse(event.target.value) : undefined); setBad(false); } catch { setBad(true); } }}/>;
  // For JSON fields, say what shape is expected, e.g. "list of {value*, label*}".
  const item = spec.type === 'array' ? resolve(window.__schema, spec.items) : null;
  const shape = item?.properties ? `list of {${Object.keys(item.properties).map(key => key + (item.required?.includes(key) ? '*' : '')).join(', ')}}` : null;
  const description = [spec.description, !lines && shape].filter(Boolean).join(' · ');
  return <div className={`field ${unset ? 'unset' : ''}`}>
    <label>{name}{required && <span className="req"> *</span>}</label>{input}
    {description && <div className="hint">{description}{rich && !description.includes('*muted') ? ' — *muted words*, [accent words]' : ''}</div>}
  </div>;
}

function SceneForm({schema, scene, onChange}) {
  const definition = resolve(schema, schema.$defs[scene.type]);
  const keys = Object.keys(definition.properties || {}).filter(key => key !== 'type');
  return <>{definition.description && <div className="status" style={{marginTop: 0}}>{definition.description}</div>}
    {keys.map(key => <Field key={key} name={key} spec={definition.properties[key]} value={scene[key]} required={definition.required?.includes(key)}
      onChange={value => { const next = {...scene}; if (value === undefined) delete next[key]; else next[key] = value; onChange(next); }}/>)}</>;
}

function App() {
  const [state, setState] = useState(null);
  const [schema, setSchema] = useState(null);
  const [film, setFilm] = useState(null); // the editable film.json
  const [selected, setSelected] = useState(0);
  const [draft, setDraft] = useState(null); // edited copy of the selected scene (or settings)
  const [errors, setErrors] = useState(null);
  const [adding, setAdding] = useState('title');
  const player = useRef(null);
  useEffect(() => { fetch('/schema.json').then(response => response.json()).then(value => { window.__schema = value; setSchema(value); }); }, []);
  useEffect(() => {
    let current = -1;
    const poll = async () => {
      const next = await fetch('/state.json', {cache: 'no-store'}).then(response => response.json()).catch(() => null);
      if (next && next.version !== current) {
        current = next.version;
        const frame = player.current?.getCurrentFrame?.() ?? 0;
        setState(next);
        setFilm(await fetch('/film.json', {cache: 'no-store'}).then(response => response.json()));
        setTimeout(() => player.current?.seekTo?.(frame), 50);
      }
    };
    poll();
    const timer = setInterval(poll, 1000);
    return () => clearInterval(timer);
  }, []);
  const timeline = state?.props?.film;
  const select = index => {
    setSelected(index); setDraft(null); setErrors(null);
    if (index >= 0 && timeline?.scenes[index]) player.current?.seekTo(timeline.scenes[index].from);
  };
  const save = async next => {
    const response = await fetch('/save', {method: 'POST', headers: {Authorization: `Bearer ${window.JUSTREC_LIVE.token}`}, body: JSON.stringify({film: next})});
    const result = await response.json();
    if (result.errors || result.error) { setErrors((result.errors || [result.error]).join('\n')); return false; }
    setFilm(next); setDraft(null); setErrors(null); return true;
  };
  const scenes = film?.scenes || [];
  const move = (index, by) => { const next = [...scenes]; const [item] = next.splice(index, 1); next.splice(index + by, 0, item); save({...film, scenes: next}).then(ok => ok && setSelected(index + by)); };
  const remove = index => { if (scenes.length > 1) save({...film, scenes: scenes.filter((_, at) => at !== index)}).then(() => setSelected(Math.max(0, index - 1))); };
  const add = () => {
    // A new scene with its required fields filled with placeholders.
    const definition = resolve(schema, schema.$defs[adding]);
    const scene = {type: adding};
    for (const key of definition.required || []) if (key !== 'type') scene[key] = resolve(schema, definition.properties[key]).type === 'array' ? [] : key === 'recording' ? 'name-of-recording' : 'New';
    if (!scene.say) scene.say = '';
    save({...film, scenes: [...scenes.slice(0, selected + 1), scene, ...scenes.slice(selected + 1)]}).then(ok => ok && setSelected(selected + 1));
  };
  const settings = film && Object.fromEntries(Object.entries(film).filter(([key]) => !['scenes', '$schema'].includes(key)));
  const current = selected >= 0 ? (draft ?? scenes[selected]) : null;
  const kinds = useMemo(() => schema ? schema.$defs.scene.oneOf.map(option => option.$ref.split('/').pop()) : [], [schema]);
  if (!state || !schema || !film) return <div className="status" style={{padding: 20}}>Preparing the film…</div>;
  return <><style>{css}</style><div className="layout">
    <div className="list">
      {scenes.map((scene, index) => {
        const placed = timeline?.scenes[index];
        return <div key={index} className={`scene ${index === selected ? 'on' : ''}`} onClick={() => select(index)}>
          <span className="num">{index + 1}</span>
          <span className="name"><span className="kind">{scene.type}</span><br/>{plain(scene.title || scene.recording || scene.columns?.[0]?.title || scene.image) || '—'}</span>
          {placed && <span className="time">{clock(placed.from / timeline.fps)}<br/>{(placed.frames / timeline.fps).toFixed(1)}s</span>}
        </div>;
      })}
      <div className={`scene ${selected === -1 ? 'on' : ''}`} onClick={() => select(-1)}><span className="num">⚙</span><span className="name">Film settings</span></div>
      <div className="tools">
        <select value={adding} onChange={event => setAdding(event.target.value)}>{kinds.map(kind => <option key={kind}>{kind}</option>)}</select>
        <button onClick={add}>+ Add after</button>
      </div>
    </div>
    <div>
      {state.error && <div className="errors">{state.error}</div>}
      {timeline && <Player ref={player} component={Film} inputProps={state.props} durationInFrames={timeline.frames} fps={timeline.fps}
        compositionWidth={timeline.width} compositionHeight={timeline.height} controls style={{width: '100%', borderRadius: 10, overflow: 'hidden'}}/>}
      <div className="status">Version {state.version} · {timeline ? `${(timeline.frames / timeline.fps).toFixed(1)} s · ${timeline.scenes.length} scenes` : ''} · reloads when film.json or a recording changes</div>
      <div className="editor">
        {selected >= 0 && current ? <>
          <div className="head"><h2>Scene {selected + 1} · {current.type}</h2>
            <button disabled={selected === 0} onClick={() => move(selected, -1)}>↑</button>
            <button disabled={selected === scenes.length - 1} onClick={() => move(selected, 1)}>↓</button>
            <button onClick={() => remove(selected)}>Delete</button>
            <button className="primary" disabled={!draft} onClick={() => save({...film, scenes: scenes.map((scene, index) => index === selected ? draft : scene)})}>Save</button>
          </div>
          {errors && <div className="errors">{errors}</div>}
          <SceneForm schema={schema} scene={current} onChange={setDraft}/>
        </> : <>
          <div className="head"><h2>Film settings</h2><button className="primary" disabled={!draft} onClick={() => save({...(film.$schema ? {$schema: film.$schema} : {}), ...draft, scenes: film.scenes})}>Save</button></div>
          {errors && <div className="errors">{errors}</div>}
          {['theme', 'voice', 'music', 'captions', 'fps', 'width', 'height', 'output'].map(key =>
            <Field key={key} name={key} spec={schema.properties[key]} value={(draft ?? settings)[key]}
              onChange={value => { const next = {...(draft ?? settings)}; if (value === undefined) delete next[key]; else next[key] = value; setDraft(next); }}/>)}
        </>}
      </div>
    </div>
  </div></>;
}

createRoot(document.getElementById('app')).render(<App/>);
