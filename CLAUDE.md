# CLAUDE.md

ciak is a screen recorder + video editor where **agents do the editing**. The
human records and reviews; everything in between is files and commands.

The feature checklist lives in `FEATURES.md`. When you finish or test a feature,
update its status there (⬜ → 🧪 → ✅). ✅ means you actually ran it and checked
the output, not just that it compiles.

## Layout

- `ciak` — entrypoint, runs `lib/cli.mjs`. Keep it the only CLI: five words (`record`, `project`, `shot`, `voice`, `app`),
  each with its own help (`ciak <word> help`). New commands go under one of them, with a line in its help.
- `lib/session.mjs` — background worker per recording: HTTP control (pause/resume/
  mark/stop), joins segments, mixes all audio into one track, writes the project.
- `rec.swift` — native capture (ScreenCaptureKit + AVFoundation for the camera), one
  process per segment. Compiled on demand into `.build/ciak-rec`. Never compile over
  that path while a recording runs: macOS kills the running recorder.
- `lib/browser.mjs` — the ciak browser (your default Chrome-like browser on a profile copy, debugging port 9333):
  `ciak record look|click|type|…` driving commands, and the page recorder used by `ciak record browser`
  (same JSON-lines protocol as `rec.swift`).
- `app.swift` + `lib/app.mjs` — ciak.app, the menu bar app (`ciak app install`), a **thin shell**: menu, ⌘1 key,
  the permission check, and starting helpers. macOS ties Screen Recording/Microphone permission to this exact
  build and helpers it starts use it, so **don't change app.swift for features** (new shortcuts are settings: `keys` in lib/app.mjs): each change makes the user grant
  the permission again (install replaces the app only when app.swift changed). Features go in the helpers:
  `picker.swift` (⌘1 screenshot: picker, frame, sound, Finder; ⌘2 quick recording; stays running, the app signals it), `rec.swift`, the panel and the CLI.
- `lib/shot.mjs` — framed screenshots from the command line (`ciak shot`).
- `lib/voice.mjs` — the user's own cloned voice for narration (Qwen3-TTS via mlx-audio).
- `lib/clean.mjs` — the one mic cleanup (`cleanVoice`): recordings at render (`audio.denoise`) and the voice sample.
- `lib/common.mjs` — `tool()` finds ffmpeg, uvx and deep-filter, or downloads them into `~/.ciak/bin` on first use;
  `python()` is the one Python environment (uv) for every model. Nothing is installed until a feature needs it.
- `lib/project.mjs` — projects (`openProject`: a recording or a film, by id, name or path) and edits (`ciak project edit`); `lib/render.mjs` +
  `render/index.jsx` — Remotion render; `lib/ui.mjs` + `ui/index.html` — record panel.
- `skills/ciak/SKILL.md` — the one skill: everything an agent can do with ciak
  (linked into ~/.claude/skills by `ciak app install`). It is a short guide: how the parts fit and the rules
  help can't teach. Commands and options live in `ciak <word> help`, not there.
- Each recording is a project: `~/.ciak/projects/<id>/` (`CIAK_PROJECTS`) holds every artifact with
  the base name `recording`: `recording.mp4`, `.project.json`, `.cursor.jsonl`, `.srt`/`.json` (captions),
  `.render.json`, plus the session's files. A film is a project too: `film.json` (its scenes), its images and
  scene code, and its render's files (`film.mp4`, `.srt`, the check, `film.render.json`). Commands take the id
  (`openProject` in lib/project.mjs: id, name or path). Only finished videos (`<name>-<id>.mp4`) and screenshots
  go to `~/Documents/ciak/` (`CIAK_DIR`).

## Rules

- **One file, one audio track.** The reason this project exists: Recordly saved
  the mic as a side file / second track and the export dropped the voice. Never
  ship a recording or render whose voice lives in a separate track or file. If
  system audio is added, mix it into the same track.
- **Agents first.** Every feature must be usable from the command line and leave
  plain files (JSON, SRT, text) an agent can read and edit. A UI is only for
  things that need a human (recording indicator, review). No timeline editor.
- **Edits are code, not state.** Edit decisions go into a project JSON; rendering
  reads it. Re-rendering from the same inputs must give the same video.
- **Reuse tools before writing code:** ffmpeg for media plumbing, mlx-whisper for
  speech, Remotion for rendering effects. Don't add a dependency for what a few
  lines of ffmpeg do.
- Keep it small. Bash for glue, Swift only for what needs macOS APIs.

## Git

Commit each main change on `main` and push it to GitHub (`origin`) right away.

## Verifying changes

There is no test suite yet. Check output files directly:

```bash
# streams and durations: expect exactly one video + one audio stream
ffprobe -v error -show_entries stream=codec_type,duration -of compact <file.mp4>
# voice present: mean volume should be well above -60 dB when someone talked
ffmpeg -hide_banner -i <file.mp4> -vn -af volumedetect -f null - 2>&1 | grep volume
# look at a frame (cursor, layout)
ffmpeg -y -ss 2 -i <file.mp4> -frames:v 1 frame.png
```

Every ciak process (picker, cli, session, recorder, panel, render steps) writes what it does with times to
`~/.ciak/trace.log`: read it first when something is slow or fails.

Recording needs Screen Recording + Microphone permission for the terminal app
running it. If ScreenCaptureKit says the user declined, the permission is missing:
say so, don't work around it.
