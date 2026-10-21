# CLAUDE.md

justrec is a screen recorder + video editor where **agents do the editing**. The
human records and reviews; everything in between is files and commands.

The feature checklist lives in `README.md`. When you finish or test a feature,
update its status there (⬜ → 🧪 → ✅). ✅ means you actually ran it and checked
the output, not just that it compiles.

## Layout

- `justrec` — bash entrypoint. Subcommands: `rec`, `captions`. Keep it the only CLI.
- `rec.swift` — the recorder (ScreenCaptureKit, macOS 15+). Compiled on demand by
  `justrec` into `.build/justrec-rec` with `swiftc -O -parse-as-library`.
- Recordings go to `~/Movies/justrec/` (`JUSTREC_DIR`). Every artifact for a
  recording sits next to it with the same base name: `rec-X.mp4`, `rec-X.srt`,
  `rec-X.json`, later `rec-X.cursor.jsonl`, `rec-X.project.json`.

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
