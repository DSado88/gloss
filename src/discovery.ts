import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { IncrementalParser } from "./incremental-parser.js";
import type { ConvoDb } from "./db.js";

export interface DiscoveredSession {
  id: string;
  path: string;
  projectDir?: string;
  model?: string;
  startTime?: string;
  lastModified: number;
  fileSize: number;
}

export interface ScanResult {
  sessions: DiscoveredSession[];
  changedCount: number;  // How many files were new or modified
}

/** Cache of previously discovered sessions, keyed by JSONL path. */
const discoveryCache = new Map<string, { mtimeMs: number; session: DiscoveredSession }>();

/** Clear the discovery cache (useful for tests). */
export function clearDiscoveryCache(): void {
  discoveryCache.clear();
}

/**
 * Recursively find all *.jsonl files under a directory,
 * excluding subagents/ directories.
 */
function findJsonlFiles(dir: string): string[] {
  const results: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "subagents") continue;
      results.push(...findJsonlFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      results.push(fullPath);
    }
  }
  return results;
}

/**
 * Scan ~/.claude/projects/ for JSONL conversation files.
 * Parses the first ~50 lines of each to extract metadata.
 * Uses an mtime cache to skip redundant 32KB reads for unchanged files.
 */
export function scanProjectsDir(
  projectsDir?: string,
): ScanResult {
  const dir = projectsDir ?? path.join(os.homedir(), ".claude", "projects");
  if (!fs.existsSync(dir)) return { sessions: [], changedCount: 0 };

  const jsonlFiles = findJsonlFiles(dir);
  const sessions: DiscoveredSession[] = [];
  const currentPaths = new Set<string>();
  let changedCount = 0;

  for (const filePath of jsonlFiles) {
    try {
      const stat = fs.statSync(filePath);
      currentPaths.add(filePath);

      // Check mtime cache: skip the expensive 32KB read + parse if unchanged
      const cached = discoveryCache.get(filePath);
      if (cached && cached.mtimeMs === stat.mtimeMs) {
        sessions.push(cached.session);
        continue;
      }

      // File is new or modified — do the full read + parse
      changedCount++;

      // Read only the first ~32KB for metadata extraction (avoids loading 200MB+ files)
      const fd = fs.openSync(filePath, "r");
      const buf = Buffer.alloc(Math.min(32768, stat.size));
      fs.readSync(fd, buf, 0, buf.length, 0);
      fs.closeSync(fd);
      const snippet = buf.toString("utf-8");
      // Take first ~50 lines from the snippet
      const lines = snippet.split("\n").slice(0, 50);

      const parser = new IncrementalParser();
      parser.feedLines(lines);
      const meta = parser.getMetadata();

      const sessionId = meta.sessionId ?? path.parse(filePath).name;
      const session: DiscoveredSession = {
        id: sessionId,
        path: filePath,
        projectDir: meta.projectDir ?? undefined,
        model: meta.model ?? undefined,
        startTime: meta.startTime ?? undefined,
        lastModified: stat.mtimeMs,
        fileSize: stat.size,
      };
      discoveryCache.set(filePath, { mtimeMs: stat.mtimeMs, session });
      sessions.push(session);
    } catch {
      // Skip unreadable files
      continue;
    }
  }

  // Clean up cache entries for deleted files
  let deletedCount = 0;
  for (const [cachedPath] of discoveryCache) {
    if (!currentPaths.has(cachedPath)) {
      discoveryCache.delete(cachedPath);
      deletedCount++;
    }
  }

  // Deduplicate: same session UUID can appear in multiple project dirs
  // (context continuation). Keep the most recently modified copy.
  const byId = new Map<string, DiscoveredSession>();
  for (const s of sessions) {
    const existing = byId.get(s.id);
    if (!existing || s.lastModified > existing.lastModified) {
      byId.set(s.id, s);
    }
  }

  return { sessions: Array.from(byId.values()), changedCount: changedCount + deletedCount };
}

/**
 * Sync discovered sessions into the SQLite database.
 */
export function syncToDb(
  db: ConvoDb,
  sessions: DiscoveredSession[],
): void {
  for (const session of sessions) {
    db.upsertSession({
      id: session.id,
      jsonl_path: session.path,
      project: session.projectDir,
      model: session.model,
      start_time: session.startTime
        ? Math.floor(new Date(session.startTime).getTime() / 1000)
        : undefined,
      last_modified: Math.floor(session.lastModified / 1000),
      file_size: session.fileSize,
    });
  }
}

/** Max file size for accurate turn counting (50MB). Larger files use fast estimate. */
const ACCURATE_COUNT_LIMIT = 50 * 1024 * 1024;

/**
 * Accurate turn count using IncrementalParser.
 * Handles consecutive same-role merging and tool-result folding.
 */
function countTurnsAccurate(filePath: string): number {
  const content = fs.readFileSync(filePath, "utf-8");
  const parser = new IncrementalParser();
  parser.feedLines(content.split("\n"));
  return parser.getTurns().length;
}

/**
 * Fast line-based turn estimate for large files.
 * Counts lines containing "type":"user" or "type":"assistant" in 1MB chunks.
 * Returns a raw message count (higher than actual turns due to merging).
 * Divides by 2 as a rough approximation since tool results inflate the count.
 */
function countTurnsFast(filePath: string): number {
  const CHUNK = 1024 * 1024;
  const fd = fs.openSync(filePath, "r");
  const buf = Buffer.alloc(CHUNK);
  let count = 0;
  let leftover = "";
  let offset = 0;

  try {
    while (true) {
      const bytesRead = fs.readSync(fd, buf, 0, CHUNK, offset);
      if (bytesRead === 0) break;
      const text = leftover + buf.toString("utf-8", 0, bytesRead);
      const lines = text.split("\n");
      leftover = lines.pop() ?? "";
      for (const line of lines) {
        if (line.includes('"type":"user"') || line.includes('"type":"assistant"')) {
          count++;
        }
      }
      offset += bytesRead;
    }
    if (leftover && (leftover.includes('"type":"user"') || leftover.includes('"type":"assistant"'))) {
      count++;
    }
  } finally {
    fs.closeSync(fd);
  }

  // Raw line count is ~3-10x higher than actual turns due to tool result
  // folding and consecutive-role merging. Divide by 4 as rough estimate.
  return Math.max(1, Math.round(count / 4));
}

/**
 * Count turns for a file, choosing accurate or fast method based on size.
 */
function countTurns(filePath: string, fileSize: number): number {
  if (fileSize <= ACCURATE_COUNT_LIMIT) {
    return countTurnsAccurate(filePath);
  }
  return countTurnsFast(filePath);
}

/**
 * Background backfill: count turns for sessions that don't have counts yet.
 * Skips sessions where turn_count > 0 and file_size hasn't changed.
 * Processes in batches to avoid blocking the event loop.
 */
export function backfillTurnCounts(db: ConvoDb): void {
  const sessions = db.listSessions({}) as Array<{
    id: string;
    jsonl_path?: string | null;
    turn_count?: number | null;
    file_size?: number | null;
  }>;

  const needsCounting = sessions.filter(
    (s) => s.jsonl_path && (!s.turn_count || s.turn_count === 0),
  );

  if (needsCounting.length === 0) return;

  console.log(`Counting turns for ${needsCounting.length} sessions...`);
  let i = 0;
  let counted = 0;

  const batch = () => {
    const end = Math.min(i + 5, needsCounting.length);
    for (; i < end; i++) {
      const s = needsCounting[i];
      if (!s.jsonl_path) continue;
      try {
        const stat = fs.statSync(s.jsonl_path);
        if (!stat.isFile()) continue;
        const turnCount = countTurns(s.jsonl_path, stat.size);
        if (turnCount > 0) {
          db.db.run("UPDATE sessions SET turn_count = ? WHERE id = ?", [turnCount, s.id]);
          counted++;
        }
      } catch {
        // file may have been deleted
      }
    }

    if (i < needsCounting.length) {
      setTimeout(batch, 5); // yield to event loop between batches
    } else {
      console.log(`Turn counts: ${counted} sessions updated`);
    }
  };

  batch();
}

/** Max file size for FTS indexing (100MB). Larger files skipped. */
const FTS_INDEX_LIMIT = 100 * 1024 * 1024;

/**
 * Background FTS indexing: index conversation text for full-text search.
 * Processes sessions that haven't been indexed yet, in batches.
 */
export function backfillFtsIndex(db: ConvoDb): void {
  const sessions = db.listSessions({}) as Array<{
    id: string;
    jsonl_path?: string | null;
    file_size?: number | null;
  }>;

  // Check each session: needs indexing if never indexed or file changed since last index
  const needsIndexing: Array<{ id: string; jsonl_path: string; mtime: number }> = [];
  for (const s of sessions) {
    if (!s.jsonl_path) continue;
    try {
      const stat = fs.statSync(s.jsonl_path);
      if (!stat.isFile() || stat.size > FTS_INDEX_LIMIT) continue;
      const mtime = Math.floor(stat.mtimeMs / 1000);
      if (db.ftsNeedsIndexing(s.id, mtime)) {
        needsIndexing.push({ id: s.id, jsonl_path: s.jsonl_path, mtime });
      }
    } catch {
      continue;
    }
  }

  if (needsIndexing.length === 0) return;

  console.log(`FTS indexing ${needsIndexing.length} sessions...`);
  let i = 0;
  let indexed = 0;

  const batch = () => {
    const end = Math.min(i + 3, needsIndexing.length);
    for (; i < end; i++) {
      const s = needsIndexing[i];
      try {
        const content = fs.readFileSync(s.jsonl_path, "utf-8");
        const parser = new IncrementalParser();
        parser.feedLines(content.split("\n"));
        const turns = parser.getTurns();

        const ftsData = turns.map((t) => ({
          role: t.role,
          text: t.blocks
            .filter((b): b is { type: "text"; text: string } => b.type === "text")
            .map((b) => b.text || "")
            .join("\n"),
        }));

        db.indexSession(s.id, ftsData, s.mtime);
        indexed++;
      } catch {
        // skip unreadable files
      }
    }

    if (i < needsIndexing.length) {
      setTimeout(batch, 10); // yield to event loop between batches
    } else {
      console.log(`FTS: ${indexed} sessions indexed`);
    }
  };

  batch();
}
