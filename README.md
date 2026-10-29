# 🎬 ciak

**The screen recorder your agent edits.** You record, or your agent records itself. Then you ask in plain
words ("cut the pauses", "make it vertical", "narrate it in my voice") and the agent edits and renders it.
*Ciak, si gira!* is what Italian film crews say when the camera rolls.

[![Watch the launch video](docs/poster.jpg)](https://nicoloboschi.github.io/ciak/)

▶ **[Watch the launch video](https://nicoloboschi.github.io/ciak/)**: an agent recorded, edited and narrated it with ciak,
in my own cloned voice.

## Install

```sh
npx skills add nicoloboschi/ciak
```

Then ask your agent to record something. The first time, it installs ciak for you. Or install it yourself:

```sh
curl -fsSL https://raw.githubusercontent.com/nicoloboschi/ciak/main/install.sh | bash
```

macOS 15+ on Apple silicon, with the Xcode command line tools, Node.js 22+, ffmpeg and Brave
([`uv`](https://docs.astral.sh/uv/) for captions and your own voice). You get 🎬 in the menu bar
(⌘1 screenshot, ⌘2 record) and the `ciak` command. Update with `ciak app update`.

## Use it

- **You record**: press ⌘2, stop, and the panel shows the project id. Tell your agent:
  *"Use /ciak to edit project 3f9a1c2e: cut the pauses, zoom less at 0:20, make it vertical."*
- **Your agent records itself**: *"Use /ciak to record yourself signing up on our app."* It works in a second
  browser with your logins, in the background, moving and typing like a person.
- **Launch videos**: *"Make a 30 second launch video of this, in my voice."* Scenes, narration, captions and
  music, checked for problems a viewer would notice.

Everything is a command that prints JSON, and every edit is a file, so re-rendering gives the same video.
`ciak help` is the full documentation. What works today: [FEATURES.md](FEATURES.md).
