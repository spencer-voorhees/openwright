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
// Health checks hit 127.0.0.1 directly: the server binds IPv4
// loopback, and "localhost" resolves to ::1 first on some systems
// (notably Windows), which made a running server look stopped.
const HEALTH_URL = `http://127.0.0.1:${port()}`;

function pid(): number | null {
  try {
    const p = Number(readFileSync(PIDFILE, "utf-8").trim());
    if (!p) return null;
    process.kill(p, 0);          // throws if the process is gone
    return p;
  } catch { return null; }
}

// Find the listener's pid by port — needed on Windows where the
// detached `start` launch can't hand us a pid directly.
function pidByPort(): number | null {
  try {
    if (platform() === "win32") {
      const out = Bun.spawnSync({ cmd: ["netstat", "-ano", "-p", "tcp"] }).stdout.toString();
      for (const line of out.split("\n")) {
        if (line.includes(`:${port()} `) && /LISTENING/i.test(line)) {
          const p = Number(line.trim().split(/\s+/).pop());
          if (p) return p;
        }
      }
    } else {
      const out = Bun.spawnSync({ cmd: ["lsof", `-tiTCP:${port()}`, "-sTCP:LISTEN"] }).stdout.toString().trim();
      if (out) return Number(out.split("\n")[0]);
    }
  } catch {}
  return null;
}

async function healthy(): Promise<boolean> {
  try {
    const r = await fetch(`${HEALTH_URL}/api/workspaces`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch { return false; }
}

async function start(foreground = false, noOpen = false) {
  if (await healthy()) { console.log(`already running at ${URL_}`); return; }
  if (foreground) {
    const proc = Bun.spawn({ cmd: [process.execPath, "run", join(ROOT, "src", "server.ts")], cwd: ROOT, stdout: "inherit", stderr: "inherit" });
    process.exit(await proc.exited);
  }
  // The server writes the logfile through its own fd / shell
  // redirection, so this CLI can exit right after the health check.
  let spawnedPid: number | null = null;
  if (platform() === "win32") {
    // cmd `start` detaches the server from this process tree —
    // otherwise it can die when the CLI (or setup) exits.
    const server = join(ROOT, "src", "server.ts");
    Bun.spawnSync({
      cmd: ["cmd", "/c",
        `start "" /b cmd /c ""${process.execPath}" run "${server}" >> "${LOGFILE}" 2>&1"`],
      cwd: ROOT,
    });
  } else {
    const fd = openSync(LOGFILE, "a");
    const proc = Bun.spawn({
      cmd: [process.execPath, "run", join(ROOT, "src", "server.ts")],
      cwd: ROOT,
      stdout: fd, stderr: fd,
    });
    proc.unref();
    spawnedPid = proc.pid;
    writeFileSync(PIDFILE, String(proc.pid));
  }
  for (let i = 0; i < 40; i++) {
    if (await healthy()) {
      if (!spawnedPid) {
        spawnedPid = pidByPort();
        if (spawnedPid) writeFileSync(PIDFILE, String(spawnedPid));
      }
      console.log(`openwright running at ${URL_}${spawnedPid ? `  (pid ${spawnedPid}` : "  ("} logs: openwright logs)`);
      if (!noOpen) openBrowser();
      process.exit(0);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  console.error(`server did not come up — check ${LOGFILE} (openwright logs)`);
  process.exit(1);
}

function stop() {
  const p = pid() || pidByPort();
  if (!p) { console.log("not running"); try { unlinkSync(PIDFILE); } catch {} return; }
  if (platform() === "win32") Bun.spawnSync({ cmd: ["taskkill", "/PID", String(p), "/T", "/F"], stdout: "ignore", stderr: "ignore" });
  else process.kill(p);
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

async function uninstall(all = false) {
  if (await healthy()) stop();
  // Shims + bun link registration. The repo itself (your workspaces,
  // database, exports) stays unless --all.
  try { Bun.spawnSync({ cmd: [process.execPath, "unlink"], cwd: ROOT }); } catch {}
  const home = process.env.HOME || process.env.USERPROFILE || "";
  for (const shim of [
    join(home, ".local", "bin", "openwright"),
    join(home, ".bun", "bin", "openwright"),
    join(home, ".bun", "bin", "openwright.cmd"),
    join(home, ".bun", "bin", "openwright.exe"),
  ]) { try { unlinkSync(shim); } catch {} }
  console.log("openwright command removed.");
  if (!all) {
    console.log(`Everything else lives in ${ROOT} (workspaces, database, exports).`);
    console.log("Delete that folder to remove it all, or run: openwright uninstall --all");
    console.log("(bun and uv are shared tools and are left installed)");
    return;
  }
  // --all: delete the repo from a detached shell so this process can exit first.
  console.log(`Deleting ${ROOT} ...`);
  if (platform() === "win32") {
    Bun.spawn({ cmd: ["cmd", "/c", `ping -n 3 127.0.0.1 > /dev/null & rmdir /s /q "${ROOT}"`], stdout: "ignore", stderr: "ignore" }).unref();
  } else {
    Bun.spawn({ cmd: ["sh", "-c", `sleep 1 && rm -rf "${ROOT}"`], stdout: "ignore", stderr: "ignore" }).unref();
  }
  console.log("Gone. (bun and uv are shared tools and are left installed)");
}

function setup() {
  const cmd = platform() === "win32"
    ? ["powershell", "-ExecutionPolicy", "Bypass", "-File", join(ROOT, "setup.ps1")]
    : ["bash", join(ROOT, "setup.sh")];
  Bun.spawn({ cmd, cwd: ROOT, stdout: "inherit", stderr: "inherit", stdin: "inherit" });
}

const [cmd, ...args] = process.argv.slice(2);
switch (cmd) {
  case "start":   await start(args.includes("--foreground") || args.includes("-f"), args.includes("--no-open")); break;
  case "stop":    stop(); break;
  case "restart": stop(); await new Promise((r) => setTimeout(r, 500)); await start(false, true); break;
  case "status":  await status(); break;
  case "logs":    logs(Number(args[0]) || 60); break;
  case "open":    openBrowser(); break;
  case "update":  await update(); break;
  case "setup":   setup(); break;
  case "uninstall": await uninstall(args.includes("--all")); break;
  default:
    console.log(`openwright — BYOA work-artifact workspace

usage: openwright <command>

  start [-f]   start the server + open the browser (--no-open to skip)
  stop         stop the server
  restart      stop + start
  status       is it running?
  logs [n]     tail the server log
  open         open the app in your browser
  update       git pull + deps + restart if running
  setup        re-run the setup wizard
  uninstall    remove the CLI; --all deletes the whole install`);
}
