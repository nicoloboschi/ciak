---
name: justrec
description: justrec, the one entrypoint for screen work on this Mac — record the screen, a window, a browser or a terminal while doing a task; edit recordings (by project id, e.g. "edit project 3f9a1c2e") into polished demo and launch videos (zooms, cuts, captions, narration in the user's own cloned voice, music); take framed screenshots. Use when the user says "record yourself doing X", "make a demo/launch video of X", "edit my last recording", "zoom less at 1:20", "cut the pause", "screenshot this nicely", "say it in my voice", or names a justrec project/recording.
---

# justrec

All commands print JSON: `justrec <command>` (`justrec help` lists them all).

**Projects.** Every recording is a project with a short id (`justrec stop` prints it; the user sees it in
the recording panel and says "edit project 3f9a1c2e"). Its files live in `~/.justrec/projects/<id>/`:
`recording.mp4` (raw), `recording.project.json` (the edit), `recording.cursor.jsonl`, captions
(`recording.srt`/`.json`). Wherever a command takes `<project>`, give the id (or the `--name`, newest wins,
or a path). The user's folder `~/Documents/justrec/` (`JUSTREC_DIR`) only gets finished videos:
`justrec render <id>` writes `<name>-<id>.mp4` there (re-rendering replaces it) and screenshots.

`justrec project rename <id> <name>` renames a project and its finished video; `justrec project remove <id>`
moves the project and its video to the Trash (only when the user asks; refused while it records).

**The user names a project** ("edit project 3f9a1c2e: …") → go to **B. Edit**: one `justrec edit <id>` call takes
several options at once, then `justrec render <id>`. No film needed. The user's recording panel follows along:
it shows each render step with its timing and plays the new video when it's done.

**Setup (once per Mac):** if `justrec` is not found, run `<repo>/justrec install`
(repo: github.com/nicoloboschi/justrec). It puts justrec.app in the menu bar (⌘1 screenshots,
Record… which opens the recording panel; starts at login), links the command and this skill.
`justrec uninstall` undoes it. The app holds the Screen Recording/Microphone permission for what
it starts; commands an agent runs use the terminal's permission. If a capture says the user declined,
the permission is missing: tell the user which app needs it, don't work around it.

## A. Record yourself doing a task in a browser (preferred)

The justrec browser is a second Brave on a copy of the user's Brave profile, so it is
logged in to their sites. It runs in the background and is recorded from the page
itself, so it records fine while covered by other windows. Never use the user's own
browser window for this.

```bash
justrec browser https://example.com/start    # start it (first run copies the profile) + open a tab
justrec start --browser --fps 60 --system-audio --name <short-name>  # record the current tab (+ its sound; --mic for voice)
justrec browser click "Sign in"              # CSS selector or visible text; the mouse glides there
justrec browser type "Search" "my query"     # click a field, then type; or: type "text" into the focused field
justrec browser key Enter                    # Enter Tab Escape Backspace Arrow* Space
justrec browser scroll 600 | go <url> | eval <js> | tabs | switch <tab>   # recordings follow the active tab
justrec browser shot /tmp/look.png           # see the page before deciding the next step
justrec stop
```

Clicks, mouse moves and typing on the page are logged automatically: zooms and the
drawn cursor need no marks. `--system-audio` records only this browser's sound, never other apps.
The render adds a soft tick on each click (`audio.clicks: false` in the project turns it off).
If the user's logins changed, `justrec browser --refresh-login <url>` re-copies the profile.

## A2. Record the screen, a window or a region

1. `justrec sources` → a display index or a window `id` (`onScreen: false` = other Space).
2. `justrec start --window <id> --name <short-name>` (`--display <i>`, `--region x,y,w,h`,
   `--no-mic`, `--system-audio`, `--camera default`).
3. When an action doesn't move the real mouse, mark it: `justrec mark "<what>" --at <x>,<y>` (0–1).
4. `justrec stop` → returns the project `id` (and its `output` mp4 and `project` JSON paths).

A covered window stops updating in a screen recording: keep it visible.

## B0. Make a launch video (film) — the usual goal

The film's folder holds film.json, stills and the final film; recordings stay projects (refer to them
by id, or by --name). Recordings auto-edit when they stop (idle time cut, zooms on clicks), so they are
ready to use as-is.

```bash
export JUSTREC_DIR=~/Documents/justrec/<film-name>      # film.json, screenshots and the film together
justrec browser <url>                                  # set the page up as it should look first
justrec start --browser --name before  …actions…  justrec stop
justrec terminal open --blur 'sk_\w+'                 # the user's own zsh (prompt, iTerm colors) in the justrec browser
justrec start --terminal --name calls                  # …then: justrec terminal run "<command>" … justrec stop
justrec browser shot $JUSTREC_DIR/<name>.png           # stills for image/slide scenes
justrec shot --from $JUSTREC_DIR/<name>.png --no-copy  # a still framed on a wallpaper (the user's ⌘1 shortcut has the same look)
# write $JUSTREC_DIR/launch.film.json (see `justrec schema`)
justrec film $JUSTREC_DIR/launch.film.json --live      # player + scene list + schema-driven editor for the human; reloads on save
justrec film $JUSTREC_DIR/launch.film.json --preview   # ~20 s: contact sheet + layout check
justrec frames $JUSTREC_DIR/launch.film.json --scene 3 # labelled frames of one scene (or --from/--to, --at)
justrec film $JUSTREC_DIR/launch.film.json             # final mp4 + .srt + .report.json, then the check
```

**The schema is the reference**: `justrec schema` prints every field with a description;
start each film with `"$schema": "<path from justrec schema --path>"`. Unknown or misspelled
fields are errors with a "did you mean". One vocabulary everywhere: a scene's headline is
`title`, pictures are `image`, numbers are `stats`, a recording is `recording` (its project id or --name),
voice settings live in `voice` {name, speed, pronounce} (`name` can be the user's own voice: `justrec voice list`; they add it once with `justrec voice add me`, reading aloud for 15 s — first use downloads a ~4 GB model) and music in `music` (false | file |
{file, volume}). A scene's `speed` is playback speed of its recording.

**Style.** Set `"style": "<name>"`: `justrec styles` lists them (built-in `hindsight`, `midnight`,
`keynote` in styles/; your own as JSON in `~/.justrec/styles`), or a path to a style .json. A style
is theme fields: fonts (`font`, `headingFont`, `monoFont` + `fontUrl` to load them), colors, `panel`
/ `card` / `border` / `radius`, `backdrop`. `theme` fine-tunes on top. Custom scenes get it via
`theme` and the `font` / `headingFont` / `monoFont` exports of "justrec".

**Templates are shortcuts, not limits.** When a scene needs its own layout or animation, write it:
`{"type": "custom", "component": "scenes/hero.jsx", "props": {...}, "recordings": {"main": "<name>"}, "images": {"logo": "logo.png"}, "say": "…"}`.
The component (default export) is plain React + Remotion; import building blocks from `"justrec"`
(Rich, Heading, Pill, Counter, LinePanel, Recording, Text, appear, font, AbsoluteFill, Img,
useCurrentFrame, interpolate, spring, Easing). It gets its props plus {theme, frames, reserve,
recordings, images}: show a recording with `<Recording recording={recordings.main} frames={frames}
box={{width, height, padding}}/>`, keep `reserve` px free at the bottom for captions, wrap text in
`<Text>` so the layout check sees it. Narration, captions, transitions, music and the check still
apply. Example: `~/Documents/justrec/inference-launch/scenes/judgments.jsx`.

Text in `title`, `bullets`, `pill`, `chips`, column `text`: `*muted words*` render grey (two-tone
keynote headline), `[accent words]` in the accent color. Scene types: title, slide, image, stats,
chart, lines, recording, compare (before/after), end.

**Always read the check.** `justrec film` ends by inspecting the result and lists `issues`, each with a
time, a scene, what's wrong and a `frame` PNG to look at: text off-frame, overlapping, low contrast or
under the captions; picture jumps or flashes; a recording frozen on a still; music too loud under the
voice; words a listener would mishear; captions too fast. Fix and re-render until it is empty.
`--preview` runs the layout part. When something looks off, look frame by frame with `justrec frames`.

- Write `say` as plain spoken sentences; spell numbers the way they should be read.
- Only use real numbers: read them from the source or measure them; mark early results with `note`.
- Keep secrets out: `--hide <text>` / `--blur <regex>` on browser recordings, `browser mask` before a
  shot, `terminal open --blur` for the terminal (keys come from the environment, never typed).
- Terminal: `terminal run` types the command key by key into a real zsh (multi-line commands show zsh's
  own `>` / `quote>` prompts), waits for it, returns `{code, output}`. Pagers are off; a command still
  running after `--timeout` (120 s) gets Ctrl-C. Pass secrets through the environment of
  `terminal open` (e.g. `KEY=$(cat file) justrec terminal open --blur 'hsk_\w+'`), never type them.
- Auto-zooms land on every click; delete a pointless one from the recording's `zooms` in its project JSON.

## B. Edit

```bash
justrec captions <id>                  # only if someone talked; writes the transcript into the project
justrec edit <id> --cut-idle --auto-zoom
justrec preview <id> --frame 90        # look at a frame (png, in the project folder) before a full render
justrec render <id>                    # → ~/Documents/justrec/<name>-<id>.mp4, verified: 1 video + 1 audio track
```

- `--cut-idle`: removes 1 s+ stretches where the picture is still, nobody talks and nothing is clicked or typed (agent think-time). Use it for agent recordings.
- `--cut-silence`: removes pauses in speech. Use it for human talking-head demos.
- `--cut start,end`: remove a range (source seconds).
- `--auto-zoom`: zooms on clicks and marks; close actions pan instead of zooming out.
- `--preset landscape|vertical|square`. A wide screen recording in `vertical` is fitted inside the tall frame: a thin strip
  with small text (a 2560×1080 recording leaves ~80% background). Add `--auto-zoom` (zooms on clicks) or zooms by hand
  on what matters, and tell the user how it reads on a phone.
- `--background aurora|sunset|ocean|meadow|graphite|midnight` (or any CSS background): the wallpaper behind the recording. Default aurora.

Everything else is a direct edit of the project JSON, then re-render:
- `zooms[]`: `{start, end, x, y, scale}` in source seconds, x/y 0–1. "Zoom less" = lower `scale`; zooms that touch are chained.
- `clips[]`: kept source ranges, in order.
- `style`: `background`, `padding`, `radius`, `shadow`, `cursorSize`, `clickColor`.
- `captions.enabled`, `audio.normalize`, `intro`/`outro`: `{text, duration}`.
- `audio.denoise`: the mic's background noise is removed at render (a local speech denoiser; on unless Mac sound was
  recorded, since it would remove music too). Set `false` if it ever eats the voice; the cleaned voice is cached as
  `recording.clean.wav` in the project.
- `webcam`: `size` (fraction of width), `position` `bottom-right|bottom-left`.

- The first `preview`/`render` on a Mac downloads a headless Chrome (~170 MB, ~40 s), once.
- Paths contain the recording's name (spaces): quote them.

Times the user says ("at 1:20") refer to the **rendered** video; map them back to
source time through `clips` (and the intro length) before editing.

## C. Check before saying done

```bash
ffprobe -v error -show_entries stream=codec_type,duration -of compact <edited.mp4>   # exactly 1 video + 1 audio
ffmpeg -hide_banner -i <edited.mp4> -vn -af volumedetect -f null - 2>&1 | grep mean_volume   # voice: well above -60 dB
```
Look at 2–3 frames around the zooms. Report the path of the finished mp4. A silent result is fine when the raw
recording is silent too (recorded without a mic): check `recording.mp4` in the project folder before calling a voice lost.

## D. Screenshots

The user takes them with ⌘1 (menu bar app): drag an area or press space for a window; the shot
is framed on a wallpaper, saved to `~/Documents/justrec/shots/`, copied, and shown in Finder.
`justrec shot list` lists them (newest first); `shot copy <file>` puts one on the clipboard, `shot remove <file>`
moves it to the Trash (only when the user asks). The panel's Screenshots page shows them too.
For an agent: `justrec browser shot <file.png>` (page) then `justrec shot --from <file.png> --no-copy
[--background sunset] [--out file]` for the framed version; `--plain` skips the frame.

## E. The user's own voice

`justrec voice list` shows cloned voices. `"voice": {"name": "me"}` in a film narrates in it
(Qwen3-TTS, local, ~30 s per sentence; short sentences sound most natural). The user records one
with `justrec voice add me` (reads a paragraph aloud for 15–20 s; it's cleaned and cut
automatically) — it records the mic, so ask the user and tell them when to start.
There can be several voices (one per name); the panel's Voices page lists them, plays each sample, tries text,
and adds one (recorded in the page or uploaded: a voice note or video). A failed try keeps the old voice.
`justrec voice say me "text" [--out f]` writes `voice-me.wav` to try it; `voice remove <name>` moves it to the Trash. Use `pronounce` for names
(e.g. `{"Claude": "Clawd"}`).

