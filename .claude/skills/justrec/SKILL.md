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
./justrec start --browser --name after   …actions…  ./justrec stop
./justrec browser shot $JUSTREC_DIR/<name>.png           # stills for image/slide scenes
# product mockup: a self-playing HTML page (window.play() starts the animation), recorded in one step;
# scripted captures (--for) are never idle-cut, so slow parts stay in
./justrec start --browser --url "file://$JUSTREC_DIR/mock.html?mode=slow" --run "play()" --for 8 --name slow
# write $JUSTREC_DIR/launch.film.json (below)
./justrec film $JUSTREC_DIR/launch.film.json --preview   # ~30 s: one contact sheet PNG, look at it
./justrec film $JUSTREC_DIR/launch.film.json             # final mp4 + .srt + .report.json, then the check
```

**Always read the check.** `justrec film` ends by inspecting the result and lists `issues`, each with a
time, a scene, what's wrong and a `frame` PNG to look at (`<name>.check/`): text off-frame, overlapping,
low contrast or under the captions; picture jumps or flashes; a recording frozen on a still; music too
loud under the voice; words a listener would mishear (Whisper vs your script); captions too fast. Fix and
re-render until it is empty. `--preview` already runs the layout part. `justrec check <film.json>` re-runs
the inspection. The report's `timings` shows where the time went.

```bash
# keep secrets and internal things out of recordings and stills (repeatable flags):
./justrec start --browser --name x --hide "internal-model-name" --blur 'hsk_\w+' --blur '^\$\d+\.\d\d$'
./justrec browser mask --hide "internal-model-name" --blur 'hsk_\w+'    # before a browser shot
```

`launch.film.json` is a list of scenes. Each scene may have `say` (narration; the scene
stretches to fit it, captions are made from it) and `duration` (minimum seconds).

```json
{"scenes": [
  {"type": "title", "kicker": "NEW", "text": "Big headline", "subtitle": "One line", "say": "…"},
  {"type": "stats", "heading": "…", "items": [{"value": "7.2M+", "label": "articles"}], "say": "…"},
  {"type": "image", "heading": "…", "src": "light.png", "say": "…"},
  {"type": "slide", "kicker": "HOW IT WORKS", "heading": "…", "bullets": ["…", "…"], "image": "dark.png", "say": "…"},
  {"type": "chart", "heading": "…", "unit": "%", "bars": [{"label": "A", "value": 100}, {"label": "B", "value": 15, "highlight": true}], "say": "…"},
  {"type": "recording", "label": "…", "project": "after", "say": "…"},
  {"type": "compare", "heading": "…", "before": {"project": "before", "label": "Before"}, "after": {"project": "after", "label": "After"}, "say": "…"},
  {"type": "lines", "heading": "Slower, *as it grows.*", "legend": [{"label": "Time"}, {"label": "Cost"}],
   "panels": [{"title": "Time to answer", "x": ["4K", "50K", "1M"], "shared": true,
     "series": [{"values": [0.5, 1, 5.3], "projectedFrom": 1, "label": "5.3s", "color": "#9a9ca3"}, {"values": [0.09, 0.09, 0.09], "label": "0.09s"}],
     "footer": "5.3s → [0.09s]", "note": "small print"}], "say": "…"},
  {"type": "end", "columns": [{"title": "[Product]", "kicker": "OPEN SOURCE", "text": "…", "stats": [{"value": "~50K", "label": "GitHub stars"}]}],
   "buttons": ["Read the docs", "Visit example.com →"], "say": "…"}
]}
```

Headline text everywhere: `*muted words*` render grey (two-tone keynote headlines), `[accent words]`
render in the accent color/gradient; words reveal one by one.

Any scene can sit on footage or a still: `"background": "footage/city.mp4"` (darkened automatically,
`"dim": "77"` for darker). Title scenes also take `"align": "top"`, `"kicker"`, `"subtitle"`, `"pill"`
(rich text), `"chips": ["[Agent] did a thing", …]` (pop-in notifications) and
`"counter": {"from": 1037, "to": 458692, "label": "memories"}` (counts up during the scene).
Stats over footage: one item per scene reads best. Lines: each series uses its own scale unless
`"shared": true`; `"top"` sets a series' scale top; end labels never overlap.

```json
{"theme": {"base": "light", "accent": "#0f9494", "accentGradient": "linear-gradient(90deg, #1f6feb, #0fa3a3)"}}
```

- `project` is the `--name` you recorded with (newest wins), or a `.project.json` path.
- Optional top level: `"theme": {"base": "dark"|"light", "accent": "#hex", …}`, `"voice": "af_heart"`,
  `"speed": 1`, `"music": false | "song.mp3"` (default: generated soft music, ducked under
  the voice), `"musicVolume": 1` (music is normalized; 0.7 quieter, 1.4 louder), `"captions": false`, `"fps": 60`, `"output": "name.mp4"`.
- Write `say` as plain spoken sentences; spell numbers the way they should be read.
- Only use real numbers: read them from the page or measure them, never invent them.
- Narration is cached per sentence, so re-running after a visual change is fast.
- `"pronounce": {"Memlake": "Mem-lake"}` changes only what the voice says (captions keep the spelling).
- Recording/compare scenes take `"speed": 1.6` to play faster (zooms, cursor and click sounds follow).
- Auto-zooms land on every click; delete a pointless one (e.g. a click that closes a dialog) from the
  recording's `zooms` in its project JSON.

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
