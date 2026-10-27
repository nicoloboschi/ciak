# justrec

A screen recorder and video editor run by agents, not by you.

You hit record, talk, and stop. Agents do the rest: captions, cutting dead air,
zooms on what you clicked, titles, the final export. You watch the result and say
"ok" or "redo".

**Why:** apps like Recordly hide the edit behind a timeline UI, and when they get
something wrong (like dropping your voice from the export) you can't see why.
justrec keeps everything as plain files and commands, so an agent can read,
change and re-render any part of it.

## Usage

```bash
./justrec install                # once: justrec.app in the menu bar (⌘1 screenshots, Record…:
                                 # recording panel; starts at login), `justrec` on PATH, the agent skill
justrec ui                       # the recording panel (menu bar: Record…): pick source/mic/camera, record,
                                 # finish → plays the edited video and shows the project id for your agent
justrec rec                      # record main display + default mic; Enter or Ctrl-C stops

# what an agent does: record itself using a logged-in browser
justrec browser https://app.example.com          # the justrec browser: your Brave logins, runs in background
justrec start --browser --system-audio --name demo        # record its current tab, returns at once
justrec browser click "New project"              # click / type / key / scroll / go / shot
justrec pause / resume / status / stop

# or the screen / a window
justrec sources                                  # displays, windows, mics, cameras (JSON)
justrec start --window 69 --name demo
justrec mark "click Save" --at 0.4,0.2           # where an action happens if the real mouse didn't move
justrec captions <mp4>           # <name>.srt, .txt, .json (word timestamps)
justrec edit <project> --cut-idle --auto-zoom    # or --cut-silence, --cut a,b, --preset vertical, --background sunset
justrec preview <project> --frame 90             # one PNG frame
justrec render <id>              # ~/Documents/justrec/<name>-<id>.mp4, checked: one video + one audio track
```

`justrec help` lists every option. The agent workflow is written down as a Claude Code
skill in `.claude/skills/justrec/SKILL.md`.

Each recording is a project with a short id, kept in `~/.justrec/projects/<id>/`: `recording.mp4`
(raw), `recording.project.json` (the edit), `recording.cursor.jsonl`, captions, optional
`recording.camera-N.mov`. Commands take the id (`justrec edit 3f9a1c2e`, `justrec render 3f9a1c2e`).
Only finished videos land in `~/Documents/justrec/` (`JUSTREC_DIR`): `<name>-<id>.mp4`.

**Recording a browser:** use `justrec browser`. It is a second Brave on a copy of your
Brave profile (in `~/Library/Application Support/justrec/browser`, so you're logged in),
recorded from the page itself, so it works while covered. `--refresh-login` re-copies
your profile. A plain window recording only updates while the window is visible.

### First run

macOS asks once for **Screen Recording** and **Microphone** permission for the
terminal app that runs `justrec` (System Settings > Privacy & Security).
Restart the terminal after granting Screen Recording.

### Requirements

macOS 15+, Xcode command line tools (`swiftc`), Node 22+ (`npm install` once), `uv` (for Whisper), `ffmpeg`.

## Features

Status: ✅ done and tested · 🧪 built, not yet tested · ⬜ not started

### Record

- ✅ Screen + cursor + mic into **one** mp4 with a single audio track (ScreenCaptureKit)
- ✅ Pick the display (`--display <index>`)
- ✅ Stop with Enter or Ctrl-C; file is finalized cleanly
- ✅ Background recording for agents: `start` / `pause` / `resume` / `stop`, pauses leave no gap
- ✅ If the recorder crashes, the recording so far is kept and the session pauses
- ✅ Action marks (`justrec mark`, `--at` or `--page`) to drive zooms when the real mouse doesn't move
- ✅ Logged-in browser for agents (`justrec browser`), recorded while covered, page clicks/typing logged
- ✅ Drive it from the command line: `browser click/type/paste/key/scroll/go/eval/shot`
- 🧪 Looks like a person: the mouse bows and slows into its target (longer moves take longer), typing has an uneven rhythm and replaces the field's text, long text is pasted
- ✅ Browser sound in browser recordings (`--system-audio`: only the justrec browser, not other apps) · 🧪 `--mic`
- ✅ Sharp: the justrec browser draws at 2x even on a non-Retina monitor
- ✅ 60 fps by default (`--fps 30` for smaller files), kept through the render
- 🧪 Log cursor position and clicks to `<name>.cursor.jsonl` (file written; clicks not yet checked)
- ✅ Optional system audio, mixed into the same track (never a second track)
- ✅ Record a single window (only while visible) or a region
- ✅ Optional webcam bubble
- ✅ Mic, Mac sound and webcam each on or off in the video afterwards (`edit --mic off`, the panel's "In the video"): the recorder also saves the mic and the Mac sound apart
- ✅ Click sounds and zooms on or off too (`edit --clicks off`, `--zooms off`, same panel card)
- 🧪 Stop from macOS's menu bar recording icon finishes the recording (not tried with the real icon yet)
- ✅ An ultrawide screen keeps its shape in the video (2560×1080), instead of being squeezed small into 16:9
- ✅ Menu bar app (`justrec install`): ⌘1 screenshots, Record… (the recording panel), Open Recordings; starts at login and holds the permissions
- ✅ Panel (`justrec ui`, menu bar Record…): projects on the left (thumbnail, time, length, state); a new recording with live camera preview and mic meter; after Finish every step (stop, encode + mix, clicks, auto edit, render frames with a live count, audio, check) with its timing, then the video and the project id with a prompt for your agent. It follows an agent's renders live. Rename or delete a project there (`justrec project rename|remove`; delete goes to the Trash)
- ✅ Quick recording (⌘2): the screenshot overlay picks an area or a window, a red frame and timer show while it records (default mic); ⌘2 or a click on the timer stops it, the panel opens on the project and renders it. The picker stays loaded between uses, so the overlay opens at once
- ✅ Panel: Screenshots page (⌘1 shots, newest first: open, copy, show in Finder, delete to the Trash; `justrec shot list|copy|remove`)
- ✅ Panel: Voices page: every cloned voice with its sample and a Try-it box; add one by reading a text in the page or uploading a voice note or video; a failed try keeps the old voice
- ✅ An agent with only the skill edits a project by id ("Use /justrec to edit project <id>: make it vertical, sunset background") — tested with a fresh agent
- ✅ Projects by id: raw files in `~/.justrec/projects/<id>/`, every command takes the id (or the name)
- ✅ Recordings follow the screen: they used to freeze on the first picture (macOS ran out of frame slots)
- ⬜ Menu-bar indicator while recording (so you know it's on)
- 🧪 Pick the mic by name (`--mic "Brio 100"`)
- 🧪 Mic level check before recording starts (meter in `justrec ui`)

### Understand

- ✅ Local transcript with word timestamps (`justrec captions`, Whisper on Apple silicon)
- ⬜ Scene/screen-change detection (what's on screen when)
- ✅ One `<name>.project.json` that gathers everything an agent needs:
  video, transcript, cursor log, marks, edit decisions

### Edit (agents)

- 🧪 Cut silences, driven by the audio (`--cut-silence`)
- ✅ Cut idle time: still picture, no voice, no clicks or typing (`--cut-idle`, for agent recordings)
- ⬜ Cut filler words, driven by the transcript
- ⬜ Cut by text: delete a sentence from the transcript, it's gone from the video
- ✅ Auto-zoom on marks; close actions pan instead of zooming out and in; gentle (≤ 1.3x) and it lets go between actions over 2.5 s apart
- ✅ Auto-zoom on clicks in the justrec browser · 🧪 on real mouse clicks
- ⬜ Smooth pan following the cursor while zoomed
- ✅ Smooth / enlarged cursor drawn on top, gliding onto each click
- ✅ Click sounds: a soft tick on each click (`audio.clicks` in the project, on by default); films have none unless `"clicks": true`
- ✅ Screenshots like Cap: `justrec shot` (drag a region or press space for a window) puts it on a wallpaper with rounded corners and a shadow, saves it to `shots/`, copies it; ⌘1 in the menu bar app: instant native picker with a glowing border, shutter sound, then Finder shows the file
- ✅ Background (wallpaper gradients: `--background aurora|sunset|ocean|meadow|graphite`, or any CSS), padding, rounded corners, shadow
- 🧪 Burned-in captions with a clean style
- 🧪 Intro/outro title cards (`intro` / `outro` in the project)
- 🧪 Loudness normalization for the voice; ✅ a mic with nobody talking is left quiet instead of lifted (key presses no longer become thumps)
- ✅ No mic unless asked (`--mic default`, the panel's Microphone, quick recordings have none)
- ✅ Mic background noise removed automatically (`lib/clean.mjs`: level, then DeepFilterNet), for recordings and the cloned voice's sample: a built-in-mic recording went from 10 dB to 47 dB between voice and pauses
- ✅ Rendering via Remotion, so every edit is code an agent can change

### Films (launch videos)

- ✅ `justrec film <film.json>`: scenes (title, stats, image, slide, chart, recording, before/after compare) → one video
- ✅ Narration from each scene's `say` (local Kokoro voice, macOS `say` fallback), scenes stretch to fit it
- 🧪 Your own voice: `justrec voice add me` records a 15 s sample, films with `"voice": {"name": "me"}` are cloned with Qwen3-TTS (tested with a sample voice, not yet a real one)
- ✅ Captions timed per sentence, burned in and written as `.srt`
- ✅ Background music (generated, or your file), ducked under the voice
- ✅ `--preview`: one contact-sheet image of every scene in ~30 s
- ✅ Recordings auto-edit on stop (idle cut, zooms) and are referenced by `--name`
- ✅ Keynote look: light theme, two-tone headlines (`*muted*`, `[accent]`), word-by-word reveals
- ✅ Footage or stills behind any scene; chips, pills and counters on title scenes
- ✅ Animated line charts (dashed projections, end labels, side-by-side panels) and an end card
- ✅ One-step page capture: `start --browser --url <page> --run "play()" --for 8 --name x`
- ✅ Schema for film.json (`justrec schema`): one vocabulary, typo suggestions, exact error paths
- ✅ Custom scenes: any layout as a React component in the film folder (`"type": "custom"`), with justrec's building blocks
- ✅ Film styles (`"style": "hindsight"`, `justrec styles`): fonts, colors, surfaces, radius, backdrop; built-in or your own
- ✅ Live preview in the browser (`film --live`): plays with sound, reloads when files change
- ✅ Frame by frame (`justrec frames`): labelled frames of a scene or time range, before export
- ✅ Terminal recordings: `terminal open` + `start --terminal` + `terminal run "<cmd>"` (real shell, secrets masked)
- ✅ The check after every render (`justrec check`): layout, contrast, jumps, flashes, frozen recordings (also a recording that ends before its scene),
  voice vs music, misheard words, caption speed — each with a time and a frame

### Export

- ✅ `justrec render <project>` → final mp4 (1080p: about 1.3 s of work per second at 30 fps, 2.3 s at 60 fps)
- ✅ Small files: raw recordings ~20 MB/min, final videos ~30 MB/min at 1080p60 (x264, visually lossless)
- ✅ Preset 16:9 · 🧪 9:16 and square (`--preset vertical|square`) · ⬜ GIF
- ✅ Check the output before calling it done (one video + one audio track, right length)

### Agent workflow

- 🧪 Claude Code skill: record a task / edit a recording end to end (`.claude/skills/justrec`)
- 🧪 Feedback loop: you say "zoom less at 1:20", the agent edits the project JSON and re-renders
- ⬜ Watch folder: new recordings are processed automatically
