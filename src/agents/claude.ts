// ============================================================
// Claude adapter — wraps @anthropic-ai/claude-agent-sdk.
//
// Auth: ANTHROPIC_API_KEY in the environment, or a logged-in Claude
// Code install (`claude login`). Model via OPENPOD_CLAUDE_MODEL.
// ============================================================
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { AgentAdapter, AgentRunOpts, AgentResult } from "./types";
import { resolveBin } from "./resolve-bin";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_MODEL = process.env.OPENPOD_CLAUDE_MODEL || "claude-sonnet-4-6";
const MAX_TURNS = parseInt(process.env.OPENPOD_MAX_TURNS || "30", 10);

// Compact one-line summary of a tool invocation for the chat panel.
function summarizeToolInput(name: string, input: any): string {
  if (!input || typeof input !== "object") return "";
  const lc = name.toLowerCase();
  const home = homedir();
  const short = (p: any) => String(p || "").replace(home, "~");
  if (lc === "read" || lc === "write" || lc === "edit") return short(input.file_path || input.path);
  if (lc === "bash") return String(input.command || "").slice(0, 200);
  if (lc === "glob") return String(input.pattern || "");
  if (lc === "grep") return `${input.pattern || ""}${input.path ? " in " + short(input.path) : ""}`;
  for (const v of Object.values(input)) {
    if (typeof v === "string") return v.slice(0, 120);
  }
  return "";
}

export const claudeAdapter: AgentAdapter = {
  id: "claude",
  label: "Claude (Agent SDK)",
  async listModels() {
    // With an API key the models endpoint is authoritative; the
    // Claude Code OAuth path can't call it, so fall back to the
    // current generation of models.
    if (process.env.ANTHROPIC_API_KEY) {
      try {
        const r = await fetch("https://api.anthropic.com/v1/models?limit=50", {
          headers: { "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
        });
        if (r.ok) {
          const d: any = await r.json();
          const ids = (d.data || []).map((m: any) => m.id).filter(Boolean);
          if (ids.length) return ids;
        }
      } catch {}
    }
    return ["claude-fable-5", "claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5"];
  },

  async available() {
    if (process.env.ANTHROPIC_API_KEY) return { ok: true, detail: `API key set · ${DEFAULT_MODEL}` };
    // The SDK can also ride a logged-in Claude Code credential —
    // ~/.claude/.credentials.json on Linux, Keychain on macOS. A
    // resolvable claude binary is the practical signal for the latter.
    const credPath = join(homedir(), ".claude", ".credentials.json");
    try {
      if (await Bun.file(credPath).exists()) return { ok: true, detail: `Claude Code login · ${DEFAULT_MODEL}` };
    } catch {}
    const bin = resolveBin("claude");
    if (bin !== "claude" || Bun.which("claude")) {
      return { ok: true, detail: `Claude Code install · ${DEFAULT_MODEL}` };
    }
    return {
      ok: false,
      detail: "Set ANTHROPIC_API_KEY in .env, or install Claude Code and run `claude login`.",
    };
  },

  async run(opts: AgentRunOpts): Promise<AgentResult> {
    const abortCtl = new AbortController();
    const onParentAbort = () => { try { abortCtl.abort(); } catch {} };
    opts.abortSignal.addEventListener("abort", onParentAbort, { once: true });

    let lastText = "";
    try {
      const result = query({
        prompt: opts.prompt,
        options: {
          cwd: opts.cwd,
          systemPrompt: opts.systemPrompt,
          model: opts.model || DEFAULT_MODEL,
          maxTurns: MAX_TURNS,
          allowedTools: ["Read", "Glob", "Grep", "Bash", "Write", "Edit"],
          permissionMode: "bypassPermissions",
          abortController: abortCtl,
          // Partial deltas keep the idle watchdog fed while the model
          // composes a 30KB deck body inside a single Write call.
          includePartialMessages: true,
        } as any,
      });

      for await (const msg of result as any) {
        opts.onActivity();
        if (msg.type === "stream_event") continue; // heartbeat only
        if (msg.type === "assistant" && msg.message?.content) {
          for (const block of msg.message.content) {
            if (block.type === "text" && block.text?.trim()) {
              lastText = block.text;
              opts.onEvent({ kind: "text", text: block.text });
            } else if (block.type === "tool_use") {
              opts.onEvent({
                kind: "tool",
                text: `[tool:${block.name}] ${summarizeToolInput(block.name, block.input)}`,
              });
            }
          }
        }
      }
    } catch (e: any) {
      // Abort-driven exits are the caller's flow control, not errors.
      if (!opts.abortSignal.aborted && !abortCtl.signal.aborted) throw e;
    } finally {
      opts.abortSignal.removeEventListener("abort", onParentAbort);
    }
    return { finalText: lastText };
  },
};
