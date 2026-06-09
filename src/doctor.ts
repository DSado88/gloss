import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { scanAllProjects, resolveProjectsRoots, classifyJsonlPath, type DiscoveredSession, type ProjectsRoot } from "./discovery.js";
import type { ConvoDb } from "./db.js";

// ---------------------------------------------------------------------------
// gloss doctor — corpus + DB health report
//
// Read-only. Surfaces the ingestion problems that used to fail silently:
// duplicate session ids, agent/temp files winning canonical selection,
// DB rows pointing at deleted files, stale search indexes, files skipped
// for size, and annotation backup recency.
// ---------------------------------------------------------------------------

export type DoctorSeverity = "critical" | "warning" | "info";

export interface DoctorFinding {
  severity: DoctorSeverity;
  code: string;
  message: string;
  count?: number;
  /** Sample paths/ids (capped) so the report stays readable. */
  details?: string[];
}

export interface DoctorReport {
  generatedAt: string;
  projectsDir: string;
  totals: {
    jsonlFiles: number;
    emptyFiles: number;
    missingTrailingNewline: number;
    duplicateSessionIds: number;
    dbSessions: number;
    annotations: number;
    ftsIndexed: number;
    embeddingIndexed: number;
    lastAnnotationBackup: string | null;
  };
  findings: DoctorFinding[];
  hasCritical: boolean;
}

const DETAIL_CAP = 10;
const FTS_LIMIT = 100 * 1024 * 1024;
const EMBEDDING_LIMIT = 50 * 1024 * 1024;

function lastByteIsNewline(filePath: string, size: number): boolean {
  const fd = fs.openSync(filePath, "r");
  try {
    const buf = Buffer.alloc(1);
    fs.readSync(fd, buf, 0, 1, size - 1);
    return buf[0] === 0x0a;
  } finally {
    fs.closeSync(fd);
  }
}

export function runDoctor(db: ConvoDb, projectsDirArg?: string): DoctorReport {
  const roots: ProjectsRoot[] = projectsDirArg
    ? [{ source: "local", path: projectsDirArg }]
    : resolveProjectsRoots();
  const projectsDir = roots.map((r) => r.path).join(", ");

  const findings: DoctorFinding[] = [];
  const add = (severity: DoctorSeverity, code: string, message: string, items?: string[]) => {
    if (items && items.length === 0) return;
    findings.push({
      severity,
      code,
      message,
      ...(items ? { count: items.length, details: items.slice(0, DETAIL_CAP) } : {}),
    });
  };

  // ---- Filesystem scan ----------------------------------------------------
  const { sessions: canonical, allSessions = [] } = scanAllProjects(roots, { collectAll: true });

  const emptyFiles = allSessions.filter((s) => s.fileSize === 0);
  add("info", "empty-jsonl", "Empty JSONL files", emptyFiles.map((s) => s.path));

  const noNewline: string[] = [];
  for (const s of allSessions) {
    if (s.fileSize === 0) continue;
    try {
      if (!lastByteIsNewline(s.path, s.fileSize)) noNewline.push(s.path);
    } catch {
      // unreadable — skip
    }
  }
  add("info", "missing-trailing-newline", "Files without trailing newline (likely mid-write)", noNewline);

  // Duplicate session ids across files
  const byId = new Map<string, DiscoveredSession[]>();
  for (const s of allSessions) {
    const group = byId.get(s.id);
    if (group) group.push(s);
    else byId.set(s.id, [s]);
  }
  const dupGroups = [...byId.entries()].filter(([, group]) => group.length > 1);
  add(
    "info",
    "duplicate-session-ids",
    "Session ids appearing in multiple JSONL files (canonical ranking picks one)",
    dupGroups.map(([id, group]) => `${id} (${group.length} files)`),
  );

  // Oversized files skipped by indexing
  add(
    "warning",
    "fts-skipped-oversize",
    `Files over ${FTS_LIMIT / 1048576}MB — skipped by FTS indexing`,
    canonical.filter((s) => s.fileSize > FTS_LIMIT).map((s) => s.path),
  );
  add(
    "info",
    "embedding-skipped-oversize",
    `Files over ${EMBEDDING_LIMIT / 1048576}MB — skipped by embedding indexing`,
    canonical.filter((s) => s.fileSize > EMBEDDING_LIMIT && s.fileSize <= FTS_LIMIT).map((s) => s.path),
  );

  // ---- DB cross-checks ----------------------------------------------------
  const bestById = new Map(canonical.map((s) => [s.id, s]));
  const dbSessions = db.listSessions({ includeHidden: true });

  const missingPaths: string[] = [];
  const outsideDir: string[] = [];
  const agentCanonicalBetterExists: string[] = [];
  const agentCanonicalOnly: string[] = [];
  const tempCanonicalBetterExists: string[] = [];
  const tempCanonicalOnly: string[] = [];
  const staleFts: string[] = [];
  const staleEmbeddings: string[] = [];

  for (const sess of dbSessions) {
    const p = sess.jsonl_path;
    if (!p) continue;

    let stat: fs.Stats | null = null;
    try {
      stat = fs.statSync(p);
    } catch {
      stat = null;
    }
    if (!stat) {
      missingPaths.push(`${sess.id} → ${p}`);
      continue;
    }

    if (!roots.some((r) => p.startsWith(r.path + path.sep))) {
      outsideDir.push(`${sess.id} → ${p}`);
    }

    const cls = classifyJsonlPath(p);
    if (cls.isAgentFile) {
      const best = bestById.get(sess.id);
      if (best && best.path !== p) {
        agentCanonicalBetterExists.push(`${sess.id} → ${p} (better: ${best.path})`);
      } else {
        agentCanonicalOnly.push(`${sess.id} → ${p}`);
      }
    }
    if (cls.isTempPath) {
      const best = bestById.get(sess.id);
      if (best && best.path !== p) {
        tempCanonicalBetterExists.push(`${sess.id} → ${p} (better: ${best.path})`);
      } else {
        tempCanonicalOnly.push(`${sess.id} → ${p}`);
      }
    }

    // Index staleness: only flag sessions that HAVE an index entry that is
    // now out of date. Never-indexed sessions are backlog, not staleness.
    if (stat.size <= FTS_LIMIT) {
      const hasFts = db.db.query("SELECT 1 FROM fts_status WHERE session_id = ?").get(sess.id);
      if (hasFts && db.ftsNeedsIndexing(sess.id, stat.mtimeMs, stat.size)) {
        staleFts.push(sess.id);
      }
    }
    if (stat.size <= EMBEDDING_LIMIT) {
      const hasEmb = db.db.query("SELECT 1 FROM embedding_status WHERE session_id = ?").get(sess.id);
      if (hasEmb && db.embeddingNeedsIndexing(sess.id, stat.mtimeMs, stat.size)) {
        staleEmbeddings.push(sess.id);
      }
    }
  }

  add("warning", "missing-jsonl", "DB sessions whose JSONL file no longer exists", missingPaths);
  add("warning", "outside-projects-dir", "DB sessions pointing outside the projects dir", outsideDir);
  add(
    "critical",
    "agent-file-canonical",
    "DB sessions whose canonical file is an agent transcript while a better file exists (annotations may be misanchored — rescan to heal)",
    agentCanonicalBetterExists,
  );
  add("info", "agent-file-only", "Sessions whose only transcript is an agent file", agentCanonicalOnly);
  add(
    "warning",
    "temp-path-canonical",
    "DB sessions canonical to a temp-cwd transcript while a better file exists (rescan to heal)",
    tempCanonicalBetterExists,
  );
  add("info", "temp-path-only", "Sessions whose only transcript came from a temp cwd (normal for headless agents)", tempCanonicalOnly);
  add("warning", "stale-fts", "Sessions with an outdated FTS index (backfill will catch up)", staleFts);
  add("warning", "stale-embeddings", "Sessions with outdated embeddings (backfill will catch up)", staleEmbeddings);

  // ---- Annotations ---------------------------------------------------------
  const annCount = (db.db.query("SELECT COUNT(*) AS n FROM annotations").get() as { n: number }).n;

  let lastBackup: string | null = null;
  if (db.dbPath && db.dbPath !== ":memory:") {
    const backupsDir = path.join(path.dirname(db.dbPath), "backups");
    try {
      let latest = 0;
      for (const f of fs.readdirSync(backupsDir)) {
        if (!/^annotations-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)) continue;
        const m = fs.statSync(path.join(backupsDir, f)).mtimeMs;
        if (m > latest) latest = m;
      }
      if (latest > 0) lastBackup = new Date(latest).toISOString();
    } catch {
      // no backups dir yet
    }
  }
  if (annCount > 0 && !lastBackup) {
    add(
      "warning",
      "no-annotation-backup",
      `${annCount} annotations exist but no journal/backup found — run \`annotations export\` before any rebuild`,
    );
  }

  const hasCritical = findings.some((f) => f.severity === "critical");

  return {
    generatedAt: new Date().toISOString(),
    projectsDir,
    totals: {
      jsonlFiles: allSessions.length,
      emptyFiles: emptyFiles.length,
      missingTrailingNewline: noNewline.length,
      duplicateSessionIds: dupGroups.length,
      dbSessions: dbSessions.length,
      annotations: annCount,
      ftsIndexed: db.ftsIndexedCount(),
      embeddingIndexed: db.embeddingIndexedCount(),
      lastAnnotationBackup: lastBackup,
    },
    findings,
    hasCritical,
  };
}

/** Human-readable report for terminal output. */
export function formatDoctorReport(report: DoctorReport): string {
  const lines: string[] = [];
  const t = report.totals;
  lines.push(`Gloss Doctor — ${report.generatedAt}`);
  lines.push(`Projects dir: ${report.projectsDir}`);
  lines.push("");
  lines.push(`  JSONL files:          ${t.jsonlFiles} (${t.emptyFiles} empty, ${t.missingTrailingNewline} mid-write)`);
  lines.push(`  Duplicate ids:        ${t.duplicateSessionIds}`);
  lines.push(`  DB sessions:          ${t.dbSessions}`);
  lines.push(`  FTS indexed:          ${t.ftsIndexed}`);
  lines.push(`  Embedding indexed:    ${t.embeddingIndexed}`);
  lines.push(`  Annotations:          ${t.annotations}`);
  lines.push(`  Last annotation bkp:  ${t.lastAnnotationBackup ?? "never"}`);
  lines.push("");

  if (report.findings.length === 0) {
    lines.push("No findings. All clear.");
    return lines.join("\n");
  }

  const icon: Record<DoctorSeverity, string> = { critical: "✖", warning: "⚠", info: "·" };
  for (const sev of ["critical", "warning", "info"] as const) {
    for (const f of report.findings.filter((x) => x.severity === sev)) {
      lines.push(`${icon[sev]} [${sev}] ${f.message}${f.count != null ? ` (${f.count})` : ""}`);
      for (const d of f.details ?? []) {
        lines.push(`    ${d}`);
      }
      if (f.count != null && f.count > (f.details?.length ?? 0)) {
        lines.push(`    … and ${f.count - (f.details?.length ?? 0)} more`);
      }
    }
  }
  return lines.join("\n");
}
