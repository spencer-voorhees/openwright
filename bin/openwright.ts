#!/usr/bin/env bun
// openwright CLI — start/stop/status for the local server.
// Registered globally by setup via `bun link`; works the same on
// macOS, Linux, and Windows.
import { existsSync, readFileSync, writeFileSync, unlinkSync, openSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { platform } from "node:os";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PIDFILE = join(ROOT, ".openwright.pid");
const LOGFILE = join(ROOT, "openwright.log");

function port(): number {
  if (process.env.OPENWRIGHT_PORT) return Number(process.env.OPENWRIGHT_PORT);
  try {
    const env = readFileSync(join(ROOT, ".env"), "utf-8");
    const m = env.match(/^OPENWRIGHT_PORT=(\d+)/m) || env.match(/^PORT=(\d+)/m);
    if (m) return Number(m[1]);
  } catch {}
  return 8090;
}
const URL_ = `http://localhost:${port()}`;

function pid(): number | null {
  try {
    const p = Number(readFileSync(PIDFILE, "utf-8").trim());
    if (!p) return null;
    process.kill(p, 0);          // throws if the process is gone
    return p;
  } catch { return null; }
}

async function healthy(): Promise<boolean> {
  try {
    const r = await fetch(`${URL_}/api/workspaces`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch { return false; }
}

async function start(foreground = false) {
  if (await healthy()) { console.log(`already running at ${URL_}`); return; }
  if (foreground) {
    const proc = Bun.spawn({ cmd: [process.execPath, "run", join(ROOT, "src", "server.ts")], cwd: ROOT, stdout: "inherit", stderr: "inherit" });
    process.exit(await proc.exited);
  }
  // The server writes the logfile through its own fd, so this CLI
  // can exit immediately after the health check.
  const fd = openSync(LOGFILE, "a");
  const proc = Bun.spawn({
    cmd: [process.execPath, "run", join(ROOT, "src", "server.ts")],
    cwd: ROOT,
    stdout: fd, stderr: fd,
  });
  proc.unref();
  writeFileSync(PIDFILE, String(proc.pid));
  for (let i = 0; i < 40; i++) {
    if (await healthy()) {
      console.log(`openwright running at ${URL_}  (pid ${proc.pid}, logs: openwright logs)`);
      process.exit(0);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  console.error(`server did not come up — check ${LOGFILE}`);
  process.exit(1);
}

function stop() {
  const p = pid();
  if (!p) { console.log("not running (no live pid)"); try { unlinkSync(PIDFILE); } catch {} return; }
  process.kill(p);
  try { unlinkSync(PIDFILE); } catch {}
  console.log(`stopped (pid ${p})`);
}

async function status() {
  const p = pid();
  const up = await healthy();
  if (up) console.log(`running at ${URL_}${p ? ` (pid ${p})` : " (pid unknown — started outside the CLI)"}`);
  else if (p) console.log(`pid ${p} is alive but ${URL_} is not answering — check openwright logs`);
  else console.log("stopped");
}

function logs(n = 60) {
  if (!existsSync(LOGFILE)) { console.log("(no log file yet)"); return; }
  const lines = readFileSync(LOGFILE, "utf-8").trimEnd().split("\n");
  console.log(lines.slice(-n).join("\n"));
}

function openBrowser() {
  const cmd = platform() === "darwin" ? ["open", URL_]
    : platform() === "win32" ? ["cmd", "/c", "start", "", URL_]
    : ["xdg-open", URL_];
  Bun.spawn({ cmd, stdout: "ignore", stderr: "ignore" });
  console.log(URL_);
}

async function update() {
  const wasUp = await healthy();
  for (const cmd of [["git", "pull", "--ff-only"], [process.execPath, "install"]]) {
    const proc = Bun.spawn({ cmd, cwd: ROOT, stdout: "inherit", stderr: "inherit" });
    if (await proc.exited !== 0) process.exit(1);
  }
  if (wasUp) { stop(); await new Promise((r) => setTimeout(r, 500)); await start(); }
  else console.log("updated — `openwright start` when ready");
}

function setup() {
  const cmd = platform() === "win32"
    ? ["powershell", "-ExecutionPolicy", "Bypass", "-File", join(ROOT, "setup.ps1")]
    : ["bash", join(ROOT, "setup.sh")];
  Bun.spawn({ cmd, cwd: ROOT, stdout: "inherit", stderr: "inherit", stdin: "inherit" });
}

const [cmd, ...args] = process.argv.slice(2);
switch (cmd) {
  case "start":   await start(args.includes("--foreground") || args.includes("-f")); break;
  case "stop":    stop(); break;
  case "restart": stop(); await new Promise((r) => setTimeout(r, 500)); await start(); break;
  case "status":  await status(); break;
  case "logs":    logs(Number(args[0]) || 60); break;
  case "open":    openBrowser(); break;
  case "update":  await update(); break;
  case "setup":   setup(); break;
  default:
    console.log(`openwright — BYOA work-artifact workspace

usage: openwright <command>

  start [-f]   start the server (background; -f for foreground)
  stop         stop the server
  restart      stop + start
  status       is it running?
  logs [n]     tail the server log
  open         open the app in your browser
  update       git pull + deps + restart if running
  setup        re-run the setup wizard`);
}
