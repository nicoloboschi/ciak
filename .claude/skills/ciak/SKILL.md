---
name: ciak
description: ciak, the one entrypoint for screen work on this Mac — record the screen, a window, a browser or a terminal while doing a task; edit recordings (by project id, e.g. "edit project 3f9a1c2e") into polished demo and launch videos (zooms, cuts, captions, narration in the user's own cloned voice, music); take framed screenshots. Use when the user says "record yourself doing X", "make a demo/launch video of X", "edit my last recording", "zoom less at 1:20", "cut the pause", "screenshot this nicely", "say it in my voice", or names a ciak project/recording.
---

# 🎬 ciak

Five words, each with its own help. **Run `ciak <word> help` before using one**: it has every
command, option and an example. Everything prints JSON.

| | |
|---|---|
| `ciak record` | make a video: the screen, a window, the **ciak browser** or a **terminal**, and act in it |
| `ciak project` | what you made: list, edit, render. A project is one recording, or a film of many scenes |
| `ciak shot` | framed screenshots (the user's ⌘1) |
| `ciak voice` | the user's own voices, for narration |
| `ciak app` | install the menu bar app; the panel |

**How it fits.** `record … stop` makes a project and prints its id. Recordings are cut (idle time) and
zoomed (on clicks) when they stop, so `ciak project render <id>` already gives a good video. A **film**
(`ciak project new <name> --with <ids>`) is a project too: its `film.json` lists scenes (recordings,
titles, pictures, numbers) with narration. Every project lives in `~/.ciak/projects/<id>/`; finished
videos go to `~/Documents/ciak/<name>-<id>.mp4`. The user sees all of it in the panel, live, and
names projects by id ("edit project 3f9a1c2e: …").

**Setup.** If `ciak` is not found: `<repo>/ciak app install` (github.com/nicoloboschi/ciak). If a capture says
the user declined, the Screen Recording or Microphone permission is missing: say which app needs it, don't work around it.

## Recording yourself

- **Use the ciak browser** (`ciak record browser <url>`), never the user's own browser. It is a second Brave
  with a copy of the user's logins, recorded from inside the page, so it works while covered.
- **Look before you act.** `ciak record look` lists the page's buttons, links and fields with numbers;
  `click 12` / `type 7 "…"` hit exactly that. After a click that loads something, `wait "text"`
  instead of `sleep`. Numbers expire when the page changes: look again.
- **Look like a person.** Viewers spot an agent at once: text that appears without typing, a mouse that
  jumps, pages that snap. Act only with `click`/`type`/`paste`/`scroll`/`select`/`drag`; never set
  values or scroll with `eval`. Short text: `type`; long text: `paste`. Give the viewer a beat
  (`sleep 1`) after each result.
- Set the page up before recording (`ciak record open <url>`, log in, scroll): the same commands work
  without a recording.
- **Keep secrets out.** Browser: `--hide <text>` / `--blur <regex>` when starting, `ciak record mask` before
  a shot. Terminal: `--blur` and pass keys through the environment (`KEY=$(cat f) ciak record terminal --blur 'hsk_\w+'`),
  never type them.
- Screen and window recordings show the real screen: anything on it ends up in the video. A covered
  window stops updating. Mark actions the cursor log can't see: `ciak record mark "<what>" --at x,y`.

## Editing

- One `ciak project edit <id>` call takes several options; then `ciak project render <id>` (verified: one
  video track, one audio track). `--out <file>` for test renders, so the user's video isn't replaced.
- Anything without an option is a direct edit of the project's `recording.project.json`
  (`zooms[]`, `clips[]`, `style`, `captions`, `webcam`, `audio.denoise`), then render.
- **Times the user says ("at 1:20") are in the rendered video.** Map them back to the recording's own
  seconds through `clips` (and their `speed`) before editing.
- `vertical` fits a wide recording into a thin strip with small text: add zooms on what matters and
  tell the user how it reads on a phone.

## Films

- **The schema is the reference**: `ciak project schema`. Unknown fields are errors with a "did you mean".
  `*muted words*` render grey, `[accent words]` in the accent color. Pick a look with `"style"` (`ciak project styles`).
- Write `say` as plain spoken sentences; spell numbers as they should be read. Only use real numbers:
  read or measure them. `"voice": {"name": "me"}` speaks in the user's voice (`ciak voice list`);
  `pronounce` fixes names.
- Record enough: a scene longer than its recording freezes on the last frame. Keep browser recordings
  at speed 1–1.25. Never slowly zoom into a recording or screenshot; it looks cheap.
- A scene that needs its own layout is a React + Remotion component: `{"type": "custom", "component": "scenes/x.jsx", …}`
  (the schema describes it; building blocks come from `"ciak"`).
- Loop: `ciak project preview <id>` (a picture per scene and the layout check, ~20 s), then
  `ciak project render <id>`. **Always read the check** at the end of a render: each issue has a time,
  a scene and a frame to look at. Fix and render again until it is empty. `ciak project frames <id>`
  to look closer; `ciak project live <id>` for the user to watch and comment.

## Before saying done

Look at 2–3 frames of the result, and check the sound when someone talked:

```bash
ffmpeg -hide_banner -i <video.mp4> -vn -af volumedetect -f null - 2>&1 | grep mean_volume   # well above -60 dB
```

Report the finished video's path. A silent result is fine when the recording had no mic.

## Screenshots and voices

- The user takes screenshots with ⌘1. For an agent: `ciak record shot <file.png>`, then
  `ciak shot --from <file.png> --no-copy` frames it on a wallpaper. Remove only when the user asks.
- `ciak voice add` records the mic: ask the user first and tell them when to start reading.
