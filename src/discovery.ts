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
 */
export function scanProjectsDir(
  projectsDir?: string,
): DiscoveredSession[] {
  const dir = projectsDir ?? path.join(os.homedir(), ".claude", "projects");
  if (!fs.existsSync(dir)) return [];

  const jsonlFiles = findJsonlFiles(dir);
  const sessions: DiscoveredSession[] = [];

  for (const filePath of jsonlFiles) {
    try {
      const stat = fs.statSync(filePath);

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
      sessions.push({
        id: sessionId,
        path: filePath,
        projectDir: meta.projectDir ?? undefined,
        model: meta.model ?? undefined,
        startTime: meta.startTime ?? undefined,
        lastModified: stat.mtimeMs,
      });
    } catch {
      // Skip unreadable files
      continue;
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

  return Array.from(byId.values());
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
    });
  }
}
