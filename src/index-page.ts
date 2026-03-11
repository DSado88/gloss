import fs from "node:fs";
import path from "node:path";
import type { ConvoMeta } from "./types.js";
import type { SessionRecord } from "./db.js";

/** Escape HTML special characters. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Shorten a model name for display.
 *
 * Strips `claude-` / `anthropic/` prefixes and `-YYYYMMDD` date suffixes.
 */
export function shortenModel(model: string): string {
  if (!model) return "\u2014";
  let s = model.toLowerCase();
  for (const prefix of ["anthropic/", "claude-"]) {
    if (s.startsWith(prefix)) {
      s = s.slice(prefix.length);
    }
  }
  // Strip date suffix
  s = s.replace(/-\d{8}$/, "");
  return s;
}

/**
 * Format an ISO-8601 timestamp for the index display.
 *
 * Returns "Mon DD, YYYY HH:MM AM/PM" in local timezone, or the first 16
 * characters of the raw string as a fallback.
 */
export function formatIndexTime(startTime: string): string {
  if (!startTime) return "";
  try {
    const dt = new Date(startTime);
    if (isNaN(dt.getTime())) return startTime.slice(0, 16);
    const months = [
      "Jan", "Feb", "Mar", "Apr", "May", "Jun",
      "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    const mon = months[dt.getMonth()];
    const dd = String(dt.getDate()).padStart(2, "0");
    const yyyy = dt.getFullYear();
    let hours = dt.getHours();
    const ampm = hours >= 12 ? "PM" : "AM";
    hours = hours % 12 || 12;
    const mm = String(dt.getMinutes()).padStart(2, "0");
    return `${mon} ${dd}, ${yyyy} ${hours}:${mm} ${ampm}`;
  } catch {
    return startTime.slice(0, 16);
  }
}

/**
 * Build the full index HTML page, inserting pre-built entry rows.
 */
export function buildIndexPage(entriesHtml: string, count: number): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Claude Conversations</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  :root {
    --bg: #0d1117;
    --surface: #161b22;
    --surface2: #21262d;
    --text: #e6edf3;
    --text2: #7d8590;
    --border: #30363d;
    --accent: #da7756;
  }
  @media (prefers-color-scheme: light) {
    :root {
      --bg: #f6f8fa;
      --surface: #ffffff;
      --surface2: #f0f2f5;
      --text: #1f2328;
      --text2: #656d76;
      --border: #d0d7de;
      --accent: #c2613a;
    }
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
    background: var(--bg);
    color: var(--text);
    -webkit-font-smoothing: antialiased;
    padding: 40px 24px;
    max-width: 960px;
    margin: 0 auto;
  }
  h1 {
    font-size: 1.5rem;
    font-weight: 600;
    margin-bottom: 4px;
  }
  .meta {
    color: var(--text2);
    font-size: 0.82rem;
    margin-bottom: 24px;
  }
  .index-list {
    display: flex;
    flex-direction: column;
    gap: 1px;
    background: var(--border);
    border-radius: 8px;
    overflow: hidden;
  }
  .index-entry {
    display: grid;
    grid-template-columns: 80px 1fr 140px 160px 90px;
    gap: 12px;
    align-items: center;
    padding: 12px 16px;
    background: var(--surface);
    text-decoration: none;
    color: inherit;
    transition: background 0.15s;
  }
  .index-entry:hover {
    background: var(--surface2);
  }
  .entry-id {
    font-family: 'SF Mono', 'Fira Code', monospace;
    font-size: 0.82rem;
    color: var(--accent);
    font-weight: 500;
  }
  .entry-project {
    font-size: 0.85rem;
    color: var(--text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .entry-model {
    font-size: 0.8rem;
    color: var(--text2);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .entry-time {
    font-size: 0.8rem;
    color: var(--text2);
    white-space: nowrap;
  }
  .entry-turns {
    font-size: 0.8rem;
    color: var(--text2);
    text-align: right;
    white-space: nowrap;
  }
  .empty {
    text-align: center;
    padding: 40px;
    color: var(--text2);
    background: var(--surface);
    border-radius: 8px;
  }
  @media (max-width: 700px) {
    .index-entry {
      grid-template-columns: 70px 1fr 80px;
    }
    .entry-model, .entry-time {
      display: none;
    }
  }
</style>
</head>
<body>
  <h1>Claude Conversations</h1>
  <div class="meta">${count} sessions</div>
  ${entriesHtml}
</body>
</html>`;
}

/**
 * Regenerate the `index.html` catalog of all rendered sessions in `viewerDir`.
 */
export function updateIndex(viewerDir: string): void {
  const metaPattern = /<!-- CONVO_META:(\{.*?\}) -->/;

  interface EntryMeta extends Partial<ConvoMeta> {
    _filename: string;
  }

  const entries: EntryMeta[] = [];

  let files: string[];
  try {
    files = fs.readdirSync(viewerDir).filter((f) => f.endsWith(".html")).sort();
  } catch {
    files = [];
  }

  for (const file of files) {
    if (file === "index.html") continue;
    try {
      const fd = fs.openSync(path.join(viewerDir, file), "r");
      let head: string;
      try {
        const buf = Buffer.alloc(1024);
        const bytesRead = fs.readSync(fd, buf, 0, 1024, 0);
        head = buf.toString("utf-8", 0, bytesRead);
      } finally {
        fs.closeSync(fd);
      }
      const match = metaPattern.exec(head);
      if (match) {
        const meta = JSON.parse(match[1]) as Partial<ConvoMeta>;
        entries.push({ ...meta, _filename: file });
      }
    } catch {
      continue;
    }
  }

  // Sort by start_time descending
  entries.sort((a, b) => {
    const ta = a.start_time ?? "";
    const tb = b.start_time ?? "";
    return tb.localeCompare(ta);
  });

  let entriesHtml: string;

  if (entries.length > 0) {
    const rows = entries.map((meta) => {
      const shortId = escapeHtml(meta.short_id ?? meta._filename);
      const project = meta.project_dir ?? "";
      let projectDisplay = "";
      if (project) {
        const parts = project.replace(/\/+$/, "").split("/");
        projectDisplay =
          parts.length >= 2 ? parts.slice(-2).join("/") : project;
      }
      const modelDisplay = shortenModel(meta.model ?? "");
      const timeDisplay = formatIndexTime(meta.start_time ?? "");
      const turnCount = meta.turn_count ?? 0;
      const userTurns = meta.user_turns ?? 0;
      const filename = meta._filename;

      return (
        `<a class="index-entry" href="${filename}">` +
        `<span class="entry-id">${shortId}</span>` +
        `<span class="entry-project" title="${escapeHtml(project)}">${escapeHtml(projectDisplay)}</span>` +
        `<span class="entry-model">${escapeHtml(modelDisplay)}</span>` +
        `<span class="entry-time">${timeDisplay}</span>` +
        `<span class="entry-turns">${turnCount} turns (${userTurns} user)</span>` +
        `</a>`
      );
    });
    entriesHtml = '<div class="index-list">\n' + rows.join("\n") + "\n</div>";
  } else {
    entriesHtml = '<div class="empty">No conversations rendered yet.</div>';
  }

  const indexHtml = buildIndexPage(entriesHtml, entries.length);
  fs.writeFileSync(path.join(viewerDir, "index.html"), indexHtml, "utf-8");
}

/**
 * Build an index page from session records (SQLite), for server mode.
 * Groups by project, sorted by recency, with client-side search/filter.
 */
/**
 * Decode a Claude projects directory name back to a readable path.
 * e.g. "-Users-david-Documents-Programs-fb-monitor" → "/Users/david/Documents/Programs/fb-monitor"
 *
 * The encoding replaces "/" with "-" and prepends "-". We can't perfectly reverse
 * this since "-" is ambiguous, but we can use the known prefix structure.
 */
function decodeProjectDir(encoded: string): string {
  if (!encoded.startsWith("-")) return encoded;
  // Common structure: -Users-<user>-Documents-Programs-<project>
  // or -Users-<user>-<project>
  // Try to find the known path segments and reconstruct
  const stripped = encoded.slice(1); // remove leading -
  // Replace the known path prefix segments, keeping everything after Programs/ or Documents/ intact
  // Temp dirs from runners (ori/orchid) — collapse to a readable label
  // e.g. "private-tmp-ori-orchid-work-bidi-1771993919-746449" → "ori/orchid-bidi"
  // e.g. "private-tmp-ori-orchid-work-streaming-01KHSTXMG..." → "ori/orchid-streaming"
  const tmpMatch = stripped.match(
    /^private-(?:tmp|var-folders-[^-]+-[^-]+-[^-]+-[^-]+-T)-ori-orchid-(?:work-)?(\w+?)[-_](?:\d{10,}|01[0-9A-Z]{20,})/,
  );
  if (tmpMatch) return "ori/orchid-" + tmpMatch[1];
  // Other /private/tmp or /var paths — just show last meaningful segment
  if (stripped.startsWith("private-tmp-") || stripped.startsWith("private-var-")) {
    const parts = stripped.split("-");
    // Find the last non-numeric, non-hash segment
    for (let i = parts.length - 1; i >= 0; i--) {
      if (parts[i].length > 2 && !/^\d+$/.test(parts[i]) && !/^[0-9a-f]{8,}$/i.test(parts[i]) && !/^01[0-9A-Z]{10,}$/.test(parts[i])) {
        return parts.slice(2, i + 1).join("-"); // skip "private-tmp"
      }
    }
  }

  const knownPrefixes = [
    /^Users-([^-]+)-Documents-Programs-/,
    /^Users-([^-]+)-Documents-/,
    /^Users-([^-]+)-/,
  ];
  for (const re of knownPrefixes) {
    const m = stripped.match(re);
    if (m) {
      const rest = stripped.slice(m[0].length);
      return rest || stripped;
    }
  }
  return stripped;
}

/**
 * Build an index page from session records (SQLite), for server mode.
 * Default view: flat list of recent sessions. Search filters by project/model/id.
 */
export function buildServerIndex(sessions: SessionRecord[]): string {
  const sessionsJson = JSON.stringify(
    sessions.map((s) => {
      // Decode the JSONL directory to a readable project name
      let dirProject = "";
      if (s.jsonl_path) {
        const dirName = s.jsonl_path.split("/").slice(-2, -1)[0] ?? "";
        dirProject = decodeProjectDir(dirName);
      }
      // Use metadata project's last component, or the decoded dir name
      const project = s.project ?? "";
      const parts = project.replace(/\/+$/, "").split("/");
      let shortProject = parts.length >= 1 ? parts[parts.length - 1] : "";
      // If shortProject looks like a KSUID, timestamp, or hash, prefer dirProject
      if (/^01[0-9A-Z]{10,}$/.test(shortProject) || /^\d{10,}/.test(shortProject) || /^[0-9a-f]{16,}$/i.test(shortProject)) {
        shortProject = "";
      }

      return {
        id: s.id,
        project: shortProject || dirProject || "",
        fullProject: project,
        dirProject,
        model: s.model ?? "",
        last_modified: s.last_modified ?? s.start_time ?? 0,
        turn_count: s.turn_count ?? 0,
      };
    }),
  );

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Gloss — Conversations</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  :root {
    --bg: #0d1117;
    --surface: #161b22;
    --surface2: #21262d;
    --text: #e6edf3;
    --text2: #7d8590;
    --border: #30363d;
    --accent: #da7756;
    --accent2: #da775620;
  }
  @media (prefers-color-scheme: light) {
    :root {
      --bg: #f6f8fa;
      --surface: #ffffff;
      --surface2: #f0f2f5;
      --text: #1f2328;
      --text2: #656d76;
      --border: #d0d7de;
      --accent: #c2613a;
      --accent2: #c2613a15;
    }
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
    background: var(--bg);
    color: var(--text);
    -webkit-font-smoothing: antialiased;
    padding: 32px 24px;
    max-width: 1000px;
    margin: 0 auto;
  }
  .header { display: flex; align-items: baseline; gap: 12px; margin-bottom: 16px; }
  h1 { font-size: 1.4rem; font-weight: 600; }
  .count { color: var(--text2); font-size: 0.85rem; }

  .controls { display: flex; gap: 8px; margin-bottom: 20px; flex-wrap: wrap; align-items: center; }
  .search {
    flex: 1; min-width: 200px;
    height: 34px;
    padding: 0 12px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 6px;
    color: var(--text);
    font-size: 0.85rem;
    outline: none;
  }
  .search:focus { border-color: var(--accent); }
  .view-btn {
    padding: 6px 12px;
    height: 34px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 6px;
    color: var(--text2);
    font-size: 0.8rem;
    cursor: pointer;
    white-space: nowrap;
  }
  .view-btn.active { color: var(--accent); border-color: var(--accent); background: var(--accent2); }

  /* Flat list */
  .session-table {
    display: flex; flex-direction: column; gap: 1px;
    background: var(--border);
    border-radius: 8px;
    overflow: hidden;
  }
  .session-row {
    display: grid;
    grid-template-columns: 160px 1fr 100px 60px;
    gap: 12px;
    align-items: center;
    padding: 10px 14px;
    background: var(--surface);
    text-decoration: none;
    color: inherit;
    transition: background 0.1s;
  }
  .session-row:hover { background: var(--surface2); }
  .session-row.table-header {
    font-size: 0.72rem;
    font-weight: 600;
    color: var(--text2);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    cursor: default;
    padding: 8px 14px;
  }
  .session-row.table-header:hover { background: var(--surface); }
  .s-project { font-size: 0.85rem; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .s-id {
    font-family: 'SF Mono', 'Fira Code', monospace;
    font-size: 0.78rem;
    color: var(--accent);
  }
  .s-meta { font-size: 0.78rem; color: var(--text2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .s-time { font-size: 0.78rem; color: var(--text2); white-space: nowrap; }
  .s-turns { font-size: 0.78rem; color: var(--text2); text-align: right; }
  .load-more {
    display: block; width: 100%; padding: 12px;
    background: var(--surface); border: none; color: var(--accent);
    font-size: 0.85rem; cursor: pointer; text-align: center;
  }
  .load-more:hover { background: var(--surface2); }

  /* Project groups */
  .project-group { margin-bottom: 2px; }
  .project-header {
    display: flex; align-items: center; gap: 8px;
    padding: 10px 14px;
    background: var(--surface);
    border-bottom: 1px solid var(--border);
    cursor: pointer;
    user-select: none;
  }
  .project-header:hover { background: var(--surface2); }
  .project-name { font-size: 0.9rem; font-weight: 500; }
  .project-count { font-size: 0.75rem; color: var(--text2); }
  .project-arrow { color: var(--text2); font-size: 0.65rem; transition: transform 0.15s; }
  .project-group.collapsed .project-arrow { transform: rotate(-90deg); }
  .project-group.collapsed .group-sessions { display: none; }
  .group-sessions { background: var(--border); display: flex; flex-direction: column; gap: 1px; }
  .group-sessions .session-row { grid-template-columns: 1fr 100px 60px; }
  .group-sessions .s-project { display: none; }

  .empty { text-align: center; padding: 40px; color: var(--text2); }

  /* Project filter dropdown */
  .filter-wrap { position: relative; }
  .filter-btn.has-muted { color: var(--accent); border-color: var(--accent); background: var(--accent2); }
  .filter-drop {
    display: none;
    position: absolute;
    top: 100%;
    right: 0;
    margin-top: 4px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 8px 0;
    min-width: 240px;
    max-height: 400px;
    overflow-y: auto;
    z-index: 100;
    box-shadow: 0 8px 24px rgba(0,0,0,0.25);
  }
  .filter-drop.open { display: block; }
  .filter-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 14px;
    font-size: 0.82rem;
    cursor: pointer;
    user-select: none;
  }
  .filter-item:hover { background: var(--surface2); }
  .filter-item input { accent-color: var(--accent); }
  .filter-item .proj-count { color: var(--text2); font-size: 0.75rem; margin-left: auto; }
  .filter-actions {
    display: flex; gap: 8px; padding: 6px 14px; border-top: 1px solid var(--border); margin-top: 4px;
  }
  .filter-actions button {
    background: none; border: none; color: var(--accent); font-size: 0.78rem; cursor: pointer; padding: 2px 0;
  }
  .filter-actions button:hover { text-decoration: underline; }
  .filter-search {
    display: block; width: calc(100% - 28px); margin: 4px 14px 6px;
    padding: 5px 8px;
    background: var(--surface2); border: 1px solid var(--border); border-radius: 4px;
    color: var(--text); font-size: 0.8rem; outline: none;
  }
  .filter-search:focus { border-color: var(--accent); }

  @media (max-width: 640px) {
    .session-row { grid-template-columns: 140px 1fr 50px; }
    .s-meta { display: none; }
    .group-sessions .session-row { grid-template-columns: 1fr 50px; }
    .s-time { display: none; }
  }
</style>
</head>
<body>
  <div class="header">
    <h1>Gloss</h1>
    <span class="count" id="count"></span>
  </div>
  <div class="controls">
    <input class="search" id="search" type="text" placeholder="Search..." autofocus>
    <button class="view-btn active" data-view="recent" onclick="setView('recent')">Recent</button>
    <button class="view-btn" data-view="project" onclick="setView('project')">By project</button>
    <div class="filter-wrap">
      <button class="view-btn filter-btn" id="filterBtn" onclick="toggleFilter()">Filter projects</button>
      <div class="filter-drop" id="filterDrop"></div>
    </div>
  </div>
  <div id="content"></div>

<script>
const ALL = ${sessionsJson};
let view = 'recent';
let query = '';
let showCount = 80;
let mutedProjects = new Set(JSON.parse(localStorage.getItem('gloss_muted_projects') || '[]'));

function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

function shortModel(m) {
  if (!m) return '';
  return m.toLowerCase().replace(/^(anthropic\\/|claude-)/, '').replace(/-\\d{8}$/, '');
}

function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  const diff = Date.now() - d.getTime();
  if (diff < 3600000) return Math.max(1, Math.floor(diff / 60000)) + 'm ago';
  if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
  if (diff < 604800000) return Math.floor(diff / 86400000) + 'd ago';
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return months[d.getMonth()] + ' ' + d.getDate();
}

function filter(list) {
  let out = list;
  if (mutedProjects.size) {
    out = out.filter(s => {
      const key = s.project || s.dirProject || 'Unknown';
      return !mutedProjects.has(key);
    });
  }
  if (!query) return out;
  const q = query.toLowerCase();
  return out.filter(s =>
    s.project.toLowerCase().includes(q) ||
    s.dirProject.toLowerCase().includes(q) ||
    s.fullProject.toLowerCase().includes(q) ||
    s.model.toLowerCase().includes(q) ||
    s.id.toLowerCase().includes(q)
  );
}

function setView(v) {
  view = v;
  showCount = 80;
  document.querySelectorAll('.view-btn').forEach(b => b.classList.toggle('active', b.dataset.view === v));
  render();
}

function renderRecent(filtered) {
  const sorted = [...filtered].sort((a, b) => (b.last_modified || 0) - (a.last_modified || 0));
  const visible = sorted.slice(0, showCount);

  let html = '<div class="session-table">';
  html += '<div class="session-row table-header"><span>Project</span><span>Session</span><span>When</span><span style="text-align:right">Turns</span></div>';
  for (const s of visible) {
    const proj = esc(s.project || s.dirProject || '—');
    const model = shortModel(s.model);
    html += '<a class="session-row" href="/c/' + s.id + '">';
    html += '<span class="s-project" title="' + esc(s.fullProject) + '">' + proj + '</span>';
    html += '<span><span class="s-id">' + s.id + '</span> <span class="s-meta">' + esc(model) + '</span></span>';
    html += '<span class="s-time">' + fmtTime(s.last_modified) + '</span>';
    html += '<span class="s-turns">' + (s.turn_count || '—') + '</span>';
    html += '</a>';
  }
  if (sorted.length > showCount) {
    html += '<button class="load-more" onclick="showCount+=' + 80 + ';render()">Show more (' + (sorted.length - showCount) + ' remaining)</button>';
  }
  html += '</div>';
  return html;
}

function renderByProject(filtered) {
  const groups = new Map();
  for (const s of filtered) {
    const key = s.project || s.dirProject || 'Unknown';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }
  for (const arr of groups.values()) arr.sort((a, b) => (b.last_modified || 0) - (a.last_modified || 0));

  const sorted = [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));

  let html = '';
  for (const [name, sessions] of sorted) {
    const collapsed = sessions.length > 5 ? ' collapsed' : '';
    html += '<div class="project-group' + collapsed + '">';
    html += '<div class="project-header" onclick="this.parentElement.classList.toggle(\\'collapsed\\')">';
    html += '<span class="project-arrow">&#9660;</span>';
    html += '<span class="project-name">' + esc(name) + '</span>';
    html += '<span class="project-count">' + sessions.length + '</span>';
    html += '</div>';
    html += '<div class="group-sessions">';
    for (const s of sessions) {
      const model = shortModel(s.model);
      html += '<a class="session-row" href="/c/' + s.id + '">';
      html += '<span class="s-project">' + esc(name) + '</span>';
      html += '<span><span class="s-id">' + s.id + '</span> <span class="s-meta">' + esc(model) + '</span></span>';
      html += '<span class="s-time">' + fmtTime(s.last_modified) + '</span>';
      html += '<span class="s-turns">' + (s.turn_count || '—') + '</span>';
      html += '</a>';
    }
    html += '</div></div>';
  }
  return html;
}

function render() {
  const filtered = filter(ALL);
  const unmuted = mutedProjects.size ? ALL.filter(s => !mutedProjects.has(s.project || s.dirProject || 'Unknown')).length : ALL.length;
  const label = query ? filtered.length + ' of ' + unmuted : (mutedProjects.size ? unmuted + ' of ' + ALL.length : '' + ALL.length);
  document.getElementById('count').textContent = label + ' sessions';

  if (filtered.length === 0) {
    document.getElementById('content').innerHTML = '<div class="empty">No matching conversations.</div>';
    return;
  }

  document.getElementById('content').innerHTML = view === 'recent' ? renderRecent(filtered) : renderByProject(filtered);
}

document.getElementById('search').addEventListener('input', function(e) {
  query = e.target.value;
  showCount = 80;
  render();
});

// --- Project filter ---
function getProjectCounts() {
  const counts = new Map();
  for (const s of ALL) {
    const key = s.project || s.dirProject || 'Unknown';
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

function saveMuted() {
  localStorage.setItem('gloss_muted_projects', JSON.stringify([...mutedProjects]));
  document.getElementById('filterBtn').classList.toggle('has-muted', mutedProjects.size > 0);
}

let filterQuery = '';

function buildFilterDrop() {
  const drop = document.getElementById('filterDrop');
  // Build the static header (actions + search) only once
  if (!drop.querySelector('#filterSearch')) {
    let header = '<div class="filter-actions" style="border-top:none;border-bottom:1px solid var(--border);margin-top:0;margin-bottom:4px">';
    header += '<button onclick="showAll()">Select all</button><button onclick="muteAll()">Hide all</button>';
    header += '</div>';
    header += '<input class="filter-search" id="filterSearch" type="text" placeholder="Filter...">';
    header += '<div id="filterList"></div>';
    drop.innerHTML = header;
    document.getElementById('filterSearch').addEventListener('input', function(e) {
      filterQuery = e.target.value;
      updateFilterList();
    });
  }
  updateFilterList();
}

function updateFilterList() {
  const projects = getProjectCounts();
  const fq = filterQuery.toLowerCase();
  const filtered = fq ? projects.filter(([name]) => name.toLowerCase().includes(fq)) : projects;
  let html = '';
  for (const [name, count] of filtered) {
    const checked = !mutedProjects.has(name) ? ' checked' : '';
    html += '<label class="filter-item"><input type="checkbox"' + checked + ' data-proj="' + esc(name) + '" onchange="toggleProject(this)"><span>' + esc(name) + '</span><span class="proj-count">' + count + '</span></label>';
  }
  document.getElementById('filterList').innerHTML = html;
}

function toggleFilter() {
  const drop = document.getElementById('filterDrop');
  const isOpen = drop.classList.toggle('open');
  if (isOpen) { filterQuery = ''; buildFilterDrop(); }
}

function toggleProject(el) {
  const name = el.dataset.proj;
  if (el.checked) mutedProjects.delete(name);
  else mutedProjects.add(name);
  saveMuted();
  showCount = 80;
  render();
}

function muteAll() {
  const fq = filterQuery.toLowerCase();
  const projects = getProjectCounts();
  const targets = fq ? projects.filter(([name]) => name.toLowerCase().includes(fq)) : projects;
  for (const [name] of targets) mutedProjects.add(name);
  saveMuted();
  updateFilterList();
  showCount = 80;
  render();
}

function showAll() {
  const fq = filterQuery.toLowerCase();
  if (!fq) { mutedProjects.clear(); }
  else {
    const projects = getProjectCounts();
    for (const [name] of projects) {
      if (name.toLowerCase().includes(fq)) mutedProjects.delete(name);
    }
  }
  saveMuted();
  updateFilterList();
  showCount = 80;
  render();
}

// Close filter dropdown when clicking outside
document.addEventListener('click', function(e) {
  if (!e.target.closest('.filter-wrap')) {
    document.getElementById('filterDrop').classList.remove('open');
  }
});

// Init filter button state
document.getElementById('filterBtn').classList.toggle('has-muted', mutedProjects.size > 0);

render();
</script>
</body>
</html>`;
}
