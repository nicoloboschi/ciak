---
name: ciak
description: ciak, the one entrypoint for screen work on this Mac — record the screen, a window, a browser or a terminal while doing a task; edit recordings (by project id, e.g. "edit project 3f9a1c2e") into polished demo and launch videos (zooms, cuts, captions, narration in the user's own cloned voice, music); take framed screenshots. Use when the user says "record yourself doing X", "make a demo/launch video of X", "edit my last recording", "zoom less at 1:20", "cut the pause", "screenshot this nicely", "say it in my voice", or names a ciak project/recording. If the ciak command is missing, this skill explains how to install it.
---

# 🎬 ciak

**The documentation is `ciak help`.** Run it first, then `ciak <word> help` before you use a word:
it lists every command and option, with rules and an example, and always matches the installed version.

| | |
|---|---|
| `ciak record` | make a video: the screen, a window, the ciak browser or a terminal, and act in it |
| `ciak project` | what you made: list, edit, render. One recording or a film of many scenes |
| `ciak shot` | framed screenshots |
| `ciak voice` | the user's own voices, for narration |
| `ciak app` | the menu bar app, the panel, updates |

## First time: install ciak

If `ciak` is not found, it isn't installed yet. Tell the user, then run:

```sh
curl -fsSL https://raw.githubusercontent.com/nicoloboschi/ciak/main/install.sh | bash
```

It needs macOS 15+, the Xcode command line tools and Node.js 22+, and says what's missing. Everything else
is downloaded the first time a feature needs it (the first caption or narration in the user's voice takes minutes).
It puts ciak in `~/.ciak/app`, the `ciak` command in `~/.local/bin` and 🎬 in the menu bar. macOS then asks
the user once for Screen Recording: tell them to allow ciak.
