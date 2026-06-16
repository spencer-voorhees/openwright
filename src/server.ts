// openwright HTTP server. Bun + bun:sqlite. Serves the React SPA from
// public/ and the REST API at /api/*.
//
// API surface (see README for details):
//   GET    /api/workspaces
//   POST   /api/workspaces                        {name}
//   GET    /api/workspaces/:slug
//   POST   /api/workspaces/:slug/files            multipart
//   DELETE /api/workspaces/:slug/files/:id
//   POST   /api/workspaces/:slug/notes            {title?, content, mode?}
//   POST   /api/workspaces/:slug/generate         {prompt?}
//   GET    /api/generations/:id
//   POST   /api/generations/:id/reply             {content}   (answers an ASK)
//   GET    /api/artifacts/:gen_id                 (latest artifact)
//   GET    /api/files/:id                         (download a workspace file)
import { mkdirSync, writeFileSync, statSync, unlinkSync, existsSync, readFileSync } from "node:fs";
import { join, extname } from "node:path";
import { db, getSetting, setSetting } from "./db";
import { startGeneration, postUserReply, reapStrandedGenerations, stopGeneration, WORKSPACE_ROOT } from "./agent";
import { ADAPTERS, DEFAULT_ENGINE } from "./agents/index";

const PORT = Number(process.env.OPENWRIGHT_PORT || process.env.PORT || 8090);

// Accent presets — the UI offers exactly these; PATCH validates.
const ACCENT_PRESETS = ["#ff5a1f", "#0A84FF", "#BF5AF2", "#30D158", "#FF375F", "#64D2FF", "#FFD60A", "#F5F5F7"];

// Agent probes spawn CLIs (--version, login status, help) — cache per
// adapter and refresh in parallel so /api/agents answers fast.
type AgentProbe = { id: string; label: string; models: string[]; ok: boolean; detail: string; pending?: boolean };
const probeCache = new Map<string, { at: number; probe: AgentProbe }>();
// CLIs can hang on first run (copilot with no config blocks forever),
// so every probe gets a hard deadline.
function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([p, new Promise<T>((res) => setTimeout(() => res(fallback), ms))]);
}
async function refreshProbe(a: (typeof ADAPTERS)[number]): Promise<AgentProbe> {
  const [avail, models] = await Promise.all([
    withTimeout(a.available().catch(() => ({ ok: false, detail: "probe failed" })), 6000,
      { ok: false, detail: "probe timed out" }),
    withTimeout(a.listModels().catch(() => [] as string[]), 6000, [] as string[]),
  ]);
  const probe = { id: a.id, label: a.label, models, ...avail };
  probeCache.set(a.id, { at: Date.now(), probe });
  return probe;
}
const probeInflight = new Map<string, Promise<AgentProbe>>();
async function probeAgent(a: (typeof ADAPTERS)[number]): Promise<AgentProbe> {
  const hit = probeCache.get(a.id);
  if (!hit) {
    // Cold start: answer instantly with a pending placeholder and let
    // the real probe land in the cache — the UI refetches until no
    // probe is pending. CLI spawns can take seconds on Windows.
    if (!probeInflight.has(a.id)) {
      probeInflight.set(a.id, refreshProbe(a).finally(() => probeInflight.delete(a.id)));
    }
    return { id: a.id, label: a.label, models: [], ok: false, detail: "checking…", pending: true } as AgentProbe;
  }
  // Stale-while-revalidate: never make the UI wait on CLI spawns —
  // serve the last known answer and refresh in the background.
  if (Date.now() - hit.at > 60_000) refreshProbe(a);
  return hit.probe;
}
// Warm the cache at boot so the first settings open is instant.
setTimeout(() => { for (const a of ADAPTERS) probeAgent(a); }, 250);

mkdirSync(WORKSPACE_ROOT, { recursive: true });

// ─── helpers ────────────────────────────────────────────────────────

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

function err(message: string, status = 400) {
  return json({ error: message }, status);
}

function slugify(s: string): string {
  const base = s.toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "workspace";
  // uniquify
  let candidate = base;
  let n = 2;
  while (db.query("SELECT 1 FROM workspaces WHERE slug = ?").get(candidate)) {
    candidate = `${base}-${n++}`;
  }
  return candidate;
}

function workspaceBySlug(slug: string) {
  return db.query("SELECT * FROM workspaces WHERE slug = ?").get(slug) as any;
}

function workspaceDir(slug: string) {
  const dir = join(WORKSPACE_ROOT, slug);
  mkdirSync(join(dir, "files"), { recursive: true });
  mkdirSync(join(dir, "artifacts"), { recursive: true });
  mkdirSync(join(dir, "notes"), { recursive: true });
  return dir;
}

// ─── handlers ───────────────────────────────────────────────────────

async function listWorkspaces() {
  const rows = db.query(`
    SELECT w.*,
           (SELECT COUNT(*) FROM files       WHERE workspace_id = w.id) AS file_count,
           (SELECT COUNT(*) FROM generations WHERE workspace_id = w.id) AS gen_count,
           (SELECT artifact_path FROM generations
             WHERE workspace_id = w.id AND status = 'done'
             ORDER BY completed_at DESC LIMIT 1) AS latest_artifact,
           (SELECT completed_at FROM generations
             WHERE workspace_id = w.id AND status = 'done'
             ORDER BY completed_at DESC LIMIT 1) AS latest_done_at,
           (SELECT status FROM generations
             WHERE workspace_id = w.id
             ORDER BY id DESC LIMIT 1) AS latest_gen_status,
           (SELECT COALESCE(completed_at, started_at) FROM generations
             WHERE workspace_id = w.id
             ORDER BY id DESC LIMIT 1) AS latest_gen_at,
           (SELECT id FROM generations
             WHERE workspace_id = w.id
               AND status IN ('queued','running','awaiting_user')
             ORDER BY id DESC LIMIT 1) AS active_gen_id,
           (SELECT status FROM generations WHERE id = (
             SELECT id FROM generations
              WHERE workspace_id = w.id
                AND status IN ('queued','running','awaiting_user')
              ORDER BY id DESC LIMIT 1)) AS active_gen_status,
           (SELECT phase FROM generations WHERE id = (
             SELECT id FROM generations
              WHERE workspace_id = w.id
                AND status IN ('queued','running','awaiting_user')
              ORDER BY id DESC LIMIT 1)) AS active_gen_phase,
           (SELECT started_at FROM generations WHERE id = (
             SELECT id FROM generations
              WHERE workspace_id = w.id
                AND status IN ('queued','running','awaiting_user')
              ORDER BY id DESC LIMIT 1)) AS active_gen_started_at,
           (SELECT MAX(ts) FROM messages WHERE generation_id = (
             SELECT id FROM generations
              WHERE workspace_id = w.id
                AND status IN ('queued','running','awaiting_user')
              ORDER BY id DESC LIMIT 1)) AS active_gen_last_message_at
    FROM workspaces w
    -- most recently touched first: latest run activity, file upload,
    -- or creation — running workspaces bubble to the top naturally
    ORDER BY COALESCE(
      (SELECT MAX(COALESCE(completed_at, started_at)) FROM generations WHERE workspace_id = w.id),
      (SELECT MAX(uploaded_at) FROM files WHERE workspace_id = w.id),
      w.created_at
    ) DESC
  `).all();
  return json({ workspaces: rows });
}

const KNOWN_THEMES = new Set(["oneshot", "oneshot-doc", "boardroom", "apple", "editorial", "graphite", "aurora", "twilight", "manuscript", "monolith", "bladerunner", "vesper", "apollo", "geist", "default"]);
const KNOWN_ENGINES = new Set(["html"]);
const KNOWN_PERSONAS = new Set(["terse-technical", "executive", "detailed", "mixed-audience"]);
const KNOWN_ARTIFACT_TYPES = new Set(["deck", "document", "spreadsheet"]);
// artifact_type → the design-system CSS variant query param it renders with.
function variantParam(artifactType: string | null | undefined): string {
  if (artifactType === "document") return "?type=document";
  if (artifactType === "spreadsheet") return "?type=spreadsheet";
  return "";
}

// ─── design systems ───────────────────────────────────────────────────
// Workspace-agnostic CSS bundles. A workspace points at one via
// workspaces.design_system_id; the agent prompt links to the live CSS
// URL so any edit to the system shows up next reload.

async function listDesignSystems() {
  const rows = db.query(
    `SELECT id, name, slug, description, builtin, length(css) as css_size,
            (length(css_document) > 0) as has_document,
            (length(css_spreadsheet) > 0) as has_spreadsheet, created_at, updated_at
     FROM design_systems ORDER BY id ASC`).all();
  return json({ design_systems: rows });
}

async function getDesignSystem(id: string) {
  const row = db.query("SELECT * FROM design_systems WHERE id = ?").get(id) as any;
  if (!row) return err("not found", 404);
  return json({ design_system: row });
}

async function createDesignSystem(req: Request) {
  const { name, css, description, from_id } = await req.json() as
    { name: string; css?: string; description?: string; from_id?: number };
  if (!name || !name.trim()) return err("name required");
  let base = slugify(name.trim());
  if (!base) base = "system";
  let candidate = base;
  let n = 2;
  while (db.query("SELECT 1 FROM design_systems WHERE slug = ?").get(candidate)) {
    candidate = `${base}-${n++}`;
  }
  let cssContent = css ?? "";
  // Optional clone-from: copy CSS from an existing system as starting point.
  if (!cssContent && from_id) {
    const src = db.query("SELECT css FROM design_systems WHERE id = ?").get(from_id) as any;
    if (src) cssContent = src.css || "";
  }
  if (!cssContent) {
    // New systems start as a themed copy of Oneshot — it is the
    // export-lossless baseline, so every derivative stays portable.
    const oneshot = db.query("SELECT css FROM design_systems WHERE slug = 'oneshot'").get() as any;
    cssContent = `/* ${name.trim()} — themed from Oneshot. Restyle via tokens; keep structural rules intact for export fidelity. */\n` + (oneshot?.css || "");
  }
  const now = Date.now();
  const ins = db.run(
    "INSERT INTO design_systems(name, slug, css, description, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?)",
    [name.trim(), candidate, cssContent, description?.trim() || null, now, now]) as any;
  return json({ design_system: db.query("SELECT * FROM design_systems WHERE id = ?").get(Number(ins.lastInsertRowid)) }, 201);
}

async function updateDesignSystem(id: string, req: Request) {
  const row = db.query("SELECT * FROM design_systems WHERE id = ?").get(id) as any;
  if (!row) return err("not found", 404);
  if (row.builtin) return err("built-in design systems are read-only", 403);
  const body = await req.json() as { name?: string; css?: string; description?: string };
  const sets: string[] = [];
  const vals: any[] = [];
  if (body.name !== undefined && body.name.trim()) { sets.push("name = ?"); vals.push(body.name.trim()); }
  if (body.css !== undefined) { sets.push("css = ?"); vals.push(body.css); }
  if (body.description !== undefined) { sets.push("description = ?"); vals.push(body.description); }
  if (sets.length === 0) return json({ design_system: row });
  sets.push("updated_at = ?"); vals.push(Date.now());
  vals.push(row.id);
  db.run(`UPDATE design_systems SET ${sets.join(", ")} WHERE id = ?`, vals);
  return json({ design_system: db.query("SELECT * FROM design_systems WHERE id = ?").get(row.id) });
}

async function deleteDesignSystem(id: string) {
  const row = db.query("SELECT * FROM design_systems WHERE id = ?").get(id) as any;
  if (!row) return err("not found", 404);
  if (row.builtin) return err("built-in design systems can't be deleted", 403);
  // Don't allow deleting a system that's currently in use unless the
  // caller passes ?force=1 — protects against accidental link-breakage.
  const inUse = db.query("SELECT COUNT(*) AS c FROM workspaces WHERE design_system_id = ?").get(row.id) as any;
  if (inUse?.c > 0) return err(`${inUse.c} workspace(s) reference this design system`, 409);
  db.run("DELETE FROM design_systems WHERE id = ?", [row.id]);
  return json({ ok: true });
}

// Serve the CSS content as a stylesheet so the deck shell can link to
// it directly. Path: /api/design-systems/:id/css.css (Spencer reads
// the resource as a stylesheet — Bun infers the content type from the
// .css suffix on the URL, but we set it explicitly for safety).
async function designSystemCss(id: string, variant: "deck" | "document" | "spreadsheet" = "deck") {
  const row = db.query("SELECT css, css_document, css_spreadsheet FROM design_systems WHERE id = ?").get(id) as any;
  if (!row) return new Response("/* design system not found */", { status: 404, headers: { "content-type": "text/css" } });
  // Each medium pulls its own variant; a system with no variant for that
  // medium (e.g. a deck-only custom system) falls back to the deck CSS so
  // it still renders rather than coming up blank.
  const css = variant === "document" ? (row.css_document || row.css || "")
            : variant === "spreadsheet" ? (row.css_spreadsheet || row.css || "")
            : (row.css || "");
  return new Response(css, {
    headers: { "content-type": "text/css; charset=utf-8", "cache-control": "no-cache" },
  });
}

async function createWorkspace(req: Request) {
  const { name, engine, theme, design_system_id, agent_engine, artifact_type } = await req.json() as
    { name: string; engine?: string; theme?: string; design_system_id?: number; agent_engine?: string; artifact_type?: string };
  if (!name || !name.trim()) return err("name required");
  const slug = slugify(name.trim());
  const now = Date.now();
  const eng = engine && KNOWN_ENGINES.has(engine) ? engine : "html";
  const artType = artifact_type && KNOWN_ARTIFACT_TYPES.has(artifact_type) ? artifact_type : "deck";
  // A design system now dresses BOTH mediums, so the artifact type no
  // longer picks a different system — the workspace's artifact_type
  // selects the variant at render time. Theme defaults to oneshot.
  const th = theme && KNOWN_THEMES.has(theme) ? theme : "oneshot";
  // Resolve the design system. If the client passed an id, use it.
  // Otherwise fall back to the system whose slug matches `theme`, then
  // to whatever the first seeded system is. This keeps html mode (which
  // reads design_system_id) functional out of the box.
  let dsId: number | null = null;
  if (design_system_id) {
    const ds = db.query("SELECT id FROM design_systems WHERE id = ?").get(design_system_id) as any;
    if (ds) dsId = ds.id;
  }
  if (!dsId) {
    const bySlug = db.query("SELECT id FROM design_systems WHERE slug = ?").get(th) as any;
    if (bySlug) dsId = bySlug.id;
  }
  if (!dsId) {
    const first = db.query("SELECT id FROM design_systems ORDER BY id ASC LIMIT 1").get() as any;
    if (first) dsId = first.id;
  }
  const settingEng = getSetting("default_agent_engine", DEFAULT_ENGINE);
  const fallbackEng = ADAPTERS.some((a) => a.id === settingEng) ? settingEng : DEFAULT_ENGINE;
  const agentEng = agent_engine && ADAPTERS.some((a) => a.id === agent_engine) ? agent_engine : fallbackEng;
  const agentModel = getSetting("default_agent_model", "");
  db.run("INSERT INTO workspaces(slug, name, created_at, engine, theme, design_system_id, agent_engine, agent_model, artifact_type) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)",
         [slug, name.trim(), now, eng, th, dsId, agentEng, agentModel, artType]);
  workspaceDir(slug);
  return json({ workspace: workspaceBySlug(slug) }, 201);
}

async function updateWorkspace(slug: string, req: Request) {
  const w = workspaceBySlug(slug);
  if (!w) return err("not found", 404);
  const body = await req.json() as { name?: string; engine?: string; theme?: string; design_system_id?: number; persona?: string; agent_engine?: string; agent_model?: string; artifact_type?: string };
  const sets: string[] = [];
  const vals: any[] = [];
  if (body.engine !== undefined && KNOWN_ENGINES.has(body.engine)) {
    sets.push("engine = ?"); vals.push(body.engine);
  }
  if (body.theme !== undefined && KNOWN_THEMES.has(body.theme)) {
    sets.push("theme = ?"); vals.push(body.theme);
  }
  if (body.design_system_id !== undefined) {
    const ds = db.query("SELECT id, slug FROM design_systems WHERE id = ?").get(body.design_system_id) as any;
    if (!ds) return err("design_system_id not found", 404);
    sets.push("design_system_id = ?"); vals.push(ds.id);
    // Mirror the slug into the legacy theme column so the agent prompt
    // pre-html-engine still gets a sensible label.
    sets.push("theme = ?"); vals.push(ds.slug);
  }
  if (body.name && body.name.trim()) { sets.push("name = ?"); vals.push(body.name.trim()); }
  if (body.artifact_type !== undefined && KNOWN_ARTIFACT_TYPES.has(body.artifact_type)) {
    sets.push("artifact_type = ?"); vals.push(body.artifact_type);
  }
  if (body.persona !== undefined && KNOWN_PERSONAS.has(body.persona)) {
    sets.push("persona = ?"); vals.push(body.persona);
  }
  if (body.agent_engine !== undefined && ADAPTERS.some((a) => a.id === body.agent_engine)) {
    sets.push("agent_engine = ?"); vals.push(body.agent_engine);
  }
  if (body.agent_model !== undefined) {
    sets.push("agent_model = ?"); vals.push(String(body.agent_model || "").trim());
  }
  if (sets.length === 0) return json({ workspace: w });
  vals.push(w.id);
  db.run(`UPDATE workspaces SET ${sets.join(", ")} WHERE id = ?`, vals);
  return json({ workspace: workspaceBySlug(slug) });
}

async function getWorkspace(slug: string) {
  const w = workspaceBySlug(slug);
  if (!w) return err("not found", 404);
  const files = db.query("SELECT * FROM files WHERE workspace_id = ? ORDER BY uploaded_at DESC").all(w.id);
  const artifacts = db.query(
    "SELECT * FROM artifacts WHERE workspace_id = ? ORDER BY id ASC"
  ).all(w.id);
  const generations = db.query(
    `SELECT g.id, g.prompt, g.status, g.started_at, g.completed_at, g.error,
            g.artifact_path, g.artifact_version, g.artifact_id, g.phase, g.engine, g.model,
            (SELECT MAX(ts) FROM messages WHERE generation_id = g.id) AS last_message_at
     FROM generations g WHERE g.workspace_id = ? ORDER BY g.id DESC`).all(w.id);
  for (const g of generations as any[]) {
  }
  return json({ workspace: w, files, artifacts, generations });
}

async function uploadFiles(slug: string, req: Request) {
  const w = workspaceBySlug(slug);
  if (!w) return err("workspace not found", 404);
  const form = await req.formData();
  const dir = workspaceDir(slug);
  const filesDir = join(dir, "files");
  const saved: any[] = [];
  for (const [, value] of form.entries()) {
    if (!(value instanceof File)) continue;
    const safeName = value.name.replace(/[\\/]/g, "_");
    // Avoid clobbering — prefix duplicates with a timestamp.
    let target = join(filesDir, safeName);
    if (existsSync(target)) {
      const ext = extname(safeName);
      const base = safeName.slice(0, safeName.length - ext.length);
      target = join(filesDir, `${base}-${Date.now()}${ext}`);
    }
    const buf = Buffer.from(await value.arrayBuffer());
    writeFileSync(target, buf);
    const now = Date.now();
    const result = db.run(
      `INSERT INTO files(workspace_id, name, mimetype, size, path, uploaded_at)
       VALUES(?, ?, ?, ?, ?, ?)`,
      [w.id, safeName, value.type || null, value.size, target, now]) as any;
    saved.push(db.query("SELECT * FROM files WHERE id = ?").get(result.lastInsertRowid));
  }
  return json({ files: saved }, 201);
}

async function deleteWorkspace(slug: string) {
  const w = workspaceBySlug(slug);
  if (!w) return err("not found", 404);
  // Best-effort filesystem cleanup; the DB delete cascades to
  // files / generations / messages.
  const dir = join(WORKSPACE_ROOT, slug);
  try {
    const fs = await import("node:fs");
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
  db.run("DELETE FROM workspaces WHERE id = ?", [w.id]);
  return json({ ok: true });
}

async function deleteFile(slug: string, fileId: string) {
  const w = workspaceBySlug(slug);
  if (!w) return err("workspace not found", 404);
  const f = db.query("SELECT * FROM files WHERE id = ? AND workspace_id = ?").get(fileId, w.id) as any;
  if (!f) return err("file not found", 404);
  try { unlinkSync(f.path); } catch {}
  db.run("DELETE FROM files WHERE id = ?", [f.id]);
  return json({ ok: true });
}

async function downloadFile(fileId: string) {
  const f = db.query("SELECT * FROM files WHERE id = ?").get(fileId) as any;
  if (!f || !existsSync(f.path)) return err("not found", 404);
  return new Response(Bun.file(f.path), {
    headers: {
      "content-type": f.mimetype || "application/octet-stream",
      "content-disposition": `attachment; filename="${f.name}"`,
    },
  });
}

// Overwrite a note's content in place. Notes are markdown files in the
// workspace's notes/ dir tracked in `files`; this rewrites the file and
// refreshes the row. Gated to markdown/text — binary uploads (PDF, CSV)
// can't be text-edited.
async function updateNote(slug: string, fileId: string, req: Request) {
  const w = workspaceBySlug(slug);
  if (!w) return err("workspace not found", 404);
  const f = db.query("SELECT * FROM files WHERE id = ? AND workspace_id = ?").get(fileId, w.id) as any;
  if (!f) return err("note not found", 404);
  const editable = f.mimetype === "text/markdown" || /\.(md|markdown|txt)$/i.test(f.name || "");
  if (!editable) return err("only markdown/text notes can be edited", 400);
  if (!existsSync(f.path)) return err("note file missing on disk", 404);
  const { content } = await req.json() as { content?: string };
  if (typeof content !== "string") return err("content required", 400);
  writeFileSync(f.path, content);
  const st = statSync(f.path);
  db.run("UPDATE files SET size = ?, uploaded_at = ? WHERE id = ?", [st.size, Date.now(), f.id]);
  return json({ ok: true, id: f.id, size: st.size });
}

async function quickNote(slug: string, req: Request) {
  const w = workspaceBySlug(slug);
  if (!w) return err("workspace not found", 404);
  const { title, content, mode = "new" } = await req.json() as
    { title?: string; content: string; mode?: "new" | "append" };
  if (!content || !content.trim()) return err("content required");

  const notesDir = join(workspaceDir(slug), "notes");
  let target: string;
  if (mode === "append") {
    target = join(notesDir, "notes.md");
    const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
    const append = `\n\n## ${stamp}${title ? " — " + title : ""}\n${content.trim()}\n`;
    const existing = existsSync(target) ? readFileSync(target, "utf-8") : "# Notes\n";
    writeFileSync(target, existing + append);
  } else {
    const stamp = new Date().toISOString().slice(0, 16).replace(/[T:]/g, "-");
    const fname = (title ? `${stamp}-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}` : stamp) + ".md";
    target = join(notesDir, fname);
    const body = (title ? `# ${title}\n\n` : "") + content.trim() + "\n";
    writeFileSync(target, body);
  }
  // Also register as a file so it shows up in the workspace file list.
  const st = statSync(target);
  const fileName = target.split("/").pop()!;
  // If "append" mode and notes.md already tracked, just bump its mtime.
  const existing = db.query("SELECT id FROM files WHERE path = ?").get(target) as any;
  if (existing) {
    db.run("UPDATE files SET size = ?, uploaded_at = ? WHERE id = ?",
           [st.size, Date.now(), existing.id]);
  } else {
    db.run(`INSERT INTO files(workspace_id, name, mimetype, size, path, uploaded_at)
            VALUES(?, ?, ?, ?, ?, ?)`,
           [w.id, fileName, "text/markdown", st.size, target, Date.now()]);
  }
  return json({ ok: true, path: target }, 201);
}

async function kickoffGeneration(slug: string, req: Request) {
  const w = workspaceBySlug(slug);
  if (!w) return err("workspace not found", 404);
  const { prompt, fresh, artifact_id } = await req.json().catch(() => ({})) as
    { prompt?: string; fresh?: boolean; artifact_id?: number };
  // Resolve the artifact this generation belongs to: explicit id from
  // the request, else the latest artifact for the workspace, else
  // create a default one.
  let art_id: number | null = artifact_id ?? null;
  if (art_id) {
    const a = db.query("SELECT id FROM artifacts WHERE id = ? AND workspace_id = ?").get(art_id, w.id) as any;
    if (!a) return err("artifact not found in this workspace", 404);
  } else {
    const a = db.query(
      "SELECT id FROM artifacts WHERE workspace_id = ? ORDER BY id DESC LIMIT 1"
    ).get(w.id) as any;
    if (a) {
      art_id = a.id;
    } else {
      const ins = db.run(
        "INSERT INTO artifacts(workspace_id, name, slug, created_at) VALUES(?, ?, ?, ?)",
        [w.id, "Untitled", "untitled", Date.now()]) as any;
      art_id = Number(ins.lastInsertRowid);
    }
  }
  const now = Date.now();
  const result = db.run(
    `INSERT INTO generations(workspace_id, artifact_id, prompt, status, started_at)
     VALUES(?, ?, ?, 'queued', ?)`,
    [w.id, art_id, prompt || null, now]) as any;
  const gen_id = Number(result.lastInsertRowid);
  startGeneration(gen_id, { fresh: !!fresh }).catch((e) => {
    console.error("[generation]", gen_id, e);
    db.run("UPDATE generations SET status='errored', error=?, completed_at=? WHERE id=?",
           [String(e?.message || e), Date.now(), gen_id]);
    db.run("INSERT INTO messages(generation_id, role, content, ts) VALUES(?, 'agent', ?, ?)",
           [gen_id, `Run failed: ${String(e?.message || e).slice(0, 300)}`, Date.now()]);
  });
  return json({ generation_id: gen_id, artifact_id: art_id }, 202);
}

async function listArtifacts(slug: string) {
  const w = workspaceBySlug(slug);
  if (!w) return err("workspace not found", 404);
  const artifacts = db.query(
    `SELECT a.id, a.name, a.slug, a.artifact_type, a.created_at,
            (SELECT COUNT(*) FROM generations WHERE artifact_id = a.id) AS gen_count,
            (SELECT artifact_path FROM generations
              WHERE artifact_id = a.id AND status = 'done' AND artifact_path IS NOT NULL
              ORDER BY completed_at DESC LIMIT 1) AS latest_artifact_path,
            (SELECT artifact_version FROM generations
              WHERE artifact_id = a.id AND status = 'done' AND artifact_path IS NOT NULL
              ORDER BY completed_at DESC LIMIT 1) AS latest_version
     FROM artifacts a WHERE a.workspace_id = ? ORDER BY a.id ASC`
  ).all(w.id);
  return json({ artifacts });
}

async function createArtifact(slug: string, req: Request) {
  const w = workspaceBySlug(slug);
  if (!w) return err("workspace not found", 404);
  const { name, artifact_type } = await req.json() as { name: string; artifact_type?: string };
  if (!name || !name.trim()) return err("name required");
  const artType = artifact_type && KNOWN_ARTIFACT_TYPES.has(artifact_type) ? artifact_type : "deck";
  // Derive a unique slug within this workspace.
  let base = slugify(name.trim());
  if (!base) base = "artifact";
  let candidate = base;
  let n = 2;
  while (db.query("SELECT 1 FROM artifacts WHERE workspace_id = ? AND slug = ?").get(w.id, candidate)) {
    candidate = `${base}-${n++}`;
  }
  const ins = db.run(
    "INSERT INTO artifacts(workspace_id, name, slug, artifact_type, created_at) VALUES(?, ?, ?, ?, ?)",
    [w.id, name.trim(), candidate, artType, Date.now()]) as any;
  return json({
    artifact: db.query("SELECT * FROM artifacts WHERE id = ?").get(Number(ins.lastInsertRowid)),
  }, 201);
}

async function renameArtifact(slug: string, art_id: string, req: Request) {
  const w = workspaceBySlug(slug);
  if (!w) return err("workspace not found", 404);
  const { name } = await req.json() as { name: string };
  if (!name || !name.trim()) return err("name required");
  const a = db.query("SELECT * FROM artifacts WHERE id = ? AND workspace_id = ?").get(art_id, w.id) as any;
  if (!a) return err("artifact not found", 404);
  db.run("UPDATE artifacts SET name = ? WHERE id = ?", [name.trim(), a.id]);
  return json({ artifact: db.query("SELECT * FROM artifacts WHERE id = ?").get(a.id) });
}

async function deleteArtifact(slug: string, art_id: string) {
  const w = workspaceBySlug(slug);
  if (!w) return err("workspace not found", 404);
  const a = db.query("SELECT * FROM artifacts WHERE id = ? AND workspace_id = ?").get(art_id, w.id) as any;
  if (!a) return err("artifact not found", 404);
  db.run("DELETE FROM artifacts WHERE id = ?", [a.id]);
  // Generations are NOT cascade-deleted (the FK in db.ts on artifacts
  // table doesn't reach into generations). Sever the link instead so
  // the chat history is preserved but orphaned of an artifact.
  db.run("UPDATE generations SET artifact_id = NULL WHERE artifact_id = ?", [a.id]);
  return json({ ok: true });
}

async function getGeneration(gen_id: string) {
  const g = db.query("SELECT * FROM generations WHERE id = ?").get(gen_id) as any;
  if (!g) return err("not found", 404);
  const messages = db.query("SELECT * FROM messages WHERE generation_id = ? ORDER BY ts").all(g.id);
  return json({ generation: g, messages });
}

async function replyToAgent(gen_id: string, req: Request) {
  const { content } = await req.json() as { content: string };
  if (!content || !content.trim()) return err("content required");
  const g = db.query("SELECT * FROM generations WHERE id = ?").get(gen_id) as any;
  if (!g) return err("generation not found", 404);
  // The run loop writes the user's reply to the transcript when it
  // consumes it — inserting here too duplicated every answer.
  // If the generation was paused waiting for input, resume.
  if (g.status === "awaiting_user") {
    postUserReply(g.id, content.trim()).catch((e) => {
      console.error("[reply]", gen_id, e);
      db.run("UPDATE generations SET status='errored', error=?, completed_at=? WHERE id=?",
             [String(e?.message || e), Date.now(), g.id]);
      db.run("INSERT INTO messages(generation_id, role, content, ts) VALUES(?, 'agent', ?, ?)",
             [g.id, `Run failed: ${String(e?.message || e).slice(0, 300)}`, Date.now()]);
    });
  }
  return json({ ok: true });
}

// ─── Comments ────────────────────────────────────────────────
// Per-artifact slide-level comments. Open comments are surfaced into
// the agent's trigger message on the next generation; the agent makes
// targeted edits and the user marks them resolved.
async function listComments(artifact_id: string) {
  const rows = db.query(
    `SELECT id, artifact_id, slide_index, body, status, created_at,
            resolved_at, resolved_by_gen_id
     FROM comments
     WHERE artifact_id = ?
     ORDER BY (status = 'resolved'), slide_index IS NULL, slide_index, created_at`,
  ).all(artifact_id);
  return json({ comments: rows });
}
async function addComment(artifact_id: string, req: Request) {
  const a = db.query("SELECT * FROM artifacts WHERE id = ?").get(artifact_id) as any;
  if (!a) return err("artifact not found", 404);
  const body = await req.json() as { slide_index?: number | null; body?: string };
  if (!body.body || !body.body.trim()) return err("body required", 400);
  const slideIdx = (typeof body.slide_index === "number" && body.slide_index >= 0)
    ? body.slide_index : null;
  const ins = db.run(
    `INSERT INTO comments (artifact_id, slide_index, body, status, created_at)
     VALUES (?, ?, ?, 'open', ?)`,
    [a.id, slideIdx, body.body.trim(), Date.now()],
  );
  const row = db.query("SELECT * FROM comments WHERE id = ?").get(Number(ins.lastInsertRowid));
  return json({ comment: row }, 201);
}
async function updateComment(comment_id: string, req: Request) {
  const c = db.query("SELECT * FROM comments WHERE id = ?").get(comment_id) as any;
  if (!c) return err("comment not found", 404);
  const body = await req.json() as { status?: string; body?: string };
  const sets: string[] = [];
  const vals: any[] = [];
  if (body.status === "open" || body.status === "resolved") {
    sets.push("status = ?"); vals.push(body.status);
    if (body.status === "resolved") {
      sets.push("resolved_at = ?"); vals.push(Date.now());
    } else {
      sets.push("resolved_at = NULL");
    }
  }
  if (body.body && body.body.trim()) {
    sets.push("body = ?"); vals.push(body.body.trim());
  }
  if (!sets.length) return json({ comment: c });
  vals.push(c.id);
  db.run(`UPDATE comments SET ${sets.join(", ")} WHERE id = ?`, vals);
  return json({ comment: db.query("SELECT * FROM comments WHERE id = ?").get(c.id) });
}
async function deleteComment(comment_id: string) {
  db.run("DELETE FROM comments WHERE id = ?", [comment_id]);
  return json({ ok: true });
}

async function downloadArtifact(gen_id: string) {
  const g = db.query("SELECT * FROM generations WHERE id = ?").get(gen_id) as any;
  const apath = resolveArtifact(g?.artifact_path);
  if (!g || !apath || !existsSync(apath)) return err("no artifact", 404);
  const name = apath.replace(/\\/g, "/").split("/").pop()!;
  const ext = name.split(".").pop()?.toLowerCase() || "";
  const friendly = exportFilename(apath, ext);
  const mime = ext === "html" ? "text/html; charset=utf-8"
             : ext === "pdf"  ? "application/pdf"
             : ext === "md"   ? "text/markdown; charset=utf-8"
             : "application/vnd.openxmlformats-officedocument.presentationml.presentation";
  return new Response(Bun.file(apath), {
    headers: {
      "content-type": mime,
      "content-disposition": `attachment; filename="${friendly}"`,
    },
  });
}

// Find a Chrome/Chromium binary for PDF printing, cross-platform.
// Order: explicit env, playwright's chromium (setup.sh installs it),
// puppeteer's chrome-headless-shell, then system installs.
import { homedir, platform } from "node:os";
function findChromeCandidates(): { bin: string; headlessShell: boolean }[] {
  const out: { bin: string; headlessShell: boolean }[] = [];
  const home = homedir();
  if (process.env.OPENWRIGHT_CHROME) out.push({ bin: process.env.OPENWRIGHT_CHROME, headlessShell: false });
  const plat = platform();   // 'darwin' | 'win32' | 'linux'

  // playwright cache
  const pwRoot = plat === "darwin" ? join(home, "Library", "Caches", "ms-playwright")
    : plat === "win32" ? join(process.env.LOCALAPPDATA || join(home, "AppData", "Local"), "ms-playwright")
    : join(home, ".cache", "ms-playwright");
  try {
    const fs = require("node:fs");
    for (const dir of (fs.readdirSync(pwRoot) as string[]).sort().reverse()) {
      if (dir.startsWith("chromium_headless_shell-")) {
        for (const rel of [
          ["chrome-mac", "headless_shell"],
          ["chrome-win", "headless_shell.exe"],
          ["chrome-linux", "headless_shell"],
        ]) out.push({ bin: join(pwRoot, dir, ...rel), headlessShell: true });
      } else if (dir.startsWith("chromium-")) {
        for (const rel of [
          ["chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium"],
          ["chrome-win", "chrome.exe"],
          ["chrome-linux", "chrome"],
        ]) out.push({ bin: join(pwRoot, dir, ...rel), headlessShell: false });
      }
    }
  } catch {}

  // puppeteer chrome-headless-shell cache
  try {
    const fs = require("node:fs");
    const base = join(home, ".cache", "puppeteer", "chrome-headless-shell");
    for (const dir of (fs.readdirSync(base) as string[]).sort().reverse()) {
      for (const rel of [
        ["chrome-headless-shell-mac-arm64", "chrome-headless-shell"],
        ["chrome-headless-shell-mac-x64", "chrome-headless-shell"],
        ["chrome-headless-shell-win64", "chrome-headless-shell.exe"],
        ["chrome-headless-shell-linux64", "chrome-headless-shell"],
      ]) out.push({ bin: join(base, dir, ...rel), headlessShell: true });
    }
  } catch {}

  // system installs
  out.push(
    { bin: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headlessShell: false },
    { bin: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", headlessShell: false },
    { bin: "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe", headlessShell: false },
    { bin: "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", headlessShell: false },
    { bin: "/usr/bin/google-chrome", headlessShell: false },
    { bin: "/usr/bin/chromium", headlessShell: false },
  );
  return out;
}
// Python for the PPTX exporters: the repo venv that setup creates
// wins; otherwise python3/python/py from PATH.
const VENV_PY = [
  join(import.meta.dir, "..", ".venv", "bin", "python"),
  join(import.meta.dir, "..", ".venv", "Scripts", "python.exe"),
].find(existsSync);
const PYTHON_BIN = process.env.OPENWRIGHT_PYTHON || VENV_PY
  || Bun.which("python3") || Bun.which("python") || Bun.which("py") || "python3";

const CHROME = findChromeCandidates().find((c) => existsSync(c.bin)) || null;
const CHROME_BIN = CHROME?.bin || "";

// Export the HTML deck behind a generation to a PDF using Chrome
// headless. The deck-shell.js has a built-in @media print stylesheet
// that lays every slide out as its own page at authored 1920×1080
// size, so Chrome's --print-to-pdf gets the right pagination for
// free. Output sits next to the .html as <base>.pdf.
// DOM-walking HTML → PPTX export. Sidecars out to the python script
// at ~/html-engine/exporters/export_pptx.py — that script uses
// playwright to walk the DOM at authored 1920×1080 and emits one
// editable pptx shape per leaf element (text box, picture, rect).
const HTML_PPTX_EXPORT       = join(import.meta.dir, "..", "html-engine", "exporters", "export_pptx.py");
const HTML_PPTX_IMAGE_EXPORT = join(import.meta.dir, "..", "html-engine", "exporters", "export_pptx_image.py");
// DOM-walking HTML → DOCX export. The document medium is block-flow
// only, so this maps each block to an editable Word construct rather
// than rasterizing. Output sits next to the .html as <base>.docx.
const HTML_DOCX_EXPORT       = join(import.meta.dir, "..", "html-engine", "exporters", "export_docx.py");
// DOM-walking HTML → XLSX export. Each <table class="sheet"> becomes an
// editable worksheet. Output sits next to the .html as <base>.xlsx.
const HTML_XLSX_EXPORT       = join(import.meta.dir, "..", "html-engine", "exporters", "export_xlsx.py");

// Kill an active generation on user request. If the in-memory loop is
// gone (server restarted under it), mark the row directly so the UI
// unsticks either way.
async function stopGen(gen_id: string) {
  const g = db.query("SELECT * FROM generations WHERE id = ?").get(gen_id) as any;
  if (!g) return err("generation not found", 404);
  if (!["queued", "running", "awaiting_user"].includes(g.status)) {
    return err("generation is not active", 400);
  }
  const inMemory = stopGeneration(Number(gen_id));
  if (!inMemory) {
    db.run("UPDATE generations SET status = 'errored', error = 'stopped by user', completed_at = ? WHERE id = ?",
           [Date.now(), gen_id]);
  }
  return json({ ok: true, in_memory: inMemory });
}

async function exportPptxFromHtml(gen_id: string, mode: "dom" | "image" = "dom") {
  const g = db.query("SELECT * FROM generations WHERE id = ?").get(gen_id) as any;
  if (!g || !g.artifact_path) return err("no artifact", 404);
  g.artifact_path = resolveArtifact(g.artifact_path);
  if (!/\.html$/i.test(g.artifact_path)) return err("export-pptx requires an HTML artifact", 400);
  if (!existsSync(g.artifact_path)) return err("artifact file missing on disk", 404);
  const script = mode === "image" ? HTML_PPTX_IMAGE_EXPORT : HTML_PPTX_EXPORT;
  if (!existsSync(script)) return err(`html-engine ${mode} exporter not found`, 500);
  const m = String(g.artifact_path).replace(/\\/g, "/").match(/\/workspaces\/(.+)$/);
  if (!m) return err("could not derive preview path", 500);
  const previewUrl = `http://127.0.0.1:${PORT}/preview/${m[1]}`;
  // image mode lands in a separate .image.pptx so it doesn't clobber
  // the editable export. dom mode uses the canonical <base>.pptx.
  const suffix = mode === "image" ? ".image.pptx" : ".pptx";
  const outPath = g.artifact_path.replace(/\.html$/i, suffix);
  const proc = Bun.spawn({
    cmd: [PYTHON_BIN, script, "--url", previewUrl, "--out", outPath],
    stderr: "pipe", stdout: "pipe",
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0 || !existsSync(outPath)) {
    const stderr = proc.stderr ? await new Response(proc.stderr).text() : "";
    return err(`pptx ${mode} export failed (exit ${exitCode}): ${stderr.slice(-500)}`, 500);
  }
  return json({ ok: true, path: outPath, mode });
}

// HTML → DOCX. Gated to document artifacts (decks export to PPTX).
// Walks the rendered .doc-page block flow into an editable Word file.
async function exportDocxFromHtml(gen_id: string) {
  const g = db.query("SELECT * FROM generations WHERE id = ?").get(gen_id) as any;
  if (!g || !g.artifact_path) return err("no artifact", 404);
  g.artifact_path = resolveArtifact(g.artifact_path);
  if (!/\.html$/i.test(g.artifact_path)) return err("export-docx requires an HTML artifact", 400);
  if (!existsSync(g.artifact_path)) return err("artifact file missing on disk", 404);
  // DOCX only makes sense for documents — decks have no block flow.
  const art = db.query("SELECT artifact_type FROM artifacts WHERE id = ?").get(g.artifact_id) as any;
  if (art && (art.artifact_type || "deck") !== "document") {
    return err("export-docx is only available for document artifacts", 400);
  }
  if (!existsSync(HTML_DOCX_EXPORT)) return err("html-engine docx exporter not found", 500);
  const m = String(g.artifact_path).replace(/\\/g, "/").match(/\/workspaces\/(.+)$/);
  if (!m) return err("could not derive preview path", 500);
  const previewUrl = `http://127.0.0.1:${PORT}/preview/${m[1]}`;
  const outPath = g.artifact_path.replace(/\.html$/i, ".docx");
  const proc = Bun.spawn({
    cmd: [PYTHON_BIN, HTML_DOCX_EXPORT, "--url", previewUrl, "--out", outPath],
    stderr: "pipe", stdout: "pipe",
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0 || !existsSync(outPath)) {
    const stderr = proc.stderr ? await new Response(proc.stderr).text() : "";
    return err(`docx export failed (exit ${exitCode}): ${stderr.slice(-500)}`, 500);
  }
  return json({ ok: true, path: outPath });
}

// HTML → XLSX. Gated to spreadsheet artifacts. Walks each rendered
// <table class="sheet"> into an editable worksheet.
async function exportXlsxFromHtml(gen_id: string) {
  const g = db.query("SELECT * FROM generations WHERE id = ?").get(gen_id) as any;
  if (!g || !g.artifact_path) return err("no artifact", 404);
  g.artifact_path = resolveArtifact(g.artifact_path);
  if (!/\.html$/i.test(g.artifact_path)) return err("export-xlsx requires an HTML artifact", 400);
  if (!existsSync(g.artifact_path)) return err("artifact file missing on disk", 404);
  const art = db.query("SELECT artifact_type FROM artifacts WHERE id = ?").get(g.artifact_id) as any;
  if (art && (art.artifact_type || "deck") !== "spreadsheet") {
    return err("export-xlsx is only available for spreadsheet artifacts", 400);
  }
  if (!existsSync(HTML_XLSX_EXPORT)) return err("html-engine xlsx exporter not found", 500);
  const m = String(g.artifact_path).replace(/\\/g, "/").match(/\/workspaces\/(.+)$/);
  if (!m) return err("could not derive preview path", 500);
  const previewUrl = `http://127.0.0.1:${PORT}/preview/${m[1]}`;
  const outPath = g.artifact_path.replace(/\.html$/i, ".xlsx");
  const proc = Bun.spawn({
    cmd: [PYTHON_BIN, HTML_XLSX_EXPORT, "--url", previewUrl, "--out", outPath],
    stderr: "pipe", stdout: "pipe",
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0 || !existsSync(outPath)) {
    const stderr = proc.stderr ? await new Response(proc.stderr).text() : "";
    return err(`xlsx export failed (exit ${exitCode}): ${stderr.slice(-500)}`, 500);
  }
  return json({ ok: true, path: outPath });
}

// Build a friendly download filename like
// "dit-theme-migration-untitled-deck-v22.pptx" so saved files identify
// which workspace and artifact they belong to. Strips the "untitled"
// artifact slug since it's the default and noise.
// Absolute artifact paths go stale when the install moves (folder
// rename, restored backup). Re-root the stable /workspaces/ suffix
// onto the live WORKSPACE_ROOT before touching disk.
function resolveArtifact(p: string | null): string | null {
  if (!p) return p;
  if (existsSync(p)) return p;
  const m = String(p).replace(/\\/g, "/").match(/\/workspaces\/(.+)$/);
  if (m) {
    const alt = join(WORKSPACE_ROOT, m[1]!);
    if (existsSync(alt)) return alt;
  }
  return p;
}

function exportFilename(artifact_path: string, kind: string): string {
  // Windows paths arrive with backslashes — normalize first or the
  // whole path collapses into the filename (C_Users... downloads).
  const p = String(artifact_path).replace(/\\/g, "/");
  const m = p.match(/\/workspaces\/([^/]+)\/artifacts\/([^/]+)\/([^/]+)$/);
  const base = p.split("/").pop()!;
  if (!m) return base;
  const [, wsSlug, artSlug, file] = m;
  const stem = file.replace(/\.[^/.]+$/, "");
  const fileBase = artSlug && artSlug !== "untitled" ? `${wsSlug}-${artSlug}-${stem}` : `${wsSlug}-${stem}`;
  return `${fileBase}.${kind === "pptx-image" ? "image.pptx" : kind}`;
}

// Serve an exported PDF/PPTX sibling of the gen's html artifact —
// `<base>.pdf` / `<base>.pptx` next to the .html file.
async function downloadExport(gen_id: string, kind: "pdf" | "pptx" | "pptx-image" | "docx" | "xlsx") {
  const g = db.query("SELECT * FROM generations WHERE id = ?").get(gen_id) as any;
  if (!g || !g.artifact_path) return err("no artifact", 404);
  g.artifact_path = resolveArtifact(g.artifact_path);
  const ext = kind === "pptx-image" ? ".image.pptx" : `.${kind}`;
  const out = g.artifact_path.replace(/\.html$/i, ext);
  if (!existsSync(out)) return err(`no exported ${kind}`, 404);
  const friendly = exportFilename(out, kind);
  const mime = kind === "pdf"
    ? "application/pdf"
    : kind === "docx"
    ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    : kind === "xlsx"
    ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    : "application/vnd.openxmlformats-officedocument.presentationml.presentation";
  return new Response(Bun.file(out), {
    headers: {
      "content-type": mime,
      "content-disposition": `attachment; filename="${friendly}"`,
    },
  });
}

// Save inline text edits made via the deck-preview iframe. The iframe
// posts back the full deck HTML; we write it to the next deck-vN.html
// path and create a new generation row pointing at it so the UI can
// jump to the new version. Old version stays on disk so edits are
// reversible.
async function saveEdits(gen_id: string, req: Request) {
  const g = db.query("SELECT * FROM generations WHERE id = ?").get(gen_id) as any;
  if (!g || !g.artifact_path) return err("no artifact", 404);
  g.artifact_path = resolveArtifact(g.artifact_path);
  if (!/\.html$/i.test(g.artifact_path)) return err("only HTML artifacts can be edited", 400);
  const body = await req.json() as { html?: string };
  if (!body.html || typeof body.html !== "string") return err("html body required", 400);
  // Resolve the next-version path. Canonical files are deck|doc|sheet-vN.html,
  // but tolerate ANY base name (<base>-vN.html) and unversioned files
  // (<base>.html → <base>-v2.html) so a save never 400s on an unexpected
  // filename — e.g. a deck the agent named after an uploaded artifact.
  const versioned = g.artifact_path.match(/^(.+-v)(\d+)(\.html)$/i);
  let prefix: string, nextV: number, suffix: string;
  if (versioned) {
    prefix = versioned[1]; nextV = parseInt(versioned[2], 10) + 1; suffix = versioned[3];
  } else {
    const unversioned = g.artifact_path.match(/^(.+?)(\.html)$/i);
    if (!unversioned) return err("only HTML artifacts can be edited", 400);
    prefix = `${unversioned[1]}-v`; nextV = 2; suffix = unversioned[2];
  }
  let newPath = `${prefix}${nextV}${suffix}`;
  // Avoid overwriting if a future-version file already exists (e.g. agent
  // ran in the background while user was editing). Bump until free.
  while (existsSync(newPath)) {
    nextV += 1;
    newPath = `${prefix}${nextV}${suffix}`;
  }
  writeFileSync(newPath, body.html);
  const now = Date.now();
  const ins = db.run(
    `INSERT INTO generations
       (workspace_id, artifact_id, prompt, status, phase, started_at, completed_at,
        artifact_path, artifact_version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [g.workspace_id, g.artifact_id, "[edit] manual text edits", "done", "done",
     now, now, newPath, nextV],
  );
  return json({
    ok: true,
    new_gen_id: Number(ins.lastInsertRowid),
    artifact_path: newPath,
    version: nextV,
  });
}

async function exportPdf(gen_id: string) {
  const g = db.query("SELECT * FROM generations WHERE id = ?").get(gen_id) as any;
  if (!g || !g.artifact_path) return err("no artifact", 404);
  g.artifact_path = resolveArtifact(g.artifact_path);
  if (!/\.html$/i.test(g.artifact_path)) return err("export-pdf requires an HTML artifact", 400);
  if (!existsSync(g.artifact_path)) return err("artifact file missing on disk", 404);
  if (!CHROME_BIN) return err("No Chrome/Chromium found — set OPENWRIGHT_CHROME or run setup to install playwright chromium", 500);

  const m = String(g.artifact_path).replace(/\\/g, "/").match(/\/workspaces\/(.+)$/);
  if (!m) return err("could not derive preview path", 500);
  const previewUrl = `http://127.0.0.1:${PORT}/preview/${m[1]}`;
  const outPath = g.artifact_path.replace(/\.html$/i, ".pdf");

  // chrome-headless-shell is intrinsically headless; the full Chrome
  // app needs --headless=new. Decide based on which one we resolved.
  // Use Bun.spawn (async) so the server can keep serving other
  // requests during the ~15s chrome takes to print.
  const usingShell = !!CHROME?.headlessShell;
  const proc = Bun.spawn({
    cmd: [
      CHROME_BIN,
      ...(usingShell ? [] : ["--headless=new"]),
      "--no-sandbox",
      "--disable-gpu",
      "--no-pdf-header-footer",
      "--virtual-time-budget=15000",
      `--print-to-pdf=${outPath}`,
      previewUrl,
    ],
    stderr: "pipe", stdout: "pipe",
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0 || !existsSync(outPath)) {
    const stderr = proc.stderr ? await new Response(proc.stderr).text() : "";
    return err(`chrome print-to-pdf failed (exit ${exitCode}): ${stderr.slice(-500)}`, 500);
  }
  return json({ ok: true, path: outPath });
}

// Download a theme variant — same generation, alternate theme file.
// Variant path is `<base>-<theme>.pptx` next to the original.
// (md-engine retheme removed — openwright is html-engine only)

// Scan the artifacts directory next to a base artifact and find sibling

// ─── router ─────────────────────────────────────────────────────────

function route(req: Request, url: URL): Promise<Response> | Response {
  const path = url.pathname;
  const m = (p: string) => path.match(new RegExp("^" + p + "$"));

  if (path === "/api/workspaces" && req.method === "GET") return listWorkspaces();
  if (path === "/api/workspaces" && req.method === "POST") return createWorkspace(req);
  let mt: RegExpMatchArray | null;
  if ((mt = m("/api/workspaces/([^/]+)")) && req.method === "GET") return getWorkspace(mt[1]);
  if ((mt = m("/api/workspaces/([^/]+)")) && req.method === "DELETE") return deleteWorkspace(mt[1]);
  if ((mt = m("/api/workspaces/([^/]+)")) && req.method === "PATCH") return updateWorkspace(mt[1], req);
  if ((mt = m("/api/workspaces/([^/]+)/files")) && req.method === "POST") return uploadFiles(mt[1], req);
  if ((mt = m("/api/workspaces/([^/]+)/files/(\\d+)")) && req.method === "DELETE") return deleteFile(mt[1], mt[2]);
  if ((mt = m("/api/workspaces/([^/]+)/notes")) && req.method === "POST") return quickNote(mt[1], req);
  if ((mt = m("/api/workspaces/([^/]+)/notes/(\\d+)")) && req.method === "PUT") return updateNote(mt[1], mt[2], req);
  if ((mt = m("/api/workspaces/([^/]+)/generate")) && req.method === "POST") return kickoffGeneration(mt[1], req);
  if ((mt = m("/api/workspaces/([^/]+)/artifacts")) && req.method === "GET") return listArtifacts(mt[1]);
  if ((mt = m("/api/workspaces/([^/]+)/artifacts")) && req.method === "POST") return createArtifact(mt[1], req);
  if ((mt = m("/api/workspaces/([^/]+)/artifacts/(\\d+)")) && req.method === "PATCH") return renameArtifact(mt[1], mt[2], req);
  if ((mt = m("/api/workspaces/([^/]+)/artifacts/(\\d+)")) && req.method === "DELETE") return deleteArtifact(mt[1], mt[2]);
  if ((mt = m("/api/generations/(\\d+)")) && req.method === "GET") return getGeneration(mt[1]);
  if ((mt = m("/api/generations/(\\d+)/reply")) && req.method === "POST") return replyToAgent(mt[1], req);
  if ((mt = m("/api/artifacts/(\\d+)/comments")) && req.method === "GET")  return listComments(mt[1]);
  if ((mt = m("/api/artifacts/(\\d+)/comments")) && req.method === "POST") return addComment(mt[1], req);
  if ((mt = m("/api/comments/(\\d+)")) && req.method === "PATCH")  return updateComment(mt[1], req);
  if ((mt = m("/api/comments/(\\d+)")) && req.method === "DELETE") return deleteComment(mt[1]);
  if ((mt = m("/api/generations/(\\d+)/save-edits")) && req.method === "POST") return saveEdits(mt[1], req);
  if ((mt = m("/api/generations/(\\d+)/export-pdf")) && req.method === "POST") return exportPdf(mt[1]);
  if (url.pathname === "/api/agents" && req.method === "GET") {
    return (async () => {
      const out = await Promise.all(ADAPTERS.map(probeAgent));
      // Overlay persisted verify outcomes (engines with no native
      // status command would otherwise always read "auth unknown").
      for (const probe of out) {
        try {
          const raw = getSetting(`${probe.id}_auth_state`, "");
          if (!raw) continue;
          const v = JSON.parse(raw);
          const age = Date.now() - (v.at || 0);
          const ageTxt = age < 90_000 ? "just now" : age < 5_400_000 ? `${Math.round(age / 60_000)}m ago` : `${Math.round(age / 3_600_000)}h ago`;
          if (probe.ok || v.ok) {
            probe.ok = probe.ok && v.ok !== false;
            probe.detail = `${v.detail} (checked ${ageTxt})`;
          }
        } catch {}
      }
      const def = getSetting("default_agent_engine", DEFAULT_ENGINE);
      return json({ agents: out, default: ADAPTERS.some((a) => a.id === def) ? def : DEFAULT_ENGINE });
    })();
  }
  const mVerify = url.pathname.match(/^\/api\/agents\/([a-z]+)\/verify$/);
  if (mVerify && req.method === "POST") {
    return (async () => {
      const a = ADAPTERS.find((x) => x.id === mVerify[1]);
      if (!a) return err("unknown engine", 404);
      if (!a.verifyAuth) return err("engine has no deep auth check (its availability probe is authoritative)", 400);
      const r = await a.verifyAuth();
      // Persist the outcome so Settings and the shelf agree, across
      // restarts, until the next check says otherwise.
      setSetting(`${a.id}_auth_state`, JSON.stringify({ ...r, at: Date.now() }));
      probeCache.delete(a.id);   // availability detail may change
      return json(r);
    })();
  }
  if (url.pathname === "/api/settings" && req.method === "GET") {
    return json({
      settings: {
        default_agent_engine: getSetting("default_agent_engine", DEFAULT_ENGINE),
        default_agent_model: getSetting("default_agent_model", ""),
        accent_color: getSetting("accent_color", "#ff5a1f"),
      },
    });
  }
  if (url.pathname === "/api/settings" && req.method === "PATCH") {
    return (async () => {
      const body = await req.json() as { default_agent_engine?: string; default_agent_model?: string; accent_color?: string };
      if (body.default_agent_engine !== undefined) {
        if (!ADAPTERS.some((a) => a.id === body.default_agent_engine)) return err("unknown engine");
        setSetting("default_agent_engine", body.default_agent_engine);
      }
      if (body.default_agent_model !== undefined) {
        setSetting("default_agent_model", String(body.default_agent_model || "").trim());
      }
      if (body.accent_color !== undefined) {
        if (!ACCENT_PRESETS.includes(body.accent_color)) return err("unknown accent color");
        setSetting("accent_color", body.accent_color);
      }
      return json({
        settings: {
          default_agent_engine: getSetting("default_agent_engine", DEFAULT_ENGINE),
          default_agent_model: getSetting("default_agent_model", ""),
          accent_color: getSetting("accent_color", "#ff5a1f"),
        },
      });
    })();
  }
  if ((mt = m("/api/generations/(\\d+)/stop")) && req.method === "POST") return stopGen(mt[1]);
  if ((mt = m("/api/generations/(\\d+)/export-pptx")) && req.method === "POST") return exportPptxFromHtml(mt[1], "dom");
  if ((mt = m("/api/generations/(\\d+)/export-pptx-image")) && req.method === "POST") return exportPptxFromHtml(mt[1], "image");
  if ((mt = m("/api/generations/(\\d+)/export-docx")) && req.method === "POST") return exportDocxFromHtml(mt[1]);
  if ((mt = m("/api/generations/(\\d+)/export-xlsx")) && req.method === "POST") return exportXlsxFromHtml(mt[1]);
  if ((mt = m("/api/generations/(\\d+)/download-pdf")) && req.method === "GET") return downloadExport(mt[1], "pdf");
  if ((mt = m("/api/generations/(\\d+)/download-pptx")) && req.method === "GET") return downloadExport(mt[1], "pptx");
  if ((mt = m("/api/generations/(\\d+)/download-pptx-image")) && req.method === "GET") return downloadExport(mt[1], "pptx-image");
  if ((mt = m("/api/generations/(\\d+)/download-docx")) && req.method === "GET") return downloadExport(mt[1], "docx");
  if ((mt = m("/api/generations/(\\d+)/download-xlsx")) && req.method === "GET") return downloadExport(mt[1], "xlsx");
  if ((mt = m("/api/artifacts/(\\d+)")) && req.method === "GET") return downloadArtifact(mt[1]);
  if ((mt = m("/api/files/(\\d+)")) && req.method === "GET") return downloadFile(mt[1]);
  if (path === "/api/design-systems" && req.method === "GET")  return listDesignSystems();
  if (path === "/api/design-systems" && req.method === "POST") return createDesignSystem(req);
  if ((mt = m("/api/design-systems/(\\d+)")) && req.method === "GET")    return getDesignSystem(mt[1]);
  if ((mt = m("/api/design-systems/(\\d+)")) && req.method === "PATCH")  return updateDesignSystem(mt[1], req);
  if ((mt = m("/api/design-systems/(\\d+)")) && req.method === "DELETE") return deleteDesignSystem(mt[1]);
  if ((mt = m("/api/design-systems/(\\d+)/css\\.css")) && req.method === "GET") {
    const t = url.searchParams.get("type");
    return designSystemCss(mt[1], t === "document" ? "document" : t === "spreadsheet" ? "spreadsheet" : "deck");
  }

  return err("not found", 404);
}

// ─── server ─────────────────────────────────────────────────────────

Bun.serve({
  port: PORT,
  // Loopback by default: a local tool should not listen on the LAN
  // (also avoids the Windows Firewall prompt). OPENWRIGHT_HOST=0.0.0.0
  // opts into network access (e.g. phone via Tailscale).
  hostname: process.env.OPENWRIGHT_HOST || "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);
    // Logo tinted to the accent — the source svg is single-fill.
    if (url.pathname === "/logo.svg") {
      const c = (url.searchParams.get("c") || "ff5a1f").replace(/[^0-9a-fA-F]/g, "").slice(0, 6);
      // Re-center the mark in a square canvas: the raw viewBox rides
      // the robot high-left, which shows at favicon size.
      const svg = readFileSync(join(import.meta.dir, "..", "public", "openwright-logo.svg"), "utf-8")
        .replace(/#ff5a1f/gi, `#${c.padEnd(6, "f")}`)
        .replace('viewBox="3 0.5 14 14"', 'viewBox="2.5 -1 15 15"');
      return new Response(svg, { headers: { "content-type": "image/svg+xml", "cache-control": "public, max-age=3600" } });
    }
    if (url.pathname.startsWith("/api/")) {
      try {
        return await route(req, url);
      } catch (e: any) {
        console.error(e);
        return err(e?.message || String(e), 500);
      }
    }
    // /html-engine/* serves the deck shell + themes (read-only).
    if (url.pathname.startsWith("/html-engine/")) {
      const rel = url.pathname.replace(/^\/html-engine\//, "");
      const t = join(import.meta.dir, "..", "html-engine", rel);
      if (!t.startsWith(join(import.meta.dir, "..", "html-engine"))) {
        return new Response("forbidden", { status: 403 });
      }
      if (existsSync(t)) return new Response(Bun.file(t), {
        headers: { "cache-control": "no-cache" },
      });
      return new Response("not found", { status: 404 });
    }
    // Synthetic preview route for a design system: returns the example
    // deck wired to the system's live CSS so the editor can show
    // changes immediately.
    const dsPreview = url.pathname.match(/^\/preview\/__design-system-preview\/(\d+)\.html$/);
    if (dsPreview) {
      const id = dsPreview[1];
      // One system, three ways to view it:
      //   mode=specimen        → the token spec sheet (showcase.html)
      //   example=document     → a worked document, doc variant CSS
      //   default (deck)       → a worked deck, deck variant CSS
      // showcase.html is a richer regression suite — typography
      // hierarchy, color swatches, every pattern, component examples —
      // so the specimen surfaces what the system actually covers.
      const mode = url.searchParams.get("mode");
      const example = url.searchParams.get("example");
      let file = "sample.html";
      let cssVariant = "";
      if (mode === "specimen") file = "showcase.html";
      else if (example === "document") { file = "sample-doc.html"; cssVariant = "?type=document"; }
      else if (example === "spreadsheet") { file = "sample-sheet.html"; cssVariant = "?type=spreadsheet"; }
      const sourcePath = join(import.meta.dir, "..", "html-engine", "examples", file);
      if (!existsSync(sourcePath)) {
        return new Response(`${file} not found`, { status: 404 });
      }
      const sample = readFileSync(sourcePath, "utf-8");
      // Swap the static themes/<x>.css link for the live design system CSS.
      const patched = sample.replace(
        /<link\s+rel="stylesheet"\s+href="\/html-engine\/themes\/[^"]+"\s*\/?>/i,
        `<link rel="stylesheet" href="/api/design-systems/${id}/css.css${cssVariant}">`,
      );
      return new Response(patched, {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" },
      });
    }
    // /preview/<workspace_slug>/<artifact_slug>/<file> serves the
    // live HTML deck preview from the workspace artifacts directory.
    if (url.pathname.startsWith("/preview/")) {
      const rel = url.pathname.replace(/^\/preview\//, "");
      const t = join(WORKSPACE_ROOT, rel);
      if (!t.startsWith(WORKSPACE_ROOT)) {
        return new Response("forbidden", { status: 403 });
      }
      if (!existsSync(t)) return new Response("not found", { status: 404 });
      // For HTML artifacts we rewrite the embedded design-system CSS
      // link to point at the workspace's CURRENT design_system_id.
      // The link is baked into the file at generation time, but the
      // user can change the workspace's design system any time after
      // — we want that change to take effect immediately for previews
      // and downstream exports (PDF / PPTX both render via this URL).
      if (rel.endsWith(".html")) {
        const parts = rel.split("/");
        const wsSlug = parts[0];
        const artSlug = parts[1] === "artifacts" ? parts[2] : null;
        const ws = db.query("SELECT id, design_system_id FROM workspaces WHERE slug = ?").get(wsSlug) as any;
        if (ws && ws.design_system_id) {
          // The artifact's own type picks the variant: documents pull
          // the document CSS, spreadsheets the spreadsheet CSS, decks the
          // deck CSS.
          const art = artSlug
            ? db.query("SELECT artifact_type FROM artifacts WHERE workspace_id = ? AND slug = ?").get(ws.id, artSlug) as any
            : null;
          const artType = (art?.artifact_type || "deck");
          // Non-deck mediums (document, spreadsheet) share the same
          // treatment: variant CSS, a mobile viewport, and the edit
          // bridge (they carry no deck shell).
          const isNonDeck = artType === "document" || artType === "spreadsheet";
          const variant = variantParam(artType);
          const html = readFileSync(t, "utf-8");
          let patched = html.replace(
            /<link\s+rel="stylesheet"\s+href="\/api\/design-systems\/\d+\/css\.css(?:\?[^"]*)?"\s*\/?>/i,
            `<link rel="stylesheet" href="/api/design-systems/${ws.design_system_id}/css.css${variant}">`,
          );
          // Safety net for files authored before the viewport-meta
          // guidance: without it, mobile renders the page at ~980px and
          // scrolls. Inject one if missing.
          if (isNonDeck && !/name=["']viewport["']/i.test(patched)) {
            patched = patched.replace(/<head([^>]*)>/i,
              `<head$1><meta name="viewport" content="width=device-width, initial-scale=1">`);
          }
          // Non-deck artifacts carry no deck shell, so the host's Edit
          // button has nothing to talk to. Inject the edit bridge
          // (stripped on save) so inline editing works for them too.
          if (isNonDeck) {
            const tag = `<script src="/html-engine/doc-edit.js"></script>`;
            patched = /<\/body>/i.test(patched)
              ? patched.replace(/<\/body>/i, `${tag}</body>`)
              : patched + tag;
          }
          return new Response(patched, {
            headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" },
          });
        }
      }
      return new Response(Bun.file(t), {
        headers: { "cache-control": "no-cache" },
      });
    }
    // Static files from public/
    const file = url.pathname === "/" ? "index.html" : url.pathname.replace(/^\//, "");
    const target = join(import.meta.dir, "..", "public", file);
    if (existsSync(target)) {
      return new Response(Bun.file(target));
    }
    // SPA fallback
    return new Response(Bun.file(join(import.meta.dir, "..", "public", "index.html")));
  },
});

const reaped = reapStrandedGenerations();
if (reaped > 0) console.log(`[openwright] reaped ${reaped} stranded generation${reaped === 1 ? "" : "s"} from previous run`);
console.log(`[openwright] http://localhost:${PORT}`);
