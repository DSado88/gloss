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
  hidden?: number | null;
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
  contentless_delete=1,
  content_rowid='id'
);

CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project);
CREATE INDEX IF NOT EXISTS idx_annotations_session ON annotations(session_id);
CREATE INDEX IF NOT EXISTS idx_annotation_tags_tag_id ON annotation_tags(tag_id);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Embedding vectors stored as BLOBs (256 x float32 = 1024 bytes each)
CREATE TABLE IF NOT EXISTS turn_embeddings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  turn_index INTEGER NOT NULL,
  role TEXT NOT NULL DEFAULT '',
  text_hash TEXT NOT NULL,
  embedding BLOB NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(session_id, turn_index)
);
CREATE INDEX IF NOT EXISTS idx_turn_emb_session ON turn_embeddings(session_id);

-- Track embedding indexing status per session (mirrors fts_status pattern)
CREATE TABLE IF NOT EXISTS embedding_status (
  session_id TEXT PRIMARY KEY,
  indexed_at INTEGER NOT NULL DEFAULT (unixepoch()),
  turn_count INTEGER NOT NULL DEFAULT 0,
  file_mtime INTEGER NOT NULL DEFAULT 0,
  model_name TEXT NOT NULL DEFAULT 'snowflake-arctic-embed-m-v2.0'
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

  /** Run a function inside a BEGIN/COMMIT transaction. */
  transaction(fn: () => void): void {
    this.db.transaction(fn)();
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

  listSessions(opts?: { project?: string; limit?: number; offset?: number; includeHidden?: boolean }): SessionRecord[] {
    const clauses: string[] = [];
    const params: SQLQueryBindings[] = [];

    if (!opts?.includeHidden) {
      clauses.push("coalesce(hidden, 0) = 0");
    }
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

    // FTS match — sanitize special chars to prevent FTS5 syntax errors
    if (query) {
      const safeQuery = query
        .replace(/[":*^~(){}[\]<>+\-!|&\\/]/g, " ")
        .split(/\s+/)
        .filter((t) => t.length > 0 && !/^(AND|OR|NOT|NEAR)$/i.test(t))
        .join(" ")
        .trim();
      if (safeQuery) {
        clauses.push("a.rowid IN (SELECT rowid FROM annotations_fts WHERE annotations_fts MATCH ?)");
        params.push(safeQuery);
      }
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
        const { lastInsertRowid } = insertMap.run(sessionId, i, turns[i].role);
        insertFts.run(lastInsertRowid, text);
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
        this.db.run("DELETE FROM conversation_fts WHERE rowid = ?", [row.id]);
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

  // ---- Settings -----------------------------------------------------------

  getSetting(key: string): string | null {
    const row = this.db.query("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | null;
    return row?.value ?? null;
  }

  setSetting(key: string, value: string): void {
    this.db.run(
      "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      key, value,
    );
  }

  /** Get project path patterns excluded from AI search (glob-style, one per line) */
  getSearchExcludedProjects(): string[] {
    const val = this.getSetting("search_excluded_projects");
    if (!val) return [];
    return val.split("\n").map(s => s.trim()).filter(Boolean);
  }

  /** Set project path patterns excluded from AI search */
  setSearchExcludedProjects(patterns: string[]): void {
    this.setSetting("search_excluded_projects", patterns.join("\n"));
  }

  // ---- Embeddings ---------------------------------------------------------

  /** Check if a session needs embedding (re)indexing based on file mtime. */
  embeddingNeedsIndexing(sessionId: string, fileMtime: number): boolean {
    const row = this.db.query("SELECT file_mtime FROM embedding_status WHERE session_id = ?").get(sessionId) as { file_mtime: number } | null;
    if (!row) return true;
    return fileMtime > row.file_mtime;
  }

  /** Store embeddings for a session's turns. Replaces any existing. */
  storeEmbeddings(
    sessionId: string,
    entries: Array<{
      turnIndex: number;
      role: string;
      textHash: string;
      embedding: Float32Array;
    }>,
    fileMtime: number,
  ): void {
    this.db.exec("BEGIN");
    try {
      // Remove old embeddings for this session
      this.db.run("DELETE FROM turn_embeddings WHERE session_id = ?", [sessionId]);

      const insert = this.db.prepare(
        "INSERT INTO turn_embeddings (session_id, turn_index, role, text_hash, embedding) VALUES (?, ?, ?, ?, ?)",
      );
      for (const entry of entries) {
        const blob = Buffer.from(entry.embedding.buffer, entry.embedding.byteOffset, entry.embedding.byteLength);
        insert.run(sessionId, entry.turnIndex, entry.role, entry.textHash, blob);
      }

      this.db.run(
        "INSERT OR REPLACE INTO embedding_status (session_id, indexed_at, turn_count, file_mtime) VALUES (?, unixepoch(), ?, ?)",
        [sessionId, entries.length, fileMtime],
      );

      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  /** Remove all embeddings for a session. */
  removeEmbeddings(sessionId: string): void {
    this.db.run("DELETE FROM turn_embeddings WHERE session_id = ?", [sessionId]);
    this.db.run("DELETE FROM embedding_status WHERE session_id = ?", [sessionId]);
  }

  /** Load all embeddings into memory. Returns arrays for VectorIndex construction. */
  loadAllEmbeddings(): {
    sessionIds: string[];
    turnIndices: number[];
    roles: string[];
    embeddings: Float32Array[];
  } {
    const rows = this.db.query(
      "SELECT session_id, turn_index, role, embedding FROM turn_embeddings ORDER BY session_id, turn_index",
    ).all() as Array<{
      session_id: string;
      turn_index: number;
      role: string;
      embedding: Buffer;
    }>;

    const sessionIds: string[] = [];
    const turnIndices: number[] = [];
    const roles: string[] = [];
    const embeddings: Float32Array[] = [];

    const EXPECTED_BLOB_SIZE = 256 * 4; // 256 dims × 4 bytes per float32
    for (const row of rows) {
      const buf = row.embedding;
      if (buf.byteLength !== EXPECTED_BLOB_SIZE) {
        console.warn(`[db] Skipping corrupt embedding: session=${row.session_id} turn=${row.turn_index} (${buf.byteLength} bytes, expected ${EXPECTED_BLOB_SIZE})`);
        continue;
      }
      sessionIds.push(row.session_id);
      turnIndices.push(row.turn_index);
      roles.push(row.role);
      const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
      embeddings.push(new Float32Array(ab));
    }

    return { sessionIds, turnIndices, roles, embeddings };
  }

  /** Get count of sessions with embeddings. */
  embeddingIndexedCount(): number {
    const row = this.db.query("SELECT COUNT(*) as n FROM embedding_status").get() as { n: number };
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
  try { db.exec("ALTER TABLE sessions ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0"); } catch {}

  // Migrate FTS to contentless_delete=1 if needed (fixes ghost entry bug)
  try {
    const ftsInfo = db.query("SELECT sql FROM sqlite_master WHERE name = 'conversation_fts'").get() as { sql: string } | null;
    if (ftsInfo?.sql && !ftsInfo.sql.includes("contentless_delete")) {
      db.exec("DROP TABLE IF EXISTS conversation_fts");
      db.exec("CREATE VIRTUAL TABLE conversation_fts USING fts5(text, content='', contentless_delete=1, content_rowid='id')");
      db.exec("DELETE FROM fts_status"); // Force re-index on next backfill
    }
  } catch {}

  return new ConvoDb(db);
}
