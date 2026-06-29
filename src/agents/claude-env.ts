// ============================================================
// Side-effect module: pin the Claude Agent SDK's output-token ceiling
// BEFORE the SDK is imported.
//
// The SDK reads CLAUDE_CODE_MAX_OUTPUT_TOKENS once, at import time — so
// raising it later (e.g. per run, once the model is known) never takes
// effect, and every run stays stuck at the SDK's 32K default. A deck/doc
// body is often written in a single tool call well past 32K tokens, so
// the run dies with "Claude's response exceeded the 32000 output token
// maximum."
//
// claude.ts imports THIS module before it imports the SDK, and ESM
// evaluates imports in order, depth-first — so this assignment lands
// before the SDK reads the env. 64000 is the safe extended-output max
// across the current Claude model line; ample for full single-file
// artifacts. An explicit value (shell env or .env, which Bun loads
// first) always wins.
// ============================================================
if (!process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS) {
  process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = "64000";
}
