# OpenWright

[![install](https://github.com/spencer-voorhees/openwright/actions/workflows/install.yml/badge.svg)](https://github.com/spencer-voorhees/openwright/actions/workflows/install.yml)

Agent-built slide decks from a workspace of files. Drop in source material
(markdown, PDFs, transcripts, CSVs), hit Generate, and an agent writes a
single-file HTML deck rendered live in the app — exportable to PDF and to
genuinely editable PPTX.

Bring your own agent: **Claude** (Agent SDK), **GitHub Copilot CLI**, or
**OpenAI Codex CLI**. Everything runs locally and drives the agent CLI you
are already authorized to use — no new data path, files never leave your
machine except through your chosen agent.

## Features

- **Review loop**: leave comments on the slide you're viewing, send the
  batch to the agent, accept the fixes or reopen with a follow-up note.
  The agent answers clarifying questions mid-run and you reply in the
  same chat.
- **Engine + model per workspace**: model pickers list what each engine
  can actually run right now (probed live from the CLIs). Swap engines
  whenever a run isn't mid-thought — even while one is waiting on your
  answer — and the next turn continues on the new engine. Every run
  records the engine and model that produced it.
- **App-level defaults** in Settings: default engine, default model, and
  the accent color (which also re-tints the logo). Copilot auth can be
  verified on demand — useful where authorization is mandatory.
- **Exports that finish the job**: PDF (headless Chromium print),
  editable PPTX (every visual a real shape), pixel-perfect image PPTX,
  and the HTML source — all under one Export menu, auto-downloading the
  moment rendering completes.
- **A workspace that behaves**: live preview with expand/collapse window
  controls, version history per artifact, status everywhere it matters,
  and a dashboard ordered by what you touched last.
- **Local-only by default**: the server binds 127.0.0.1; set
  `OPENWRIGHT_HOST=0.0.0.0` if you want it reachable from other devices.

## Quick start

One line on a machine with zero prerequisites — the wizard installs
everything it needs (bun, an isolated Python via uv, agent CLIs),
detects engines you already have, and requires picking at least one:

macOS / Linux:

```sh
curl -fsSL https://raw.githubusercontent.com/spencer-voorhees/openwright/main/install.sh | bash
openwright start     # http://localhost:8090
```

(append `-s -- -y` to the curl line for hands-off). Or from a clone:

```sh
git clone https://github.com/spencer-voorhees/openwright && cd openwright
bash setup.sh        # guided; or `bash setup.sh -y` for hands-off
```

The wizard offers to start the app itself; afterwards it's
`openwright start` (http://localhost:8090).

Windows (PowerShell):

```powershell
irm https://raw.githubusercontent.com/spencer-voorhees/openwright/main/install.ps1 | iex
openwright start
```

If `openwright` isn't recognized right after setup, open a new
terminal — the PATH update lands in fresh sessions.

Or from a clone: `powershell -ExecutionPolicy Bypass -File setup.ps1`
(add `-Yes` for hands-off).

Both wizards are idempotent and touch nothing outside the repo,
`~/.bun`, and `~/.local`. They detect installed agent CLIs, offer to
install missing ones (through bun's global shims — no node/npm
needed), and can walk you through `copilot login` / `codex login`
on the spot. PDF export resolves Chrome from playwright's chromium,
puppeteer's cache, or a system Chrome/Edge install (override with
`OPENWRIGHT_CHROME`).

### The CLI

Setup links an `openwright` command globally:

```
openwright start | stop | restart | status | logs [n] | open | update | setup | uninstall
```

`update` pulls the latest, reinstalls deps, and restarts if running.
`uninstall` removes the command (your data stays in the repo folder);
`uninstall --all` deletes the entire install. bun and uv are shared
tools and are left in place either way.

### Agent auth (any one is enough)

| Engine | Setup |
| --- | --- |
| Claude | `ANTHROPIC_API_KEY` in `.env`, or a logged-in Claude Code install |
| Copilot | run `copilot` once and `/login`, or `COPILOT_GITHUB_TOKEN` (fine-grained PAT with Copilot permission; classic tokens are rejected) |
| Codex | `codex login` (ChatGPT account) or `codex login --api-key` |

The workspace settings popover shows live availability per engine and a
model dropdown listing what that engine reports as runnable right now.
Settings can verify Copilot auth on demand (one minimal request) and
remembers the result.

## How it works

- **One HTML file is the source of truth.** The agent writes
  `deck-vN.html` against a vendored deck shell (`html-engine/deck-shell.js`)
  at an authored 1920x1080. The same file renders the live preview, prints
  to PDF via headless Chromium, and walks through a DOM-level exporter to
  editable PPTX.
- **Adapters are a single run.** `src/agents/types.ts` defines the whole
  BYOA contract: prompt in, files on disk out, events streamed for the chat
  panel. The outer loop (ASK:/DONE: markers, retries, idle watchdog,
  comment triggers) lives in `src/agent.ts` and is engine-agnostic.
  Adding an engine = one adapter file + one line in `src/agents/index.ts`.
- **System prompt channel:** Claude gets it natively via the SDK; Copilot
  and Codex read it from `AGENTS.md`, written into the workspace before
  each run.
- **Design systems:** the app ships with **Oneshot**, an export-lossless
  baseline (Helvetica/solid fills/no effects that break PPTX). New design
  systems derive from Oneshot — tokens change, structure stays — so every
  theme survives the exporters. In-app creation is intentionally absent
  until prompting an agent to build one is wired up.

## Layout

```
src/server.ts        Bun HTTP server + API + exporter shell-outs
src/agent.ts         engine-agnostic generation loop
src/agents/          BYOA adapters (claude, copilot, codex)
src/db.ts            sqlite schema + design-system seeding
design-systems/      built-in CSS, seeded into the db on boot
html-engine/         deck shell, lucide build, example deck, exporters
public/              React UI (babel-standalone, no build step)
workspaces/          per-workspace files + artifacts (gitignored)
```

## Configuration

Copy `.env.example` to `.env`. Everything defaults sanely; see the file
for engine binaries, models, port, and watchdog tuning.
