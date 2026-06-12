// ============================================================
// openwright — generation engine (BYOA).
//
// The outer loop here is engine-agnostic: trigger prompts, ASK:/DONE:
// markers, idle watchdogs with auto-recovery, user stop, comment
// triggers, version pinning, design-system snapshots. The actual
// model run is delegated to an AgentAdapter (Claude SDK, Copilot CLI,
// …) selected per workspace.
// ============================================================
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { db } from "./db";
import { getAdapter, type AgentEvent } from "./agents/index";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const WORKSPACE_ROOT = process.env.OPENWRIGHT_WORKSPACES || join(REPO_ROOT, "workspaces");
export const HTML_ENGINE_DIR = join(REPO_ROOT, "html-engine");

const AGENT_IDLE_TIMEOUT_MS = parseInt(process.env.OPENWRIGHT_IDLE_TIMEOUT_MS || `${10 * 60_000}`, 10);
const AGENT_LOOP_TIMEOUT_MS = parseInt(process.env.OPENWRIGHT_LOOP_TIMEOUT_MS || `${30 * 60_000}`, 10);

function appendMessage(gen_id: number, role: "agent" | "user", content: string): number {
  const r = db.run("INSERT INTO messages(generation_id, role, content, ts) VALUES(?, ?, ?, ?)",
    [gen_id, role, content, Date.now()]) as any;
  return Number(r.lastInsertRowid);
}

function setStatus(gen_id: number, status: string, extra: Record<string, any> = {}) {
  const keys = Object.keys(extra);
  const sets = ["status = ?", ...keys.map((k) => `${k} = ?`)].join(", ");
  db.run(`UPDATE generations SET ${sets} WHERE id = ?`, [status, ...keys.map((k) => extra[k]), gen_id]);
  if (status === "done") markCommentsAddressed(gen_id);
}

// Open comments that existed when a generation started were folded
// into its trigger as requirements — when the run completes, flip
// them to 'addressed' so the user reviews and accepts or reopens.
function markCommentsAddressed(gen_id: number) {
  const g = db.query("SELECT artifact_id, started_at FROM generations WHERE id = ?").get(gen_id) as any;
  if (!g?.artifact_id || !g.started_at) return;
  db.run(`UPDATE comments SET status = 'addressed', resolved_by_gen_id = ?
          WHERE artifact_id = ? AND status = 'open' AND created_at <= ?`,
    [gen_id, g.artifact_id, g.started_at]);
}

const pendingReply = new Map<number, (text: string) => void>();
export function postUserReply(gen_id: number, content: string) {
  const resolve = pendingReply.get(gen_id);
  if (resolve) { pendingReply.delete(gen_id); resolve(content); }
  return Promise.resolve();
}

// Mid-run steering is engine-specific (the Claude SDK supports it,
// subprocess CLIs don't) — openwright keeps the endpoint but records the
// note for the NEXT loop iteration instead of injecting mid-turn.
const steerNotes = new Map<number, string[]>();
export function postSteer(gen_id: number, content: string) {
  const list = steerNotes.get(gen_id) || [];
  list.push(content);
  steerNotes.set(gen_id, list);
  appendMessage(gen_id, "user", content);
  appendMessage(gen_id, "agent",
    "[noted] Steering lands at the agent's next checkpoint; engines without live injection can't take mid-turn input.");
  return Promise.resolve();
}

const activeAborts = new Map<number, AbortController>();
const stopRequests = new Set<number>();
export function stopGeneration(gen_id: number): boolean {
  const known = activeAborts.has(gen_id) || pendingReply.has(gen_id);
  stopRequests.add(gen_id);
  const ctl = activeAborts.get(gen_id);
  if (ctl) { try { ctl.abort(); } catch {} }
  const resolve = pendingReply.get(gen_id);
  if (resolve) { pendingReply.delete(gen_id); resolve(""); }
  return known;
}

export function reapStrandedGenerations(): number {
  const rows = db.query(
    `SELECT id FROM generations WHERE status IN ('queued','running','awaiting_user')`
  ).all() as any[];
  for (const r of rows) {
    setStatus(r.id, "errored", { error: "stranded by server restart", completed_at: Date.now() });
  }
  return rows.length;
}

function dsSwitchNotice(ws: any, priorArtifactPath: string | null): string | null {
  if (!priorArtifactPath || !priorArtifactPath.endsWith(".html") || !existsSync(priorArtifactPath)) return null;
  try {
    const html = readFileSync(priorArtifactPath, "utf-8");
    const m = html.match(/\/api\/design-systems\/(\d+)\/css\.css/);
    const priorId = m ? Number(m[1]) : null;
    const curId = ws.design_system_id || null;
    if (priorId === curId) return null;
    const ds = curId ? (db.query("SELECT name FROM design_systems WHERE id = ?").get(curId) as any) : null;
    if (!ds) return null;
    return [
      `DESIGN SYSTEM CHANGED: this workspace now uses "${ds.name}", but the prior deck was authored against a different system.`,
      `Restyle, don't inherit: point the <link> at /api/design-systems/${curId}/css.css, read the new system's snapshot (.design-system.css in the workspace) FIRST, and rewrite the deck's layout CSS and component class usage to the new system's tokens and conventions.`,
      `Carry over the CONTENT (slides, copy, data, structure) — none of the prior styling.`,
    ].join("\n");
  } catch { return null; }
}

function buildContinuationContext(artifact_id: number, current_gen_id: number, ws: any): string | null {
  const prior = db.query(
    `SELECT * FROM generations WHERE artifact_id = ? AND id < ? AND status = 'done'
     ORDER BY id DESC LIMIT 1`).get(artifact_id, current_gen_id) as any;
  if (!prior) return null;
  const lastAgentMsg = db.query(
    `SELECT content FROM messages WHERE generation_id = ? AND role = 'agent'
       AND content NOT LIKE '[tool:%' AND content NOT LIKE '[copilot]%' AND content NOT LIKE '[noted]%'
     ORDER BY id DESC LIMIT 1`).get(prior.id) as any;
  const lines: string[] = [];
  lines.push(`Prior generation: run #${prior.id}, v${prior.artifact_version || prior.id}`);
  if (prior.prompt) lines.push(`Prior user prompt: ${prior.prompt}`);
  if (prior.engine) lines.push(`Prior run engine: ${prior.engine}${prior.model ? ` (${prior.model})` : ""} — possibly a different agent than you; trust the files on disk over assumptions about prior behavior.`);
  if (prior.artifact_path) lines.push(`Prior artifact: ${prior.artifact_path}`);
  if (lastAgentMsg?.content) lines.push(`Prior agent summary: ${String(lastAgentMsg.content).slice(0, 600)}`);
  const notice = dsSwitchNotice(ws, prior.artifact_path || null);
  if (notice) lines.push("", notice);
  return lines.join("\n");
}

const PERSONA_GUIDANCE: Record<string, string> = {
  "terse-technical":
    "Voice: terse and technical. Audience already knows the domain — no hand-holding, no marketing language. Dense slides are fine. Prefer exact numbers, file names, command names. Bullets over prose.",
  "executive":
    "Voice: executive briefing. Audience is decision-makers who will read 30 seconds of a slide max. Every slide answers 'so what'. Lead with the recommendation or headline number; one supporting line of context underneath. Crisp, opinionated, decision-oriented.",
  "detailed":
    "Voice: thorough and explanatory. Audience needs full context — include methodology, caveats, alternatives considered, edge cases. Tables and structured comparisons are encouraged.",
  "mixed-audience":
    "Voice: layered. Headline + supporting bullets read top-down — exec gets the gist from the first 2 lines, practitioner gets the detail below. Avoid jargon in the headline; allow it in the bullets.",
};

function buildSystemPrompt(ws: any, files: any[], userPrompt?: string, artifact?: any): string {
  const fileList = files.map((f) =>
    `  - ${f.name} (${f.mimetype || "unknown"}, ${f.size ?? "?"} bytes) @ ${f.path}`
  ).join("\n");
  const artifactName = artifact?.name || "Untitled";
  const artifactSlug = artifact?.slug || "untitled";
  const ds = ws.design_system_id
    ? (db.query("SELECT * FROM design_systems WHERE id = ?").get(ws.design_system_id) as any)
    : (db.query("SELECT * FROM design_systems WHERE slug = ?").get(ws.theme || "oneshot") as any);
  const dsLabel = ds?.name || "Oneshot";
  const dsCssUrl = ds ? `/api/design-systems/${ds.id}/css.css` : "";
  const dsCssPath = join(WORKSPACE_ROOT, ws.slug, ".design-system.css");
  if (ds?.css) { try { writeFileSync(dsCssPath, ds.css); } catch {} }
  const persona = ws.persona || "terse-technical";
  const personaGuidance = PERSONA_GUIDANCE[persona] || PERSONA_GUIDANCE["terse-technical"];
  return `You are openwright, an agent whose only job is to turn a workspace of mixed-format
files into a slide deck.

You write the deck as a SINGLE HTML FILE that openwright renders live in an
iframe (no build step). The same source ships to PDF (chromium print) and
to editable PPTX (DOM-walking exporter) — so HTML/CSS is the source of
truth; what you write is what the user sees.

Host OS: ${process.platform === "win32" ? "Windows — use Windows-style paths (C:\\...) and PowerShell/cmd-compatible commands" : process.platform === "darwin" ? "macOS (POSIX paths and shell)" : "Linux (POSIX paths and shell)"}
Workspace: "${ws.name}" (slug ${ws.slug})
Workspace directory: ${join(WORKSPACE_ROOT, ws.slug)}
Artifact for this run: "${artifactName}" — outputs go in artifacts/${artifactSlug}/.
Design system: "${dsLabel}"
Files available:
${fileList || "  (no files)"}

# The deck shell

Reference the openwright-provided deck shell + this workspace's design-
system CSS at the top of your file:

    <link rel="stylesheet" href="${dsCssUrl}">
    <script defer src="/html-engine/deck-shell.js"></script>

Then wrap your slides in <deck-stage width="1920" height="1080">…</deck-stage>.
Each direct <section> child is one slide. The shell handles slide nav,
keyboard shortcuts (←/→/F), and scaling to viewport. Authored size is
1920×1080 — design at that scale; the shell scales to fit.

Icons: write <i data-lucide="icon-name"></i> placeholders (lucide.dev
names). The shell auto-loads a vendored lucide build and swaps them to
inline SVG — do NOT add your own CDN <script> or hand-rolled icon
engine. Size/color via CSS targeting svg.lucide (stroke uses
currentColor).

# Read the example deck for structure + idiom

    ${join(HTML_ENGINE_DIR, "examples", "sample.html")}

It uses CSS variables — DO NOT hardcode colors or font sizes. Use the
variables so the design-system picker keeps working across themes.

# Design system tokens in scope

A snapshot of this workspace's design-system CSS is on disk at:

    ${dsCssPath}

READ THAT FILE FIRST — before writing any deck CSS. It defines the
tokens, component classes, and (for some systems) hard constraints on
what you may use. Do NOT substitute another theme's CSS: the <link>
above is what actually renders, and decks authored against a different
system's tokens/classes come out broken. The live URL ${dsCssUrl} is
for the BROWSER, not for you — read the snapshot path. Common tokens:
  --fg, --fg-muted, --bg, --bg-soft, --accent, --border
  --type-display, --type-title, --type-h2, --type-h3, --type-body, --type-small
  --r-sm, --r-md, --r-lg, --r-xl

If the user asks you to create or alter a DESIGN SYSTEM (not a deck),
start from the Oneshot CSS and retheme its tokens (colors, fonts,
radii) — never restructure its component/layout rules. Oneshot is the
export-lossless baseline; derivatives that keep its structure stay
portable to PPTX/PDF.

# Voice

${personaGuidance}

# Workflow

1. List the workspace files. Read the ones that matter.
2. Look at the example deck for slide layout idioms.
3. If anything material is unclear, emit "ASK: …" on its own line and stop.
4. Otherwise, write the deck to artifacts/${artifactSlug}/deck-vN.html. N is
   the next available integer above existing files. Pin to the version
   the runner tells you to use in the trigger message.
5. Final message starts with "DONE:" + 1-sentence summary.`;
}

function inferVersion(name: string): number {
  const m = name.match(/-v(\d+)\./);
  return m ? parseInt(m[1]!, 10) : 0;
}

function findLatestArtifact(dir: string): { name: string; path: string } | null {
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((f) => /^deck-v\d+\.html$/i.test(f));
  if (!files.length) return null;
  files.sort((a, b) => inferVersion(b) - inferVersion(a));
  return { name: files[0]!, path: join(dir, files[0]!) };
}

const ASK_PREFIXES = ["ASK:", "Q:", "QUESTION:"];
function extractAsk(text: string): string | null {
  const t = text.trim();
  const upper = t.toUpperCase();
  for (const p of ASK_PREFIXES) {
    if (upper.startsWith(p)) return t.slice(p.length).trim();
  }
  return null;
}

async function runAgentLoop(gen_id: number, workspace_id: number, sys: string, trigger: string,
                            wsDir: string, specDir: string): Promise<{ path: string; version: number } | null> {
  // Engine + model are re-resolved from the workspace EVERY iteration:
  // each iteration is a fresh adapter session anyway (continuity lives
  // on disk), so a user who swaps engines mid-run — even while a
  // question is pending — gets the new engine on the next turn.
  let adapter = getAdapter((db.query("SELECT agent_engine FROM workspaces WHERE id = ?").get(workspace_id) as any)?.agent_engine);
  let nextPrompt: string | null = trigger;
  let attempts = 0;
  let idleRetries = 0;
  let lastAgentMessage = "";

  while (nextPrompt && attempts < 4) {
    if (stopRequests.has(gen_id)) { stopRequests.delete(gen_id); throw new Error("stopped by user"); }
    attempts++;

    const notes = steerNotes.get(gen_id);
    if (notes?.length) {
      // A user often answers the agent's question by repeating their
      // queued steer — don't feed the agent the same text twice.
      const fresh = notes.filter((n) => !nextPrompt!.includes(n));
      if (fresh.length) {
        nextPrompt += "\n\nUser steering notes (added mid-run — treat as requirements):\n" +
          fresh.map((n) => `- ${n}`).join("\n");
      }
      steerNotes.delete(gen_id);
    }

    const wsNow = db.query("SELECT agent_engine, agent_model FROM workspaces WHERE id = ?").get(workspace_id) as any;
    const nowAdapter = getAdapter(wsNow?.agent_engine);
    if (nowAdapter.id !== adapter.id) {
      appendMessage(gen_id, "agent", `[engine switched] continuing with ${nowAdapter.label}`);
    }
    adapter = nowAdapter;
    const model = wsNow?.agent_model || "";
    db.run("UPDATE generations SET engine = ?, model = ? WHERE id = ?", [adapter.id, model || null, gen_id]);

    const abortCtl = new AbortController();
    activeAborts.set(gen_id, abortCtl);
    let askContent: string | null = null;
    let hangReason: string | null = null;
    let lastEventAt = Date.now();

    const wallTimer = setTimeout(() => {
      hangReason = `agent loop wall-clock timeout (${AGENT_LOOP_TIMEOUT_MS / 60_000}m)`;
      try { abortCtl.abort(); } catch {}
    }, AGENT_LOOP_TIMEOUT_MS);
    const idleTimer = setInterval(() => {
      if (Date.now() - lastEventAt > AGENT_IDLE_TIMEOUT_MS) {
        hangReason = `agent idle timeout (no engine activity in ${AGENT_IDLE_TIMEOUT_MS / 60_000}m)`;
        try { abortCtl.abort(); } catch {}
        clearInterval(idleTimer);
      }
    }, 30_000);

    const onEvent = (e: AgentEvent) => {
      lastEventAt = Date.now();
      if (e.kind === "text") {
        lastAgentMessage = e.text;
        const ask = extractAsk(e.text);
        if (ask) { askContent = ask; try { abortCtl.abort(); } catch {} return; }
        appendMessage(gen_id, "agent", e.text);
      } else {
        appendMessage(gen_id, "agent", e.text);
      }
    };

    try {
      await adapter.run({
        prompt: nextPrompt,
        systemPrompt: sys,
        cwd: wsDir,
        model: model || undefined,
        abortSignal: abortCtl.signal,
        onEvent,
        onActivity: () => { lastEventAt = Date.now(); },
      });
    } catch (e: any) {
      if (!hangReason && !askContent && !stopRequests.has(gen_id) && !abortCtl.signal.aborted) throw e;
    } finally {
      clearTimeout(wallTimer);
      clearInterval(idleTimer);
      activeAborts.delete(gen_id);
    }

    if (stopRequests.has(gen_id)) { stopRequests.delete(gen_id); throw new Error("stopped by user"); }

    if (hangReason && hangReason.includes("idle timeout") && idleRetries < 2) {
      idleRetries++;
      appendMessage(gen_id, "agent",
        `[recovering] engine stalled (${hangReason}) — restarting, attempt ${idleRetries}/2. Progress on disk is preserved.`);
      nextPrompt =
        "Your previous session stalled mid-run and was restarted. Any files you already " +
        "wrote or edited are intact on disk — check artifacts/ for the partially-built " +
        "deck before redoing work. Pick up where you left off, finish the remaining " +
        "work, and end with \"DONE:\" as usual.";
      attempts--;
      continue;
    }
    if (hangReason) throw new Error(hangReason);

    if (!askContent) {
      const artifact = findLatestArtifact(specDir);
      if (!artifact && lastAgentMessage && lastAgentMessage.trim().endsWith("?")) {
        askContent = lastAgentMessage.trim();
      }
    }

    if (askContent) {
      setStatus(gen_id, "awaiting_user");
      appendMessage(gen_id, "agent", askContent);
      const userText = await new Promise<string>((resolve) => { pendingReply.set(gen_id, resolve); });
      if (stopRequests.has(gen_id)) { stopRequests.delete(gen_id); throw new Error("stopped by user"); }
      if (userText.trim()) appendMessage(gen_id, "user", userText);
      setStatus(gen_id, "running");
      nextPrompt = `User replied: ${userText}\nContinue.`;
      continue;
    }

    break;
  }

  const artifact = findLatestArtifact(specDir);
  if (!artifact) return null;
  return { path: artifact.path, version: inferVersion(artifact.name) };
}

export async function startGeneration(gen_id: number, opts: { fresh?: boolean } = {}): Promise<void> {
  const g = db.query("SELECT * FROM generations WHERE id = ?").get(gen_id) as any;
  if (!g) return;
  const ws = db.query("SELECT * FROM workspaces WHERE id = ?").get(g.workspace_id) as any;
  if (!ws) { setStatus(gen_id, "errored", { error: "workspace gone" }); return; }
  const files = db.query("SELECT * FROM files WHERE workspace_id = ?").all(ws.id) as any[];
  const fresh = !!opts.fresh;
  const engineId = ws.agent_engine || "";
  const adapter = getAdapter(engineId);

  let artifact = g.artifact_id
    ? (db.query("SELECT * FROM artifacts WHERE id = ?").get(g.artifact_id) as any)
    : null;
  if (!artifact) {
    artifact = db.query("SELECT * FROM artifacts WHERE workspace_id = ? ORDER BY id ASC LIMIT 1").get(ws.id) as any;
    if (!artifact) {
      const ins = db.run("INSERT INTO artifacts(workspace_id, name, slug, created_at) VALUES(?, ?, ?, ?)",
        [ws.id, "Untitled", "untitled", Date.now()]) as any;
      artifact = db.query("SELECT * FROM artifacts WHERE id = ?").get(Number(ins.lastInsertRowid));
    }
    db.run("UPDATE generations SET artifact_id = ? WHERE id = ?", [artifact.id, gen_id]);
  }

  const priorContext = fresh ? null : buildContinuationContext(artifact.id, gen_id, ws);

  setStatus(gen_id, "running", { started_at: Date.now() });
  if (g.prompt) appendMessage(gen_id, "user", g.prompt);
  appendMessage(gen_id, "agent",
    `Reading ${files.length} file${files.length === 1 ? "" : "s"} from workspace "${ws.name}", artifact "${artifact.name}"… (engine: ${adapter.label}${priorContext ? ", continuing from prior run" : ""})`);

  const wsDir = join(WORKSPACE_ROOT, ws.slug);
  const specDir = join(wsDir, "artifacts", artifact.slug);
  mkdirSync(specDir, { recursive: true });

  const sys = buildSystemPrompt(ws, files, g.prompt, artifact);

  const triggerHead = priorContext
    ? `You are continuing an existing deck for this workspace, not starting from scratch. Build on prior work:\n\n${priorContext}\n\n---\n\nNow:\n`
    : "";
  const maxByArtifact = (db.query(
    "SELECT MAX(artifact_version) AS m FROM generations WHERE artifact_id = ? AND artifact_version IS NOT NULL"
  ).get(artifact.id) as any)?.m as (number | null);
  const nextVersion = (maxByArtifact || 0) + 1;
  const artifactDirRel = `./artifacts/${artifact.slug}`;
  const versionPin = `Write the deck to ${artifactDirRel}/deck-v${nextVersion}.html. The HTML IS the deliverable — no separate build step. openwright renders it live in an iframe + exports to PDF / PPTX from the same source. v${nextVersion} is the next available integer above all existing files in ${artifactDirRel}/.`;

  const openComments = db.query(
    `SELECT id, slide_index, body, created_at
     FROM comments WHERE artifact_id = ? AND status = 'open'
     ORDER BY slide_index IS NULL, slide_index, created_at`
  ).all(artifact.id) as any[];
  const commentsBlock = openComments.length
    ? "\n\n# Outstanding comments to address\n\nThe user left specific comments on the prior version. Each one names a slide and a directive. Address every comment in this build. If a comment is no longer applicable (the slide changed structurally), explain why in your final summary. Do NOT silently skip them.\n\n" +
      openComments.map((c: any) => {
        const where = (typeof c.slide_index === "number") ? `Slide ${c.slide_index + 1}` : "Deck-level";
        return `- [${where}] ${c.body}`;
      }).join("\n")
    : "";

  const trigger = `${triggerHead}Author a deck for this workspace. ${
    g.prompt ? "User prompt: " + g.prompt : (priorContext ? "No new user prompt — produce the next-version deck building on the prior version." : "No specific prompt was given — produce a general summary of the workspace.")
  }

${versionPin}${commentsBlock}

If anything material is ambiguous (audience, scope, intended length, missing data), ASK ME using a single message that begins with "ASK:" and stop. Otherwise, build the deck.`;

  try {
    const built = await runAgentLoop(gen_id, ws.id, sys, trigger, wsDir, specDir);
    const cur = db.query("SELECT * FROM generations WHERE id = ?").get(gen_id) as any;
    if (cur.status === "errored" || cur.status === "awaiting_user") return;
    if (!built) {
      setStatus(gen_id, "errored", { error: "agent finished without producing a deck.html", completed_at: Date.now() });
      appendMessage(gen_id, "agent",
        "I finished without producing a deck. Try the generate button again with a clearer prompt.");
      return;
    }
    db.run("UPDATE generations SET artifact_path = ?, artifact_version = ? WHERE id = ?",
      [built.path, built.version, gen_id]);
    setStatus(gen_id, "done", { completed_at: Date.now() });
  } catch (e: any) {
    setStatus(gen_id, "errored", { error: String(e?.message || e).slice(0, 500), completed_at: Date.now() });
    appendMessage(gen_id, "agent", `Run failed: ${String(e?.message || e).slice(0, 300)}`);
  } finally {
    steerNotes.delete(gen_id);
  }
}
