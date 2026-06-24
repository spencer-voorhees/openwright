/* ============================================================
   openwright app — dashboard + 3-pane workspace + agent chat,
   ported from the Claude Design prototype with wiring to the
   real REST API.
   ============================================================ */
const { useState, useEffect, useMemo, useRef, useCallback, useId } = React;

// ─── popover state ──────────────────────────────────────────────
// Shared open/close for every dropdown + popover. Two behaviors:
//   1) click anywhere outside closes it (the panel itself stops
//      propagation so clicks inside don't count);
//   2) mutual exclusivity — opening one popover broadcasts a
//      "popover-open" event that makes every other one close, so two
//      menus can never overlap. Use `toggle` on the trigger button and
//      spread `open`/`setOpen` as before.
function usePopover() {
  const id = useId();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const onClickAway = () => setOpen(false);
    const onOther = (e) => { if (e.detail !== id) setOpen(false); };
    window.addEventListener("click", onClickAway);
    window.addEventListener("popover-open", onOther);
    return () => {
      window.removeEventListener("click", onClickAway);
      window.removeEventListener("popover-open", onOther);
    };
  }, [open, id]);
  const toggle = () => {
    if (!open) window.dispatchEvent(new CustomEvent("popover-open", { detail: id }));
    setOpen((o) => !o);
  };
  return { open, setOpen, toggle };
}

// ─── lucide icon wrapper ────────────────────────────────────────
// Renders an inline SVG by lucide name. Strokes inherit currentColor
// via CSS, so colors flow from theme tokens.
// Custom inline SVGs for icons lucide doesn't carry. Same 24x24
// viewBox + currentColor + stroke conventions as lucide so they
// drop in seamlessly next to lucide icons in chips/buttons.
const CUSTOM_ICONS = {
  // Tesla-autopilot-style steering wheel: outer ring, center hub,
  // three spokes (top + lower-left + lower-right). Matches the
  // negative space of the Model 3 / S autopilot UI icon.
  "steering-wheel": `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"
         stroke="currentColor" stroke-width="1.8"
         stroke-linecap="round" stroke-linejoin="round">
      <circle cx="12" cy="12" r="9"/>
      <circle cx="12" cy="12" r="2"/>
      <path d="M12 10V3"/>
      <path d="M10.5 13.4 4.2 17"/>
      <path d="M13.5 13.4 19.8 17"/>
    </svg>`,
};

function Spinner({ style }) {
  return <Icon name="loader-circle" className="spin" style={style} />;
}

function Icon({ name, className, style }) {
  const ref = React.useRef(null);
  React.useEffect(() => {
    if (!ref.current) return;
    ref.current.innerHTML = "";
    // Inline custom SVGs first — they're not in lucide's registry.
    if (CUSTOM_ICONS[name]) {
      ref.current.innerHTML = CUSTOM_ICONS[name];
      const svg = ref.current.firstElementChild;
      if (svg) {
        svg.setAttribute("width", "100%");
        svg.setAttribute("height", "100%");
      }
      return;
    }
    try {
      const ic = window.lucide?.icons?.[toPascal(name)];
      if (!ic) return;
      const node = window.lucide.createElement(ic);
      node.setAttribute("width", "100%");
      node.setAttribute("height", "100%");
      ref.current.appendChild(node);
    } catch {}
  }, [name]);
  return <span ref={ref} className={"wp-ic" + (className ? " " + className : "")} style={style} aria-hidden="true" />;
}
function toPascal(s) {
  return s.split("-").map((p) => p ? p[0].toUpperCase() + p.slice(1) : "").join("");
}

// Per-medium icon: documents read as a page, spreadsheets as a grid,
// decks as a slide.
function artifactTypeIcon(type) {
  if (type === "document") return "file-text";
  if (type === "spreadsheet") return "table";
  return "presentation";
}
// Short medium tag shown on an artifact row.
function artifactTypeTag(type) {
  if (type === "document") return "Doc";
  if (type === "spreadsheet") return "Sheet";
  return "Deck";
}

// Markdown renderer for chat content. Configured with breaks=true so
// single newlines become <br>, matching how chat-style prose reads.
// Sanitization isn't bolted on because the content source is our own
// backend (claude agent output we control) — no untrusted HTML hits
// this path. If we ever pipe external markdown through here, add
// DOMPurify before the dangerouslySetInnerHTML.
if (window.marked && !window.__markedConfigured) {
  window.marked.setOptions({ gfm: true, breaks: true });
  window.__markedConfigured = true;
}
function Markdown({ text, className }) {
  const html = React.useMemo(() => {
    if (!text) return "";
    try { return window.marked.parse(text); }
    catch { return text; }
  }, [text]);
  return <div className={"md " + (className || "")} dangerouslySetInnerHTML={{ __html: html }} />;
}

// ─── fetch helpers ─────────────────────────────────────────────
async function fetchJson(url, opts) {
  const r = await fetch(url, { cache: "no-store", ...(opts || {}) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}
async function postJson(url, body) {
  return fetchJson(url, { method: "POST", headers: { "content-type": "application/json" },
                          body: JSON.stringify(body || {}) });
}
async function patchJson(url, body) {
  return fetchJson(url, { method: "PATCH", headers: { "content-type": "application/json" },
                          body: JSON.stringify(body || {}) });
}
async function putJson(url, body) {
  return fetchJson(url, { method: "PUT", headers: { "content-type": "application/json" },
                          body: JSON.stringify(body || {}) });
}
async function del(url) { return fetchJson(url, { method: "DELETE" }); }

// ─── formatters ─────────────────────────────────────────────────
function fmtBytes(b) {
  if (b == null) return "";
  if (b < 1024) return b + " B";
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + " KB";
  return (b / 1024 / 1024).toFixed(1) + " MB";
}
function fmtTime(ms) {
  if (!ms) return "—";
  const d = Date.now() - ms;
  if (d < 60_000) return "just now";
  if (d < 3_600_000) return Math.floor(d / 60_000) + "m ago";
  if (d < 86_400_000) return Math.floor(d / 3_600_000) + "h ago";
  return Math.floor(d / 86_400_000) + "d ago";
}
function fmtElapsed(ms) {
  if (!ms || ms < 0) return "—";
  if (ms < 60_000) return Math.floor(ms / 1000) + "s";
  const min = Math.floor(ms / 60_000);
  const sec = Math.floor((ms % 60_000) / 1000);
  if (min < 60) return `${min}m${sec ? " " + sec + "s" : ""}`;
  const hr = Math.floor(min / 60);
  return `${hr}h ${min % 60}m`;
}

// Re-renders every second so elapsed/since-last-activity timers feel live.
function useTick(intervalMs = 1000) {
  const [, setN] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setN((n) => n + 1), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
}

// Heartbeat chip — shows "Nm running · Ns since last msg · iter X/Y" when
// a generation is mid-flight, with the "since last msg" turning amber/red
// as it grows past the comfort threshold.
const PHASE_LABEL = {
  generating:   "generating",
};

function Heartbeat({ startedAt, lastMessageAt, phase = null, compact = false }) {
  useTick(1000);
  const now = Date.now();
  const runMs   = startedAt ? now - startedAt : 0;
  const idleMs  = lastMessageAt ? now - lastMessageAt : runMs;
  const cls =
    idleMs > 300_000 ? "hb-stale" :
    idleMs > 120_000 ? "hb-warm"  : "hb-ok";
  // No dot here — the StatusPill beside it is the region's one light.
  // Idle only appears once it means something; below 10s it just
  // flickered between 0s and 1s.
  return (
    <span className={"hb " + cls}>
      {!compact && <span className="hb-run">{fmtElapsed(runMs)} running</span>}
      {idleMs >= 10_000 && (
        <span className="hb-idle" title={`Last agent message ${fmtElapsed(idleMs)} ago`}>
          {fmtElapsed(idleMs)} idle
        </span>
      )}
      {phase && PHASE_LABEL[phase] && (
        <span className={"hb-phase hb-phase-" + phase}>{PHASE_LABEL[phase]}</span>
      )}
    </span>
  );
}
function fileKind(name, mimetype) {
  const ext = (name || "").toLowerCase();
  if (mimetype === "text/markdown" || ext.endsWith(".md")) return "note";
  if (ext.endsWith(".pdf")) return "pdf";
  if (/\.(xlsx?|csv|tsv)$/.test(ext)) return "sheet";
  if (/\.(png|jpe?g|gif|webp|svg)$/.test(ext)) return "img";
  if (/\.(pptx?)$/.test(ext)) return "slides";
  return "doc";
}
const KIND = {
  doc:    { icon: "file-text", cls: "ic-doc" },
  sheet:  { icon: "sheet",     cls: "ic-sheet" },
  pdf:    { icon: "file",      cls: "ic-pdf" },
  img:    { icon: "image",     cls: "ic-img" },
  note:   { icon: "sticky-note", cls: "ic-note" },
  slides: { icon: "monitor-play", cls: "" },
};

// Status mapping: server statuses → UI bucket.
const STATUS = {
  queued:        { pill: "is-generating", dot: "s-generating", label: "Queued" },
  running:       { pill: "is-generating", dot: "s-generating", label: "Generating" },
  awaiting_user: { pill: "is-input",      dot: "s-input",      label: "Needs input" },
  done:          { pill: "is-ready",      dot: "s-ready",      label: "Ready" },
  // Finished within the last 30 minutes — the "something new since
  // you looked" signal. Rail dot and card pill share it; both go
  // quiet when it ages out.
  fresh:         { pill: "is-ready",      dot: "s-ready",      label: "Updated" },
  errored:       { pill: "is-error",      dot: "s-error",      label: "Errored" },
  idle:          { pill: "",              dot: "s-idle",       label: "Idle" },
};
const FRESH_WINDOW_MS = 30 * 60_000;

// ─── workspace status derivation ──────────────────────────────
// Given a workspace's generation rows, pick the single status the
// pod-chip + pod-card should reflect.
function podStatus(generations) {
  if (!generations?.length) return "idle";
  const active = generations.find((g) =>
    g.status === "queued" || g.status === "running" || g.status === "awaiting_user"
  );
  if (active) return active.status;
  const top = generations[0];
  const recent = top.completed_at && Date.now() - top.completed_at < FRESH_WINDOW_MS;
  if (top.status === "errored") return recent ? "errored" : "idle";
  if (top.status === "done")    return recent ? "fresh" : "idle";
  return "idle";
}

// ═══════════════════════════════════════════════════════════════
// APP
// ═══════════════════════════════════════════════════════════════

function App() {
  const [workspaces, setWorkspaces] = useState([]);
  const [activeSlug, setActiveSlug] = useState(null);
  const [view, setView] = useState("dashboard");   // "dashboard" | "workspace" | "design-systems" | "settings"
  const [activeSystemId, setActiveSystemId] = useState(null);
  const [menu, setMenu] = useState(null);            // {ws, x, y}
  const [modal, setModal] = useState(null);
  const [wsTab, setWsTab] = useState("files");      // mobile only

  const refresh = useCallback(async () => {
    const d = await fetchJson("/api/workspaces");
    setWorkspaces(d.workspaces || []);
  }, []);
  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => {
    fetchJson("/api/settings")
      .then((d) => d.settings?.accent_color && applyAccent(d.settings.accent_color))
      .catch(() => {});
    fetchJson("/api/agents").catch(() => {});   // warm the probe cache
  }, []);
  // Track the visual viewport so overlays (modals) stay above the
  // on-screen keyboard on mobile — the keyboard shrinks the visual
  // viewport but not the layout viewport, so a bottom-anchored sheet
  // would otherwise sit behind it. Publish the visible box as CSS vars.
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const root = document.documentElement;
    const apply = () => {
      root.style.setProperty("--vv-height", vv.height + "px");
      root.style.setProperty("--vv-top", (vv.offsetTop || 0) + "px");
    };
    apply();
    vv.addEventListener("resize", apply);
    vv.addEventListener("scroll", apply);
    return () => { vv.removeEventListener("resize", apply); vv.removeEventListener("scroll", apply); };
  }, []);

  const openWs = useCallback((slug) => {
    setActiveSlug(slug);
    setView("workspace");
    setWsTab("files");
    setMenu(null);
  }, []);
  const backToDashboard = useCallback(() => {
    setView("dashboard");
    setActiveSlug(null);
    refresh();
  }, [refresh]);

  // Poll the workspaces list every 5s so dashboard chips reflect status.
  useEffect(() => {
    const id = setInterval(refresh, 5000);
    return () => clearInterval(id);
  }, [refresh]);

  // Close menus on click-anywhere.
  useEffect(() => {
    if (!menu) return;
    const h = () => setMenu(null);
    window.addEventListener("click", h);
    return () => window.removeEventListener("click", h);
  }, [menu]);

  const deleteWorkspace = useCallback(async (slug) => {
    if (!confirm(`Delete workspace "${slug}"? Files and runs go too.`)) return;
    await del(`/api/workspaces/${slug}`);
    if (activeSlug === slug) backToDashboard();
    refresh();
  }, [activeSlug, backToDashboard, refresh]);

  return (
    <div className="wp-app">
      <ToastHost />
      <Rail workspaces={workspaces} activeSlug={activeSlug}
            view={view} onHome={backToDashboard}
            onOpenDesignSystems={() => { setView("design-systems"); setActiveSystemId(null); }}
            onOpenSettings={() => setView("settings")}
            onOpen={openWs} onNew={() => setModal({ type: "new-ws" })} />
      <div className={"ws " + (wsTab === "agent" ? "ws-tab-agent" : "ws-tab-files")}>
        {view === "dashboard" && (
          <Dashboard workspaces={workspaces}
                     onOpen={openWs} onNew={() => setModal({ type: "new-ws" })}
                     onMenu={(e, ws) => { e.stopPropagation(); setMenu({ ws, x: e.clientX, y: e.clientY }); }} />
        )}
        {view === "workspace" && (
          <WorkspaceView key={activeSlug} slug={activeSlug}
                          wsTab={wsTab} setWsTab={setWsTab}
                          onBack={backToDashboard} onChange={refresh} />
        )}
        {view === "design-systems" && (
          <DesignSystems activeSystemId={activeSystemId}
                         onSelect={(id) => setActiveSystemId(id)}
                         onBack={backToDashboard} />
        )}
        {view === "settings" && <SettingsView />}
      </div>
      {menu && (() => {
        // Clamp to the viewport so a tap near the right/bottom edge (the
        // pod card's ⋯ sits top-right, hard against the edge on mobile)
        // doesn't open the menu off-screen.
        const MW = 200, MH = 130, pad = 8;
        const left = Math.max(pad, Math.min(menu.x, window.innerWidth - MW - pad));
        const top = Math.max(pad, Math.min(menu.y, window.innerHeight - MH - pad));
        return (
        <div className="menu" style={{ left, top }} onClick={(e) => e.stopPropagation()}>
          <button onClick={() => { openWs(menu.ws.slug); setMenu(null); }}>
            <Icon name="folder-open" /> Open
          </button>
          <div className="sep" />
          <button className="danger" onClick={() => { setMenu(null); deleteWorkspace(menu.ws.slug); }}>
            <Icon name="trash-2" /> Delete workspace
          </button>
        </div>
        );
      })()}
      {modal?.type === "new-ws" && (
        <NewWorkspaceModal onClose={() => setModal(null)}
          onCreated={(ws) => { setModal(null); refresh(); openWs(ws.slug); }} />
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// RAIL (icon sidebar)
// ═══════════════════════════════════════════════════════════════

// Workspace avatar: an iMessage/Telegram-style gradient tile with
// the initials on top. Pixel identicons read as noise at 38px; a
// smooth two-tone gradient + letters carries identity cleanly and
// speaks the same iOS language as the rest of the UI. Uniqueness =
// hue pair (8) x gradient angle (4) + the initials themselves.
// Artifact paths come from the server as absolute host paths — on
// Windows that means backslashes, which every regex/split here would
// otherwise miss.
function normPath(p) { return String(p || "").replace(/\\/g, "/"); }

// ─── toasts ────────────────────────────────────────────────────
function showToast(text, kind = "ok") {
  window.dispatchEvent(new CustomEvent("op-toast", { detail: { text, kind, id: ++showToast._id } }));
}
showToast._id = 0;
function ToastHost() {
  const [toasts, setToasts] = useState([]);
  useEffect(() => {
    const h = (e) => {
      const t = e.detail;
      setToasts((list) => [...list, t]);
      setTimeout(() => setToasts((list) => list.filter((x) => x.id !== t.id)), 3800);
    };
    window.addEventListener("op-toast", h);
    return () => window.removeEventListener("op-toast", h);
  }, []);
  return (
    <div className="toast-host">
      {toasts.map((t) => (
        <div key={t.id} className={"toast fade-up " + (t.kind === "bad" ? "is-bad" : "is-ok")}>
          <Icon name={t.kind === "bad" ? "shield-alert" : "check-circle-2"} />
          {t.text}
        </div>
      ))}
    </div>
  );
}

// ─── accent theming ────────────────────────────────────────────
// One source accent drives the CSS variable family, the favicon, and
// the rail logo (served re-tinted by /logo.svg?c=).
const ACCENTS = [
  { name: "Ultra",  hex: "#ff5a1f" },
  { name: "Blue",   hex: "#0A84FF" },
  { name: "Purple", hex: "#BF5AF2" },
  { name: "Green",  hex: "#30D158" },
  { name: "Pink",   hex: "#FF375F" },
  { name: "Cyan",   hex: "#64D2FF" },
  { name: "Yellow", hex: "#FFD60A" },
  { name: "White",  hex: "#F5F5F7" },
];
let CURRENT_ACCENT = "#ff5a1f";
function shade(hex, f) {
  const n = parseInt(hex.slice(1), 16);
  const ch = (x) => Math.max(0, Math.min(255, Math.round(x)));
  const r = ch(((n >> 16) & 255) * f), g = ch(((n >> 8) & 255) * f), b = ch((n & 255) * f);
  return `rgb(${r} ${g} ${b})`;
}
function applyAccent(hex) {
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return;
  CURRENT_ACCENT = hex;
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  const rs = document.documentElement.style;
  rs.setProperty("--um-ultra", hex);
  rs.setProperty("--um-ultra-deep", shade(hex, 0.78));
  rs.setProperty("--um-ultra-soft", `rgb(${Math.min(255, r + 48)} ${Math.min(255, g + 48)} ${Math.min(255, b + 48)})`);
  rs.setProperty("--wp-accent-tint", `rgba(${r}, ${g}, ${b}, 0.14)`);
  rs.setProperty("--wp-accent-line", `rgba(${r}, ${g}, ${b}, 0.32)`);
  // Text that sits ON the accent: light accents (white, yellow, cyan)
  // need dark glyphs, the rest take white.
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  rs.setProperty("--wp-accent-fg", lum > 165 ? "#16161a" : "#ffffff");
  document.querySelectorAll('link[rel="icon"]').forEach((l) => { l.href = `/logo.svg?c=${hex.slice(1)}`; });
  window.dispatchEvent(new CustomEvent("op-accent", { detail: hex }));
}
function useAccent() {
  const [accent, setAccent] = useState(CURRENT_ACCENT);
  useEffect(() => {
    const h = (e) => setAccent(e.detail);
    window.addEventListener("op-accent", h);
    return () => window.removeEventListener("op-accent", h);
  }, []);
  return accent;
}

function icHash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
// Deep jewel register tuned for the slate UI — rich but not candy,
// and the orange pair stays in the ultra-accent family.
const AV_GRADS = [
  ["#2E8BFF", "#0A55BE"],   // blue
  ["#6E6BF0", "#4644BE"],   // indigo
  ["#AE5BE0", "#7A36A8"],   // purple
  ["#E0506E", "#A8273F"],   // rose
  ["#FF7A45", "#CC4412"],   // ultra orange
  ["#34B85C", "#1B7038"],   // green
  ["#3FB9D6", "#147294"],   // teal
  ["#92929B", "#54545C"],   // graphite
];
function initialsFor(nameOrSlug) {
  return String(nameOrSlug || "?").split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase() || "?";
}
function Identicon({ seed, className, letters }) {
  const h = icHash(String(seed));
  const [a, b] = AV_GRADS[h % AV_GRADS.length];
  const angle = [135, 115, 160, 95][(h >>> 4) % 4];
  return (
    <span className={"avatar-grad " + (className || "")}
          style={{ backgroundImage: `linear-gradient(${angle}deg, ${a} 0%, ${b} 100%)` }}>
      {letters || ""}
    </span>
  );
}

function RailLogo() {
  const accent = useAccent();
  return <img src={`/logo.svg?c=${accent.slice(1)}`} alt="openwright" />;
}

function railStatus(ws) {
  // Active gen wins.
  if (ws.active_gen_status === "running" || ws.active_gen_status === "queued") return "running";
  if (ws.active_gen_status === "awaiting_user") return "awaiting_user";
  // Same vocabulary as the cards (podStatus): recent error outranks
  // recent success; both age out after the fresh window.
  if (ws.latest_gen_status === "errored" && ws.latest_gen_at && Date.now() - ws.latest_gen_at < FRESH_WINDOW_MS) return "errored";
  if (ws.latest_gen_status === "done" && ws.latest_done_at && Date.now() - ws.latest_done_at < FRESH_WINDOW_MS) return "fresh";
  return "idle";
}

function Rail({ workspaces, activeSlug, view, onHome, onOpen, onNew, onOpenDesignSystems, onOpenSettings }) {
  // Overflow affordance: when more chips exist than fit, fade the
  // clipped edge (top/bottom on desktop, left/right on mobile) and
  // keep the active workspace scrolled into view.
  const podsRef = useRef(null);
  const updateOvf = useCallback(() => {
    const el = podsRef.current; if (!el) return;
    let start = false, end = false;
    if (el.scrollHeight > el.clientHeight + 2) {
      start = el.scrollTop > 2;
      end = el.scrollTop + el.clientHeight < el.scrollHeight - 2;
    } else if (el.scrollWidth > el.clientWidth + 2) {
      start = el.scrollLeft > 2;
      end = el.scrollLeft + el.clientWidth < el.scrollWidth - 2;
    }
    el.classList.toggle("ovf-start", start);
    el.classList.toggle("ovf-end", end);
  }, []);
  useEffect(() => {
    updateOvf();
    const el = podsRef.current; if (!el) return;
    el.addEventListener("scroll", updateOvf, { passive: true });
    const ro = new ResizeObserver(updateOvf);
    ro.observe(el);
    return () => { el.removeEventListener("scroll", updateOvf); ro.disconnect(); };
  }, [updateOvf, workspaces.length]);
  useEffect(() => {
    podsRef.current?.querySelector(".pod-chip.active")
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeSlug, view]);
  return (
    <aside className="rail">
      <button className="rail-logo" onClick={onHome} title="Workspaces">
        <RailLogo />
      </button>
      <div className="rail-div" />
      <div className="rail-pods" ref={podsRef}>
        {workspaces.map((ws) => {
          const status = railStatus(ws);
          const cls = "pod-chip" + (ws.slug === activeSlug && view === "workspace" ? " active" : "");
          const letters = (ws.name || ws.slug).split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase() || "?";
          const animate = status === "running" || status === "queued" || status === "awaiting_user";
          return (
            <button key={ws.id} className={cls} onClick={() => onOpen(ws.slug)}
              title={`${ws.name}${status !== "idle" ? " · " + (STATUS[status]?.label || status) : ""}`}>
              <Identicon seed={ws.slug} className="chip-identicon" letters={letters} />
              {status !== "idle" && (
                <span className={"dot " + (STATUS[status]?.dot || "s-idle") + (animate ? " pulse" : "")} />
              )}
            </button>
          );
        })}
      </div>
      <button className="rail-btn" onClick={onNew} title="New workspace">
        <Icon name="plus" />
      </button>
      <button className={"rail-btn" + (view === "design-systems" ? " on" : "")}
              onClick={onOpenDesignSystems} title="Design systems">
        <Icon name="palette" />
      </button>
      <button className={"rail-btn" + (view === "settings" ? " on" : "")}
              onClick={onOpenSettings} title="Settings">
        <Icon name="settings" />
      </button>
    </aside>
  );
}

// ═══════════════════════════════════════════════════════════════
// DASHBOARD
// ═══════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════
// SETTINGS — app-level defaults + agent availability
// ═══════════════════════════════════════════════════════════════

function SettingsView() {
  const [agents, setAgents] = useState(null);
  const [settings, setSettings] = useState(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    let dead = false;
    const load = () => fetchJson("/api/agents").then((d) => {
      if (dead) return;
      const list = d.agents || [];
      setAgents(list);
      if (list.some((a) => a.pending)) setTimeout(load, 1000);
    }).catch(() => !dead && setAgents([]));
    load();
    fetchJson("/api/settings").then((d) => setSettings(d.settings)).catch(() => {});
    return () => { dead = true; };
  }, []);
  const save = async (patch) => {
    const d = await patchJson("/api/settings", patch);
    setSettings(d.settings);
    setSaved(true);
    setTimeout(() => setSaved(false), 1600);
  };
  const eng = settings?.default_agent_engine || "";
  const engInfo = (agents || []).find((a) => a.id === eng);
  return (
    <div className="dash">
      <div className="dash-inner">
        <div className="dash-head">
          <div>
            <div className="eyebrow" style={{ marginBottom: 12 }}>OpenWright</div>
            <h1 className="dash-title">Settings</h1>
            <p className="dash-sub">Defaults for new workspaces. Each workspace can override its agent and model in workspace settings.</p>
          </div>
          <span className={"set-saved" + (saved ? " show" : "")}><Icon name="check" /> Saved</span>
        </div>

        <div className="set-section">
          <h2 className="set-section-title">Default agent</h2>
          <p className="set-section-sub">New workspaces start on this engine. Pick an engine card, then optionally pin a model.</p>
          <div className="set-agents">
            {agents === null && <div className="set-empty"><Spinner style={{ width: 14, height: 14 }} /> Probing engines…</div>}
            {(agents || []).map((a) => (
              <AgentCard key={a.id} agent={a} active={a.id === eng}
                         onPick={() => save({ default_agent_engine: a.id })} />
            ))}
          </div>
        </div>

        <div className="set-section">
          <h2 className="set-section-title">Accent color</h2>
          <p className="set-section-sub">Drives buttons, highlights, and the logo.</p>
          <div className="set-accents">
            {ACCENTS.map((a) => {
              const light = a.hex === "#F5F5F7" || a.hex === "#FFD60A";
              return (
                <button key={a.hex} title={a.name}
                        className={"set-accent" + ((settings?.accent_color || "#ff5a1f") === a.hex ? " active" : "") + (light ? " is-light" : "")}
                        style={{ background: a.hex }}
                        onClick={async () => { await save({ accent_color: a.hex }); applyAccent(a.hex); }}>
                  {(settings?.accent_color || "#ff5a1f") === a.hex && <Icon name="check" />}
                </button>
              );
            })}
          </div>
        </div>

        <div className="set-section">
          <h2 className="set-section-title">Default model</h2>
          <p className="set-section-sub">Models the selected engine reports as available right now.</p>
          <select className="field set-model" value={settings?.default_agent_model || ""}
                  onChange={(e) => save({ default_agent_model: e.target.value })}>
            <option value="">{engInfo ? `Engine default · ${engInfo.label}` : "Engine default"}</option>
            {(engInfo?.models || []).filter(Boolean).map((m) => <option key={m} value={m}>{m}</option>)}
            {settings?.default_agent_model && !(engInfo?.models || []).includes(settings.default_agent_model) && (
              <option value={settings.default_agent_model}>{settings.default_agent_model}</option>
            )}
          </select>
        </div>
      </div>
    </div>
  );
}

function AgentCard({ agent: a, active, onPick }) {
  const [verifying, setVerifying] = useState(false);
  const [verdict, setVerdict] = useState(null);   // {ok, detail}
  return (
    <div className={"set-agent" + (active ? " active" : "") + (a.ok ? "" : " unavailable")}
         role="button" tabIndex={0} onClick={onPick}
         onKeyDown={(e) => { if (e.key === "Enter") onPick(); }}>
      <span className="set-agent-top">
        {a.pending
          ? <Spinner style={{ width: 10, height: 10 }} />
          : <span className={"set-agent-dot" + ((verdict ? verdict.ok : a.ok) ? " ok" : "")} />}
        <span className="set-agent-name">{a.label}</span>
        {active && <Icon name="check" />}
      </span>
      <span className="set-agent-detail">{verdict ? verdict.detail : a.detail}</span>
      {a.id === "copilot" && (
        <button className="set-agent-verify"
                disabled={verifying}
                onClick={async (e) => {
                  e.stopPropagation();
                  setVerifying(true);
                  try {
                    const r = await postJson("/api/agents/copilot/verify", {});
                    setVerdict(r);
                    showToast(r.detail || (r.ok ? "Copilot signed in" : "Copilot not signed in"), r.ok ? "ok" : "bad");
                  }
                  catch (err) { setVerdict({ ok: false, detail: "check failed: " + err.message }); }
                  finally { setVerifying(false); }
                }}>
          {verifying && <Spinner style={{ width: 12, height: 12 }} />}
          {verifying ? " Checking… (sends one tiny request)" : "Verify auth"}
        </button>
      )}
    </div>
  );
}

function Dashboard({ workspaces, onOpen, onNew, onMenu }) {
  const [q, setQ] = useState("");
  // Server orders by recent activity, so live workspaces lead the
  // grid — an explicit Active filter was empty noise at this scale.
  const list = workspaces.filter((w) =>
    !q || w.name.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="dash">
      <div className="dash-inner">
        <div className="dash-head">
          <div>
            <div className="eyebrow" style={{ marginBottom: 12 }}>OpenWright</div>
            <h1 className="dash-title">Workspaces</h1>
            <p className="dash-sub">Each workspace is a sandbox on the host where the agent works — drop in files, notes, and context, then generate artifacts.</p>
          </div>
          <button className="btn btn-primary" onClick={onNew}><Icon name="plus" /> New workspace</button>
        </div>
        <div className="dash-tools">
          <div className="search">
            <Icon name="search" />
            <input placeholder="Search workspaces…" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
        </div>
        <div className="pod-grid">
          {list.map((ws) => <PodCard key={ws.id} ws={ws} onOpen={onOpen} onMenu={onMenu} />)}
          <div className="pod-card pod-new fade-up" onClick={onNew}>
            <div className="plus"><Icon name="plus" style={{ width: 22, height: 22 }} /></div>
            <div>
              <div style={{ fontWeight: 600, color: "var(--wp-fg)" }}>New workspace</div>
              <div style={{ fontSize: 12.5, marginTop: 4 }}>Start an empty workspace</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function StatusPill({ status }) {
  if (status === "idle") return null;
  const s = STATUS[status];
  if (!s) return null;
  return (
    <span className={"pill " + s.pill}>
      <span className={"pdot " + s.dot + (status === "running" || status === "queued" ? " pulse" : "")} />
      {s.label}
    </span>
  );
}

function PodCard({ ws, onOpen, onMenu }) {
  // The dashboard list payload includes summary counts + the latest
  // artifact path; live preview of file names requires a workspace fetch.
  const [files, setFiles] = useState(null);
  const [latestGen, setLatestGen] = useState(null);
  const [gens, setGens] = useState(null);
  useEffect(() => {
    let cancelled = false;
    fetchJson(`/api/workspaces/${ws.slug}`).then((d) => {
      if (cancelled) return;
      setFiles(d.files || []);
      const list = d.generations || [];
      setGens(list);
      setLatestGen(list.find((g) => g.artifact_path && g.status === "done") || list[0] || null);
      // Also stash on the workspace ref for the dashboard's active
      // filter. NOTE: the 5s poll replaces ws objects, so the stash
      // is best-effort — component state is the source of truth here
      // (the old stash-only approach made the status pill vanish on
      // the first poll after load).
      ws._gens = list;
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [ws.slug, ws.gen_count, ws.file_count, ws.active_gen_id]);

  const preview = (files || []).slice(0, 3);
  const extra = (files?.length || 0) - preview.length;
  const status = ws.active_gen_status || podStatus(gens || []);
  return (
    <div className="pod-card fade-up" onClick={() => onOpen(ws.slug)}>
      <button className="icon-btn pod-menu-btn" onClick={(e) => onMenu(e, ws)}>
        <Icon name="more-horizontal" />
      </button>
      <div className="pod-card-top">
        <Identicon seed={ws.slug} className="card-identicon" letters={initialsFor(ws.name || ws.slug)} />
        <div style={{ minWidth: 0 }}>
          <div className="pod-name">{ws.name}</div>
          <div className="pod-meta">
            {ws.file_count || 0} file{(ws.file_count || 0) === 1 ? "" : "s"} · {ws.gen_count || 0} run{(ws.gen_count || 0) === 1 ? "" : "s"} · {fmtTime(ws.created_at)}
          </div>
        </div>
      </div>
      <div className="pod-files">
        {preview.length === 0 && (
          <div className="pod-file" style={{ color: "var(--wp-fg-faint)" }}>
            <Icon name="file-plus" />
            <span className="nm">No files yet</span>
          </div>
        )}
        {preview.map((f) => {
          const k = KIND[fileKind(f.name, f.mimetype)] || KIND.doc;
          return (
            <div className="pod-file" key={f.id}>
              <Icon name={k.icon} className={k.cls} />
              <span className="nm">{f.name}</span>
            </div>
          );
        })}
        {extra > 0 && <div className="pod-more-files">+{extra} more</div>}
      </div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        {/* Pills show exceptions plus the 30-minute fresh window —
            exactly the states the rail dot shows. */}
        <StatusPill status={status} />
        {ws.active_gen_id && (
          <Heartbeat
            startedAt={ws.active_gen_started_at}
            lastMessageAt={ws.active_gen_last_message_at}
            phase={ws.active_gen_phase}
            compact />
        )}
      </div>
      <div className="pod-foot">
        {latestGen && latestGen.artifact_path ? (
          <div className="pod-artifact">
            <Icon name="monitor-play" style={{ width: 15, height: 15, color: "var(--wp-accent)" }} />
            <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 150 }}>
              {normPath(latestGen.artifact_path).split("/").pop()}
            </span>
            {latestGen.artifact_version && (
              <span className="vtag">v{latestGen.artifact_version}</span>
            )}
          </div>
        ) : (
          <div className="pod-artifact" style={{ color: "var(--wp-fg-faint)" }}>
            <Icon name="sparkles" style={{ width: 15, height: 15 }} />
            <span>No artifacts yet</span>
          </div>
        )}
        <span className="pod-open">Open <Icon name="arrow-right" style={{ width: 14, height: 14 }} /></span>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// NEW WORKSPACE MODAL
// ═══════════════════════════════════════════════════════════════

function NewWorkspaceModal({ onClose, onCreated }) {
  const [name, setName] = useState("");
  const [engine, setEngine] = useState("");
  const [agents, setAgents] = useState([]);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef(null);
  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => {
    fetchJson("/api/agents")
      .then((d) => { setAgents(d.agents || []); setEngine((e) => e || d.default || "claude"); })
      .catch(() => {});
  }, []);
  const submit = async (e) => {
    e?.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      const d = await postJson("/api/workspaces", { name: name.trim(), agent_engine: engine || undefined });
      onCreated(d.workspace);
    } catch (e) { alert("create failed: " + e.message); }
    finally { setBusy(false); }
  };
  return (
    <div className="scrim" onClick={onClose}>
      <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h3>New workspace</h3>
        <p>A workspace is a folder on this host. Drop files into it, then generate an artifact.</p>
        <input ref={inputRef} className="field" placeholder="e.g. Q3 board review"
               value={name} onChange={(e) => setName(e.target.value)} />
        <div className="ws-options">
          <label className="opt">
            <span>
              <span className="opt-label">Agent</span>
              <span className="opt-sub">Engine and model can be changed later in workspace settings.</span>
            </span>
            <select className="ws-settings-select" value={engine} onChange={(e) => setEngine(e.target.value)}>
              {agents.length === 0 && <option value="">detecting…</option>}
              {agents.map((a) => (
                <option key={a.id} value={a.id} disabled={!a.ok}>{a.label}{a.ok ? "" : " (not set up)"}</option>
              ))}
            </select>
          </label>
        </div>
        <div className="modal-foot">
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={busy || !name.trim()}>
            <Icon name="plus" /> Create
          </button>
        </div>
      </form>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// WORKSPACE VIEW (3-pane)
// ═══════════════════════════════════════════════════════════════

function WorkspaceView({ slug, wsTab, setWsTab, onBack, onChange }) {
  const [data, setData] = useState(null);
  const [activeGen, setActiveGen] = useState(null);
  const [activeArtifactId, setActiveArtifactId] = useState(null);
  const [composerBusy, setComposerBusy] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [newArtifactOpen, setNewArtifactOpen] = useState(false);
  // When Generate is hit with no artifact yet, stash the prompt, make
  // the user create+type an artifact, then run it on the new artifact.
  const [pendingPrompt, setPendingPrompt] = useState(null);
  // On mobile the agent pane's visibility is the Files/Agent tab, not
  // the drawer flag — open/close must drive both or taps appear dead.
  const openAgent = useCallback(() => { setDrawerOpen(true); setWsTab("agent"); }, [setWsTab]);
  const closeAgent = useCallback(() => { setDrawerOpen(false); setWsTab("files"); }, [setWsTab]);

  const refresh = useCallback(async () => {
    try {
      const d = await fetchJson(`/api/workspaces/${slug}`);
      setData(d);
      // Auto-select the most recent generation when there's any.
      if (d.generations?.length && (activeGen == null ||
          !d.generations.find((g) => g.id === activeGen))) {
        setActiveGen(d.generations[0].id);
      }
      onChange?.();
    } catch (e) { /* swallow */ }
  }, [slug, activeGen, onChange]);

  useEffect(() => { refresh(); }, [slug]);

  // Kick a generation against a specific artifact and follow it.
  const runGeneration = useCallback(async (artifactId, prompt, fresh = false) => {
    setComposerBusy(true);
    openAgent();
    try {
      const d = await postJson(`/api/workspaces/${slug}/generate`,
        { prompt: prompt?.trim() || undefined, fresh, artifact_id: artifactId });
      setActiveArtifactId(d.artifact_id || artifactId);
      setActiveGen(d.generation_id);
      refresh();
    } catch (e) { alert("kickoff failed: " + e.message); }
    finally { setComposerBusy(false); }
  }, [slug, refresh, openAgent]);

  const createArtifact = useCallback(async ({ name, artifact_type }) => {
    const d = await postJson(`/api/workspaces/${slug}/artifacts`, { name, artifact_type });
    setNewArtifactOpen(false);
    const newId = d.artifact.id;
    setActiveArtifactId(newId);
    setActiveGen(null);
    await refresh();
    // If this artifact was created because the user hit Generate with
    // none yet, run their prompt now against the new artifact.
    if (pendingPrompt !== null) {
      const pp = pendingPrompt;
      setPendingPrompt(null);
      await runGeneration(newId, pp);
    }
  }, [slug, refresh, pendingPrompt, runGeneration]);

  // Active run drives the polling cadence.
  // Fall back to the workspace's live run: without this, opening the
  // shelf mid-run (nothing explicitly selected) showed an idle
  // composer that could start a second concurrent generation.
  const activeGenRow = data?.generations?.find((g) => g.id === activeGen)
    || data?.generations?.find((g) => ["queued", "running", "awaiting_user"].includes(g.status));
  useEffect(() => {
    if (!activeGenRow) return;
    const s = activeGenRow.status;
    if (s === "running" || s === "queued" || s === "awaiting_user") {
      const id = setInterval(refresh, 1500);
      return () => clearInterval(id);
    }
  }, [activeGenRow?.status, refresh]);

  if (!data) {
    return <div className="ws-main"><div className="empty">loading…</div></div>;
  }
  const ws = data.workspace;
  const files = data.files || [];
  const allGenerations = data.generations || [];
  const artifacts = data.artifacts || [];

  // Pick a default active artifact: stick with the explicit selection
  // if it still exists, otherwise prefer the artifact the active gen
  // belongs to, otherwise the most-recently-touched artifact (by latest
  // gen id), otherwise the first artifact.
  let resolvedArtifactId = activeArtifactId;
  if (resolvedArtifactId && !artifacts.find((a) => a.id === resolvedArtifactId)) {
    resolvedArtifactId = null;
  }
  if (!resolvedArtifactId) {
    const activeGenRow0 = allGenerations.find((g) => g.id === activeGen);
    if (activeGenRow0?.artifact_id) {
      resolvedArtifactId = activeGenRow0.artifact_id;
    } else if (allGenerations.length) {
      const withArt = allGenerations.find((g) => g.artifact_id);
      resolvedArtifactId = withArt ? withArt.artifact_id : (artifacts[0]?.id ?? null);
    } else {
      resolvedArtifactId = artifacts[0]?.id ?? null;
    }
  }
  const generations = resolvedArtifactId
    ? allGenerations.filter((g) => g.artifact_id === resolvedArtifactId)
    : allGenerations;

  // Split files vs notes for display
  const notes = files.filter((f) => f.mimetype === "text/markdown" || f.name.endsWith(".md"));
  const regularFiles = files.filter((f) => f.mimetype !== "text/markdown" && !f.name.endsWith(".md"));

  return (
    <>
      <div className="ws-tabs">
        <button className={wsTab === "files" ? "on" : ""} onClick={() => setWsTab("files")}>
          <Icon name="folder" /> Files
        </button>
        <button className={wsTab === "agent" ? "on" : ""}
                onClick={() => setWsTab(wsTab === "agent" ? "files" : "agent")}>
          {(() => {
            const st = (generations.find((g) =>
              ["queued", "running", "awaiting_user"].includes(g.status)) || {}).status;
            return st === "running" || st === "queued" ? <Spinner />
              : st === "awaiting_user" ? <Icon name="message-circle-question" />
              : <Icon name="bot" />;
          })()} Agent
        </button>
      </div>
      <div className="ws-main">
        <FilesPanel ws={ws} files={regularFiles} notes={notes} generations={generations}
                    artifacts={artifacts}
                    activeArtifactId={resolvedArtifactId}
                    onSelectArtifact={(id) => { setActiveArtifactId(id); setActiveGen(null); }}
                    onNewArtifact={() => setNewArtifactOpen(true)}
                    onBack={onBack} onChange={refresh}
                    onActivate={(id) => setActiveGen(id)}
                    onOpenAgent={openAgent}
                    agentOpen={drawerOpen}
                    onToggleAgent={() => (drawerOpen ? closeAgent() : openAgent())} />
      </div>
      {newArtifactOpen && <NewArtifactModal
        onClose={() => { setNewArtifactOpen(false); setPendingPrompt(null); }}
        onCreate={createArtifact} />}
      <AgentDrawer
        ws={ws} generation={activeGenRow}
        open={drawerOpen}
        onOpen={openAgent}
        onClose={closeAgent}
        hasPrior={generations.some((g) => g.status === "done" && g.artifact_path)}
        onGenerate={async (prompt, { fresh = false } = {}) => {
          // No artifact yet → make the user create+type one first, then
          // run their prompt against it (no silent Untitled default).
          if (!resolvedArtifactId) {
            setPendingPrompt(prompt ?? "");
            setNewArtifactOpen(true);
            return;
          }
          await runGeneration(resolvedArtifactId, prompt, fresh);
        }}
        busy={composerBusy}
        files={regularFiles} notes={notes}
        onReply={async (text) => {
          if (!activeGen) return;
          await postJson(`/api/generations/${activeGen}/reply`, { content: text });
          refresh();
        }}
        />
    </>
  );
}

// ═══════════════════════════════════════════════════════════════
// FILES PANEL
// ═══════════════════════════════════════════════════════════════

function WorkspaceSettingsButton({ ws, onChange, runActive }) {
  const { open, setOpen, toggle } = usePopover();
  return (
    <span className="ws-settings-wrap" onClick={(e) => e.stopPropagation()}>
      <button className="icon-btn ws-settings-btn"
              title="Workspace settings"
              onClick={toggle}>
        <Icon name="settings" />
      </button>
      {open && (
        <div className="ws-settings-pop">
          <InlineAgentSelect ws={ws} onChange={onChange} runActive={runActive} />
          <div className="ws-settings-row">
            <div className="ws-settings-label">
              <Icon name="palette" />
              <span>Design system</span>
            </div>
            <div className="ws-settings-control">
              <InlineDesignSystemSelect ws={ws} onChange={onChange} />
            </div>
          </div>
          <div className="ws-settings-row">
            <div className="ws-settings-label">
              <Icon name="message-square-text" />
              <span>Persona</span>
            </div>
            <div className="ws-settings-control">
              <select className="ws-settings-select" value={ws.persona || "terse-technical"}
                      onChange={async (e) => {
                        await patchJson(`/api/workspaces/${ws.slug}`, { persona: e.target.value });
                        onChange();
                      }}>
                <option value="terse-technical">Terse + technical</option>
                <option value="executive">Executive summary</option>
                <option value="detailed">Detailed</option>
                <option value="mixed-audience">Mixed audience</option>
              </select>
            </div>
          </div>
        </div>
      )}
    </span>
  );
}

// BYOA engine + model rows for the settings popover — each control
// gets its own labeled row, like every other row in the popover.
function InlineAgentSelect({ ws, onChange, runActive }) {
  const [agents, setAgents] = useState([]);
  useEffect(() => {
    let dead = false;
    const load = () => fetchJson("/api/agents").then((d) => {
      if (dead) return;
      const list = d.agents || [];
      setAgents(list);
      if (list.some((a) => a.pending)) setTimeout(load, 1000);
    }).catch(() => !dead && setAgents([]));
    load();
    return () => { dead = true; };
  }, []);
  const cur = ws.agent_engine || "claude";
  const curInfo = agents.find((a) => a.id === cur);
  return (
    <>
      <div className="ws-settings-row" style={{ alignItems: "flex-start" }}>
        <div className="ws-settings-label" style={{ marginTop: 7 }}>
          <Icon name="bot" />
          <span>Agent</span>
        </div>
        <div className="ws-settings-control" style={{ flexDirection: "column", alignItems: "stretch", gap: 4 }}>
          <select className="ws-settings-select" value={cur}
                  onChange={async (e) => {
                    await patchJson(`/api/workspaces/${ws.slug}`, { agent_engine: e.target.value });
                    onChange();
                  }}>
            {agents.length === 0 && <option value={cur}>{cur}</option>}
            {agents.map((a) => (
              <option key={a.id} value={a.id}>{a.label}{a.ok ? "" : " (not set up)"}</option>
            ))}
          </select>
          {curInfo && (
            <span style={{ fontSize: 10.5, maxWidth: 220, lineHeight: 1.4, color: curInfo.ok ? "var(--wp-fg-faint)" : "var(--um-warning)" }}>
              {curInfo.detail}
            </span>
          )}
        </div>
      </div>
      <div className="ws-settings-row">
        <div className="ws-settings-label">
          <Icon name="sparkles" />
          <span>Model</span>
        </div>
        <div className="ws-settings-control">
          <select className="ws-settings-select" style={{ width: "100%" }}
                  value={ws.agent_model || ""}
                  onChange={async (e) => {
                    await patchJson(`/api/workspaces/${ws.slug}`, { agent_model: e.target.value });
                    onChange();
                  }}>
            <option value="">Default model</option>
            {(curInfo?.models || []).filter(Boolean).map((m) => <option key={m} value={m}>{m}</option>)}
            {ws.agent_model && !(curInfo?.models || []).includes(ws.agent_model) && (
              <option value={ws.agent_model}>{ws.agent_model}</option>
            )}
          </select>
        </div>
      </div>
      {runActive && (
        <div style={{ fontSize: 10.5, color: "var(--wp-warn)", lineHeight: 1.45, padding: "2px 10px 6px" }}>
          A run is active: switching takes effect on the agent's next turn
          (its next reply or restart), not mid-thought.
        </div>
      )}
    </>
  );
}

function InlineDesignSystemSelect({ ws, onChange }) {
  const [systems, setSystems] = useState([]);
  useEffect(() => {
    fetchJson("/api/design-systems")
      .then((d) => setSystems(d.design_systems || []))
      .catch(() => setSystems([]));
  }, []);
  // A design system dresses both mediums now, so every system is
  // selectable regardless of the workspace's artifact type — the
  // variant is chosen at render time.
  let currentId = ws.design_system_id;
  if (!currentId && systems.length) {
    const bySlug = systems.find((s) => s.slug === (ws.theme || "oneshot"));
    currentId = (bySlug || systems[0]).id;
  }
  return (
    <select className="ws-settings-select" value={currentId || ""}
            onChange={async (e) => {
              await patchJson(`/api/workspaces/${ws.slug}`, { design_system_id: Number(e.target.value) });
              onChange();
            }}>
      {systems.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
    </select>
  );
}

function ArtifactSelector({ ws, artifacts, activeArtifactId, onSelect, onChange, onNewArtifact, runActive }) {
  const { open, setOpen, toggle } = usePopover();
  const active = artifacts.find((a) => a.id === activeArtifactId);
  // While a run is in flight, the active artifact is locked — switching,
  // creating, renaming, or deleting mid-build would orphan the run.
  const create = () => { if (runActive) return; setOpen(false); onNewArtifact?.(); };
  const rename = async () => {
    if (runActive) return;
    setOpen(false);
    if (!active) return;
    const name = prompt(`Rename artifact "${active.name}" to:`, active.name);
    if (!name || !name.trim() || name.trim() === active.name) return;
    try {
      await patchJson(`/api/workspaces/${ws.slug}/artifacts/${active.id}`, { name: name.trim() });
      await onChange?.();
    } catch (e) { alert("rename failed: " + e.message); }
  };
  const remove = async () => {
    if (runActive) return;
    setOpen(false);
    if (!active) return;
    if (!confirm(`Delete artifact "${active.name}"? Its versions stay on disk but the chat history is severed.`)) return;
    try {
      await del(`/api/workspaces/${ws.slug}/artifacts/${active.id}`);
      onSelect?.(null);
      await onChange?.();
    } catch (e) { alert("delete failed: " + e.message); }
  };
  return (
    <span className="ws-chip ws-chip-artifact on" onClick={(e) => e.stopPropagation()}>
      <Icon name={artifactTypeIcon(active?.artifact_type)} />
      <button className="ws-chip-artifact-btn" onClick={toggle}>
        {active ? active.name : "No artifact"}
        <Icon name="chevron-down" style={{ width: 10, height: 10, marginLeft: 4 }} />
      </button>
      {open && (
        <div className="vhist ws-artifact-menu">
          <div className="eyebrow" style={{ padding: "4px 8px 8px" }}>Artifacts</div>
          {runActive && (
            <div className="art-lock-note">
              <Icon name="lock" style={{ width: 12, height: 12 }} />
              Locked while the agent is working
            </div>
          )}
          {artifacts.map((a) => {
            const locked = runActive && a.id !== activeArtifactId;
            return (
            <div className={"vrow" + (a.id === activeArtifactId ? " cur" : "") + (locked ? " is-locked" : "")} key={a.id}
              onClick={() => { if (locked) return; setOpen(false); onSelect?.(a.id); }}>
              <Icon name={artifactTypeIcon(a.artifact_type)} className="vrow-type-ic" />
              <div className="vmain">
                <div className="vlabel">
                  {a.name}
                  <span className="art-type-tag">{artifactTypeTag(a.artifact_type)}</span>
                  {a.gen_count > 0 && <span className="eyebrow">{a.gen_count} run{a.gen_count === 1 ? "" : "s"}</span>}
                </div>
                {a.latest_version && <div className="vtime">v{a.latest_version}</div>}
              </div>
            </div>
            );
          })}
          {!runActive && (
          <div className="vrow" onClick={create}>
            <span className="vdot" style={{ background: "transparent", border: "1px dashed var(--wp-fg-faint)" }} />
            <div className="vmain"><div className="vlabel">+ New artifact</div></div>
          </div>
          )}
          {active && !runActive && (
            <>
              <div className="vrow" onClick={rename}>
                <Icon name="edit-3" style={{ width: 12, height: 12, opacity: 0.6 }} />
                <div className="vmain"><div className="vlabel">Rename "{active.name}"</div></div>
              </div>
              <div className="vrow" onClick={remove}>
                <Icon name="trash-2" style={{ width: 12, height: 12, color: "var(--um-negative)" }} />
                <div className="vmain"><div className="vlabel" style={{ color: "var(--um-negative)" }}>Delete "{active.name}"</div></div>
              </div>
            </>
          )}
        </div>
      )}
    </span>
  );
}

// Name + medium picker for a new artifact. Medium is the artifact's own
// property now (a workspace can hold both decks and documents), so it's
// chosen here at creation time rather than once per workspace.
function NewArtifactModal({ onClose, onCreate }) {
  const [name, setName] = useState("");
  const [type, setType] = useState("deck");
  const [busy, setBusy] = useState(false);
  const inputRef = useRef(null);
  useEffect(() => { inputRef.current?.focus(); }, []);
  const submit = async (e) => {
    e?.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true);
    try { await onCreate({ name: name.trim(), artifact_type: type }); }
    catch (e2) { alert("create failed: " + e2.message); setBusy(false); }
  };
  return (
    <div className="scrim" onClick={onClose}>
      <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h3>New artifact</h3>
        <input ref={inputRef} className="field" placeholder="e.g. Q3 Board Review"
               value={name} onChange={(e) => setName(e.target.value)} />
        <div className="ws-options">
          <label className="opt">
            <span className="opt-label">Type</span>
            <select className="ws-settings-select" value={type} onChange={(e) => setType(e.target.value)}>
              <option value="deck">Deck</option>
              <option value="document">Document</option>
              <option value="spreadsheet">Spreadsheet</option>
            </select>
          </label>
        </div>
        <div className="modal-foot">
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={!name.trim() || busy}>
            <Icon name="plus" /> {busy ? "Creating…" : "Create artifact"}
          </button>
        </div>
      </form>
    </div>
  );
}

function FilesPanel({ ws, files, notes, generations, artifacts, activeArtifactId,
                       onSelectArtifact, onNewArtifact, onBack, onChange, onActivate, onOpenAgent,
                       agentOpen, onToggleAgent }) {
  // Expanded = the artifact card (and its section header) escape the
  // standard measure to the full window; remembered per browser.
  const [expanded, setExpanded] = useState(() => localStorage.getItem("ow-preview-expanded") === "1");
  const toggleExpanded = () => setExpanded((x) => {
    localStorage.setItem("ow-preview-expanded", x ? "0" : "1");
    return !x;
  });
  const [over, setOver] = useState(false);
  const fileInput = useRef(null);
  const [noteModal, setNoteModal] = useState(false);
  const status = podStatus(generations);

  const upload = async (fileList) => {
    if (!fileList || !fileList.length) return;
    const fd = new FormData();
    for (const f of fileList) fd.append("files", f);
    try {
      await fetch(`/api/workspaces/${ws.slug}/files`, { method: "POST", body: fd });
      onChange();
    } catch (e) { alert("upload failed: " + e.message); }
  };

  const removeFile = async (id) => {
    if (!confirm("Remove this file?")) return;
    await del(`/api/workspaces/${ws.slug}/files/${id}`);
    onChange();
  };

  const allArtifacts = generations.filter((g) => g.artifact_path);
  // Run state must come from the FULL generations list — a freshly
  // kicked-off run has no artifact_path yet, so deriving busy-ness from
  // allArtifacts misses exactly the window where the UI should lock.
  const wsRunActive = generations.some((g) =>
    ["queued", "running", "awaiting_user"].includes(g.status));

  return (
    <div className="files-panel">
      <div className="panel-head">
        <button className="icon-btn" onClick={onBack} title="All workspaces">
          <Icon name="arrow-left" />
        </button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="crumb">
            <a className="crumb-trail" onClick={onBack}>Workspaces</a>
            <Icon name="chevron-right" className="crumb-trail" style={{ width: 13, height: 13 }} />
            <span className="cur">{ws.name}</span>
            <span className="crumb-status">
              <StatusPill status={status} />
              {(() => {
                const active = generations.find((g) =>
                  g.status === "running" || g.status === "queued" || g.status === "awaiting_user");
                if (!active) return null;
                return <Heartbeat
                  startedAt={active.started_at}
                  lastMessageAt={active.last_message_at}
                  phase={active.phase} />;
              })()}
            </span>
            <span className="ws-settings">
              <ArtifactSelector ws={ws} artifacts={artifacts || []}
                                activeArtifactId={activeArtifactId}
                                onSelect={onSelectArtifact}
                                onNewArtifact={onNewArtifact}
                                runActive={wsRunActive}
                                onChange={onChange} />
              <WorkspaceSettingsButton ws={ws} onChange={onChange} runActive={wsRunActive} />
            </span>
          </div>
        </div>
        <button className={"btn btn-primary agent-open-btn" + (agentOpen ? " on" : "")}
                title={agentOpen ? "Close the agent panel" : "Open the agent panel"}
                onClick={onToggleAgent}>
          {(status === "running" || status === "queued")
            ? <Spinner />
            : status === "awaiting_user"
              ? <Icon name="message-circle-question" />
              : <Icon name="bot" />}
          Agent
        </button>
      </div>
      <div className="files-body"
        onDragOver={(e) => { e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); upload(e.dataTransfer.files); }}>

        <div className={"sec-label" + (expanded ? " expanded" : "")} style={{ marginTop: 0 }}>
          <span className="eyebrow">Artifacts</span>
          {allArtifacts.length > 0 && <span className="fmeta">version controlled</span>}
        </div>
        {allArtifacts.length > 0 ? (
          <ArtifactCard
            expanded={expanded} onToggleExpanded={toggleExpanded}
            artifactType={(artifacts.find((a) => a.id === activeArtifactId)?.artifact_type) || "deck"}
            artifacts={allArtifacts}
            runActive={wsRunActive}
            designSystemId={ws.design_system_id}
            onOpen={(g) => onActivate(g.id)}
            onRefresh={onChange}
            onRunStarted={(genId) => { if (genId) onActivate(genId); onOpenAgent(); }} />
        ) : artifacts.length === 0 ? (
          <div className="dropzone" style={{ borderStyle: "solid" }}>
            <div className="dz-title">{wsRunActive ? "Working…" : "No artifacts yet"}</div>
            <div className="dz-sub">
              {wsRunActive
                ? <>The agent is working. The first version will appear here when it lands.</>
                : <>An artifact is one deliverable — a deck, a document, or a spreadsheet. Create one,
                    then add a prompt and hit <strong style={{ color: "var(--wp-fg)" }}> Generate</strong>.</>}
            </div>
            {wsRunActive ? (
              <button className="btn btn-primary" style={{ marginTop: 14 }} onClick={onOpenAgent}>
                <Spinner /> Watch the agent
              </button>
            ) : (
              <button className="btn btn-primary" style={{ marginTop: 14 }} onClick={onNewArtifact}>
                <Icon name="plus" /> Create your first artifact
              </button>
            )}
          </div>
        ) : (
          // The workspace already has artifacts; this one just has no
          // built version yet — point at Generate (or show progress).
          <div className="dropzone" style={{ borderStyle: "solid" }}>
            <div className="dz-title">{wsRunActive ? "Building…" : "Nothing built yet"}</div>
            <div className="dz-sub">
              {wsRunActive
                ? <>The agent is building
                    {" "}{artifacts.find((a) => a.id === activeArtifactId)?.name
                      ? `“${artifacts.find((a) => a.id === activeArtifactId).name}”`
                      : "this artifact"}. The first version will appear here.</>
                : <>Add a prompt in the agent panel and hit
                    <strong style={{ color: "var(--wp-fg)" }}> Generate</strong> to build
                    {" "}{artifacts.find((a) => a.id === activeArtifactId)?.name
                      ? `“${artifacts.find((a) => a.id === activeArtifactId).name}”`
                      : "this artifact"}.</>}
            </div>
            <button className="btn btn-primary" style={{ marginTop: 14 }} onClick={onOpenAgent}>
              {wsRunActive ? <><Spinner /> Watch the agent</> : <><Icon name="bot" /> Open the agent</>}
            </button>
          </div>
        )}

        <div className="files-toolbar" style={{ marginTop: 28 }}>
          <button className="btn btn-ghost" onClick={() => fileInput.current?.click()}>
            <Icon name="upload" /> Upload
          </button>
          <button className="btn btn-ghost" onClick={() => setNoteModal(true)}>
            <Icon name="sticky-note" /> Add note
          </button>
          <input ref={fileInput} type="file" multiple style={{ display: "none" }}
                 onChange={(e) => upload(e.target.files)} />
        </div>

        <div className="sec-label">
          <span className="eyebrow">Files</span>
          <span className="fmeta">{files.length} item{files.length === 1 ? "" : "s"}</span>
        </div>
        {files.length > 0 && (
          <div className="tree">
            {files.map((f) => <FileRow key={f.id} file={f} onDelete={removeFile} />)}
          </div>
        )}

        <div className={"dropzone" + (over ? " over" : "")} onClick={() => fileInput.current?.click()}>
          <div className="dz-title">
            <Icon name="upload-cloud" style={{ width: 16, height: 16, verticalAlign: "-3px", marginRight: 6 }} />
            Drop files here
          </div>
          <div className="dz-sub">They're written into the workspace on the host — the agent reads them instantly.</div>
        </div>

        {notes.length > 0 && (
          <>
            <div className="sec-label"><span className="eyebrow">Notes</span></div>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {notes.map((n) => <NoteRow key={n.id} note={n} onEdit={setNoteModal} onDelete={removeFile} />)}
            </div>
          </>
        )}
      </div>
      {noteModal && (
        <NoteModal slug={ws.slug} note={noteModal === true ? null : noteModal}
                   onClose={() => setNoteModal(false)}
                   onSaved={() => { setNoteModal(false); onChange(); }} />
      )}
    </div>
  );
}

function FileRow({ file, onDelete }) {
  const kind = fileKind(file.name, file.mimetype);
  const k = KIND[kind] || KIND.doc;
  return (
    <div className="node">
      <div className="row">
        <span className="ficon"><Icon name={k.icon} className={k.cls} /></span>
        <span className="fname" title={file.name}>{file.name}</span>
        {file.size != null && <span className="fmeta">{fmtBytes(file.size)}</span>}
        <span className="row-actions">
          <button className="icon-btn" title="Download"
            onClick={() => window.open(`/api/files/${file.id}`)}>
            <Icon name="download" />
          </button>
          <button className="icon-btn danger" title="Remove" onClick={() => onDelete(file.id)}>
            <Icon name="trash-2" />
          </button>
        </span>
      </div>
    </div>
  );
}

function NoteRow({ note, onEdit, onDelete }) {
  return (
    <div className="note fade-up">
      <Icon name="sticky-note" className="qico" />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="ntext">{note.name}</div>
        <div className="nmeta">NOTE · {fmtTime(note.uploaded_at)} · {fmtBytes(note.size)}</div>
      </div>
      <span className="row-actions">
        <button className="icon-btn" title="Edit" onClick={() => onEdit(note)}>
          <Icon name="pencil" />
        </button>
        <button className="icon-btn" title="Download"
          onClick={() => window.open(`/api/files/${note.id}`)}>
          <Icon name="download" />
        </button>
        <button className="icon-btn danger" title="Delete" onClick={() => onDelete(note.id)}>
          <Icon name="trash-2" />
        </button>
      </span>
    </div>
  );
}

// ─── version diff ───────────────────────────────────────────────
// Compare two versions of an artifact. Fully client-side: we already
// serve every version's rendered HTML (/preview/*) and its raw source
// (/api/artifacts/:id), so the diff needs no backend or schema changes.
const DIFF_MARK = " § ";  // sentinel prefix marking a slide/section boundary

// Pull an ordered token stream of visible text out of a version's HTML.
// Decks split into <section> slides; flow artifacts (doc/sheet) collapse
// to one "Content" group. Slide boundaries ride along as marker tokens so
// a single LCS pass aligns inserted/removed slides naturally.
async function extractTokens(genId) {
  const res = await fetch(`/api/artifacts/${genId}`);
  if (!res.ok) throw new Error("artifact fetch failed");
  const doc = new DOMParser().parseFromString(await res.text(), "text/html");
  // Walk every "leaf block" (a block-level element with no block descendant)
  // via the shared selector + leafLabel — div is included (decks hold stats
  // in styled divs) and images count via a filename surrogate, so an image
  // swap/add is a real diff, not invisible.
  const sections = Array.from(doc.querySelectorAll("section"));
  const groups = sections.length ? sections : [doc.body];
  const tokens = [];
  let slideNo = 0;
  groups.forEach((grp) => {
    const lines = [];
    grp.querySelectorAll(DIFF_BLOCK_SEL).forEach((el) => {
      if (el.querySelector(DIFF_BLOCK_SEL)) return;  // container — its leaf blocks carry the text
      const line = leafLabel(el);
      if (line) lines.push(line);
    });
    // Skip empty/spacer sections so slide numbers track content slides.
    if (!lines.length) return;
    tokens.push(DIFF_MARK + (sections.length ? `Slide ${++slideNo}` : "Content"));
    tokens.push(...lines);
  });
  return tokens;
}

// Classic LCS line diff → [{ t: 'eq'|'add'|'del', text }]. Inputs are
// short (a deck's worth of text lines), so the O(n·m) table is fine.
function lcsDiff(a, b) {
  const n = a.length, m = b.length;
  const dp = [];
  for (let i = 0; i <= n; i++) dp.push(new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const ops = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { ops.push({ t: "eq", text: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push({ t: "del", text: a[i] }); i++; }
    else { ops.push({ t: "add", text: b[j] }); j++; }
  }
  while (i < n) ops.push({ t: "del", text: a[i++] });
  while (j < m) ops.push({ t: "add", text: b[j++] });
  return ops;
}

function previewUrlFor(g) {
  const m = normPath(g?.artifact_path || "").match(/\/workspaces\/(.+)$/);
  return m ? `/preview/${m[1]}` : null;
}

// Element-level diff for the side-by-side highlight. Same leaf-block walk
// as the text view, but we keep the live element handle plus a cheap
// non-text fingerprint (tag + class + inline style) so a restyle with no
// text change is still caught.
const DIFF_BLOCK_SEL = "h1,h2,h3,h4,h5,h6,p,li,td,th,blockquote,figcaption,caption,dt,dd,div,header,footer";
function leafLabel(el) {
  // Visible text of a leaf block; falls back to an image surrogate (by
  // filename) so an image swap / add / removal registers instead of being
  // invisible to a text-only diff.
  const parts = [];
  el.childNodes.forEach((n) => { const t = (n.textContent || "").replace(/\s+/g, " ").trim(); if (t) parts.push(t); });
  let text = parts.join(" ").replace(/\s+/g, " ").trim();
  if (!text) {
    const img = el.querySelector("img");
    if (img) text = "▦ " + ((img.getAttribute("src") || "image").split("/").pop().split("?")[0]);
  }
  return text;
}
function sectionIndex(el) {
  const sec = el.closest && el.closest("section");
  if (!sec) return -1;
  return Array.prototype.indexOf.call(sec.ownerDocument.querySelectorAll("section"), sec);
}
function blockSig(el) {
  return [el.tagName, el.getAttribute("class") || "", el.getAttribute("style") || ""].join("|");
}
function collectBlocks(root) {
  const out = [];
  root.querySelectorAll(DIFF_BLOCK_SEL).forEach((el) => {
    if (el.querySelector(DIFF_BLOCK_SEL)) return;   // container — its leaves carry the text
    const text = leafLabel(el);
    if (!text) return;
    out.push({ el, text, sig: blockSig(el) });
  });
  return out;
}
// Leaf blocks contained within `el` (the granularity collectBlocks tracks).
function leavesIn(el) {
  const out = [];
  el.querySelectorAll(DIFF_BLOCK_SEL).forEach((c) => {
    if (c.querySelector(DIFF_BLOCK_SEL)) return;
    if (leafLabel(c)) out.push(c);
  });
  return out;
}
// Merge a cluster of same-type changed leaves into a single box ONLY when it
// collapses many fragments (e.g. a wholly-removed 33-cell console → one box).
// Below the threshold we keep each changed item boxed on its own, so two
// distinct stat cards stay two tight boxes instead of one loose region.
const DIFF_MERGE_MIN = 6;
function coalesceTargets(entries, root) {
  const changed = new Map(entries.map((e) => [e.el, e.cls]));
  const allSame = (parent, cls) => {
    const leaves = leavesIn(parent);
    return leaves.length > 0 && leaves.every((l) => changed.get(l) === cls);
  };
  const targets = new Map();
  const claimed = new Set();
  entries.forEach(({ el, cls }) => {
    if (claimed.has(el)) return;
    let node = el;
    while (node.parentElement && node.parentElement !== root && node.parentElement.tagName !== "BODY"
           && allSame(node.parentElement, cls)) {
      node = node.parentElement;
    }
    const grouped = leavesIn(node);
    if (node !== el && grouped.length >= DIFF_MERGE_MIN) {
      targets.set(node, cls);                       // dense cluster → one box
      grouped.forEach((l) => claimed.add(l));
      claimed.add(node);
    } else {
      targets.set(el, cls);                         // few items → box this one precisely
      claimed.add(el);
    }
  });
  return targets;
}
// LCS over block text, carrying source indices so ops map back to elements.
function diffBlocks(L, R) {
  const A = L.map((x) => x.text), B = R.map((x) => x.text);
  const n = A.length, m = B.length;
  const dp = []; for (let i = 0; i <= n; i++) dp.push(new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const ops = []; let i = 0, j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { ops.push({ t: "eq", ai: i, bi: j }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push({ t: "del", ai: i, bi: -1 }); i++; }
    else { ops.push({ t: "add", ai: -1, bi: j }); j++; }
  }
  while (i < n) ops.push({ t: "del", ai: i++, bi: -1 });
  while (j < m) ops.push({ t: "add", ai: -1, bi: j++ });
  return ops;
}
// Outline + an ::after wash painted ON TOP of the element (content included),
// so the tint shows over opaque images/cards instead of hiding behind them.
// The wash is light (~15%) so text stays readable; the outline gives a crisp
// edge. The element is made a positioning context in JS (static→relative only,
// a layout no-op) so the absolute ::after anchors to it.
const DIFF_HL_CSS = `
  .diff-hl { outline-offset: -2px !important; border-radius: 3px !important; }
  .diff-hl::after { content: ""; position: absolute; inset: 0; pointer-events: none; border-radius: inherit; z-index: 2147483646; }
  .diff-hl-del { outline: 2px solid rgba(248,81,73,0.95) !important; }
  .diff-hl-del::after { background: rgba(248,81,73,0.16) !important; }
  .diff-hl-add { outline: 2px solid rgba(63,185,80,0.95) !important; }
  .diff-hl-add::after { background: rgba(63,185,80,0.16) !important; }
  .diff-hl-mod { outline: 2px solid rgba(88,166,255,0.95) !important; }
  .diff-hl-mod::after { background: rgba(88,166,255,0.16) !important; }`;
function injectDiffStyle(doc) {
  if (doc.getElementById("diff-hl-style")) return;
  const s = doc.createElement("style");
  s.id = "diff-hl-style";
  s.textContent = DIFF_HL_CSS;
  (doc.head || doc.documentElement).appendChild(s);
}
// Tag changed elements in both live preview docs (red removed / green added /
// blue restyled). Outline-based so it never shifts the deck's layout.
function applyHighlights(leftDoc, rightDoc) {
  injectDiffStyle(leftDoc); injectDiffStyle(rightDoc);
  const L = collectBlocks(leftDoc.body), R = collectBlocks(rightDoc.body);
  const ops = diffBlocks(L, R);
  let add = 0, del = 0, mod = 0;
  const leftEntries = [], rightEntries = [];
  ops.forEach((o) => {
    if (o.t === "del") { if (L[o.ai]) { leftEntries.push({ el: L[o.ai].el, cls: "diff-hl-del" }); del++; } }
    else if (o.t === "add") { if (R[o.bi]) { rightEntries.push({ el: R[o.bi].el, cls: "diff-hl-add" }); add++; } }
    else {
      const le = L[o.ai], re = R[o.bi];
      if (le && re && le.sig !== re.sig) { leftEntries.push({ el: le.el, cls: "diff-hl-mod" }); rightEntries.push({ el: re.el, cls: "diff-hl-mod" }); mod++; }
    }
  });
  const slides = new Set();
  const applyPane = (doc, entries) => {
    const win = doc.defaultView;
    coalesceTargets(entries, doc.body).forEach((cls, el) => {
      el.classList.add("diff-hl", cls);
      // The ::after wash needs `el` as its positioning context. Only promote
      // static elements to relative (a layout no-op) — never touch elements
      // already positioned, so absolutely-positioned deck pieces don't move.
      try { if (win.getComputedStyle(el).position === "static") el.style.position = "relative"; } catch { /* noop */ }
      const si = sectionIndex(el);
      if (si >= 0) slides.add(si);
    });
  };
  applyPane(leftDoc, leftEntries);
  applyPane(rightDoc, rightEntries);
  const leftCount = leftDoc.querySelectorAll("section").length;
  const rightCount = rightDoc.querySelectorAll("section").length;
  // A slide position past one deck's count exists only in the other version —
  // surface those as added/removed stops so the panes never silently drift.
  for (let i = Math.min(leftCount, rightCount); i < Math.max(leftCount, rightCount); i++) slides.add(i);
  return { add, del, mod, leftCount, rightCount, slides: [...slides].sort((a, b) => a - b) };
}
// Group the text-token diff into slide sections so the "only changes" filter
// can drop sections with no edits.
function groupRows(diff) {
  const groups = [];
  let cur = null;
  (diff || []).forEach((o) => {
    if (o.text.startsWith(DIFF_MARK)) {
      cur = { marker: o, lines: [], changed: o.t !== "eq" };
      groups.push(cur);
    } else {
      if (!cur) { cur = { marker: null, lines: [], changed: false }; groups.push(cur); }
      cur.lines.push(o);
      if (o.t !== "eq") cur.changed = true;
    }
  });
  return groups;
}

function DiffModal({ artifacts, initialCompareId, onClose }) {
  // Only versions that actually produced an HTML artifact are comparable.
  const versions = useMemo(
    () => artifacts.filter((g) => g.artifact_path && /\.html$/i.test(normPath(g.artifact_path))),
    [artifacts],
  );
  const compIdx = Math.max(0, versions.findIndex((g) => g.id === initialCompareId));
  const [compareId, setCompareId] = useState(versions[compIdx]?.id);
  const [baseId, setBaseId] = useState((versions[compIdx + 1] || versions[compIdx])?.id);
  const [mode, setMode] = useState("changes");   // 'changes' | 'side'
  const [onlyChanges, setOnlyChanges] = useState(false);
  const [diff, setDiff] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [sideStats, setSideStats] = useState(null);
  const [changedPtr, setChangedPtr] = useState(0);   // pointer into sideStats.slides for the changed-slide stepper
  const [curSlide, setCurSlide] = useState(0);       // slide index both decks are currently showing

  const base = versions.find((g) => g.id === baseId);
  const comp = versions.find((g) => g.id === compareId);
  const same = baseId === compareId;

  // Text diff (Changes view).
  useEffect(() => {
    if (mode !== "changes" || !base || !comp || same) return;
    let cancelled = false;
    setLoading(true); setError(null); setDiff(null);
    Promise.all([extractTokens(base.id), extractTokens(comp.id)])
      .then(([a, b]) => { if (!cancelled) setDiff(lcsDiff(a, b)); })
      .catch(() => { if (!cancelled) setError("Couldn't load one of the versions."); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [mode, baseId, compareId, same]);

  // Side-by-side element highlight: tag changed elements once BOTH preview
  // iframes finish loading (deck-shell has upgraded the slides by then).
  const leftRef = useRef(null), rightRef = useRef(null);
  const loadedRef = useRef({ l: false, r: false });
  useEffect(() => { loadedRef.current = { l: false, r: false }; setSideStats(null); setChangedPtr(0); setCurSlide(0); }, [mode, baseId, compareId]);
  const onFrameLoad = (which) => {
    loadedRef.current[which] = true;
    if (!(loadedRef.current.l && loadedRef.current.r)) return;
    try {
      const ld = leftRef.current?.contentDocument, rd = rightRef.current?.contentDocument;
      if (ld?.body && rd?.body) setSideStats(applyHighlights(ld, rd));
    } catch { /* same-origin, so this shouldn't throw — fail quietly if it does */ }
  };
  // Changed-slide stepper: drive both decks to the same slide via the
  // deck-shell's workpod-goto message so the toggle works in this view too.
  const changedSlides = sideStats?.slides || [];
  const gotoBoth = (slideIdx) => {
    [leftRef, rightRef].forEach((r) => {
      try { r.current?.contentWindow?.postMessage({ type: "workpod-goto", index: slideIdx }, "*"); } catch { /* noop */ }
    });
  };
  useEffect(() => {
    if (mode === "side" && onlyChanges && changedSlides.length) {
      gotoBoth(changedSlides[Math.min(changedPtr, changedSlides.length - 1)]);
    }
  }, [mode, onlyChanges, changedPtr, sideStats]);
  // Keep both decks locked to the same slide: when either reports a slide
  // change, mirror it to the other (a guard stops the echo from looping).
  useEffect(() => {
    if (mode !== "side") return;
    let syncing = false;
    const onMsg = (e) => {
      const d = e.data;
      if (!d || d.type !== "workpod-slide" || typeof d.index !== "number") return;
      if (syncing) return;   // ignore the mirror's echo (incl. a clamped deck reporting a lower index)
      setCurSlide(d.index);
      const lw = leftRef.current?.contentWindow, rw = rightRef.current?.contentWindow;
      const target = e.source === lw ? rw : e.source === rw ? lw : null;
      if (!target) return;
      syncing = true;
      try { target.postMessage({ type: "workpod-goto", index: d.index }, "*"); } catch { /* noop */ }
      setTimeout(() => { syncing = false; }, 60);
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, [mode, baseId, compareId]);

  const stats = useMemo(() => {
    if (!diff) return { add: 0, del: 0 };
    let add = 0, del = 0;
    diff.forEach((o) => {
      if (o.text.startsWith(DIFF_MARK)) return;
      if (o.t === "add") add++; else if (o.t === "del") del++;
    });
    return { add, del };
  }, [diff]);

  const groups = useMemo(() => groupRows(diff), [diff]);
  const visibleGroups = useMemo(
    () => onlyChanges ? groups.filter((g) => g.changed) : groups,
    [groups, onlyChanges],
  );

  const vlabel = (g) => `v${g.artifact_version || g.id} · ${fmtTime(g.completed_at)}`;

  // Which slide the panes are showing. In stepper mode the target index is
  // authoritative (a deck without that slide clamps and can't report it);
  // otherwise trust the decks' own reports. A slide index past a deck's count
  // means that version simply has no such slide → show a placeholder there.
  const activeSlide = (mode === "side" && onlyChanges && changedSlides.length)
    ? changedSlides[Math.min(changedPtr, changedSlides.length - 1)]
    : curSlide;
  const leftMissing = !!sideStats && activeSlide >= sideStats.leftCount;
  const rightMissing = !!sideStats && activeSlide >= sideStats.rightCount;

  return (
    <div className="diff-overlay" onClick={onClose}>
      <div className="diff-modal" onClick={(e) => e.stopPropagation()}>
        <div className="diff-head">
          <div className="diff-title"><Icon name="git-compare" /> Compare versions</div>
          <button className="icon-btn" onClick={onClose} title="Close"><Icon name="x" /></button>
        </div>
        <div className="diff-controls">
          <label className="diff-pick">
            <span className="eyebrow">Base</span>
            <select value={baseId} onChange={(e) => setBaseId(Number(e.target.value))}>
              {versions.map((g) => <option key={g.id} value={g.id}>{vlabel(g)}</option>)}
            </select>
          </label>
          <Icon name="arrow-right" className="diff-arrow" />
          <label className="diff-pick">
            <span className="eyebrow">Compare</span>
            <select value={compareId} onChange={(e) => setCompareId(Number(e.target.value))}>
              {versions.map((g) => <option key={g.id} value={g.id}>{vlabel(g)}</option>)}
            </select>
          </label>
          <div className="diff-modes">
            <button className={"btn btn-ghost" + (mode === "changes" ? " on" : "")} onClick={() => setMode("changes")}>Changes</button>
            <button className={"btn btn-ghost" + (mode === "side" ? " on" : "")} onClick={() => setMode("side")}>Side by side</button>
          </div>
          <label className="diff-only" title="Show only the slides that changed">
            <input type="checkbox" checked={onlyChanges} onChange={(e) => setOnlyChanges(e.target.checked)} />
            Only changed
          </label>
        </div>
        {same ? (
          <div className="diff-empty">Pick two different versions to compare.</div>
        ) : mode === "side" ? (
          <>
            <div className="diff-legend">
              <span className="diff-key add">added</span>
              <span className="diff-key del">removed</span>
              <span className="diff-key mod">style changed</span>
              {onlyChanges ? (
                changedSlides.length ? (
                  <span className="diff-stepper">
                    <button className="btn btn-ghost" disabled={changedPtr <= 0} onClick={() => setChangedPtr((p) => Math.max(0, p - 1))}><Icon name="chevron-left" /></button>
                    Changed slide {changedPtr + 1} / {changedSlides.length} <span className="diff-key-note">(slide {changedSlides[changedPtr] + 1})</span>
                    <button className="btn btn-ghost" disabled={changedPtr >= changedSlides.length - 1} onClick={() => setChangedPtr((p) => Math.min(changedSlides.length - 1, p + 1))}><Icon name="chevron-right" /></button>
                  </span>
                ) : <span className="diff-key-note">{sideStats ? "No changed slides." : "Loading…"}</span>
              ) : (
                sideStats && <span className="diff-key-note">{sideStats.add} added · {sideStats.del} removed · {sideStats.mod} restyled · changes show as you flip to each slide</span>
              )}
            </div>
            <div className="diff-side">
              <div className="diff-pane">
                <div className="diff-pane-label">{base && vlabel(base)}</div>
                <div className="diff-pane-body">
                  <iframe key={`l-${baseId}-${compareId}`} ref={leftRef} onLoad={() => onFrameLoad("l")} src={previewUrlFor(base)} title="base version" sandbox="allow-scripts allow-same-origin" />
                  {leftMissing && (
                    <div className="diff-missing add">
                      <Icon name="plus-circle" />
                      <div>This slide is <b>new</b> in {comp && vlabel(comp)}</div>
                      <span className="diff-key-note">no counterpart in this version</span>
                    </div>
                  )}
                </div>
              </div>
              <div className="diff-pane">
                <div className="diff-pane-label">{comp && vlabel(comp)}</div>
                <div className="diff-pane-body">
                  <iframe key={`r-${baseId}-${compareId}`} ref={rightRef} onLoad={() => onFrameLoad("r")} src={previewUrlFor(comp)} title="compare version" sandbox="allow-scripts allow-same-origin" />
                  {rightMissing && (
                    <div className="diff-missing del">
                      <Icon name="minus-circle" />
                      <div>This slide was <b>removed</b> in {comp && vlabel(comp)}</div>
                      <span className="diff-key-note">it exists only in {base && vlabel(base)}</span>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </>
        ) : (
          <div className="diff-body">
            {loading && <div className="diff-empty">Computing differences…</div>}
            {error && <div className="diff-empty">{error}</div>}
            {diff && !loading && !error && (
              <>
                <div className="diff-stats">
                  <span className="diff-stat add">+{stats.add}</span>
                  <span className="diff-stat del">−{stats.del}</span>
                  {stats.add === 0 && stats.del === 0 && <span className="diff-stat muted">No text changes between these versions.</span>}
                </div>
                <div className="diff-lines">
                  {visibleGroups.length === 0 ? (
                    <div className="diff-empty">No changed slides.</div>
                  ) : visibleGroups.map((grp, gi) => {
                    const lines = onlyChanges ? grp.lines.filter((o) => o.t !== "eq") : grp.lines;
                    return (
                      <div key={gi}>
                        {grp.marker && (
                          <div className={"diff-slide " + grp.marker.t}>
                            {grp.marker.text.slice(DIFF_MARK.length)}{grp.marker.t === "add" ? " · new" : grp.marker.t === "del" ? " · removed" : ""}
                          </div>
                        )}
                        {lines.map((o, k) => (
                          <div key={k} className={"diff-line " + o.t}>
                            <span className="diff-gutter">{o.t === "add" ? "+" : o.t === "del" ? "−" : ""}</span>
                            <span className="diff-text">{o.text}</span>
                          </div>
                        ))}
                      </div>
                    );
                  })}
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function ArtifactCard({ artifacts, runActive, onOpen, onRefresh, onRunStarted, expanded, onToggleExpanded, artifactType, designSystemId }) {
  const isDoc = artifactType === "document";
  const isSheet = artifactType === "spreadsheet";
  // "Flow" mediums (document, spreadsheet) scroll, carry no slides, and
  // take artifact-level comments — unlike a slide deck.
  const isFlow = isDoc || isSheet;
  const { open, setOpen, toggle } = usePopover();
  const [compareOpen, setCompareOpen] = useState(false);
  // Current slide inside the preview iframe (0-based) — the deck shell
  // broadcasts workpod-slide messages on every slide change so the
  // quick-comment affordance targets the slide being viewed.
  const previewRef = useRef(null);
  const [curSlide, setCurSlide] = useState(0);
  // Title of the slide currently in view, captured so a comment can anchor to
  // the slide by content (not just a number that drifts as the deck changes).
  const [curSlideLabel, setCurSlideLabel] = useState("");
  const [commentsBump, setCommentsBump] = useState(0);
  // The deck iframe pops in white when it finishes loading — fade it
  // in instead. Reset whenever the underlying generation changes (the
  // key remounts the iframe, so onLoad fires again).
  const [previewLoaded, setPreviewLoaded] = useState(false);
  // The expand toggle only earns a place when expansion would
  // meaningfully widen the card (the standard measure is 1472px wide
  // inside 44px gutters) — a breakpoint guess showed it on laptops
  // where it visibly did nothing.
  const artifactRef = useRef(null);
  const [canExpand, setCanExpand] = useState(false);
  useEffect(() => {
    const el = artifactRef.current?.parentElement;
    if (!el) return;
    const measure = () => setCanExpand(el.clientWidth - 88 - 1472 > 192);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // Collapsing the tall preview brings uploads/files above the fold;
  // remembered per browser.
  const [previewHidden, setPreviewHidden] = useState(() => localStorage.getItem("ow-preview-hidden") === "1");
  const togglePreview = () => setPreviewHidden((h) => {
    localStorage.setItem("ow-preview-hidden", h ? "0" : "1");
    return !h;
  });

  useEffect(() => {
    const onMsg = (e) => {
      if (e?.data?.type !== "workpod-slide") return;
      if (previewRef.current && e.source !== previewRef.current.contentWindow) return;
      if (typeof e.data.index === "number") setCurSlide(e.data.index);
      if (typeof e.data.label === "string") setCurSlideLabel(e.data.label);
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, []);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editsDirty, setEditsDirty] = useState(false);
  // A run can kick off (from the agent panel) while the preview is being
  // edited — drop out of edit mode so the two don't fight over the file.
  useEffect(() => {
    if (runActive && editing) {
      previewRef.current?.contentWindow?.postMessage({ type: "workpod-edit-disable" }, "*");
      setEditing(false);
      setEditsDirty(false);
    }
  }, [runActive, editing]);
  // null = follow latest. Setting an id pins to that version.
  const [pinnedId, setPinnedId] = useState(null);
  useEffect(() => {
    // If the pinned version goes away, fall back to following latest.
    if (pinnedId && !artifacts.find((g) => g.id === pinnedId)) {
      setPinnedId(null);
    }
  }, [artifacts, pinnedId]);
  useEffect(() => {
    // Iframe announces the first user keystroke after edit-mode is on
    // → flip dirty so Save/Discard become prominent.
    const onMsg = (e) => { if (e.data?.type === "workpod-edit-dirty") setEditsDirty(true); };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, []);
  useEffect(() => { if (!editing) setEditsDirty(false); }, [editing]);
  const cur = pinnedId
    ? (artifacts.find((g) => g.id === pinnedId) || artifacts[0])
    : artifacts[0];
  useEffect(() => { setPreviewLoaded(false); }, [cur?.id, cur?.artifact_path, designSystemId]);
  if (!cur || !cur.artifact_path) return null;
  const latestId = artifacts[0]?.id;
  const isLatest = cur.id === latestId;
  const name = normPath(cur.artifact_path).split("/").pop();
  // HTML artifacts get a live preview iframe — the file IS the deck.
  // Derive the /preview/* URL by stripping the workspaces/ prefix from
  // the absolute path. Anything not matching .html falls through.
  const isHtml = /\.html$/i.test(name);
  let previewUrl = null;
  if (isHtml) {
    const m = normPath(cur.artifact_path).match(/\/workspaces\/(.+)$/);
    if (m) previewUrl = `/preview/${m[1]}`;
  }
  const wsSlug = (normPath(cur.artifact_path).match(/\/workspaces\/([^/]+)\//) || [])[1] || null;
  return (
    <div ref={artifactRef} className={"artifact fade-up" + (expanded ? " expanded" : "")}>
      {previewUrl && !previewHidden && (
        <div className={"artifact-preview" + (isFlow ? " is-doc" : "")}>
          {!previewLoaded && <div className="preview-loading"><Spinner style={{ width: 22, height: 22 }} /></div>}
          {/* cur.id in the src busts the iframe when a new generation
              lands on the SAME file (agents often edit deck-vN.html in
              place for comment rounds) — path alone never changes then,
              and the preview silently stayed stale until a manual
              refresh. */}
          <iframe ref={previewRef} key={`${previewUrl}#${cur.id}#${designSystemId}`} src={`${previewUrl}?_g=${cur.id}&_ds=${designSystemId}`} title="Live preview"
                  sandbox="allow-scripts allow-same-origin"
                  onLoad={() => setPreviewLoaded(true)}
                  style={{ opacity: previewLoaded ? 1 : 0,
                           transition: 'opacity 480ms var(--um-ease-out)' }} />
          {cur.artifact_id && (
            <QuickComment artifactId={cur.artifact_id} slideIndex={curSlide} slideLabel={curSlideLabel} isDoc={isFlow}
                          onAdded={() => setCommentsBump((b) => b + 1)} />
          )}
          <div className="preview-controls">
            {(canExpand || expanded) && (
              <button className="pc-btn expand-toggle"
                      title={expanded ? "Fit to the standard width" : "Expand to the full window"}
                      onClick={onToggleExpanded}>
                <Icon name={expanded ? "minimize-2" : "maximize-2"} />
              </button>
            )}
            <button className="pc-btn"
                    title="Hide the deck preview"
                    onClick={togglePreview}>
              <Icon name="chevron-up" />
            </button>
          </div>
        </div>
      )}
      <div className="artifact-head">
        <div className="artifact-ico"><Icon name="monitor-play" /></div>
        <div className="artifact-info" style={{ flex: 1, minWidth: 0 }}>
          <div className="artifact-name">
            <span className="artifact-fname">{name}</span>
          </div>
          <div className="artifact-sub">HTML · run #{cur.id} · {fmtTime(cur.completed_at)}{isLatest ? "" : " · viewing older version"}</div>
        </div>
        {previewUrl && previewHidden && (
          <button className="icon-btn preview-toggle"
                  title="Show the deck preview"
                  onClick={togglePreview}>
            <Icon name="chevron-down" />
          </button>
        )}
        {cur.artifact_id && <CommentsSection artifactId={cur.artifact_id} wsSlug={wsSlug} isDoc={isFlow}
                                             refreshKey={commentsBump}
                                             onKickedOff={(genId) => { onRefresh(); onRunStarted?.(genId); }}
                                             onJumpToSlide={(idx) => {
                                               previewRef.current?.contentWindow?.postMessage({ type: "workpod-goto", index: idx }, "*");
                                             }}
                                             runActive={runActive} />}
        <div className="vsel" onClick={(e) => e.stopPropagation()}>
          <button className="vsel-btn" onClick={toggle}>
            <Icon name="history" style={{ width: 13, height: 13 }} />
            v{cur.artifact_version || cur.id}
            <Icon name={open ? "chevron-up" : "chevron-down"} style={{ width: 12, height: 12 }} />
          </button>
          {open && (
            <div className="vhist">
              <div className="vhist-head">
                <span className="eyebrow">Version history</span>
                {artifacts.length >= 2 && (
                  <button className="vhist-compare" onClick={() => { setOpen(false); setCompareOpen(true); }}>
                    <Icon name="git-compare" style={{ width: 12, height: 12 }} /> Compare
                  </button>
                )}
              </div>
              {artifacts.map((g) => {
                return (
                  <div className={"vrow" + (g.id === cur.id ? " cur" : "")} key={g.id}
                    onClick={() => {
                      setOpen(false);
                      setPinnedId(g.id === latestId ? null : g.id);
                      onOpen?.(g);
                    }}>
                    <span className="vdot" />
                    <div className="vmain">
                      <div className="vlabel">
                        v{g.artifact_version || g.id}
                        {g.id === latestId && <span className="eyebrow" style={{ color: "var(--wp-accent)" }}>latest</span>}
                      </div>
                      <div className="vtime">{fmtTime(g.completed_at)}</div>
                      {g.prompt && <div className="vnote">{g.prompt}</div>}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
      {compareOpen && (
        <DiffModal artifacts={artifacts} initialCompareId={cur.id}
                   onClose={() => setCompareOpen(false)} />
      )}
      <div className="artifact-foot">
        <span className="fmeta" style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
          <span className="pdot s-ready" style={{ width: 7, height: 7, borderRadius: 999, display: "inline-block" }} />
          Generated by agent
        </span>
        <div className="artifact-actions">
          {isHtml && previewUrl && (
            <button className="btn btn-ghost"
                    onClick={() => {
                      const ifr = previewRef.current;
                      if (ifr?.requestFullscreen) {
                        ifr.requestFullscreen().catch(() => {
                          window.open(previewUrl, "_blank", "noopener,noreferrer");
                        });
                      } else {
                        window.open(previewUrl, "_blank", "noopener,noreferrer");
                      }
                    }}
                    title="Present in fullscreen — arrows / space to navigate, Esc to exit">
              <Icon name="maximize" /> Present
            </button>
          )}
          {/* Not editing: a single Edit button enters edit mode. While
              editing, the only exits are explicit — Save (apply) or
              Discard/Done (leave). No ambiguous "stop editing" toggle. */}
          {isHtml && previewUrl && !editing && (
            <button className="btn btn-ghost"
                    disabled={runActive}
                    onClick={() => {
                      if (runActive) return;
                      const ifr = previewRef.current;
                      if (!ifr?.contentWindow) return;
                      ifr.contentWindow.postMessage({ type: "workpod-edit-enable" }, "*");
                      setEditing(true);
                    }}
                    title={runActive ? "Locked while the agent is working" : "Click-edit text in the preview"}>
              <Icon name="pencil" /> Edit
            </button>
          )}
          {isHtml && previewUrl && editing && (
            <>
              <button className="btn btn-primary edits-save-pulse"
                      disabled={saving || !editsDirty}
                      title={editsDirty ? "Save your edits as a new version" : "No changes to save yet"}
                      onClick={async () => {
                        const ifr = previewRef.current;
                        if (!ifr?.contentWindow) return;
                        setSaving(true);
                        const onMsg = async (e) => {
                          if (e.source !== ifr.contentWindow) return;
                          if (e.data?.type !== "workpod-edit-saved") return;
                          window.removeEventListener("message", onMsg);
                          try {
                            await postJson(`/api/generations/${cur.id}/save-edits`,
                              { html: e.data.html });
                            await onRefresh?.();
                            setEditing(false);
                            setEditsDirty(false);
                          } catch (err) {
                            alert("save failed: " + err.message);
                          } finally {
                            setSaving(false);
                          }
                        };
                        window.addEventListener("message", onMsg);
                        ifr.contentWindow.postMessage({ type: "workpod-edit-save" }, "*");
                      }}>
                <Icon name="save" /> {saving ? "Saving…" : "Save edits"}
              </button>
              <button className={"btn btn-ghost" + (editsDirty ? " btn-danger" : "")}
                      disabled={saving}
                      title={editsDirty ? "Discard unsaved edits and leave edit mode" : "Leave edit mode"}
                      onClick={() => {
                        if (editsDirty && !confirm("Discard all unsaved edits? It will reload to the last saved version.")) return;
                        const ifr = previewRef.current;
                        ifr?.contentWindow?.postMessage({ type: "workpod-edit-disable" }, "*");
                        // Dirty → reload to revert the light-DOM edits;
                        // clean → just leave edit mode, nothing to undo.
                        if (editsDirty && ifr) ifr.src = previewUrl + (previewUrl.includes("?") ? "&" : "?") + "discard=" + Date.now();
                        setEditing(false);
                        setEditsDirty(false);
                      }}>
                <Icon name="x" /> {editsDirty ? "Discard" : "Cancel"}
              </button>
            </>
          )}
          {isHtml && <ExportMenu genId={cur.id} onDone={onRefresh} artifactType={artifactType} />}
          {!isHtml && (
            <a className="btn btn-ghost" href={`/api/artifacts/${cur.id}`}>
              <Icon name="download" /> Download
            </a>
          )}
        </div>
      </div>
    </div>
  );
}

// Floating quick-comment affordance over the live preview — one click
// to leave a note targeted at the slide currently being viewed (the
// deck shell broadcasts the index to the parent).
function QuickComment({ artifactId, slideIndex, slideLabel, onAdded, isDoc }) {
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  // Documents have no slide index — comments land at the document level.
  const label = isDoc ? "Comment on this artifact" : `Comment on slide ${slideIndex + 1}`;
  const submit = async (e) => {
    e?.preventDefault();
    if (!body.trim() || busy) return;
    setBusy(true);
    try {
      await postJson(`/api/artifacts/${artifactId}/comments`,
        { slide_index: isDoc ? null : slideIndex, slide_ref: isDoc ? null : (slideLabel || null), body: body.trim() });
      setBody("");
      setOpen(false);
      onAdded?.();
    } catch (e2) { alert("comment failed: " + e2.message); }
    finally { setBusy(false); }
  };
  return (
    <div className="preview-quick-comment" onClick={(e) => e.stopPropagation()}>
      {open && (
        <form className="qc-pop" onSubmit={submit}>
          <div className="qc-title">{label}</div>
          <textarea autoFocus rows={2} value={body}
                    placeholder={isDoc ? "What should change in this artifact?" : "What should change on this slide?"}
                    onChange={(e) => setBody(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit(e); }} />
          <div className="qc-row">
            <button type="button" className="btn btn-ghost" onClick={() => setOpen(false)}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={!body.trim() || busy}>
              {busy ? "Adding…" : "Add"}
            </button>
          </div>
        </form>
      )}
      <button type="button" className="qc-fab" title={label}
              onClick={() => setOpen((o) => !o)}>
        <Icon name="message-square" />
        <span>{isDoc ? "Note" : `S${slideIndex + 1}`}</span>
      </button>
    </div>
  );
}

// Per-artifact comments — slide-level notes the user leaves for the
// agent's next run. Open comments get surfaced into the trigger
// message as targeted requirements.
function CommentsSection({ artifactId, wsSlug, refreshKey, onKickedOff, onJumpToSlide, runActive, isDoc }) {
  const { open, setOpen, toggle } = usePopover();
  const [comments, setComments] = useState([]);
  const [slideIdx, setSlideIdx] = useState("");   // string so blank means "deck-level"
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [kicking, setKicking] = useState(false);
  const [showResolved, setShowResolved] = useState(false);
  const [acceptingAll, setAcceptingAll] = useState(false);
  const refresh = useCallback(async () => {
    try {
      const d = await fetchJson(`/api/artifacts/${artifactId}/comments`);
      setComments(d.comments || []);
    } catch {}
  }, [artifactId]);
  useEffect(() => { refresh(); }, [refresh, refreshKey]);
  // While a run is in flight, poll: when it completes the server flips
  // open comments to 'addressed' and the panel should show that without
  // a manual reload.
  useEffect(() => {
    if (!runActive) { refresh(); return; }
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, [runActive, refresh]);
  const openCount = comments.filter((c) => c.status === "open").length;
  const addressedCount = comments.filter((c) => c.status === "addressed").length;
  const submit = async (e) => {
    e?.preventDefault();
    if (!body.trim() || busy) return;
    setBusy(true);
    try {
      const idx = slideIdx.trim() === "" ? null : (parseInt(slideIdx, 10) - 1);
      await postJson(`/api/artifacts/${artifactId}/comments`,
        { slide_index: (idx != null && !isNaN(idx) && idx >= 0) ? idx : null, body: body.trim() });
      setBody("");
      setSlideIdx("");
      await refresh();
    } finally { setBusy(false); }
  };
  return (
    <div className="vsel" onClick={(e) => e.stopPropagation()}>
      <button className="vsel-btn" onClick={toggle} title="Comments — add, review, send to agent">
        <Icon name="message-square" style={{ width: 13, height: 13 }} />
        Comments
        {openCount > 0 && <span className="comments-hub-badge">{openCount}</span>}
        {addressedCount > 0 && <span className="comments-hub-badge is-addressed">{addressedCount}</span>}
        <Icon name="chevron-down" style={{ width: 12, height: 12 }} />
      </button>
      {open && (
        <div className="vhist chist">
          <form className={"comment-form" + (isDoc ? " comment-form-doc" : "")} onSubmit={submit}>
            {!isDoc && (
              <input className="comment-slide-input" type="number" min="1"
                     placeholder="Slide #" value={slideIdx}
                     onChange={(e) => setSlideIdx(e.target.value)} />
            )}
            <textarea className="comment-body-input"
                      placeholder={isDoc
                        ? "Leave a comment for the next agent run — e.g. 'tighten the opening section, drop the marketing tone'"
                        : "Leave a comment for the next agent run — e.g. 'tighten the bullets on slide 3, drop the marketing tone'"}
                      value={body}
                      onChange={(e) => setBody(e.target.value)}
                      rows={2} />
            <button className="btn btn-primary" type="submit"
                    disabled={!body.trim() || busy}>
              <Icon name="plus" /> {busy ? "Adding…" : "Add"}
            </button>
          </form>
          {runActive && (
            <div className="comments-running">
              <span className="spinner" />
              <span>Agent run in progress — open comments were folded into it and will flip to <b>addressed</b> when it completes.</span>
            </div>
          )}
          {openCount > 0 && wsSlug && (
            <button className="btn btn-primary comments-run" disabled={kicking || runActive}
                    onClick={async () => {
                      setKicking(true);
                      try {
                        const d = await postJson(`/api/workspaces/${wsSlug}/generate`,
                          { prompt: "Address the outstanding open comments on this artifact. Make the targeted edits each comment asks for, and leave the rest of the artifact unchanged.",
                            artifact_id: artifactId });
                        onKickedOff?.(d?.generation_id);
                        setOpen(false);   // hand off to the agent chat — one panel at a time
                      } catch (e) { alert("kickoff failed: " + e.message); }
                      finally { setKicking(false); }
                    }}>
              <Icon name="play" /> {runActive ? "Agent is working…" : kicking ? "Starting…" : `Send ${openCount} open comment${openCount === 1 ? "" : "s"} to agent`}
            </button>
          )}
          {addressedCount > 0 && !runActive && (
            <div className="comments-review-hint">
              {addressedCount} comment{addressedCount === 1 ? "" : "s"} addressed by the agent — review the
              new version, then accept to close or reopen to send back.
            </div>
          )}
          {comments.length === 0 && (
            <div className="comment-empty">No comments yet. Add notes per slide and the agent will address them on its next run.</div>
          )}
          <div className={runActive ? "comments-list is-busy" : "comments-list"}>
            {(() => {
              const bySlide = (a, b) => (a.slide_index ?? 1e9) - (b.slide_index ?? 1e9) || a.created_at - b.created_at;
              const openC = comments.filter((c) => c.status === "open").sort(bySlide);
              const addrC = comments.filter((c) => c.status === "addressed").sort(bySlide);
              const resC  = comments.filter((c) => c.status === "resolved").sort(bySlide);
              const acceptAll = async () => {
                setAcceptingAll(true);
                try {
                  await Promise.all(addrC.map((c) => patchJson(`/api/comments/${c.id}`, { status: "resolved" })));
                  await refresh();
                } finally { setAcceptingAll(false); }
              };
              return (
                <>
                  {openC.length > 0 && (
                    <>
                      <div className="comment-group-head">Open <span className="cnt">{openC.length}</span></div>
                      {openC.map((c) => <CommentRow key={c.id} comment={c} onChange={refresh} disabled={runActive} onJump={onJumpToSlide} isDoc={isDoc} />)}
                    </>
                  )}
                  {addrC.length > 0 && (
                    <>
                      <div className="comment-group-head">
                        Addressed <span className="cnt">{addrC.length}</span>
                        <button className="btn btn-primary" disabled={acceptingAll || runActive} onClick={acceptAll}>
                          <Icon name="check-check" /> {acceptingAll ? "Accepting…" : `Accept all ${addrC.length}`}
                        </button>
                      </div>
                      {addrC.map((c) => <CommentRow key={c.id} comment={c} onChange={refresh} disabled={runActive} onJump={onJumpToSlide} isDoc={isDoc} />)}
                    </>
                  )}
                  {resC.length > 0 && (
                    <>
                      <button className="comments-show-resolved" onClick={() => setShowResolved((s) => !s)}>
                        <Icon name={showResolved ? "chevron-down" : "chevron-right"} style={{ width: 12, height: 12 }} />
                        {showResolved ? "Hide" : "Show"} {resC.length} resolved
                      </button>
                      {showResolved && resC.map((c) => <CommentRow key={c.id} comment={c} onChange={refresh} disabled={runActive} onJump={onJumpToSlide} isDoc={isDoc} />)}
                    </>
                  )}
                </>
              );
            })()}
          </div>
        </div>
      )}
    </div>
  );
}

function CommentRow({ comment, onChange, disabled, onJump, isDoc }) {
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [reopening, setReopening] = useState(false);   // addressed → open w/ note
  const [note, setNote] = useState("");
  const [draft, setDraft] = useState(comment.body);
  const where = (typeof comment.slide_index === "number" && comment.slide_index >= 0)
    ? (comment.slide_ref ? `Slide ${comment.slide_index + 1} · ${comment.slide_ref}` : `Slide ${comment.slide_index + 1}`)
    : (isDoc ? "Artifact" : "Deck");
  const resolved = comment.status === "resolved";
  const addressed = comment.status === "addressed";
  // Editable only while still open (not folded into a run, not yet
  // addressed) and no run is in flight.
  const editable = comment.status === "open" && !disabled;
  const setStatus = async (status) => {
    setBusy(true);
    try {
      await patchJson(`/api/comments/${comment.id}`, { status });
      await onChange();
    } finally { setBusy(false); }
  };
  const saveEdit = async () => {
    if (!draft.trim() || draft.trim() === comment.body) { setEditing(false); setDraft(comment.body); return; }
    setBusy(true);
    try {
      await patchJson(`/api/comments/${comment.id}`, { body: draft.trim() });
      setEditing(false);
      await onChange();
    } finally { setBusy(false); }
  };
  return (
    <div className={"comment-row" + (resolved ? " is-resolved" : "") + (addressed ? " is-addressed" : "")}>
      <div className="comment-meta">
        {typeof comment.slide_index === "number" && comment.slide_index >= 0 && onJump ? (
          <button className="comment-where comment-jump" title={`Jump the preview to slide ${comment.slide_index + 1}`}
                  onClick={() => onJump(comment.slide_index)}>
            {where} <Icon name="arrow-up-right" style={{ width: 10, height: 10 }} />
          </button>
        ) : (
        <span className="comment-where">{where}</span>
        )}
        <span className="comment-ts">{new Date(comment.created_at).toLocaleString()}</span>
        {resolved && <span className="comment-status">resolved</span>}
        {addressed && <span className="comment-status addressed">addressed</span>}
      </div>
      {editing ? (
        <div className="comment-edit">
          <textarea autoFocus rows={2} value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) saveEdit(); }} />
          <div className="qc-row">
            <button className="btn btn-ghost" disabled={busy}
                    onClick={() => { setEditing(false); setDraft(comment.body); }}>Cancel</button>
            <button className="btn btn-primary" disabled={busy || !draft.trim()}
                    onClick={saveEdit}>{busy ? "Saving…" : "Save"}</button>
          </div>
        </div>
      ) : (
        <div className="comment-body">{comment.body}</div>
      )}
      <div className="comment-actions">
        {editable && !editing && (
          <button className="btn btn-ghost" disabled={busy}
                  onClick={() => { setDraft(comment.body); setEditing(true); }}>
            <Icon name="pencil" /> Edit
          </button>
        )}
        {addressed ? (
          <>
            <button className="btn btn-ghost btn-success" disabled={busy || disabled}
                    onClick={() => setStatus("resolved")}>
              <Icon name="check" /> Accept
            </button>
            <button className="btn btn-ghost" disabled={busy || disabled}
                    onClick={() => { setNote(""); setReopening((r) => !r); }}>
              <Icon name="rotate-ccw" /> Reopen
            </button>
          </>
        ) : (
        <button className="btn btn-ghost" disabled={busy || disabled}
                onClick={() => setStatus(resolved ? "open" : "resolved")}>
          <Icon name={resolved ? "rotate-ccw" : "check"} />
          {resolved ? " Reopen" : " Resolve"}
        </button>
        )}
        <button className="btn btn-ghost btn-danger" disabled={busy}
                onClick={async () => {
                  if (!confirm("Delete this comment?")) return;
                  setBusy(true);
                  try {
                    await del(`/api/comments/${comment.id}`);
                    await onChange();
                  } finally { setBusy(false); }
                }}>
          <Icon name="trash-2" />
        </button>
      </div>
      {reopening && (
        <div className="comment-edit" style={{ marginTop: 6 }}>
          <textarea autoFocus rows={2} value={note}
                    placeholder="What still needs to change? This goes to the agent with the reopened comment."
                    onChange={(e) => setNote(e.target.value)} />
          <div className="qc-row">
            <button className="btn btn-ghost" disabled={busy} onClick={() => setReopening(false)}>Cancel</button>
            <button className="btn btn-primary" disabled={busy}
                    onClick={async () => {
                      setBusy(true);
                      try {
                        const body = note.trim()
                          ? `${comment.body}\n\n↳ follow-up: ${note.trim()}`
                          : comment.body;
                        await patchJson(`/api/comments/${comment.id}`, { status: "open", body });
                        setReopening(false);
                        await onChange();
                      } finally { setBusy(false); }
                    }}>
              <Icon name="rotate-ccw" /> {note.trim() ? "Reopen with note" : "Reopen"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// Create OR edit a note. With `note` it loads that note's markdown for
// editing (saves back via PUT); without, it creates a new note. Either
// way the body is edited as raw markdown with a Raw/Preview toggle.
function NoteModal({ slug, note, onClose, onSaved }) {
  const editing = !!note;
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [mode, setMode] = useState("new");
  const [view, setView] = useState("raw");       // raw | preview
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(editing);
  const taRef = useRef(null);

  // Editing: pull the note's current markdown to prefill the editor.
  useEffect(() => {
    if (!editing) { taRef.current?.focus(); return; }
    let alive = true;
    fetch(`/api/files/${note.id}`, { cache: "no-store" })
      .then((r) => r.text())
      .then((t) => { if (alive) { setBody(t); setLoading(false); } })
      .catch(() => { if (alive) { setLoading(false); alert("could not load note"); } });
    return () => { alive = false; };
  }, [editing, note]);

  // Focus the textarea once loaded / when switching back to raw.
  useEffect(() => { if (view === "raw" && !loading) taRef.current?.focus(); }, [view, loading]);

  const submit = async (e) => {
    e?.preventDefault();
    if (busy || loading || (!editing && !body.trim())) return;
    setBusy(true);
    try {
      if (editing) {
        await putJson(`/api/workspaces/${slug}/notes/${note.id}`, { content: body });
      } else {
        await postJson(`/api/workspaces/${slug}/notes`,
          { title: title.trim() || undefined, content: body.trim(), mode });
      }
      onSaved();
    } catch (e) { alert("save failed: " + e.message); }
    finally { setBusy(false); }
  };

  return (
    <div className="scrim" onClick={onClose}>
      <form className="modal note-modal" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <div className="note-modal-head">
          <h3>{editing ? "Edit note" : "Quick note"}</h3>
          <div className="seg" role="tablist">
            <button type="button" role="tab" className={"seg-btn" + (view === "raw" ? " on" : "")}
                    onClick={() => setView("raw")}>Raw</button>
            <button type="button" role="tab" className={"seg-btn" + (view === "preview" ? " on" : "")}
                    onClick={() => setView("preview")}>Preview</button>
          </div>
        </div>
        {editing
          ? <p className="note-sub">Editing <span className="mono">{note.name}</span>. Edit the raw markdown; flip to Preview to check.</p>
          : <p className="note-sub">Markdown is fine. Creates a new dated .md, or appends to <span className="mono">notes.md</span>.</p>}

        {!editing && (
          <div className="modal-form" style={{ marginBottom: 10 }}>
            <label>Title (optional)</label>
            <input className="field" value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>
        )}

        <div className="note-editor">
          {view === "raw"
            ? <textarea ref={taRef} className="field note-raw" spellCheck={true}
                        placeholder={loading ? "Loading…" : "# Write markdown here"}
                        value={body} disabled={loading}
                        onChange={(e) => setBody(e.target.value)} />
            : <div className="note-preview">
                {body.trim() ? <Markdown text={body} /> : <span className="note-empty">Nothing to preview yet.</span>}
              </div>}
        </div>

        {!editing && (
          <div className="note-mode">
            <label><input type="radio" checked={mode === "new"} onChange={() => setMode("new")} /> new file</label>
            <label><input type="radio" checked={mode === "append"} onChange={() => setMode("append")} /> append to notes.md</label>
          </div>
        )}

        <div className="modal-foot">
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={busy || loading || (!editing && !body.trim())}>
            <Icon name="check" /> {busy ? "Saving…" : editing ? "Save changes" : "Save"}
          </button>
        </div>
      </form>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// AGENT PANEL
// ═══════════════════════════════════════════════════════════════

function AgentDrawer({ ws, generation, open, onOpen, onClose, busy, files, notes, onGenerate, onReply, hasPrior }) {
  const status = generation?.status || "idle";
  const hasActive = generation && (status === "running" || status === "queued" || status === "awaiting_user");
  return (
    <>
      <div className={"agent-drawer" + (open ? " open" : "")}>
        <AgentPanelBody
          ws={ws} generation={generation} busy={busy}
          files={files} notes={notes}
          onGenerate={onGenerate} onReply={onReply}
          hasPrior={hasPrior}
          onClose={onClose} />
      </div>
    </>
  );
}

function AgentPanelBody({ ws, generation, busy, files, notes, onGenerate, onReply, hasPrior, onClose }) {
  const [messages, setMessages] = useState([]);
  const [composing, setComposing] = useState("");

  // Pull messages for the active generation.
  useEffect(() => {
    if (!generation) { setMessages([]); return; }
    let cancelled = false;
    const tick = async () => {
      try {
        const d = await fetchJson(`/api/generations/${generation.id}`);
        if (!cancelled) setMessages(d.messages || []);
      } catch {}
    };
    tick();
    if (generation.status === "running" || generation.status === "queued" || generation.status === "awaiting_user") {
      const id = setInterval(tick, 1500);
      return () => { cancelled = true; clearInterval(id); };
    }
    return () => { cancelled = true; };
  }, [generation?.id, generation?.status]);

  const scrollRef = useRef(null);
  const [stickyBottom, setStickyBottom] = useState(true);
  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    // Within 24px of the bottom counts as "at bottom" — leaves room for
    // sub-pixel rounding and a momentary user fingerprint.
    setStickyBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 24);
  }, []);
  useEffect(() => {
    if (stickyBottom && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, busy, stickyBottom]);

  const status = generation?.status || "idle";
  const awaitingReply = status === "awaiting_user";
  const isRunning = status === "running" || status === "queued";
  // Composer modes: answering the agent's question, or starting a run.
  // While a run is mid-flight the composer disables — engines run as
  // one-shot turns, so there is no live channel to type into. (Session
  // resume will make mid-run input meaningful; steering was removed
  // because it only ever was a note for the next checkpoint.)
  const mode = awaitingReply ? "reply" : "generate";

  const send = useCallback(async (text, opts = {}) => {
    const t = text.trim();
    // For Generate, an empty prompt is allowed (the agent uses what's in
    // the workspace). Replies require text.
    if (mode === "reply" && !t) return;
    if (mode === "reply") await onReply(t);
    else                  await onGenerate(t, opts);
    setComposing("");
  }, [mode, onGenerate, onReply]);

  const hasActive = generation && (isRunning || awaitingReply);

  const placeholder =
    mode === "reply" ? "answer the agent…" :
    isRunning ? "Agent is working…" :
    "Add a prompt (optional) or just hit Generate…";

  // Generate is the only mode where the empty composer can fire.
  const sendDisabled =
    isRunning ||
    (mode === "generate" && busy) ||
    (mode === "reply" && !composing.trim());

  return (
    <>
      <div className="agent-head">
        <div className="agent-avatar"><Icon name="bot" /></div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="agent-title">
            Agent · {(() => {
              const LB = { claude: "Claude", copilot: "Copilot", codex: "Codex", cursor: "Cursor" };
              const eng = (hasActive && generation?.engine) || ws?.agent_engine || "claude";
              return LB[eng] || eng;
            })()}
          </div>
          <div className="agent-status" style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {hasActive
              ? <>{(status === "running" || status === "queued") && <Spinner style={{ width: 11, height: 11 }} />} {STATUS[status]?.label || status}</>
              : <span style={{ opacity: 0.7 }}>idle</span>}
            {(() => {
              const m = (hasActive && generation?.model) || ws?.agent_model;
              return m ? <span style={{ opacity: 0.7 }}> · {m}</span> : null;
            })()}
          </div>
        </div>
        {hasActive && (
          <button className="icon-btn stop-btn" title="Stop this run (you can retry after)"
                  onClick={async () => {
                    if (!confirm("Stop this generation? The run is killed immediately; you can retry afterward.")) return;
                    try { await postJson(`/api/generations/${generation.id}/stop`, {}); }
                    catch (e) { alert("stop failed: " + e.message); }
                  }}>
            <Icon name="square" />
          </button>
        )}
        {onClose
          ? <button className="icon-btn" onClick={onClose} title="Close">
              <Icon name="panel-right-close" />
            </button>
          : <span className="model-pill">claude-sonnet-4.5</span>}
      </div>

      <div className="chat-wrap">
        <div className="chat" ref={scrollRef} onScroll={onScroll}>
          {messages.length === 0 && !hasActive && (
            <div className="chat-empty">
              <Icon name="sparkles" style={{ width: 22, height: 22, color: "var(--wp-accent)" }} />
              <div>
                Add a prompt below and hit Generate — the agent works from everything in this workspace.
              </div>
            </div>
          )}
          {messages.map((m) => <ChatMessage key={m.id} msg={m} />)}
        </div>
        {!stickyBottom && (
          <button className="jump-to-latest" onClick={() => {
            if (scrollRef.current) {
              scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
            }
            setStickyBottom(true);
          }}>
            <Icon name="arrow-down" /> Jump to latest
          </button>
        )}
      </div>

      <div className="composer">
        <div className="composer-box">
          <textarea rows={1} placeholder={placeholder} disabled={isRunning}
            value={composing} onChange={(e) => setComposing(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send(composing);
              }
            }} />
          <div className="composer-foot">
            <span className="hint">
              <Icon name="paperclip" style={{ width: 12, height: 12, verticalAlign: "-2px", marginRight: 4 }} />
              {(files.length || notes.length)
                ? `${files.length || 0} file${files.length === 1 ? "" : "s"}${notes.length ? `, ${notes.length} note${notes.length === 1 ? "" : "s"}` : ""} in context`
                : "empty workspace"}
            </span>
            <div className="composer-actions">
              {mode === "generate" && hasPrior && (
                <button className="btn btn-ghost gen-btn"
                  disabled={busy || isRunning}
                  title={isRunning
                    ? "Available once the current run finishes"
                    : "Start clean: the next run won't carry context from prior runs (files and versions on disk are untouched)"}
                  onClick={() => send(composing, { fresh: true })}>
                  <Icon name="refresh-cw" /> Fresh start
                </button>
              )}
              <button className="btn btn-primary gen-btn"
                disabled={sendDisabled}
                onClick={() => send(composing)}>
                {mode === "reply" && <><Icon name="send" /> Send</>}
                {mode === "generate" && (busy
                  ? <><Spinner /> Working…</>
                  : <><Icon name="sparkles" /> {hasPrior ? "Continue" : "Generate"}</>)}
              </button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

function ChatMessage({ msg }) {
  if (msg.role === "user") {
    return (
      <div className="msg user fade-up">
        <div className="bubble-user">{msg.content}</div>
      </div>
    );
  }
  // Stream events use bracketed prefixes — render those as compact lines
  // (mono, smaller, dim) so they sit visually beside the agent's text
  // narration without dominating.
  const c = msg.content || "";
  const toolMatch = c.match(/^\[tool:([^\]]+)\]\s*(.*)$/s);
  if (toolMatch) {
    return (
      <div className="ev-tool fade-up">
        <Icon name="terminal" />
        <span className="ev-tag">{toolMatch[1]}</span>
        <span className="ev-body">{toolMatch[2]}</span>
      </div>
    );
  }
  // Live-streaming tool-input preview. The agent loop maintains a
  // single "[composing] <Tool> input · N chars…" row that updates as
  // partial deltas roll in, then deletes itself when the block
  // completes. Render with the same shape as ev-tool but with a
  // pulse indicator so the streaming is visible.
  const composingMatch = c.match(/^\[composing\]\s*(\w+)\s*input\s*·\s*(.+)$/s);
  if (composingMatch) {
    return (
      <div className="ev-tool ev-composing fade-up">
        <span className="pdot s-generating pulse" style={{ width: 7, height: 7, borderRadius: 999, display: "inline-block" }} />
        <span className="ev-tag">{composingMatch[1]}</span>
        <span className="ev-body">composing input · {composingMatch[2]}</span>
      </div>
    );
  }
  const thinkMatch = c.match(/^\[thinking\]\s*(.*)$/s);
  if (thinkMatch) {
    return (
      <div className="ev-think fade-up">
        <Icon name="brain" />
        <span className="ev-body">{thinkMatch[1]}</span>
      </div>
    );
  }
  if (/^Run failed:/.test(c)) {
    return (
      <div className="msg-error fade-up">
        <Icon name="alert-octagon" />
        <Markdown text={msg.content} className="agent-text" />
      </div>
    );
  }
  return (
    <div className="msg-agent fade-up">
      <Markdown text={msg.content} className="agent-text" />
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// DESIGN SYSTEMS — workspace-agnostic CSS bundles, editable
// ═══════════════════════════════════════════════════════════════

// All export targets under one button — six peer buttons in the bar
// read as noise; one Export menu matches every editor users know.
function ExportMenu({ genId, onDone, artifactType }) {
  const { open, setOpen, toggle } = usePopover();
  const isDoc = artifactType === "document";
  const isSheet = artifactType === "spreadsheet";
  return (
    <div className="vsel" onClick={(e) => e.stopPropagation()}>
      <button className="btn btn-ghost" onClick={toggle}>
        <Icon name="file-output" /> Export <Icon name={open ? "chevron-up" : "chevron-down"} style={{ width: 12, height: 12 }} />
      </button>
      {open && (
        <div className="vhist export-menu">
          <ExportButton genId={genId} kind="pdf" onDone={onDone} />
          {isDoc ? (
            <ExportButton genId={genId} kind="docx" onDone={onDone} />
          ) : isSheet ? (
            <ExportButton genId={genId} kind="xlsx" onDone={onDone} />
          ) : (
            <>
              <ExportButton genId={genId} kind="pptx" onDone={onDone} />
              <ExportButton genId={genId} kind="pptx-image" onDone={onDone} />
              <ExportButton genId={genId} kind="pptx-themed" onDone={onDone} />
            </>
          )}
          <a className="btn btn-ghost" href={`/api/artifacts/${genId}`}>
            <Icon name="download" /> HTML source
          </a>
        </div>
      )}
    </div>
  );
}

function ExportButton({ genId, kind, onDone }) {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);   // {path} once exported
  // Three flavors of export: clean PDF, editable PPTX (DOM-walking),
  // and pixel-perfect-but-image-only PPTX. Labels keep the
  // distinction explicit so the user knows what they're getting.
  const labels = {
    "pdf":         { busy: "PDF",         button: "Export PDF",
                     icon: "file-text",   title: "Render to PDF via chrome headless" },
    "pptx":        { busy: "PPTX",        button: "Export PPTX",
                     icon: "file-edit",   title: "Editable PPTX — each visual is a real shape" },
    "pptx-image":  { busy: "image PPTX",  button: "Export PPTX (image)",
                     icon: "image",       title: "Pixel-perfect PPTX — each slide is one full-bleed image. Not editable." },
    "pptx-themed": { busy: "themed PPTX", button: "Export PPTX (themed)",
                     icon: "palette",     title: "Re-themeable PPTX — palette colors & fonts reference the deck theme, so you can recolor/refont in PowerPoint via Design > Variants. Non-palette colors stay fixed." },
    "docx":        { busy: "DOCX",        button: "Export DOCX",
                     icon: "file-edit",   title: "Editable Word document — headings, lists, tables, and callouts map to native Word constructs" },
    "xlsx":        { busy: "XLSX",        button: "Export XLSX",
                     icon: "table",       title: "Editable Excel workbook — each sheet becomes a worksheet, numbers stay numeric" },
  };
  const meta = labels[kind] || labels["pdf"];
  const click = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const d = await postJson(`/api/generations/${genId}/export-${kind}`);
      setDone({ path: d.path });
      // Kick the download immediately — rendering takes long enough
      // that users click away, and the file shouldn't need a second
      // visit to collect.
      const a = document.createElement("a");
      a.href = `/api/generations/${genId}/download-${kind}`;
      a.download = "";
      document.body.appendChild(a);
      a.click();
      a.remove();
      showToast(`${meta.busy} exported — downloading`);
      onDone?.();
    } catch (e) {
      alert(`export ${kind} failed: ${e.message}`);
    } finally { setBusy(false); }
  };
  if (done) {
    const dlName = normPath(done.path).split("/").pop();
    return (
      <a className="btn btn-ghost" download={dlName}
         href={`/api/generations/${genId}/download-${kind}`} title={meta.title}>
        <Icon name="download" /> {meta.busy}
      </a>
    );
  }
  return (
    <button className="btn btn-ghost" onClick={click} disabled={busy} title={meta.title}>
      {busy ? <Spinner /> : <Icon name={meta.icon} />} {busy ? `rendering ${meta.busy}…` : meta.button}
    </button>
  );
}

function DesignSystemPicker({ ws, onChange }) {
  const [systems, setSystems] = useState([]);
  useEffect(() => {
    fetchJson("/api/design-systems")
      .then((d) => setSystems(d.design_systems || []))
      .catch(() => setSystems([]));
  }, []);
  // Resolve the currently-bound system: prefer design_system_id, else
  // match the legacy theme string by slug, else the first system.
  let currentId = ws.design_system_id;
  if (!currentId && systems.length) {
    const bySlug = systems.find((s) => s.slug === (ws.theme || "oneshot"));
    currentId = (bySlug || systems[0]).id;
  }
  return (
    <span className="ws-chip ws-chip-select on" title="Design system">
      <Icon name="palette" />
      <select value={currentId || ""}
              onChange={async (e) => {
                await patchJson(`/api/workspaces/${ws.slug}`, { design_system_id: Number(e.target.value) });
                onChange();
              }}>
        {systems.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
      </select>
    </span>
  );
}

// ─── design-system brand tokens (client mirror of the server's math) ──
// Export-safe font stacks (these map cleanly to PPTX/DOCX/XLSX).
// Only same-name cross-platform families: the export font-picker resolves a
// stack against the render machine and writes that exact name into the
// PPTX/DOCX/XLSX, with no per-platform name mapping. So a font must exist on
// BOTH macOS and Windows under the same name, or it substitutes on the
// recipient's machine. (Nicer / web fonts are tier 2 — they need embedding.)
const DS_FONTS = [
  { label: "Helvetica / Arial (Oneshot)", value: '"Helvetica Neue", Helvetica, Arial, sans-serif' },
  { label: "Arial",                       value: "Arial, Helvetica, sans-serif" },
  { label: "Verdana",                     value: "Verdana, Geneva, sans-serif" },
  { label: "Tahoma",                      value: "Tahoma, Geneva, sans-serif" },
  { label: "Trebuchet MS",                value: '"Trebuchet MS", "Segoe UI", sans-serif' },
  { label: "Segoe UI",                    value: '"Segoe UI", system-ui, sans-serif' },
  { label: "Georgia (serif)",             value: "Georgia, serif" },
  { label: "Cambria (serif)",             value: "Cambria, Georgia, serif" },
  { label: "Times New Roman (serif)",     value: '"Times New Roman", Times, serif' },
  { label: "Arial Black (heavy)",         value: '"Arial Black", Arial, sans-serif' },
  { label: "Impact (display)",            value: 'Impact, "Arial Black", sans-serif' },
  { label: "Courier New (mono)",          value: '"Courier New", Courier, monospace' },
];
const DS_ACCENTS = ["#0071E3", "#FF5A1F", "#1A8A3C", "#8E5AF2", "#D93025", "#0E7490", "#C026D3", "#B45309"];

function dsHexToRgb(h) { h = h.replace("#", ""); return [parseInt(h.slice(0,2),16), parseInt(h.slice(2,4),16), parseInt(h.slice(4,6),16)]; }
function dsRgbToHex(r,g,b) { const f = (x) => Math.round(Math.max(0,Math.min(255,x))).toString(16).padStart(2,"0"); return "#"+f(r)+f(g)+f(b); }
// fg composited over bg at alpha a → an opaque hex (exports need solid fills).
function dsOver(fg, bg, a) { const [r1,g1,b1]=dsHexToRgb(fg), [r2,g2,b2]=dsHexToRgb(bg); return dsRgbToHex(r1*a+r2*(1-a), g1*a+g2*(1-a), b1*a+b2*(1-a)); }
function dsAccentFamily(accent) {
  return {
    accent,
    accentDeep: dsOver("#000000", accent, 0.22),  // 22% black over accent
    accentSoft: dsOver("#FFFFFF", accent, 0.28),  // 28% white over accent
    accentTint: dsOver(accent, "#FFFFFF", 0.08),  // accent 8% over white (matches Oneshot)
    accentWash: dsOver(accent, "#FFFFFF", 0.04),  // accent 4% over white (matches Oneshot)
  };
}

// Guided token form: name + accent + fonts → a branded clone of Oneshot.
// With `system`, edits an existing token-themed system (prefilled, saves
// via PATCH which re-themes). Without, creates a new one.
function DesignSystemModal({ system, onClose, onSaved }) {
  const editing = !!system;
  const init = (() => {
    try {
      if (system?.tokens) return JSON.parse(system.tokens);
      // Fallback for systems themed before tokens were stored: read the
      // override values out of the CSS (last occurrence wins = the override).
      const css = system?.css || "";
      const last = (k) => { const re = new RegExp(k + "\\s*:\\s*([^;]+);", "g"); let m, v = null; while ((m = re.exec(css))) v = m[1].trim(); return v; };
      const accent = last("--accent");
      if (accent && /^#[0-9a-fA-F]{6}$/.test(accent)) {
        return { accent, fontDisplay: last("--font-display"), fontSans: last("--font-sans") };
      }
    } catch {}
    return null;
  })();
  const [name, setName] = useState(editing ? (system.name || "") : "");
  const [description, setDescription] = useState(editing ? (system.description || "") : "Themed from Oneshot");
  const [accent, setAccent] = useState(init?.accent || DS_ACCENTS[0]);
  const [fontDisplay, setFontDisplay] = useState(init?.fontDisplay || DS_FONTS[0].value);
  const [fontSans, setFontSans] = useState(init?.fontSans || DS_FONTS[0].value);
  const [busy, setBusy] = useState(false);
  const [importing, setImporting] = useState(false);
  const [mode, setMode] = useState("build");   // "build" | "import" (create only)
  const isImported = editing && !!(init && init.imported);  // colors/fonts came from a file
  const fam = dsAccentFamily(accent);
  // Import a design system straight from a reference deck/template: the
  // server parses the file's PowerPoint theme (colors + fonts) into brand
  // tokens. Exact match for a corporate template — no guessing.
  const importFromFile = async (file) => {
    if (!file || importing) return;
    setImporting(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      if (name.trim()) fd.append("name", name.trim());
      const res = await fetch("/api/design-systems/from-reference", { method: "POST", body: fd });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || res.statusText);
      onSaved(d.design_system);
    } catch (err) { alert("import failed: " + err.message); }
    finally { setImporting(false); }
  };
  const submit = async (e) => {
    e?.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      const desc = description.trim() || null;
      let d;
      if (isImported) {
        // Imported themes carry file-derived colors/fonts the form can't
        // represent — only name/description are editable. Omit tokens so the
        // server preserves the imported theme as-is.
        d = await patchJson(`/api/design-systems/${system.id}`, { name: name.trim(), description: desc });
      } else {
        const tokens = { ...fam, fontDisplay, fontSans };
        d = editing
          ? await patchJson(`/api/design-systems/${system.id}`, { name: name.trim(), description: desc, tokens })
          : await postJson("/api/design-systems", { name: name.trim(), description: desc, tokens });
      }
      onSaved(d.design_system);
    } catch (e) { alert("save failed: " + e.message); }
    finally { setBusy(false); }
  };
  const previewVars = { "--p-accent": fam.accent, "--p-deep": fam.accentDeep, "--p-soft": fam.accentSoft, "--p-tint": fam.accentTint, "--p-wash": fam.accentWash };
  return (
    <div className="scrim" onClick={onClose}>
      <form className="modal ds-new-modal" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h3>{editing ? "Edit theme" : "New design system"}</h3>
        <p className="note-sub">{editing
          ? (isImported
            ? "This system's colors and fonts come from the imported file. You can rename it here; re-import a file to change the palette."
            : "Tweak this system's name, description, colors, and fonts. Saving re-themes it from Oneshot.")
          : mode === "import"
          ? "Build a design system from a brand's colors and fonts — same Oneshot structure underneath, so results stay export-clean."
          : "A branded copy of Oneshot, same structure so results stay repeatable, just your colors and fonts."}</p>
        {!editing && (
          <div className="ds-mode">
            <button type="button" className={"ds-mode-btn" + (mode === "build" ? " on" : "")} onClick={() => setMode("build")}>Build with the form</button>
            <button type="button" className={"ds-mode-btn" + (mode === "import" ? " on" : "")} onClick={() => setMode("import")}>Import from a file</button>
          </div>
        )}
        {!editing && mode === "import" && (
          <div className="ds-import-pane">
            <label>Name <span className="note-sub" style={{ display: "inline" }}>(optional)</span></label>
            <input className="field" value={name} placeholder="Acme Brand" onChange={(e) => setName(e.target.value)} />
            <label className={"ds-import" + (importing ? " busy" : "")}>
              <Icon name="upload" />
              {importing ? "Reading theme…" : "Choose a .pptx, .potx, or .thmx — pulls its exact colors + fonts"}
              <input type="file" accept=".pptx,.potx,.thmx" style={{ display: "none" }} disabled={importing}
                     onChange={(e) => { const f = e.target.files && e.target.files[0]; e.target.value = ""; importFromFile(f); }} />
            </label>
            <p className="note-sub">Pulls the colors and fonts from the file's embedded theme (.pptx, .potx, or .thmx) — so the new system matches the source exactly.</p>
          </div>
        )}
        {isImported && (
          <div className="ds-import-pane">
            <label>Name</label>
            <input className="field" value={name} autoFocus onChange={(e) => setName(e.target.value)} />
            <label>Description</label>
            <input className="field" value={description} placeholder="One-line description" onChange={(e) => setDescription(e.target.value)} />
            <p className="note-sub">Colors and fonts were imported from a file and aren't editable here. To change them, import an updated file as a new system.</p>
          </div>
        )}
        <div className="ds-new-grid" style={((!editing && mode === "import") || isImported) ? { display: "none" } : undefined}>
          <div className="ds-new-form">
            <label>Name</label>
            <input className="field" value={name} autoFocus placeholder="Acme Brand"
                   onChange={(e) => setName(e.target.value)} />
            <label>Description</label>
            <input className="field" value={description} placeholder="One-line description"
                   onChange={(e) => setDescription(e.target.value)} />
            <label>Accent</label>
            <div className="ds-accent-row">
              {DS_ACCENTS.map((c) => (
                <button type="button" key={c} aria-label={c}
                        className={"ds-swatch" + (c.toLowerCase() === accent.toLowerCase() ? " on" : "")}
                        style={{ background: c }} onClick={() => setAccent(c)} />
              ))}
              <input type="color" className="ds-color-input" value={accent} onChange={(e) => setAccent(e.target.value)} />
            </div>
            <label>Display font</label>
            <select className="field" value={fontDisplay} onChange={(e) => setFontDisplay(e.target.value)}>
              {DS_FONTS.map((f) => <option key={f.label} value={f.value}>{f.label}</option>)}
            </select>
            <label>Body font</label>
            <select className="field" value={fontSans} onChange={(e) => setFontSans(e.target.value)}>
              {DS_FONTS.map((f) => <option key={f.label} value={f.value}>{f.label}</option>)}
            </select>
          </div>
          <div className="ds-new-preview" style={previewVars}>
            <div className="ds-prev-eyebrow" style={{ fontFamily: fontSans }}>Preview</div>
            <div className="ds-prev-title" style={{ fontFamily: fontDisplay }}>Coverage up 38%</div>
            <div className="ds-prev-bar"></div>
            <p className="ds-prev-body" style={{ fontFamily: fontSans }}>A line of body text in your typeface, with an <b>accent</b> for punctuation.</p>
            <div className="ds-prev-row">
              <span className="ds-prev-btn" style={{ fontFamily: fontSans }}>Primary</span>
              <span className="ds-prev-pill" style={{ fontFamily: fontSans }}>Tinted</span>
            </div>
            <div className="ds-prev-swatches">
              <span style={{ background: fam.accentDeep }} title="deep"></span>
              <span style={{ background: fam.accent }} title="accent"></span>
              <span style={{ background: fam.accentSoft }} title="soft"></span>
              <span style={{ background: fam.accentTint }} title="tint"></span>
              <span style={{ background: fam.accentWash }} title="wash"></span>
            </div>
          </div>
        </div>
        <div className="modal-foot">
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          {(editing || mode === "build") && (
            <button type="submit" className="btn btn-primary" disabled={busy || !name.trim()}>
              <Icon name="check" /> {busy ? "Saving…" : editing ? "Save theme" : "Create"}
            </button>
          )}
        </div>
      </form>
    </div>
  );
}

function DesignSystems({ activeSystemId, onSelect, onBack }) {
  const [systems, setSystems] = useState([]);
  const [creating, setCreating] = useState(false);
  const refresh = useCallback(async () => {
    const d = await fetchJson("/api/design-systems");
    setSystems(d.design_systems || []);
  }, []);
  useEffect(() => { refresh(); }, [refresh]);

  if (activeSystemId) {
    return <DesignSystemEditor systemId={activeSystemId}
                               onBack={() => onSelect?.(null)}
                               onChange={refresh} />;
  }
  return (
    <div className="dash">
      <div className="dash-inner">
        <div className="dash-head">
          <div>
            <div className="eyebrow" style={{ marginBottom: 12 }}>Styling</div>
            <h1 className="dash-title">Design systems</h1>
            <p className="dash-sub">Workspace-agnostic CSS bundles. Reference one from any workspace; edit here once, all referencing decks update on next reload.</p>
          </div>
          <button className="btn btn-primary" onClick={() => setCreating(true)}>
            <Icon name="plus" /> New design system
          </button>
        </div>
        {creating && (
          <DesignSystemModal
            onClose={() => setCreating(false)}
            onSaved={(s) => { setCreating(false); refresh(); onSelect?.(s.id); }} />
        )}
        <div className="ds-grid">
          {systems.map((s) => (
            <button key={s.id} className="ds-card" onClick={() => onSelect?.(s.id)}>
              <div className="ds-card-head">
                <span className="ds-name">{s.name}</span>
                <span className="fmeta">{s.css_size}b CSS</span>
              </div>
              {s.description && <p className="ds-desc">{s.description}</p>}
              <div className="ds-card-foot">
                <span className="fmeta">slug · {s.slug}</span>
              </div>
            </button>
          ))}
          {systems.length === 0 && <div className="empty">No design systems yet.</div>}
        </div>
      </div>
    </div>
  );
}

function DesignSystemEditor({ systemId, onBack, onChange }) {
  const [data, setData] = useState(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [previewKey, setPreviewKey] = useState(0);
  const [themeOpen, setThemeOpen] = useState(false);   // visual token editor
  // What the preview pane shows: the token spec sheet (default), or a
  // worked example. The example can be either medium — a sub-picker
  // inside the Example tab switches it. Pure display — no effect on
  // the system itself.
  const [view, setView] = useState("specimen");        // "specimen" | "example"
  const [exampleMedium, setExampleMedium] = useState("deck");  // "deck" | "document"
  const [exportingPdf, setExportingPdf] = useState(false);

  // Export the specimen sheet to PDF (chrome renders it server-side; ~15s).
  const exportSpecimen = async () => {
    if (exportingPdf) return;
    setExportingPdf(true);
    try {
      const res = await fetch(`/api/design-systems/${systemId}/specimen.pdf`);
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = `${(data && data.slug) || "design-system"}-specimen.pdf`;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
    } catch (e) { alert("specimen export failed: " + e.message); }
    finally { setExportingPdf(false); }
  };

  const load = useCallback(async () => {
    const d = await fetchJson(`/api/design-systems/${systemId}`);
    setData(d.design_system);
    setName(d.design_system.name || "");
    setDescription(d.design_system.description || "");
    setDirty(false);
  }, [systemId]);
  useEffect(() => { load(); }, [load]);

  const save = async () => {
    setSaving(true);
    try {
      await patchJson(`/api/design-systems/${systemId}`, {
        name: name.trim(), description: description.trim() || null,
      });
      setDirty(false);
      setPreviewKey((k) => k + 1);  // reload iframe with new CSS
      onChange?.();
    } finally { setSaving(false); }
  };

  const builtin = !!data?.builtin;

  const remove = async () => {
    if (!data) return;
    if (!confirm(`Delete design system "${data.name}"? Workspaces referencing it must switch first.`)) return;
    try {
      await del(`/api/design-systems/${systemId}`);
      onChange?.();   // refresh the list so the deleted system drops out immediately
      onBack();
    } catch (e) { alert("delete failed: " + e.message); }
  };

  if (!data) return <div className="ws-main"><div className="empty">loading…</div></div>;

  const hasDoc = !!(data && data.css_document);
  const hasSheet = !!(data && data.css_spreadsheet);
  const hasVariants = hasDoc || hasSheet;
  // Only offer a medium the system actually has a variant for.
  const medium = (exampleMedium === "document" && !hasDoc) || (exampleMedium === "spreadsheet" && !hasSheet)
    ? "deck" : exampleMedium;
  // Live preview URL: bust cache when CSS is dirty + after save.
  const viewParam = view === "specimen" ? "&mode=specimen"
                  : medium === "document" ? "&example=document"
                  : medium === "spreadsheet" ? "&example=spreadsheet" : "";
  const previewUrl = `/preview/__design-system-preview/${systemId}.html?v=${previewKey}${viewParam}`;

  return (
    <div className="ds-editor">
      <div className="ds-editor-head">
        <button className="icon-btn" onClick={onBack} title="Back">
          <Icon name="arrow-left" />
        </button>
        <div className="ds-title-block">
          <input className="ds-name-input" value={name} readOnly={builtin}
                 onChange={(e) => { setName(e.target.value); setDirty(true); }} />
          <input className="ds-desc-input" placeholder="One-line description"
                 value={description} readOnly={builtin}
                 onChange={(e) => { setDescription(e.target.value); setDirty(true); }} />
        </div>
        <div className="ds-editor-actions">
          <div className="ds-view-seg">
            <button className={view === "specimen" ? "on" : ""}
                    onClick={() => setView("specimen")}
                    title="Tokens, type scale, and components from this system's CSS">
              <Icon name="layout-list" /> Specimen
            </button>
            <button className={view === "example" ? "on" : ""}
                    onClick={() => setView("example")}
                    title="Worked examples rendered in this system">
              <Icon name="gallery-horizontal-end" /> Examples
            </button>
          </div>
          {view === "example" && hasVariants && (
            <div className="ds-view-seg ds-medium-seg" title="Which medium to preview">
              <button className={medium === "deck" ? "on" : ""}
                      onClick={() => setExampleMedium("deck")}>
                <Icon name="presentation" /> Deck
              </button>
              {hasDoc && (
                <button className={medium === "document" ? "on" : ""}
                        onClick={() => setExampleMedium("document")}>
                  <Icon name="file-text" /> Document
                </button>
              )}
              {hasSheet && (
                <button className={medium === "spreadsheet" ? "on" : ""}
                        onClick={() => setExampleMedium("spreadsheet")}>
                  <Icon name="table" /> Spreadsheet
                </button>
              )}
            </div>
          )}
          <button className="btn btn-ghost" onClick={exportSpecimen} disabled={exportingPdf}
                  title="Export this system's specimen sheet as a PDF">
            <Icon name="file-down" /> {exportingPdf ? "Exporting…" : "Specimen PDF"}
          </button>
          {builtin ? (
            <span className="ds-readonly" title="Built-in baseline — immutable in the app">
              <Icon name="lock" /> Built-in
            </span>
          ) : (
            <>
              {dirty && <span className="eyebrow" style={{ color: "var(--wp-warn)" }}>unsaved</span>}
              <button className="btn btn-primary" onClick={() => setThemeOpen(true)}
                      title="Edit this system's name, description, colors, and fonts">
                <Icon name="palette" /> Edit
              </button>
              <button className="btn btn-ghost" onClick={remove}
                      title="Delete this design system">
                <Icon name="trash-2" />
              </button>
              <button className="btn btn-ghost" onClick={save} disabled={!dirty || saving}
                      title="Save name / description changes">
                <Icon name="save" /> {saving ? "saving…" : "Save"}
              </button>
            </>
          )}
        </div>
      </div>
      <div className="ds-editor-body is-preview-only">
        <div className="ds-preview-pane">
          <iframe key={`${previewKey}-${view}`} src={previewUrl}
                  title="Design system preview"
                  sandbox="allow-scripts allow-same-origin" />
        </div>
      </div>
      {themeOpen && (
        <DesignSystemModal system={data}
          onClose={() => setThemeOpen(false)}
          onSaved={() => { setThemeOpen(false); load(); setPreviewKey((k) => k + 1); onChange?.(); }} />
      )}
    </div>
  );
}

const root = ReactDOM.createRoot(document.getElementById("root"));
root.render(<App />);
