// Find an agent CLI even when the server's PATH is narrower than the
// user's login shell (launchd, cron, npm-prefix installs).
import { existsSync } from "node:fs";
import { join } from "node:path";

const HOME = process.env.HOME || "";

const EXTRA_DIRS = [
  join(HOME, ".local", "bin"),
  join(HOME, ".bun", "bin"),
  "/opt/homebrew/bin",
  "/usr/local/bin",
];

export function resolveBin(name: string, envOverride?: string): string {
  if (envOverride) return envOverride;
  const onPath = Bun.which(name);
  if (onPath) return onPath;
  for (const dir of EXTRA_DIRS) {
    const p = join(dir, name);
    if (existsSync(p)) return p;
  }
  // npm global prefix (node installs like ~/.local/share/node-vX/bin)
  try {
    const proc = Bun.spawnSync({ cmd: ["npm", "prefix", "-g"], stdout: "pipe", stderr: "pipe" });
    const prefix = new TextDecoder().decode(proc.stdout).trim();
    if (prefix) {
      const p = join(prefix, "bin", name);
      if (existsSync(p)) return p;
    }
  } catch {}
  return name; // let spawn fail with a clear ENOENT
}
