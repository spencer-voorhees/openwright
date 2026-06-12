# Spike: single-executable openwright

Date: 2026-06-12. Question: can the CLI + server ship as one
`openwright.exe` (the winget prerequisite)?

## What worked

- `bun build --compile src/server.ts` produces a runnable binary in
  ~70ms. 61 MB on macOS arm64 (bun runtime included).
- Cross-compiling from macOS to Windows works:
  `--target=bun-windows-x64` emits a 113 MB .exe in ~2s.
- With `OPENWRIGHT_DB` and `OPENWRIGHT_WORKSPACES` pointed at real
  directories, the compiled server boots, serves the API, and the
  agent probe layer works (claude detected, models listed).

## What breaks, and why

1. **Repo-derived paths.** Inside a compiled binary, module URLs
   resolve into the read-only virtual `/$bunfs/` filesystem (the db
   path crashed with `EROFS: mkdir /$bunfs`), while `import.meta.dir`
   reflects the *build-time* source path (the SPA served only because
   the repo exists on the build machine). On a clean machine both
   bases are wrong. Every asset root (`public/`, `html-engine/`,
   `design-systems/`, db, workspaces) needs a home-directory base.
2. **Design-system seeding** reads `design-systems/manifest.json`
   from disk; absent in the binary → zero systems seeded.
3. **Claude Agent SDK** bundles for probing, but `query()` spawns the
   SDK's own `cli.js` out of `node_modules`, which does not exist
   next to a compiled exe. Needs `pathToClaudeCodeExecutable`, an
   embedded copy, or a switch to driving the system `claude` CLI like
   the other two engines.

## Productionization plan (est. one focused day)

1. `OPENWRIGHT_HOME` (default `~/.openwright`, `%LOCALAPPDATA%\openwright`
   on Windows) as the base for db, workspaces, and assets whenever the
   process is a compiled binary.
2. Assets: embed the ~20 static files with bun's `with { type: "file" }`
   imports and extract to `OPENWRIGHT_HOME/assets` on first run
   (no network dependency), versioned by build.
3. Merge the CLI and server into one entry with subcommands
   (`openwright serve` instead of spawning `bun run src/server.ts`).
4. Claude engine: drive the system `claude` CLI in the compiled build
   (consistent with the BYOA story — all three engines external).
5. Release workflow: build matrix artifacts (macos-arm64, win-x64,
   linux-x64) attached to tagged releases → winget manifest points at
   the .exe; Homebrew formula becomes possible on the mac side.

## Verdict

Feasible with no architectural blockers. The path layer (1–2) is the
bulk of the work; the SDK question (4) is the one real design
decision. Defer until after launch; the wizard install already covers
all platforms.
