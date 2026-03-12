import { Database, type SQLQueryBindings } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SessionRecord {
  id: string;
  jsonl_path?: string | null;
  title?: string | null;
  project?: string | null;
  model?: string | null;
  start_time?: number | null;
  turn_count?: number | null;
  imported_at?: number | null;
  last_modified?: number | null;
  file_size?: number | null;
}

export interface AnnotationRecord {
  id: string;
  session_id: string;
  turn_index: number;
  block_index?: number;
  char_start: number;
  char_end: number;
  text: string;
  comment?: string;
  kind?: string;
  speaker?: string | null;
  created_at?: number;
  updated_at?: number;
}

export interface AnnotationWithTags extends AnnotationRecord {
  tags: string[];
  session_title?: string | null;
  session_project?: string | null;
}

export interface TagRecord {
  id: number;
  name: string;
  color: string | null;
}

export interface TagWithCount extends TagRecord {
  count: number;
}

/** Shape of an annotation in the sidecar `.annotations.json` files. */
export interface SidecarAnnotation {
  id: string;
  turnIndex: number;
  blockIndex?: number;
  charStart: number;
  charEnd: number;
  text: string;
  comment?: string;
  kind?: string;
  speaker?: string;
  role?: string;
  tags?: string[];
  timestamp?: number;
  created?: number;
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  jsonl_path TEXT,
  title TEXT,
  project TEXT,
  model TEXT,
  start_time INTEGER,
  turn_count INTEGER,
  imported_at INTEGER NOT NULL DEFAULT (unixepoch()),
  last_modified INTEGER,
  file_size INTEGER
);

CREATE TABLE IF NOT EXISTS annotations (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  turn_index INTEGER NOT NULL,
  block_index INTEGER NOT NULL DEFAULT 0,
  char_start INTEGER NOT NULL,
  char_end INTEGER NOT NULL,
  text TEXT NOT NULL,
  comment TEXT DEFAULT '',
  kind TEXT DEFAULT 'highlight',
  speaker TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  color TEXT
);

CREATE TABLE IF NOT EXISTS annotation_tags (
  annotation_id TEXT NOT NULL REFERENCES annotations(id) ON DELETE CASCADE,
  tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (annotation_id, tag_id)
);

CREATE VIRTUAL TABLE IF NOT EXISTS annotations_fts USING fts5(
  text, comment, content=annotations, content_rowid=rowid
);

CREATE TRIGGER IF NOT EXISTS annotations_ai AFTER INSERT ON annotations BEGIN
  INSERT INTO annotations_fts(rowid, text, comment) VALUES (new.rowid, new.text, new.comment);
END;

CREATE TRIGGER IF NOT EXISTS annotations_ad AFTER DELETE ON annotations BEGIN
  INSERT INTO annotations_fts(annotations_fts, rowid, text, comment) VALUES('delete', old.rowid, old.text, old.comment);
END;

CREATE TRIGGER IF NOT EXISTS annotations_au AFTER UPDATE ON annotations BEGIN
  INSERT INTO annotations_fts(annotations_fts, rowid, text, comment) VALUES('delete', old.rowid, old.text, old.comment);
  INSERT INTO annotations_fts(rowid, text, comment) VALUES (new.rowid, new.text, new.comment);
END;

-- Full-conversation FTS: contentless index (inverted index only, no text stored)
CREATE TABLE IF NOT EXISTS fts_map (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  turn_index INTEGER NOT NULL,
  role TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_fts_map_session ON fts_map(session_id);

CREATE TABLE IF NOT EXISTS fts_status (
  session_id TEXT PRIMARY KEY,
  indexed_at INTEGER NOT NULL DEFAULT (unixepoch()),
  turn_count INTEGER NOT NULL DEFAULT 0,
  file_mtime INTEGER NOT NULL DEFAULT 0
);

CREATE VIRTUAL TABLE IF NOT EXISTS conversation_fts USING fts5(
  text,
  content='',
  content_rowid='id'
);
`;

// ---------------------------------------------------------------------------
// Default path helper
// ---------------------------------------------------------------------------

function defaultDbPath(): string {
  return process.env.CONVO_DB_PATH ?? path.join(os.homedir(), ".convo", "db.sqlite");
}

// ---------------------------------------------------------------------------
// ConvoDb class
// ---------------------------------------------------------------------------

export class ConvoDb {
  readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  // ---- Sessions -----------------------------------------------------------

  upsertSession(session: SessionRecord): void {
    this.db.run(
      `INSERT INTO sessions (id, jsonl_path, title, project, model, start_time, turn_count, imported_at, last_modified, file_size)
       VALUES (?, ?, ?, ?, ?, ?, ?, coalesce(?, unixepoch()), ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         jsonl_path     = coalesce(excluded.jsonl_path, jsonl_path),
         title          = coalesce(excluded.title, title),
         project        = coalesce(excluded.project, project),
         model          = coalesce(excluded.model, model),
         start_time     = coalesce(excluded.start_time, start_time),
         turn_count     = coalesce(excluded.turn_count, turn_count),
         last_modified  = coalesce(excluded.last_modified, last_modified),
         file_size      = coalesce(excluded.file_size, file_size)`,
      [
        session.id,
        session.jsonl_path ?? null,
        session.title ?? null,
        session.project ?? null,
        session.model ?? null,
        session.start_time ?? null,
        session.turn_count ?? null,
        session.imported_at ?? null,
        session.last_modified ?? null,
        session.file_size ?? null,
      ],
    );
  }

  getSession(id: string): SessionRecord | null {
    const row = this.db.query("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRecord | null;
    return row ?? null;
  }

  listSessions(opts?: { project?: string; limit?: number; offset?: number }): SessionRecord[] {
    const clauses: string[] = [];
    const params: SQLQueryBindings[] = [];

    if (opts?.project) {
      clauses.push("project = ?");
      params.push(opts.project);
    }

    let sql = "SELECT * FROM sessions";
    if (clauses.length) sql += " WHERE " + clauses.join(" AND ");
    sql += " ORDER BY coalesce(last_modified, imported_at) DESC";

    if (opts?.limit) {
      sql += " LIMIT ?";
      params.push(opts.limit);
    }
    if (opts?.offset) {
      sql += " OFFSET ?";
      params.push(opts.offset);
    }

    return this.db.query(sql).all(...params) as SessionRecord[];
  }

  // ---- Annotations -------------------------------------------------------

  upsertAnnotation(ann: AnnotationRecord): void {
    this.db.run(
      `INSERT INTO annotations (id, session_id, turn_index, block_index, char_start, char_end, text, comment, kind, speaker, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, coalesce(?, unixepoch()), coalesce(?, unixepoch()))
       ON CONFLICT(id) DO UPDATE SET
         turn_index  = excluded.turn_index,
         block_index = excluded.block_index,
         char_start  = excluded.char_start,
         char_end    = excluded.char_end,
         text        = excluded.text,
         comment     = excluded.comment,
         kind        = excluded.kind,
         speaker     = excluded.speaker,
         updated_at  = unixepoch()`,
      [
        ann.id,
        ann.session_id,
        ann.turn_index,
        ann.block_index ?? 0,
        ann.char_start,
        ann.char_end,
        ann.text,
        ann.comment ?? "",
        ann.kind ?? "highlight",
        ann.speaker ?? null,
        ann.created_at ?? null,
        ann.updated_at ?? null,
      ],
    );
  }

  deleteAnnotation(id: string): void {
    this.db.run("DELETE FROM annotations WHERE id = ?", [id]);
  }

  getAnnotation(id: string): AnnotationWithTags | null {
    const row = this.db
      .query(
        `SELECT a.*, s.title AS session_title, s.project AS session_project
         FROM annotations a
         LEFT JOIN sessions s ON s.id = a.session_id
         WHERE a.id = ?`,
      )
      .get(id) as (AnnotationRecord & { session_title: string | null; session_project: string | null }) | null;
    if (!row) return null;
    return { ...row, tags: this._getTagsForAnnotation(id) };
  }

  getSessionAnnotations(sessionId: string): AnnotationWithTags[] {
    const rows = this.db
      .query(
        `SELECT a.*, s.title AS session_title, s.project AS session_project
         FROM annotations a
         LEFT JOIN sessions s ON s.id = a.session_id
         WHERE a.session_id = ?
         ORDER BY a.turn_index, a.block_index, a.char_start`,
      )
      .all(sessionId) as (AnnotationRecord & { session_title: string | null; session_project: string | null })[];
    return rows.map((r) => ({ ...r, tags: this._getTagsForAnnotation(r.id) }));
  }

  // ---- Tags ---------------------------------------------------------------

  addTag(annotationId: string, tagName: string, color?: string): void {
    // Ensure the tag exists
    this.db.run(
      `INSERT INTO tags (name, color) VALUES (?, ?)
       ON CONFLICT(name) DO UPDATE SET color = coalesce(excluded.color, color)`,
      [tagName, color ?? null],
    );

    const tag = this.db.query("SELECT id FROM tags WHERE name = ?").get(tagName) as { id: number } | null;
    if (!tag) return;

    this.db.run(
      `INSERT OR IGNORE INTO annotation_tags (annotation_id, tag_id) VALUES (?, ?)`,
      [annotationId, tag.id],
    );
  }

  removeTag(annotationId: string, tagName: string): void {
    const tag = this.db.query("SELECT id FROM tags WHERE name = ?").get(tagName) as { id: number } | null;
    if (!tag) return;
    this.db.run("DELETE FROM annotation_tags WHERE annotation_id = ? AND tag_id = ?", [annotationId, tag.id]);
  }

  listTags(): TagWithCount[] {
    return this.db
      .query(
        `SELECT t.*, count(at.annotation_id) AS count
         FROM tags t
         LEFT JOIN annotation_tags at ON at.tag_id = t.id
         GROUP BY t.id
         ORDER BY count DESC, t.name`,
      )
      .all() as TagWithCount[];
  }

  getAnnotationsByTag(tagName: string, opts?: { limit?: number }): AnnotationWithTags[] {
    let sql = `
      SELECT a.*, s.title AS session_title, s.project AS session_project
      FROM annotations a
      LEFT JOIN sessions s ON s.id = a.session_id
      INNER JOIN annotation_tags at ON at.annotation_id = a.id
      INNER JOIN tags t ON t.id = at.tag_id
      WHERE t.name = ?
      ORDER BY a.created_at DESC`;
    const params: SQLQueryBindings[] = [tagName];

    if (opts?.limit) {
      sql += " LIMIT ?";
      params.push(opts.limit);
    }

    const rows = this.db.query(sql).all(...params) as (AnnotationRecord & { session_title: string | null; session_project: string | null })[];
    return rows.map((r) => ({ ...r, tags: this._getTagsForAnnotation(r.id) }));
  }

  // ---- Search -------------------------------------------------------------

  searchAnnotations(
    query: string,
    opts?: { tags?: string[]; sessionId?: string; speaker?: string; limit?: number },
  ): AnnotationWithTags[] {
    const clauses: string[] = [];
    const params: SQLQueryBindings[] = [];

    // FTS match
    if (query) {
      clauses.push("a.rowid IN (SELECT rowid FROM annotations_fts WHERE annotations_fts MATCH ?)");
      params.push(query);
    }

    if (opts?.sessionId) {
      clauses.push("a.session_id = ?");
      params.push(opts.sessionId);
    }

    if (opts?.speaker) {
      clauses.push("a.speaker = ?");
      params.push(opts.speaker);
    }

    if (opts?.tags?.length) {
      clauses.push(
        `a.id IN (
          SELECT at.annotation_id FROM annotation_tags at
          INNER JOIN tags t ON t.id = at.tag_id
          WHERE t.name IN (${opts.tags.map(() => "?").join(",")})
        )`,
      );
      params.push(...opts.tags);
    }

    let sql = `
      SELECT a.*, s.title AS session_title, s.project AS session_project
      FROM annotations a
      LEFT JOIN sessions s ON s.id = a.session_id`;
    if (clauses.length) sql += " WHERE " + clauses.join(" AND ");
    sql += " ORDER BY a.created_at DESC";

    if (opts?.limit) {
      sql += " LIMIT ?";
      params.push(opts.limit);
    }

    const rows = this.db.query(sql).all(...params) as (AnnotationRecord & { session_title: string | null; session_project: string | null })[];
    return rows.map((r) => ({ ...r, tags: this._getTagsForAnnotation(r.id) }));
  }

  // ---- Recent -------------------------------------------------------------

  getRecentAnnotations(opts?: { days?: number; limit?: number }): AnnotationWithTags[] {
    const days = opts?.days ?? 7;
    const limit = opts?.limit ?? 50;
    const cutoff = Math.floor(Date.now() / 1000) - days * 86400;

    const rows = this.db
      .query(
        `SELECT a.*, s.title AS session_title, s.project AS session_project
         FROM annotations a
         LEFT JOIN sessions s ON s.id = a.session_id
         WHERE a.created_at >= ?
         ORDER BY a.created_at DESC
         LIMIT ?`,
      )
      .all(cutoff, limit) as (AnnotationRecord & { session_title: string | null; session_project: string | null })[];
    return rows.map((r) => ({ ...r, tags: this._getTagsForAnnotation(r.id) }));
  }

  // ---- Batch tag replacement -----------------------------------------------

  replaceAnnotationTags(annotationId: string, tags: string[]): void {
    const txn = this.db.transaction(() => {
      // Remove all existing tags for this annotation
      this.db.run("DELETE FROM annotation_tags WHERE annotation_id = ?", [annotationId]);
      // Add new tags
      for (const tagName of tags) {
        this.addTag(annotationId, tagName);
      }
    });
    txn();
  }

  // ---- Client-ready annotation export ------------------------------------

  getAnnotationForClient(id: string): (AnnotationWithTags & { prefix?: string; suffix?: string; trigger?: string; turnId?: string }) | null {
    const ann = this.getAnnotation(id);
    if (!ann) return null;
    // The AnnotationRecord stores char offsets but not prefix/suffix/trigger/turnId.
    // Those are client-side fields. Return what we have; the client fills in the rest.
    return { ...ann, turnId: `turn-${ann.turn_index}` };
  }

  // ---- Path-based lookup -------------------------------------------------

  getSessionByPath(jsonlPath: string): SessionRecord | null {
    const row = this.db.query("SELECT * FROM sessions WHERE jsonl_path = ?").get(jsonlPath) as SessionRecord | null;
    return row ?? null;
  }

  // ---- Import / Export ----------------------------------------------------

  importAnnotationsJson(
    sessionId: string,
    annotations: SidecarAnnotation[],
  ): { imported: number; skipped: number } {
    let imported = 0;
    let skipped = 0;

    const txn = this.db.transaction(() => {
      for (const ann of annotations) {
        // Skip if already exists
        const existing = this.db.query("SELECT id FROM annotations WHERE id = ?").get(ann.id);
        if (existing) {
          skipped++;
          continue;
        }

        const rawTs = ann.timestamp ?? ann.created;
        const createdAt = rawTs ? Math.floor(rawTs / 1000) : null;

        this.upsertAnnotation({
          id: ann.id,
          session_id: sessionId,
          turn_index: ann.turnIndex,
          block_index: ann.blockIndex ?? 0,
          char_start: ann.charStart,
          char_end: ann.charEnd,
          text: ann.text,
          comment: ann.comment ?? "",
          kind: ann.kind ?? "highlight",
          speaker: ann.speaker ?? ann.role ?? null,
          created_at: createdAt ?? undefined,
          updated_at: createdAt ?? undefined,
        });

        if (ann.tags?.length) {
          for (const tagName of ann.tags) {
            this.addTag(ann.id, tagName);
          }
        }

        imported++;
      }
    });

    txn();
    return { imported, skipped };
  }

  exportSessionAnnotations(sessionId: string): SidecarAnnotation[] {
    const annotations = this.getSessionAnnotations(sessionId);
    return annotations.map((a) => ({
      id: a.id,
      turnIndex: a.turn_index,
      blockIndex: a.block_index ?? 0,
      charStart: a.char_start,
      charEnd: a.char_end,
      text: a.text,
      comment: a.comment ?? "",
      kind: a.kind ?? "highlight",
      speaker: a.speaker ?? undefined,
      role: a.speaker ?? undefined,
      tags: a.tags.length ? a.tags : undefined,
      timestamp: a.created_at ? a.created_at * 1000 : undefined,
    }));
  }

  // ---- Full-text search ---------------------------------------------------

  /** Check if a session needs (re)indexing based on file mtime */
  ftsNeedsIndexing(sessionId: string, fileMtime: number): boolean {
    const row = this.db.query("SELECT file_mtime FROM fts_status WHERE session_id = ?").get(sessionId) as { file_mtime: number } | null;
    if (!row) return true; // never indexed
    return fileMtime > row.file_mtime; // file changed since last index
  }

  /** Index a session's turns into FTS. Replaces any existing index for the session. */
  indexSession(sessionId: string, turns: { role: string; text: string }[], fileMtime: number): void {
    // Remove old index for this session
    this.removeFtsIndex(sessionId);

    const insertMap = this.db.prepare(
      "INSERT INTO fts_map (session_id, turn_index, role) VALUES (?, ?, ?)",
    );
    const insertFts = this.db.prepare(
      "INSERT INTO conversation_fts (rowid, text) VALUES (?, ?)",
    );
    const insertStatus = this.db.prepare(
      "INSERT OR REPLACE INTO fts_status (session_id, indexed_at, turn_count, file_mtime) VALUES (?, unixepoch(), ?, ?)",
    );

    this.db.exec("BEGIN");
    try {
      for (let i = 0; i < turns.length; i++) {
        const text = turns[i].text.trim();
        if (!text) continue;
        insertMap.run(sessionId, i, turns[i].role);
        const mapId = (this.db.query("SELECT last_insert_rowid() as id").get() as { id: number }).id;
        insertFts.run(mapId, text);
      }
      insertStatus.run(sessionId, turns.length, fileMtime);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  /** Remove FTS index for a session */
  removeFtsIndex(sessionId: string): void {
    const rows = this.db.query("SELECT id FROM fts_map WHERE session_id = ?").all(sessionId) as { id: number }[];
    if (rows.length > 0) {
      for (const row of rows) {
        this.db.run("INSERT INTO conversation_fts(conversation_fts, rowid, text) VALUES('delete', ?, '')", [row.id]);
      }
      this.db.run("DELETE FROM fts_map WHERE session_id = ?", [sessionId]);
    }
    this.db.run("DELETE FROM fts_status WHERE session_id = ?", [sessionId]);
  }

  /** Search conversations. Returns matching sessions with turn references. */
  searchConversations(query: string, limit = 50): Array<{
    session_id: string;
    turn_index: number;
    role: string;
    rank: number;
  }> {
    // FTS5 query — wrap in double quotes for phrase, or pass as-is for boolean
    const rows = this.db.query(`
      SELECT m.session_id, m.turn_index, m.role, f.rank
      FROM conversation_fts f
      JOIN fts_map m ON m.id = f.rowid
      WHERE conversation_fts MATCH ?
      ORDER BY f.rank
      LIMIT ?
    `).all(query, limit) as Array<{
      session_id: string;
      turn_index: number;
      role: string;
      rank: number;
    }>;
    return rows;
  }

  /** Search and group by session, returning top sessions with match counts. */
  searchSessions(query: string, limit = 30): Array<{
    session_id: string;
    match_count: number;
    best_rank: number;
  }> {
    const rows = this.db.query(`
      SELECT m.session_id, COUNT(*) as match_count, MIN(f.rank) as best_rank
      FROM conversation_fts f
      JOIN fts_map m ON m.id = f.rowid
      WHERE conversation_fts MATCH ?
      GROUP BY m.session_id
      ORDER BY best_rank
      LIMIT ?
    `).all(query, limit) as Array<{
      session_id: string;
      match_count: number;
      best_rank: number;
    }>;
    return rows;
  }

  /** Get count of indexed sessions */
  ftsIndexedCount(): number {
    const row = this.db.query("SELECT COUNT(*) as n FROM fts_status").get() as { n: number };
    return row.n;
  }

  // ---- Lifecycle ----------------------------------------------------------

  close(): void {
    this.db.close();
  }

  // ---- Internal helpers ---------------------------------------------------

  private _getTagsForAnnotation(annotationId: string): string[] {
    const rows = this.db
      .query(
        `SELECT t.name FROM tags t
         INNER JOIN annotation_tags at ON at.tag_id = t.id
         WHERE at.annotation_id = ?
         ORDER BY t.name`,
      )
      .all(annotationId) as { name: string }[];
    return rows.map((r) => r.name);
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function openDb(dbPath?: string): ConvoDb {
  const resolvedPath = dbPath ?? defaultDbPath();

  // Ensure parent directory exists
  const dir = path.dirname(resolvedPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = new Database(resolvedPath);

  // Enable WAL mode and foreign keys
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");

  // Run schema migration
  db.exec(SCHEMA_SQL);

  // Add columns that may not exist in older databases
  try { db.exec("ALTER TABLE sessions ADD COLUMN last_modified INTEGER"); } catch {}
  try { db.exec("ALTER TABLE sessions ADD COLUMN file_size INTEGER"); } catch {}
  try { db.exec("ALTER TABLE fts_status ADD COLUMN file_mtime INTEGER NOT NULL DEFAULT 0"); } catch {}

  return new ConvoDb(db);
}
