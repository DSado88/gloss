import fs from "node:fs";
import path from "node:path";
import type { ConvoMeta } from "./types.js";

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
