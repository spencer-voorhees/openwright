// Kill a spawned process AND its descendants.
//
// A plain proc.kill() signals only the direct child. Some agent CLIs
// (notably cursor-agent) spawn their own worker/daemon processes that
// outlive the parent, so a stop leaves the real work running. This walks
// the tree and kills every descendant, then the process itself.
export function killProcessTree(pid: number | undefined | null): void {
  if (!pid || pid <= 1) return;

  if (process.platform === "win32") {
    // taskkill /T terminates the whole tree; /F forces it.
    try {
      Bun.spawnSync({ cmd: ["taskkill", "/PID", String(pid), "/T", "/F"], stdout: "ignore", stderr: "ignore" });
    } catch { /* noop */ }
    return;
  }

  // Unix: kill children depth-first (so a parent can't re-parent them to
  // init before we reach them), then the process itself.
  let kids: number[] = [];
  try {
    const out = Bun.spawnSync({ cmd: ["pgrep", "-P", String(pid)], stdout: "pipe", stderr: "ignore" });
    kids = new TextDecoder().decode(out.stdout)
      .split("\n").map((s) => parseInt(s.trim(), 10)).filter((n) => n > 0);
  } catch { /* pgrep missing — fall through to killing just the parent */ }

  for (const kid of kids) killProcessTree(kid);
  try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
}
