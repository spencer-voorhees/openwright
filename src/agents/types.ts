// ============================================================
// openwright — agent adapter contract
//
// The whole BYOA story lives behind this interface. An adapter is a
// single agent RUN: prompt in, files on disk out, progress events
// streamed for the chat panel. The outer loop (ASK:/DONE: markers,
// retries, restarts, watchdogs, comment triggers) is engine-agnostic
// and lives in agent.ts — adapters never see it.
// ============================================================

export interface AgentEvent {
  // 'text'   — assistant prose (markdown ok) for the chat panel
  // 'tool'   — one-line tool-call summary ("[tool:Edit] deck-v2.html")
  // 'system' — adapter lifecycle notes ("session started", model id…)
  kind: "text" | "tool" | "system";
  text: string;
}

export interface AgentRunOpts {
  prompt: string;        // the trigger message for this run
  systemPrompt: string;  // openwright's full deck-building instructions
  cwd: string;           // the workspace directory — the agent's world
  model?: string;        // per-workspace override; "" = engine default
  abortSignal: AbortSignal;
  onEvent: (e: AgentEvent) => void;
  // Watchdog heartbeat — adapters call this on ANY underlying
  // activity (even events not worth showing) so the idle reaper
  // knows the engine is alive.
  onActivity: () => void;
}

export interface AgentResult {
  finalText: string;     // the agent's last prose message ("DONE: …")
}

export interface AgentAdapter {
  id: string;            // 'claude' | 'copilot' | 'codex' | …
  label: string;
  // Models the engine can actually run right now, probed from the
  // CLI/API where possible. "" is implied as "engine default" by the
  // UI and is not part of this list.
  listModels(): Promise<string[]>;
  // Cheap preflight: is this engine usable on this machine right now?
  // Returns a human-readable detail either way (version, or what to
  // install / how to log in).
  available(): Promise<{ ok: boolean; detail: string }>;
  // Optional deep check for engines whose CLI has no auth-status
  // command (copilot): does a real round-trip, so it's on-demand
  // only, never part of routine probing.
  verifyAuth?(): Promise<{ ok: boolean; detail: string }>;
  run(opts: AgentRunOpts): Promise<AgentResult>;
}
