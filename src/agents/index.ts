// Agent registry — add a new engine by writing an adapter and listing
// it here. Workspace rows store the id in agent_engine.
import type { AgentAdapter } from "./types";
import { claudeAdapter } from "./claude";
import { copilotAdapter } from "./copilot";
import { codexAdapter } from "./codex";

export const ADAPTERS: AgentAdapter[] = [claudeAdapter, copilotAdapter, codexAdapter];

export const DEFAULT_ENGINE = process.env.OPENWRIGHT_AGENT || "claude";

export function getAdapter(id?: string | null): AgentAdapter {
  const want = id || DEFAULT_ENGINE;
  return ADAPTERS.find((a) => a.id === want) || ADAPTERS[0]!;
}

export type { AgentAdapter, AgentEvent, AgentRunOpts, AgentResult } from "./types";
