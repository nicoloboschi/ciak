---
name: justrec
description: Record the screen, a window or a browser while doing a task, and edit recordings into polished demo videos with justrec (zooms, cuts, captions, webcam, presets). Use when the user says "record yourself doing X", "make a demo of X", "edit my last recording", "zoom less at 1:20", "cut the pause", or names a justrec project/recording.
---

# justrec

All commands print JSON. Run from the justrec repo: `./justrec <command>`.
Recordings and their files live in `~/Documents/justrec/` (`JUSTREC_DIR`).

## A. Record yourself doing a task in a browser (preferred)

The justrec browser is a second Brave on a copy of the user's Brave profile, so it is
logged in to their sites. It runs in the background and is recorded from the page
itself, so it records fine while covered by other windows. Never use the user's own
browser window for this.

```bash
./justrec browser https://example.com/start    # start it (first run copies the profile) + open a tab
./justrec start --browser --fps 60 --system-audio --name <short-name>  # record the current tab (+ its sound; --mic for voice)
./justrec browser click "Sign in"              # CSS selector or visible text; the mouse glides there
./justrec browser type "Search" "my query"     # click a field, then type; or: type "text" into the focused field
./justrec browser key Enter                    # Enter Tab Escape Backspace Arrow* Space
./justrec browser scroll 600 | go <url> | eval <js> | tabs
./justrec browser shot /tmp/look.png           # see the page before deciding the next step
./justrec stop
```

Clicks, mouse moves and typing on the page are logged automatically: zooms and the
drawn cursor need no marks. `--system-audio` records only this browser's sound, never other apps.
The render adds a soft tick on each click (`audio.clicks: false` in the project turns it off).
If the user's logins changed, `./justrec browser --refresh-login <url>` re-copies the profile.

## A2. Record the screen, a window or a region

1. `./justrec sources` → a display index or a window `id` (`onScreen: false` = other Space).
2. `./justrec start --window <id> --name <short-name>` (`--display <i>`, `--region x,y,w,h`,
   `--no-mic`, `--system-audio`, `--camera default`).
3. When an action doesn't move the real mouse, mark it: `./justrec mark "<what>" --at <x>,<y>` (0–1).
4. `./justrec stop` → returns `output` (mp4) and `project` (JSON).

A covered window stops updating in a screen recording: keep it visible.

## B0. Make a launch video (film) — the usual goal

Everything for one film lives in one folder. Recordings auto-edit when they stop
(idle time cut, zooms on clicks), so they are ready to use as-is.

```bash
export JUSTREC_DIR=~/Documents/justrec/<film-name>      # recordings, screenshots and film.json together
./justrec browser <url>                                  # set the page up as it should look first
./justrec start --browser --name before  …actions…  ./justrec stop
./justrec terminal open --blur 'sk_\w+'                 # a real shell, shown in the justrec browser
./justrec start --terminal --name calls                  # …then: ./justrec terminal run "<command>" … ./justrec stop
./justrec browser shot $JUSTREC_DIR/<name>.png           # stills for image/slide scenes
# write $JUSTREC_DIR/launch.film.json (see `./justrec schema`)
./justrec film $JUSTREC_DIR/launch.film.json --live      # plays it in the browser now, reloads on save (for the human)
./justrec film $JUSTREC_DIR/launch.film.json --preview   # ~20 s: contact sheet + layout check
./justrec frames $JUSTREC_DIR/launch.film.json --scene 3 # labelled frames of one scene (or --from/--to, --at)
./justrec film $JUSTREC_DIR/launch.film.json             # final mp4 + .srt + .report.json, then the check
```

**The schema is the reference**: `./justrec schema` prints every field with a description;
start each film with `"$schema": "<path from ./justrec schema --path>"`. Unknown or misspelled
fields are errors with a "did you mean". One vocabulary everywhere: a scene's headline is
`title`, pictures are `image`, numbers are `stats`, a recording is `recording` (its --name),
voice settings live in `voice` {name, speed, pronounce} and music in `music` (false | file |
{file, volume}). A scene's `speed` is playback speed of its recording.

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
- Auto-zooms land on every click; delete a pointless one from the recording's `zooms` in its project JSON.

## B. Edit

```bash
./justrec captions <mp4>                 # only if someone talked; writes <name>.json transcript
./justrec edit <project> --cut-idle --auto-zoom
./justrec preview <project> --frame 90   # look at a frame (png) before a full render
./justrec render <project>               # → <name>.edited.mp4, verified: 1 video + 1 audio track
```

- `--cut-idle`: removes 1 s+ stretches where the picture is still, nobody talks and nothing is clicked or typed (agent think-time). Use it for agent recordings.
- `--cut-silence`: removes pauses in speech. Use it for human talking-head demos.
- `--cut start,end`: remove a range (source seconds).
- `--auto-zoom`: zooms on clicks and marks; close actions pan instead of zooming out.
- `--preset landscape|vertical|square`.

Everything else is a direct edit of the project JSON, then re-render:
- `zooms[]`: `{start, end, x, y, scale}` in source seconds, x/y 0–1. "Zoom less" = lower `scale`; zooms that touch are chained.
- `clips[]`: kept source ranges, in order.
- `style`: `background`, `padding`, `radius`, `shadow`, `cursorSize`, `clickColor`.
- `captions.enabled`, `audio.normalize`, `intro`/`outro`: `{text, duration}`.
- `webcam`: `size` (fraction of width), `position` `bottom-right|bottom-left`.

Times the user says ("at 1:20") refer to the **rendered** video; map them back to
source time through `clips` (and the intro length) before editing.

## C. Check before saying done

```bash
ffprobe -v error -show_entries stream=codec_type,duration -of compact <edited.mp4>   # exactly 1 video + 1 audio
ffmpeg -hide_banner -i <edited.mp4> -vn -af volumedetect -f null - 2>&1 | grep mean_volume   # voice: well above -60 dB
```
Look at 2–3 frames around the zooms. Report the path of the edited mp4.
