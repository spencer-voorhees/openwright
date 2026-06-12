// ============================================================
// GitHub Copilot CLI adapter.
//
// Runs `copilot -p <prompt>` as a subprocess in the workspace
// directory. The system prompt travels via AGENTS.md (Copilot's
// custom-instructions file), written fresh before each run.
//
// Auth (any one of):
//   - run `copilot` once interactively and use /login
//   - COPILOT_GITHUB_TOKEN / GH_TOKEN / GITHUB_TOKEN env var holding a
//     FINE-GRAINED PAT with Copilot access (classic ghp_ tokens are
//     rejected by the CLI)
// Model via OPENPOD_COPILOT_MODEL (optional; defaults to Copilot's
// auto selection).
// ============================================================
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import type { AgentAdapter, AgentRunOpts, AgentResult } from "./types";
import { resolveBin } from "./resolve-bin";

const COPILOT_BIN = resolveBin("copilot", process.env.OPENPOD_COPILOT_BIN);
const COPILOT_MODEL = process.env.OPENPOD_COPILOT_MODEL || "";

// Classify a stdout line for the chat panel. Copilot's -p mode prints
// prose plus tool-activity lines; the markers below are tolerant — an
// unrecognized line is treated as prose.
function classifyLine(line: string): { kind: "text" | "tool" | "system"; text: string } | null {
  const t = line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd(); // strip stray ANSI
  if (!t.trim()) return null;
  // Tool/activity lines (✓/✗/● bullets, "Ran", "Created", "Edited"…)
  if (/^[✓✗•●▪◦]\s/.test(t) || /^\s*(Ran|Created|Edited|Read|Searched|Wrote)\b/.test(t)) {
    return { kind: "tool", text: `[copilot] ${t.trim()}` };
  }
  if (/^(Error|Warning):/i.test(t)) return { kind: "system", text: t.trim() };
  return { kind: "text", text: t };
}

export const copilotAdapter: AgentAdapter = {
  id: "copilot",
  label: "GitHub Copilot CLI",
  models: ["", "auto", "claude-sonnet-4.6", "gpt-5.2"],

  async available() {
    try {
      const proc = Bun.spawn({ cmd: [COPILOT_BIN, "--version"], stdout: "pipe", stderr: "pipe" });
      const code = await proc.exited;
      const out = (await new Response(proc.stdout).text()).trim();
      if (code !== 0) return { ok: false, detail: "copilot CLI errored — run `copilot` once to set up." };
      // Version works without auth; probe auth state cheaply via a
      // no-tool prompt with a short timeout? Too slow for a health
      // check — report the version and let the first run surface auth.
      return { ok: true, detail: out.split("\n")[0] || "installed" };
    } catch {
      return {
        ok: false,
        detail: "copilot CLI not found — `npm install -g @github/copilot`, then run `copilot` once and /login.",
      };
    }
  },

  async run(opts: AgentRunOpts): Promise<AgentResult> {
    // System prompt rides AGENTS.md — Copilot reads it as custom
    // instructions for every turn in this directory.
    writeFileSync(join(opts.cwd, "AGENTS.md"), opts.systemPrompt);

    const cmd = [
      COPILOT_BIN,
      "-p", opts.prompt,
      "--allow-all-tools",
      "--allow-all-paths",
      "--add-dir", opts.cwd,
      "--no-color",
      "--no-auto-update",
      "--log-level", "error",
    ];
    const model = opts.model || COPILOT_MODEL;
    if (model) cmd.push("--model", model);

    const proc = Bun.spawn({
      cmd,
      cwd: opts.cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env },
    });

    const onParentAbort = () => { try { proc.kill(); } catch {} };
    opts.abortSignal.addEventListener("abort", onParentAbort, { once: true });

    let lastText = "";
    const textParts: string[] = [];

    const consume = async (stream: ReadableStream, isErr: boolean) => {
      const reader = stream.getReader();
      const dec = new TextDecoder();
      let buf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        opts.onActivity();
        buf += dec.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() || "";
        for (const line of lines) {
          const ev = classifyLine(line);
          if (!ev) continue;
          if (isErr && ev.kind === "text") ev.kind = "system";
          if (ev.kind === "text") textParts.push(ev.text);
          opts.onEvent(ev);
        }
      }
      if (buf.trim()) {
        const ev = classifyLine(buf);
        if (ev) { if (ev.kind === "text") textParts.push(ev.text); opts.onEvent(ev); }
      }
    };

    try {
      await Promise.all([consume(proc.stdout, false), consume(proc.stderr, true)]);
      const code = await proc.exited;
      lastText = textParts.slice(-40).join("\n");
      if (code !== 0 && !opts.abortSignal.aborted) {
        // Surface auth failures clearly — they're the most common
        // first-run issue on a fresh machine.
        if (/authentication|login|token/i.test(lastText)) {
          throw new Error(`copilot auth failed — run \`copilot\` once and /login. Last output: ${lastText.slice(-300)}`);
        }
        throw new Error(`copilot exited ${code}: ${lastText.slice(-300)}`);
      }
    } finally {
      opts.abortSignal.removeEventListener("abort", onParentAbort);
    }
    return { finalText: lastText };
  },
};
