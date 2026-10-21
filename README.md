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
justrec rec            # record main display + default mic; Enter or Ctrl-C stops
justrec rec 1          # record display #1 instead
justrec captions <mp4> # writes <name>.srt, .txt, .json (word timestamps) next to the video
```

Recordings land in `~/Movies/justrec/` (set `JUSTREC_DIR` to change).

### First run

macOS asks once for **Screen Recording** and **Microphone** permission for the
terminal app that runs `justrec` (System Settings > Privacy & Security).
Restart the terminal after granting Screen Recording.

### Requirements

macOS 15+, Xcode command line tools (`swiftc`), `uv` (for Whisper), `ffmpeg`.

## Features

Status: ✅ done and tested · 🧪 built, not yet tested · ⬜ not started

### Record

- 🧪 Screen + cursor + mic into **one** mp4 with a single audio track (ScreenCaptureKit)
- 🧪 Pick the display (`justrec rec <index>`)
- 🧪 Stop with Enter or Ctrl-C; file is finalized cleanly
- ⬜ Log cursor position and clicks to `<name>.cursor.jsonl` (drives zooms)
- ⬜ Optional system audio, mixed into the same track (never a second track)
- ⬜ Record a single window or a region instead of the whole display
- ⬜ Optional webcam bubble
- ⬜ Global hotkey to start/stop without a terminal in front
- ⬜ Menu-bar indicator while recording (so you know it's on)
- ⬜ Pick the mic by name (`--mic "Brio 100"`)
- ⬜ Mic level check before recording starts (warn if silent or too quiet)

### Understand

- ✅ Local transcript with word timestamps (`justrec captions`, Whisper on Apple silicon)
- ⬜ Scene/screen-change detection (what's on screen when)
- ⬜ One `<name>.project.json` that gathers everything an agent needs:
  video, transcript, cursor log, edit decisions

### Edit (agents)

- ⬜ Cut silences and filler words, driven by the transcript
- ⬜ Cut by text: delete a sentence from the transcript, it's gone from the video
- ⬜ Auto-zoom on clicks and typing, smooth pan following the cursor
- ⬜ Smooth / enlarged cursor drawn on top
- ⬜ Background, padding, rounded corners, shadow
- ⬜ Burned-in captions with a clean style
- ⬜ Intro/outro title cards
- ⬜ Loudness normalization for the voice
- ⬜ Rendering via Remotion, so every edit is code an agent can change

### Export

- ⬜ `justrec render <project>` → final mp4
- ⬜ Presets: 16:9, 9:16 (shorts), square, GIF
- ⬜ Check the output before calling it done (has audio, voice audible, right length)

### Agent workflow

- ⬜ Claude Code skill: "edit my last recording" end to end
- ⬜ Feedback loop: you say "zoom less at 1:20", the agent edits and re-renders
- ⬜ Watch folder: new recordings are processed automatically
