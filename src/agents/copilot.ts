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
// Model via OPENWRIGHT_COPILOT_MODEL (optional; defaults to Copilot's
// auto selection).
// ============================================================
import { join } from "node:path";
import { writeFileSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import type { AgentAdapter, AgentRunOpts, AgentResult } from "./types";
import { resolveBin } from "./resolve-bin";

const COPILOT_BIN = resolveBin("copilot", process.env.OPENWRIGHT_COPILOT_BIN);
const COPILOT_MODEL = process.env.OPENWRIGHT_COPILOT_MODEL || "";

// Classify copilot's stdout for the chat panel. The CLI draws each
// tool action as a small tree:
//     ● Read deck-v6.html
//     │ artifacts/untitled/deck-v6.html
//     └ 80 lines read
// Emitting those as three separate lines rendered as broken prose —
// the classifier is stateful and coalesces a tree into ONE tool
// event in the app's [tool:Verb] format.
type Ev = { kind: "text" | "tool" | "system"; text: string };
export function makeClassifier(emit: (ev: Ev) => void) {
  let pending: { verb: string; rest: string; result: string } | null = null;
  const flush = () => {
    if (!pending) return;
    const tail = pending.result ? ` · ${pending.result}` : "";
    emit({ kind: "tool", text: `[tool:${pending.verb}] ${pending.rest}${tail}`.trim() });
    pending = null;
  };
  const line = (raw: string) => {
    const t = raw.replace(/\x1b\[[0-9;]*m/g, "").trimEnd();
    if (!t.trim()) return;
    const header = t.match(/^\s*[✓✗•●▪◦]\s+(\S+)\s*(.*)$/) || t.match(/^\s*(Ran|Created|Edited|Read|Searched|Wrote)\b\s*(.*)$/);
    if (header) {
      flush();
      pending = { verb: header[1]!, rest: header[2] || "", result: "" };
      return;
    }
    if (/^\s*[│├|]/.test(t)) {
      // path/detail continuation — the header already names the file
      return;
    }
    const result = t.match(/^\s*[└╰]\s*(.*)$/);
    if (result) {
      if (pending) { pending.result = result[1] || ""; flush(); }
      return;
    }
    flush();
    if (/^(Error|Warning):/i.test(t)) emit({ kind: "system", text: t.trim() });
    else emit({ kind: "text", text: t });
  };
  return { line, flush };
}

function copilotUser(): string | null {
  try {
    const dir = join(homedir(), ".copilot");
    for (const f of ["config.json", "settings.json", "auth.json", "hosts.json", "user.json"]) {
      try {
        const d = JSON.parse(readFileSync(join(dir, f), "utf-8").replace(/^\s*\/\/.*$/gm, ""));
        const flat = JSON.stringify(d);
        const m = flat.match(/"(?:login|user(?:name)?|github_login|gh_user)"\s*:\s*"([A-Za-z0-9-]{1,40})"/);
        if (m) return m[1]!;
      } catch {}
    }
  } catch {}
  return null;
}

export const copilotAdapter: AgentAdapter = {
  id: "copilot",
  label: "GitHub Copilot CLI",
  async listModels() {
    // `copilot help config` enumerates the valid `model` values — the
    // same list the interactive /model picker shows.
    try {
      const proc = Bun.spawn({ cmd: [COPILOT_BIN, "help", "config"], stdout: "pipe", stderr: "pipe" });
      await proc.exited;
      const out = await new Response(proc.stdout).text();
      const block = out.split(/`model`:/)[1]?.split(/\n\s*\n/)[0] || "";
      const models = [...block.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
      if (models.length) return ["auto", ...models];
    } catch {}
    return ["auto"];
  },

  async available() {
    try {
      const proc = Bun.spawn({ cmd: [COPILOT_BIN, "--version"], stdout: "pipe", stderr: "pipe" });
      const code = await proc.exited;
      const out = (await new Response(proc.stdout).text()).trim();
      if (code !== 0) return { ok: false, detail: "copilot CLI errored — run `copilot` once to set up." };
      // Version works without auth; probe auth state cheaply via a
      // no-tool prompt with a short timeout? Too slow for a health
      // check — report the version and let the first run surface auth.
      const hasToken = !!(process.env.COPILOT_GITHUB_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_TOKEN);
      return {
        ok: true,
        detail: (out.split("\n")[0] || "installed") + (hasToken ? " · token set" : " · auth unknown, verify in Settings"),
      };
    } catch {
      return {
        ok: false,
        detail: "copilot CLI not found — `npm install -g @github/copilot`, then run `copilot` once and /login.",
      };
    }
  },

  async verifyAuth() {
    // The CLI has no status command; a minimal prompt round-trip is
    // the only authoritative check. Unauthenticated fails fast;
    // authenticated costs one tiny request.
    const { tmpdir } = await import("node:os");
    const proc = Bun.spawn({
      cmd: [COPILOT_BIN, "-p", "Reply with exactly: OK", "--allow-all-tools", "--no-color", "--no-auto-update", "--log-level", "error"],
      cwd: tmpdir(),
      stdout: "pipe", stderr: "pipe",
      env: { ...process.env },
    });
    const killer = setTimeout(() => { try { proc.kill(); } catch {} }, 90_000);
    const out = (await new Response(proc.stdout).text()) + (await new Response(proc.stderr).text());
    clearTimeout(killer);
    if (/no authentication information|not authenticated|please log ?in/i.test(out)) {
      return { ok: false, detail: "not signed in. Run 'copilot login' in a terminal" };
    }
    if (/\bOK\b/.test(out)) {
      const user = copilotUser();
      return { ok: true, detail: user ? `signed in as ${user}` : "signed in, Copilot responded" };
    }
    return { ok: false, detail: `unexpected reply: ${out.trim().slice(-160) || "(no output)"}` };
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
    let authError = false;
    const textParts: string[] = [];

    const consume = async (stream: ReadableStream, isErr: boolean) => {
      const cls = makeClassifier((ev) => {
        if (isErr && ev.kind === "text") ev.kind = "system";
        if (ev.kind === "text") textParts.push(ev.text);
        if (/no authentication|not authenticated/i.test(ev.text)) authError = true;
        opts.onEvent(ev);
      });
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
        for (const line of lines) cls.line(line);
      }
      if (buf.trim()) cls.line(buf);
      cls.flush();
    };

    try {
      await Promise.all([consume(proc.stdout, false), consume(proc.stderr, true)]);
      const code = await proc.exited;
      lastText = textParts.slice(-40).join("\n");
      // The CLI exits 0 on auth failure — catch it by message.
      if (authError && !opts.abortSignal.aborted) {
        throw new Error("copilot is not authenticated — run `copilot` once and /login, or set COPILOT_GITHUB_TOKEN (fine-grained PAT with Copilot permission).");
      }
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
