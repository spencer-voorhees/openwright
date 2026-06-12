// ============================================================
// OpenAI Codex CLI adapter.
//
// Runs `codex exec --json` as a subprocess and parses the JSONL
// event stream. The system prompt travels via AGENTS.md (Codex
// reads it as project instructions), written fresh before each run.
//
// Auth: `codex login` (ChatGPT account) or `codex login --api-key`.
// Sandbox: workspace-write — reads anywhere, writes confined to the
// workspace dir, no approval prompts in exec mode.
// ============================================================
import { join } from "node:path";
import { homedir } from "node:os";
import { writeFileSync, unlinkSync } from "node:fs";
import type { AgentAdapter, AgentRunOpts, AgentResult } from "./types";
import { resolveBin } from "./resolve-bin";

const CODEX_BIN = resolveBin("codex", process.env.OPENWRIGHT_CODEX_BIN);

function shortPath(p: string): string {
  const home = homedir();
  return String(p || "").replace(home, "~");
}

export const codexAdapter: AgentAdapter = {
  id: "codex",
  label: "OpenAI Codex CLI",
  async listModels() {
    // Codex caches the account's selectable models (the /model picker
    // source) at $CODEX_HOME/models_cache.json.
    try {
      const home = process.env.CODEX_HOME || join(homedir(), ".codex");
      const d: any = await Bun.file(join(home, "models_cache.json")).json();
      const slugs = (d.models || [])
        .filter((m: any) => m.visibility === "list")
        .map((m: any) => m.slug)
        .filter(Boolean);
      if (slugs.length) return slugs;
    } catch {}
    return ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini"];
  },

  async available() {
    try {
      const ver = Bun.spawn({ cmd: [CODEX_BIN, "--version"], stdout: "pipe", stderr: "pipe" });
      if ((await ver.exited) !== 0) return { ok: false, detail: "codex CLI errored — try `codex login`." };
      const verOut = (await new Response(ver.stdout).text()).trim();
      const auth = Bun.spawn({ cmd: [CODEX_BIN, "login", "status"], stdout: "pipe", stderr: "pipe" });
      const ok = (await auth.exited) === 0;
      const authOut = (await new Response(auth.stdout).text() + await new Response(auth.stderr).text()).trim();
      if (!ok || /not logged in/i.test(authOut)) {
        return { ok: false, detail: "codex installed but not logged in — run `codex login`." };
      }
      return { ok: true, detail: `${verOut} · ${authOut.split("\n")[0]}` };
    } catch {
      return { ok: false, detail: "codex CLI not found — `npm install -g @openai/codex`, then `codex login`." };
    }
  },

  async run(opts: AgentRunOpts): Promise<AgentResult> {
    // System prompt rides AGENTS.md — Codex treats it as project
    // instructions for the workspace directory.
    writeFileSync(join(opts.cwd, "AGENTS.md"), opts.systemPrompt);
    const lastMsgPath = join(opts.cwd, ".codex-last-message.txt");

    const cmd = [
      CODEX_BIN, "exec",
      "--json",
      "--color", "never",
      "--skip-git-repo-check",
      "--sandbox", "workspace-write",
      "-C", opts.cwd,
      "-o", lastMsgPath,
    ];
    if (opts.model) cmd.push("--model", opts.model);
    cmd.push(opts.prompt);

    const proc = Bun.spawn({
      cmd,
      cwd: opts.cwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env },
    });

    const onParentAbort = () => { try { proc.kill(); } catch {} };
    opts.abortSignal.addEventListener("abort", onParentAbort, { once: true });

    let lastText = "";
    const errParts: string[] = [];

    const handleEvent = (raw: string) => {
      let ev: any;
      try { ev = JSON.parse(raw); } catch { return; }
      const item = ev.item;
      if (ev.type === "item.completed" && item?.type === "agent_message" && item.text?.trim()) {
        lastText = item.text;
        opts.onEvent({ kind: "text", text: item.text });
      } else if (ev.type === "item.started" && item?.type === "command_execution") {
        opts.onEvent({ kind: "tool", text: `[tool:Bash] ${String(item.command || "").slice(0, 200)}` });
      } else if (ev.type === "item.started" && item?.type === "file_change") {
        const files = (item.changes || []).map((c: any) => `${c.kind} ${shortPath(c.path)}`).join(", ");
        opts.onEvent({ kind: "tool", text: `[tool:Edit] ${files.slice(0, 200)}` });
      } else if (ev.type === "error" || ev.type === "turn.failed") {
        const msg = ev.message || ev.error?.message || raw.slice(0, 300);
        errParts.push(msg);
        opts.onEvent({ kind: "system", text: `codex: ${msg}` });
      }
      // thread.started / turn.started / reasoning / item.updated — heartbeat only
    };

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
          if (!line.trim()) continue;
          if (isErr) { errParts.push(line.trim()); continue; }
          handleEvent(line);
        }
      }
      if (buf.trim() && !isErr) handleEvent(buf);
    };

    try {
      await Promise.all([consume(proc.stdout, false), consume(proc.stderr, true)]);
      const code = await proc.exited;
      // -o file holds the verbatim final message — prefer it.
      try {
        const final = (await Bun.file(lastMsgPath).text()).trim();
        if (final) lastText = final;
      } catch {}
      if (code !== 0 && !opts.abortSignal.aborted) {
        const detail = errParts.slice(-8).join("\n").slice(-400);
        if (/login|auth|401|unauthorized/i.test(detail)) {
          throw new Error(`codex auth failed — run \`codex login\`. ${detail}`);
        }
        throw new Error(`codex exited ${code}: ${detail || lastText.slice(-300)}`);
      }
    } finally {
      opts.abortSignal.removeEventListener("abort", onParentAbort);
      try { unlinkSync(lastMsgPath); } catch {}
    }
    return { finalText: lastText };
  },
};
