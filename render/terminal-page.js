// The justrec terminal page: xterm.js styled like the user's iTerm2 profile, showing a real
// zsh session streamed from the justrec terminal server.
import {Terminal} from '@xterm/xterm';
import {FitAddon} from '@xterm/addon-fit';

const config = window.JUSTREC_TERMINAL;
document.title = config.title;
document.getElementById('title').textContent = config.title;
const terminal = new Terminal({
  fontFamily: `${config.font}, Monaco, Menlo, monospace`, fontSize: config.fontSize, lineHeight: config.lineHeight,
  theme: config.theme, cursorBlink: true, allowProposedApi: true, scrollback: 2000, convertEol: false,
});
const fit = new FitAddon();
terminal.loadAddon(fit);
terminal.open(document.getElementById('screen'));
fit.fit();
// Tell the shell how big the screen is, so programs wrap like in a real window.
fetch('/resize', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({cols: terminal.cols, rows: terminal.rows})});
const decode = text => Uint8Array.from(atob(text), character => character.charCodeAt(0));
new EventSource('/events').onmessage = message => terminal.write(decode(JSON.parse(message.data).data));
