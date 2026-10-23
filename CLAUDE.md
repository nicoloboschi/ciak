# CLAUDE.md

justrec is a screen recorder + video editor where **agents do the editing**. The
human records and reviews; everything in between is files and commands.

The feature checklist lives in `README.md`. When you finish or test a feature,
update its status there (⬜ → 🧪 → ✅). ✅ means you actually ran it and checked
the output, not just that it compiles.

## Layout

- `justrec` — entrypoint, runs `lib/cli.mjs`. Keep it the only CLI (`justrec help`).
- `lib/session.mjs` — background worker per recording: HTTP control (pause/resume/
  mark/stop), joins segments, mixes all audio into one track, writes the project.
- `rec.swift` — native capture (ScreenCaptureKit + AVFoundation for the camera), one
  process per segment. Compiled on demand into `.build/justrec-rec`. Never compile over
  that path while a recording runs: macOS kills the running recorder.
- `lib/browser.mjs` — the justrec browser (Brave on a profile copy, debugging port 9333):
  `justrec browser ...` driving commands, and the page recorder used by `start --browser`
  (same JSON-lines protocol as `rec.swift`).
- `app.swift` + `lib/app.mjs` — justrec.app, the menu bar app (`justrec install`), a **thin shell**: menu, ⌘1 key,
  the permission check, and starting helpers. macOS ties Screen Recording/Microphone permission to this exact
  build and helpers it starts use it, so **don't change app.swift for features** (new shortcuts are settings: `keys` in lib/app.mjs): each change makes the user grant
  the permission again (install replaces the app only when app.swift changed). Features go in the helpers:
  `picker.swift` (⌘1 screenshot: picker, frame, sound, Finder; ⌘2 quick recording; stays running, the app signals it), `rec.swift`, the panel and the CLI.
- `lib/shot.mjs` — framed screenshots from the command line (`justrec shot`).
- `lib/voice.mjs` — the user's own cloned voice for narration (Qwen3-TTS via mlx-audio).
- `lib/clean.mjs` — the one mic cleanup (`cleanVoice`): recordings at render (`audio.denoise`) and the voice sample.
- `lib/project.mjs` — project JSON and edits (`justrec edit`); `lib/render.mjs` +
  `render/index.jsx` — Remotion render; `lib/ui.mjs` + `ui/index.html` — record panel.
- `.claude/skills/justrec/SKILL.md` — the one skill: everything an agent can do with justrec
  (linked into ~/.claude/skills by `justrec install`). New commands get a line there.
- Each recording is a project: `~/.justrec/projects/<id>/` (`JUSTREC_PROJECTS`) holds every artifact with
  the base name `recording`: `recording.mp4`, `.project.json`, `.cursor.jsonl`, `.srt`/`.json` (captions),
  `.render.json`, plus the session's files. Commands take the id (`findProject` in lib/project.mjs: id, path or
  name). Only finished videos (`render` → `<name>-<id>.mp4`) and screenshots go to `~/Documents/justrec/` (`JUSTREC_DIR`).

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

Recording needs Screen Recording + Microphone permission for the terminal app
running it. If ScreenCaptureKit says the user declined, the permission is missing:
say so, don't work around it.
