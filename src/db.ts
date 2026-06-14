// SQLite schema + a thin typed wrapper around bun:sqlite. One file
// describes every table; bumping the schema is one place to edit.
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { fileURLToPath } from "node:url";
const DB_PATH = process.env.OPENWRIGHT_DB || fileURLToPath(new URL("../openwright.db", import.meta.url));
mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH, { create: true });
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS workspaces (
  id          INTEGER PRIMARY KEY,
  slug        TEXT UNIQUE NOT NULL,
  name        TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS files (
  id           INTEGER PRIMARY KEY,
  workspace_id INTEGER NOT NULL,
  name         TEXT NOT NULL,
  mimetype     TEXT,
  size         INTEGER,
  path         TEXT NOT NULL,
  uploaded_at  INTEGER NOT NULL,
  FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS generations (
  id                  INTEGER PRIMARY KEY,
  workspace_id        INTEGER NOT NULL,
  prompt              TEXT,
  status              TEXT NOT NULL DEFAULT 'queued',
  started_at          INTEGER,
  completed_at        INTEGER,
  error               TEXT,
  artifact_path       TEXT,
  artifact_version    INTEGER,
  FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS messages (
  id            INTEGER PRIMARY KEY,
  generation_id INTEGER NOT NULL,
  role          TEXT NOT NULL,
  content       TEXT NOT NULL,
  ts            INTEGER NOT NULL,
  FOREIGN KEY(generation_id) REFERENCES generations(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS artifacts (
  id            INTEGER PRIMARY KEY,
  workspace_id  INTEGER NOT NULL,
  name          TEXT NOT NULL,
  slug          TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS design_systems (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  slug        TEXT UNIQUE NOT NULL,
  css         TEXT NOT NULL DEFAULT '',
  description TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS comments (
  id              INTEGER PRIMARY KEY,
  artifact_id     INTEGER NOT NULL,
  slide_index     INTEGER,                   -- 0-based; NULL = deck-level
  body            TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'open',   -- 'open' | 'resolved'
  created_at      INTEGER NOT NULL,
  resolved_at     INTEGER,
  resolved_by_gen_id INTEGER,
  FOREIGN KEY(artifact_id) REFERENCES artifacts(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_comments_artifact ON comments(artifact_id);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_files_ws    ON files(workspace_id);
CREATE INDEX IF NOT EXISTS idx_gen_ws      ON generations(workspace_id);
CREATE INDEX IF NOT EXISTS idx_msg_gen     ON messages(generation_id);
CREATE INDEX IF NOT EXISTS idx_art_ws      ON artifacts(workspace_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_art_ws_slug ON artifacts(workspace_id, slug);
`);

// Migrations for existing DBs — CREATE TABLE IF NOT EXISTS doesn't add
// new columns on an existing table, so each new column gets its own
// guarded ALTER TABLE.
function addColumnIfMissing(table: string, column: string, ddl: string): boolean {
  const cols = db.query(`PRAGMA table_info(${table})`).all() as any[];
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
    return true;   // freshly added — caller may want to backfill
  }
  return false;
}
// Engine drives both the agent prompt and the build pipeline:
//   'html' (new default) - agent writes HTML/CSS, live preview, DOM-walking pptx export
//   'md'                 - markdown via md-engine (pandoc)
//   'spec'               - original spec.json via decks/ framework
addColumnIfMissing("workspaces",  "engine",              "TEXT NOT NULL DEFAULT 'html'");
// Theme name — matches a design_systems.slug. Default is 'boardroom',
// the system explicitly engineered for safe PowerPoint export. The
// design-forward systems (apple/editorial/graphite/aurora/twilight/
// manuscript/monolith) are opt-in via the workspace settings picker.
addColumnIfMissing("workspaces",  "theme",               "TEXT NOT NULL DEFAULT 'oneshot'");
// BYOA: which agent adapter runs this workspace's generations.
addColumnIfMissing("workspaces",  "agent_engine",        "TEXT NOT NULL DEFAULT 'claude'");
addColumnIfMissing("workspaces",  "agent_model",         "TEXT NOT NULL DEFAULT ''");
// Artifact type lived on the workspace at first; it now belongs to the
// individual artifact (a workspace can hold both decks and documents).
// The workspace column stays for back-compat but is no longer the
// driver. The artifacts column is backfilled from the workspace once.
addColumnIfMissing("workspaces",  "artifact_type",       "TEXT NOT NULL DEFAULT 'deck'");
addColumnIfMissing("design_systems", "builtin",           "INTEGER NOT NULL DEFAULT 0");
addColumnIfMissing("design_systems", "artifact_type",     "TEXT NOT NULL DEFAULT 'deck'");
// A design system is one identity that can dress both mediums. `css`
// holds the deck variant; `css_document` holds the document variant
// (empty for deck-only systems).
addColumnIfMissing("design_systems", "css_document",      "TEXT NOT NULL DEFAULT ''");
// Authoring persona — drives the AGENT's writing voice. Default is
// terse/technical; users can swap to executive-summary, detailed, or
// mixed-audience via the workspace settings panel. Persona text gets
// inlined into the agent prompt so the same workspace inputs produce
// different decks depending on the chosen audience.
addColumnIfMissing("workspaces",  "persona",             "TEXT NOT NULL DEFAULT 'terse-technical'");
// 'generating' | 'validating' | 'synthesizing' — surfaced in the UI so
// the workspace card can show what the agent is actively doing during
// a run rather than just 'running'. NULL outside an active phase.
addColumnIfMissing("generations", "phase",               "TEXT");
addColumnIfMissing("generations", "engine",              "TEXT");
addColumnIfMissing("generations", "model",               "TEXT");
// Foreign-key into the artifacts table. NULL on legacy rows; the
// post-add backfill below assigns each to a default per-workspace
// artifact so every gen has a parent artifact going forward.
addColumnIfMissing("generations", "artifact_id",         "INTEGER");
// design_system_id replaces the workspaces.theme string. Theme stays
// in place for backward compat / display label; new code reads
// design_system_id and resolves through the design_systems table.
addColumnIfMissing("workspaces",  "design_system_id",    "INTEGER");
// Per-artifact medium (deck | document). When first added, backfill
// every existing artifact from its workspace's old artifact_type so
// nothing changes medium on upgrade.
if (addColumnIfMissing("artifacts", "artifact_type", "TEXT NOT NULL DEFAULT 'deck'")) {
  db.exec(`UPDATE artifacts SET artifact_type =
             COALESCE((SELECT w.artifact_type FROM workspaces w WHERE w.id = artifacts.workspace_id), 'deck')`);
}

// Backfill: every workspace that has generations without artifact_id
// needs a default "Untitled" artifact, and those gens get re-pointed.
function backfillDefaultArtifacts() {
  const orphanWss = db.query(
    `SELECT DISTINCT g.workspace_id AS ws FROM generations g
       WHERE g.artifact_id IS NULL`).all() as any[];
  for (const r of orphanWss) {
    const ws_id = r.ws;
    // Reuse an existing artifact named "Untitled" / "Default" if present,
    // otherwise create one.
    let art = db.query(
      "SELECT id FROM artifacts WHERE workspace_id = ? ORDER BY id ASC LIMIT 1"
    ).get(ws_id) as any;
    if (!art) {
      const now = Date.now();
      const ins = db.run(
        "INSERT INTO artifacts(workspace_id, name, slug, created_at) VALUES(?, ?, ?, ?)",
        [ws_id, "Untitled", "untitled", now]) as any;
      art = { id: ins.lastInsertRowid };
    }
    db.run(
      "UPDATE generations SET artifact_id = ? WHERE workspace_id = ? AND artifact_id IS NULL",
      [art.id, ws_id],
    );
  }
}
backfillDefaultArtifacts();

// Seed the three built-in design systems from ~/html-engine/themes/.
// Each bundled CSS begins with a "/* vN — Name" version marker. When
// the bundled marker is newer than what's in the DB row for that
// Seed design systems from the repo's design-systems/ directory.
// manifest.json lists { name, slug, description }; each slug has a
// matching <slug>.css. Ship-time upgrades: a bundled css whose /* vN */
// header outranks the stored copy overwrites it; user-created systems
// (slugs not in the manifest) are never touched.
function seedBuiltinDesignSystems() {
  const fs = require("node:fs");
  const path = require("node:path");
  const dsDir = path.join(import.meta.dir, "..", "design-systems");
  // Each entry is one design-system identity. `<slug>.css` is the deck
  // variant; `doc_css` (optional) names the document-variant file.
  let manifest: Array<{ name: string; slug: string; description: string; doc_css?: string }> = [];
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(dsDir, "manifest.json"), "utf-8"));
  } catch {
    console.warn("[db] no design-systems/manifest.json — skipping seed");
    return;
  }
  const now = Date.now();
  const bundledVersion = (css: string): number => {
    const m = css.match(/^\/\*\s*v(\d+)\b/);
    return m ? parseInt(m[1]!, 10) : 0;
  };
  const readFile = (name?: string): string => {
    if (!name) return "";
    try { return fs.readFileSync(path.join(dsDir, name), "utf-8"); } catch { return ""; }
  };
  for (const b of manifest) {
    let css = "";
    try { css = fs.readFileSync(path.join(dsDir, `${b.slug}.css`), "utf-8"); }
    catch { continue; }
    const cssDoc = readFile(b.doc_css);
    const existing = db.query("SELECT id, css FROM design_systems WHERE slug = ?").get(b.slug) as any;
    if (!existing) {
      db.run("INSERT INTO design_systems(name, slug, css, css_document, description, builtin, created_at, updated_at) VALUES(?, ?, ?, ?, ?, 1, ?, ?)",
        [b.name, b.slug, css, cssDoc, b.description, now, now]);
      continue;
    }
    // Always re-assert the builtin flag + the bundle's name/description
    // (builtins are immutable in-app, so the bundle is the source of
    // truth — cheap, idempotent).
    db.run("UPDATE design_systems SET builtin = 1, name = ?, description = ? WHERE slug = ?", [b.name, b.description, b.slug]);
    if (bundledVersion(css) > bundledVersion(existing.css || "")) {
      db.run("UPDATE design_systems SET css = ?, updated_at = ? WHERE slug = ?",
        [css, now, b.slug]);
    }
    // Keep the document variant in lockstep with the bundle (it shares
    // the system's identity, not a separate version line).
    db.run("UPDATE design_systems SET css_document = ? WHERE slug = ? AND css_document != ?", [cssDoc, b.slug, cssDoc]);
  }
  migrateStandaloneDocSystem();
}

// Earlier builds shipped the document baseline as its OWN design system
// ("oneshot-doc"). The model is now one Oneshot that dresses both
// mediums, so fold any standalone doc system back into its deck sibling:
// move its CSS into the sibling's css_document, repoint workspaces, drop
// the orphan row. Idempotent — a no-op once the orphan is gone.
function migrateStandaloneDocSystem() {
  const orphan = db.query("SELECT id, css FROM design_systems WHERE slug = 'oneshot-doc'").get() as any;
  if (!orphan) return;
  const parent = db.query("SELECT id, css_document FROM design_systems WHERE slug = 'oneshot'").get() as any;
  if (!parent) return;
  if (!parent.css_document && orphan.css) {
    db.run("UPDATE design_systems SET css_document = ? WHERE id = ?", [orphan.css, parent.id]);
  }
  db.run("UPDATE workspaces SET design_system_id = ?, theme = 'oneshot' WHERE design_system_id = ?", [parent.id, orphan.id]);
  db.run("DELETE FROM design_systems WHERE id = ?", [orphan.id]);
  console.log("[db] merged standalone oneshot-doc system into Oneshot");
}
seedBuiltinDesignSystems();

// Backfill: workspaces with a theme string but no design_system_id
// get linked to the matching design system row.
function backfillDesignSystemFks() {
  const rows = db.query(
    "SELECT id, theme FROM workspaces WHERE design_system_id IS NULL"
  ).all() as any[];
  for (const r of rows) {
    const slug = r.theme || "apple";
    const ds = db.query("SELECT id FROM design_systems WHERE slug = ?").get(slug) as any;
    if (ds) {
      db.run("UPDATE workspaces SET design_system_id = ? WHERE id = ?", [ds.id, r.id]);
    }
  }
}
backfillDesignSystemFks();

export interface Workspace { id: number; slug: string; name: string; created_at: number }
export interface FileRow { id: number; workspace_id: number; name: string; mimetype?: string;
                            size?: number; path: string; uploaded_at: number }
export interface Generation { id: number; workspace_id: number; prompt?: string; status: string;
                                started_at?: number; completed_at?: number; error?: string;
                                artifact_path?: string; artifact_version?: number }
export interface Message { id: number; generation_id: number; role: "agent" | "user";
                             content: string; ts: number }

// ─── app settings ──────────────────────────────────────────────────
// Global defaults (default agent engine/model for new workspaces).
// OPENWRIGHT_AGENT env seeds the engine default on first boot only;
// after that the UI-set value wins.
export function getSetting(key: string, fallback = ""): string {
  const row = db.query("SELECT value FROM settings WHERE key = ?").get(key) as any;
  return row ? String(row.value) : fallback;
}

export function setSetting(key: string, value: string) {
  db.run("INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    [key, value]);
}

if (!(db.query("SELECT 1 FROM settings WHERE key = 'default_agent_engine'").get())) {
  setSetting("default_agent_engine", process.env.OPENWRIGHT_AGENT || "claude");
}
