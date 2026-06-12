# openpod

Agent-built slide decks from a workspace of files. Drop in source material
(markdown, PDFs, transcripts, CSVs), hit Generate, and an agent writes a
single-file HTML deck rendered live in the app — exportable to PDF and to
genuinely editable PPTX. Review with inline comments, send them back to the
agent, iterate.

Bring your own agent: Claude (Agent SDK), GitHub Copilot CLI, or OpenAI
Codex CLI. Engine and model are selectable per workspace.

## Quick start

macOS / Linux:

```sh
git clone <this repo> && cd openpod
bash setup.sh        # bun + js deps + python exporters + agent detection
bun start            # http://localhost:8090
```

Windows (PowerShell):

```powershell
git clone <this repo>; cd openpod
powershell -ExecutionPolicy Bypass -File setup.ps1
bun start
```

Both scripts are idempotent. Set `OPENPOD_INSTALL_AGENTS=1` to let them
`npm install -g` the Copilot/Codex CLIs they don't find. PDF export
resolves Chrome from playwright's chromium, puppeteer's cache, or a
system Chrome/Edge install (override with `OPENPOD_CHROME`).

### Agent auth (any one is enough)

| Engine | Setup |
| --- | --- |
| Claude | `ANTHROPIC_API_KEY` in `.env`, or a logged-in Claude Code install |
| Copilot | run `copilot` once and `/login`, or `COPILOT_GITHUB_TOKEN` (fine-grained PAT with Copilot permission; classic tokens are rejected) |
| Codex | `codex login` (ChatGPT account) or `codex login --api-key` |

The workspace settings popover shows live availability per engine and a
model picker (free text, with suggestions; blank = engine default).

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
  baseline. New design systems (via UI or agent) start as themed copies of
  Oneshot — tokens change, structure stays — so every theme survives the
  PPTX/PDF exporters.

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
