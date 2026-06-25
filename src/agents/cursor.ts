// ============================================================
// Cursor CLI adapter (cursor-agent).
//
// Runs `cursor-agent -p --output-format stream-json` as a subprocess and
// parses the NDJSON event stream. The system prompt travels via AGENTS.md
// (Cursor reads it as agent instructions for the workspace), written fresh
// before each run — same trick as the Codex adapter, and cross-platform
// safe (no giant argv).
//
// Auth: `cursor-agent login`, or CURSOR_API_KEY / --api-key.
// Headless: -p (print) gives the agent all tools incl. write/shell;
// --force auto-approves tool calls; --trust skips the workspace prompt.
//
// NOTE: the stream-json field names below are mapped to Cursor's
// documented event shape; confirm against a first authed run and tweak
// the handful of `ev.type` / field reads if Cursor changes them. Nothing
// else in the adapter depends on the exact schema.
// ============================================================
import { join } from "node:path";
import { homedir } from "node:os";
import { writeFileSync } from "node:fs";
import type { AgentAdapter, AgentRunOpts, AgentResult } from "./types";
import { resolveBin } from "./resolve-bin";

const CURSOR_BIN = resolveBin("cursor-agent", process.env.OPENWRIGHT_CURSOR_BIN);

function shortPath(p: string): string {
  return String(p || "").replace(homedir(), "~");
}

// Pre-auth fallback only — once logged in, listModels() returns the live
// account list. Cursor's --model accepts ids like these.
const FALLBACK_MODELS = ["auto", "composer-2.5-fast", "claude-opus-4-8-high", "claude-4.6-sonnet-medium", "gpt-5.5-medium"];

export const cursorAdapter: AgentAdapter = {
  id: "cursor",
  label: "Cursor CLI",

  async listModels() {
    try {
      const proc = Bun.spawn({ cmd: [CURSOR_BIN, "--list-models"], stdout: "pipe", stderr: "pipe" });
      if ((await proc.exited) !== 0) return FALLBACK_MODELS;
      const out = (await new Response(proc.stdout).text()).trim();
      // Each line is "<model-id> - <Display Name>" (e.g. "gpt-5.3-codex -
      // Codex 5.3"). Take the id before the " - " separator.
      const ids = out.split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => l.split(/\s+[-–—]\s+/)[0].trim())
        .filter((l) => /^[a-z0-9][\w.\-]+$/i.test(l));
      return ids.length ? ids : FALLBACK_MODELS;
    } catch {
      return FALLBACK_MODELS;
    }
  },

  async available() {
    try {
      const ver = Bun.spawn({ cmd: [CURSOR_BIN, "--version"], stdout: "pipe", stderr: "pipe" });
      if ((await ver.exited) !== 0) return { ok: false, detail: "cursor-agent errored — try `cursor-agent login`." };
      const verOut = (await new Response(ver.stdout).text()).trim().split("\n")[0];
      const st = Bun.spawn({ cmd: [CURSOR_BIN, "status"], stdout: "pipe", stderr: "pipe" });
      const stOk = (await st.exited) === 0;
      const stOut = (await new Response(st.stdout).text() + await new Response(st.stderr).text()).trim();
      const authed = stOk && !/not logged in|unauthenticated/i.test(stOut);
      if (!authed && !process.env.CURSOR_API_KEY) {
        return { ok: false, detail: "cursor-agent installed but not logged in — run `cursor-agent login` (or set CURSOR_API_KEY)." };
      }
      return { ok: true, detail: `cursor-agent ${verOut} · ${stOut.split("\n")[0] || "ready"}` };
    } catch {
      return { ok: false, detail: "cursor-agent not found — install from cursor.com/install, then `cursor-agent login`." };
    }
  },

  async run(opts: AgentRunOpts): Promise<AgentResult> {
    // System prompt rides AGENTS.md (Cursor reads it as project agent
    // instructions) — keeps the trigger prompt small and Windows-safe.
    writeFileSync(join(opts.cwd, "AGENTS.md"), opts.systemPrompt);

    const cmd = [
      CURSOR_BIN,
      "-p",                                 // headless / non-interactive
      "--output-format", "stream-json",     // NDJSON event stream
      "--force",                            // auto-approve tool calls (no prompts)
      "--trust",                            // trust the workspace (headless only)
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

    const onParentAbort = () => { try { proc.kill(); } catch { /* noop */ } };
    opts.abortSignal.addEventListener("abort", onParentAbort, { once: true });

    let lastText = "";
    const errParts: string[] = [];

    // Pull readable text + tool calls out of one NDJSON event. Defensive:
    // handles both Anthropic-style content blocks and flat text fields.
    const handleEvent = (raw: string) => {
      let ev: any;
      try { ev = JSON.parse(raw); } catch { return; }
      const t = ev.type;

      // Assistant turn — emit its text + surface tool_use blocks.
      if (t === "assistant" || t === "message") {
        const content = ev.message?.content ?? ev.content;
        if (Array.isArray(content)) {
          for (const blk of content) {
            if (blk?.type === "text" && blk.text?.trim()) {
              lastText = blk.text;
              opts.onEvent({ kind: "text", text: blk.text });
            } else if (blk?.type === "tool_use") {
              const name = blk.name || "tool";
              const arg = blk.input?.file_path || blk.input?.path || blk.input?.command || "";
              opts.onEvent({ kind: "tool", text: `[tool:${name}] ${String(arg).slice(0, 200)}` });
            }
          }
        } else {
          const text = ev.text ?? ev.message?.text;
          if (text?.trim()) { lastText = text; opts.onEvent({ kind: "text", text }); }
        }
        return;
      }

      // Standalone tool-call events (if Cursor emits them separately).
      if (t === "tool_call" || t === "tool_use") {
        const name = ev.name || ev.tool || "tool";
        const arg = ev.input?.file_path || ev.input?.path || ev.input?.command || ev.command || "";
        opts.onEvent({ kind: "tool", text: `[tool:${name}] ${String(arg).slice(0, 200)}` });
        return;
      }

      // Final result.
      if (t === "result") {
        const final = ev.result ?? ev.text ?? "";
        if (typeof final === "string" && final.trim()) lastText = final;
        if (ev.is_error || ev.subtype === "error") {
          const msg = (typeof final === "string" && final) || ev.error || raw.slice(0, 300);
          errParts.push(msg);
          opts.onEvent({ kind: "system", text: `cursor: ${msg}` });
        }
        return;
      }

      // Errors.
      if (t === "error") {
        const msg = ev.message || ev.error?.message || raw.slice(0, 300);
        errParts.push(msg);
        opts.onEvent({ kind: "system", text: `cursor: ${msg}` });
      }
      // system / init / user (tool results) → heartbeat only
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
      if (code !== 0 && !opts.abortSignal.aborted) {
        const detail = errParts.slice(-8).join("\n").slice(-400);
        if (/login|auth|401|unauthorized|api[_ -]?key/i.test(detail)) {
          throw new Error(`cursor auth failed — run \`cursor-agent login\` (or set CURSOR_API_KEY). ${detail}`);
        }
        throw new Error(`cursor-agent exited ${code}: ${detail || lastText.slice(-300)}`);
      }
    } finally {
      opts.abortSignal.removeEventListener("abort", onParentAbort);
    }
    return { finalText: lastText };
  },
};
