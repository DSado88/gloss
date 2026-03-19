import { describe, it, expect, afterEach, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { openDb, ConvoDb } from "./db.js";
import type { SessionRecord, AnnotationRecord, SidecarAnnotation } from "./db.js";

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "convo-db-test-"));
}

describe("ConvoDb", () => {
  let tempDir: string;
  let db: ConvoDb;

  beforeEach(() => {
    tempDir = makeTempDir();
    db = openDb(path.join(tempDir, "test.sqlite"));
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  // -----------------------------------------------------------------------
  // Schema creation
  // -----------------------------------------------------------------------

  describe("schema creation", () => {
    it("creates all tables on a fresh database", () => {
      const tables = db.db
        .query(
          `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
        )
        .all() as { name: string }[];
      const names = tables.map((t) => t.name).sort();
      expect(names).toContain("sessions");
      expect(names).toContain("annotations");
      expect(names).toContain("tags");
      expect(names).toContain("annotation_tags");
      expect(names).toContain("annotations_fts");
    });

    it("creates FTS triggers", () => {
      const triggers = db.db
        .query(`SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name`)
        .all() as { name: string }[];
      const names = triggers.map((t) => t.name);
      expect(names).toContain("annotations_ai");
      expect(names).toContain("annotations_ad");
      expect(names).toContain("annotations_au");
    });

    it("uses WAL journal mode", () => {
      const row = db.db.query("PRAGMA journal_mode").get() as { journal_mode: string };
      expect(row.journal_mode).toBe("wal");
    });

    it("is idempotent — opening twice on the same file does not throw", () => {
      const dbPath = path.join(tempDir, "test.sqlite");
      const db2 = openDb(dbPath);
      db2.close();
    });
  });

  // -----------------------------------------------------------------------
  // Session CRUD
  // -----------------------------------------------------------------------

  describe("sessions", () => {
    const session: SessionRecord = {
      id: "sess-001",
      jsonl_path: "/tmp/convo.jsonl",
      title: "My Conversation",
      project: "/home/user/project",
      model: "claude-sonnet-4-20250514",
      start_time: 1710000000,
      turn_count: 12,
    };

    it("inserts and retrieves a session", () => {
      db.upsertSession(session);
      const result = db.getSession("sess-001");
      expect(result).not.toBeNull();
      expect(result!.id).toBe("sess-001");
      expect(result!.title).toBe("My Conversation");
      expect(result!.model).toBe("claude-sonnet-4-20250514");
      expect(result!.turn_count).toBe(12);
      expect(result!.imported_at).toBeGreaterThan(0);
    });

    it("returns null for non-existent session", () => {
      expect(db.getSession("no-such-id")).toBeNull();
    });

    it("upsert updates existing session fields", () => {
      db.upsertSession(session);
      db.upsertSession({ id: "sess-001", title: "Updated Title" });
      const result = db.getSession("sess-001");
      expect(result!.title).toBe("Updated Title");
      // Original fields preserved
      expect(result!.model).toBe("claude-sonnet-4-20250514");
    });

    it("lists sessions ordered by imported_at descending", () => {
      db.upsertSession({ id: "a", project: "proj1" });
      db.upsertSession({ id: "b", project: "proj1" });
      db.upsertSession({ id: "c", project: "proj2" });

      const all = db.listSessions();
      expect(all).toHaveLength(3);

      const proj1 = db.listSessions({ project: "proj1" });
      expect(proj1).toHaveLength(2);
    });

    it("listSessions respects limit and offset", () => {
      for (let i = 0; i < 5; i++) {
        db.upsertSession({ id: `s-${i}` });
      }
      const page = db.listSessions({ limit: 2, offset: 1 });
      expect(page).toHaveLength(2);
    });
  });

  // -----------------------------------------------------------------------
  // Annotation CRUD
  // -----------------------------------------------------------------------

  describe("annotations", () => {
    beforeEach(() => {
      db.upsertSession({ id: "sess-001", title: "Test Session", project: "myproj" });
    });

    const annotation: AnnotationRecord = {
      id: "ann-001",
      session_id: "sess-001",
      turn_index: 3,
      block_index: 0,
      char_start: 10,
      char_end: 50,
      text: "some highlighted text",
      comment: "interesting point",
      kind: "highlight",
      speaker: "assistant",
    };

    it("inserts and retrieves an annotation with session metadata", () => {
      db.upsertAnnotation(annotation);
      const result = db.getAnnotation("ann-001");
      expect(result).not.toBeNull();
      expect(result!.text).toBe("some highlighted text");
      expect(result!.comment).toBe("interesting point");
      expect(result!.session_title).toBe("Test Session");
      expect(result!.session_project).toBe("myproj");
      expect(result!.tags).toEqual([]);
    });

    it("returns null for non-existent annotation", () => {
      expect(db.getAnnotation("no-such")).toBeNull();
    });

    it("upsert updates an existing annotation and bumps updated_at", () => {
      db.upsertAnnotation(annotation);
      const original = db.getAnnotation("ann-001")!;

      db.upsertAnnotation({ ...annotation, comment: "revised comment" });
      const updated = db.getAnnotation("ann-001")!;

      expect(updated.comment).toBe("revised comment");
      expect(updated.updated_at).toBeGreaterThanOrEqual(original.updated_at!);
    });

    it("deletes an annotation", () => {
      db.upsertAnnotation(annotation);
      db.deleteAnnotation("ann-001");
      expect(db.getAnnotation("ann-001")).toBeNull();
    });

    it("getSessionAnnotations returns annotations sorted by turn/block/char", () => {
      db.upsertAnnotation({ ...annotation, id: "ann-a", turn_index: 5, char_start: 0, char_end: 10 });
      db.upsertAnnotation({ ...annotation, id: "ann-b", turn_index: 2, char_start: 0, char_end: 10 });
      db.upsertAnnotation({ ...annotation, id: "ann-c", turn_index: 2, char_start: 20, char_end: 30 });

      const results = db.getSessionAnnotations("sess-001");
      expect(results).toHaveLength(3);
      expect(results[0].id).toBe("ann-b");
      expect(results[1].id).toBe("ann-c");
      expect(results[2].id).toBe("ann-a");
    });
  });

  // -----------------------------------------------------------------------
  // Tags
  // -----------------------------------------------------------------------

  describe("tags", () => {
    beforeEach(() => {
      db.upsertSession({ id: "sess-001" });
      db.upsertAnnotation({
        id: "ann-001",
        session_id: "sess-001",
        turn_index: 0,
        char_start: 0,
        char_end: 5,
        text: "hello",
      });
      db.upsertAnnotation({
        id: "ann-002",
        session_id: "sess-001",
        turn_index: 1,
        char_start: 0,
        char_end: 5,
        text: "world",
      });
    });

    it("adds and retrieves tags on an annotation", () => {
      db.addTag("ann-001", "seed_idea", "#ff0000");
      db.addTag("ann-001", "important");

      const ann = db.getAnnotation("ann-001")!;
      expect(ann.tags).toEqual(["important", "seed_idea"]); // sorted alphabetically
    });

    it("removeTag removes a specific tag", () => {
      db.addTag("ann-001", "tag-a");
      db.addTag("ann-001", "tag-b");
      db.removeTag("ann-001", "tag-a");

      const ann = db.getAnnotation("ann-001")!;
      expect(ann.tags).toEqual(["tag-b"]);
    });

    it("removeTag is a no-op for non-existent tag", () => {
      db.removeTag("ann-001", "nonexistent"); // should not throw
    });

    it("listTags returns tags with counts", () => {
      db.addTag("ann-001", "shared");
      db.addTag("ann-002", "shared");
      db.addTag("ann-001", "unique");

      const tags = db.listTags();
      const shared = tags.find((t) => t.name === "shared");
      const unique = tags.find((t) => t.name === "unique");

      expect(shared).toBeDefined();
      expect(shared!.count).toBe(2);
      expect(unique!.count).toBe(1);
    });

    it("getAnnotationsByTag returns annotations with a specific tag", () => {
      db.addTag("ann-001", "target");
      db.addTag("ann-002", "other");

      const results = db.getAnnotationsByTag("target");
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe("ann-001");
      expect(results[0].tags).toContain("target");
    });

    it("getAnnotationsByTag respects limit", () => {
      db.addTag("ann-001", "shared");
      db.addTag("ann-002", "shared");

      const results = db.getAnnotationsByTag("shared", { limit: 1 });
      expect(results).toHaveLength(1);
    });

    it("deleting an annotation cascades to annotation_tags", () => {
      db.addTag("ann-001", "cascade-test");
      db.deleteAnnotation("ann-001");

      const rows = db.db
        .query("SELECT * FROM annotation_tags WHERE annotation_id = ?")
        .all("ann-001") as any[];
      expect(rows).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // FTS Search
  // -----------------------------------------------------------------------

  describe("searchAnnotations (FTS)", () => {
    beforeEach(() => {
      db.upsertSession({ id: "sess-001" });
      db.upsertAnnotation({
        id: "ann-alpha",
        session_id: "sess-001",
        turn_index: 0,
        char_start: 0,
        char_end: 20,
        text: "machine learning is fascinating",
        comment: "AI topic",
        speaker: "assistant",
      });
      db.upsertAnnotation({
        id: "ann-beta",
        session_id: "sess-001",
        turn_index: 1,
        char_start: 0,
        char_end: 15,
        text: "the weather is nice",
        comment: "off topic",
        speaker: "user",
      });
    });

    it("finds annotations by text content", () => {
      const results = db.searchAnnotations("machine learning");
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe("ann-alpha");
    });

    it("finds annotations by comment content", () => {
      const results = db.searchAnnotations("AI topic");
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe("ann-alpha");
    });

    it("filters by speaker", () => {
      const results = db.searchAnnotations("", { speaker: "user" });
      expect(results.every((r) => r.speaker === "user")).toBe(true);
    });

    it("filters by sessionId", () => {
      db.upsertSession({ id: "sess-002" });
      db.upsertAnnotation({
        id: "ann-gamma",
        session_id: "sess-002",
        turn_index: 0,
        char_start: 0,
        char_end: 10,
        text: "machine learning deep",
        comment: "",
      });

      const results = db.searchAnnotations("machine", { sessionId: "sess-001" });
      expect(results).toHaveLength(1);
      expect(results[0].session_id).toBe("sess-001");
    });

    it("filters by tags", () => {
      db.addTag("ann-alpha", "science");

      const results = db.searchAnnotations("", { tags: ["science"] });
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe("ann-alpha");
    });

    it("respects limit", () => {
      const results = db.searchAnnotations("", { limit: 1 });
      expect(results).toHaveLength(1);
    });

    it("FTS stays in sync after update", () => {
      db.upsertAnnotation({
        id: "ann-alpha",
        session_id: "sess-001",
        turn_index: 0,
        char_start: 0,
        char_end: 20,
        text: "quantum computing is amazing",
        comment: "physics topic",
      });

      const oldResults = db.searchAnnotations("machine learning");
      expect(oldResults).toHaveLength(0);

      const newResults = db.searchAnnotations("quantum computing");
      expect(newResults).toHaveLength(1);
    });

    it("handles FTS5 special characters without throwing", () => {
      // These should not throw — FTS5 syntax errors from special chars must be handled
      expect(() => db.searchAnnotations('"unclosed quote')).not.toThrow();
      expect(() => db.searchAnnotations("(unmatched")).not.toThrow();
      expect(() => db.searchAnnotations("OR AND NOT")).not.toThrow();
      expect(() => db.searchAnnotations('hello "world')).not.toThrow();
    });

    it("FTS stays in sync after delete", () => {
      db.deleteAnnotation("ann-alpha");
      const results = db.searchAnnotations("machine learning");
      expect(results).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // getRecentAnnotations
  // -----------------------------------------------------------------------

  describe("getRecentAnnotations", () => {
    it("returns annotations created within the specified number of days", () => {
      db.upsertSession({ id: "sess-001" });

      // Insert an annotation with a recent timestamp (will get created_at = now via default)
      db.upsertAnnotation({
        id: "ann-recent",
        session_id: "sess-001",
        turn_index: 0,
        char_start: 0,
        char_end: 5,
        text: "recent text",
      });

      // Insert an annotation with an old timestamp
      const oldTimestamp = Math.floor(Date.now() / 1000) - 30 * 86400; // 30 days ago
      db.upsertAnnotation({
        id: "ann-old",
        session_id: "sess-001",
        turn_index: 1,
        char_start: 0,
        char_end: 5,
        text: "old text",
        created_at: oldTimestamp,
      });

      const recent = db.getRecentAnnotations({ days: 7 });
      expect(recent.some((r) => r.id === "ann-recent")).toBe(true);
      expect(recent.some((r) => r.id === "ann-old")).toBe(false);
    });

    it("respects limit", () => {
      db.upsertSession({ id: "sess-001" });
      for (let i = 0; i < 5; i++) {
        db.upsertAnnotation({
          id: `ann-${i}`,
          session_id: "sess-001",
          turn_index: i,
          char_start: 0,
          char_end: 5,
          text: `text ${i}`,
        });
      }

      const results = db.getRecentAnnotations({ limit: 2 });
      expect(results).toHaveLength(2);
    });
  });

  // -----------------------------------------------------------------------
  // Import from sidecar JSON
  // -----------------------------------------------------------------------

  describe("importAnnotationsJson", () => {
    beforeEach(() => {
      db.upsertSession({ id: "sess-001" });
    });

    const sidecarData: SidecarAnnotation[] = [
      {
        id: "ann-import-1",
        turnIndex: 5,
        blockIndex: 0,
        charStart: 100,
        charEnd: 250,
        text: "the highlighted text",
        comment: "my note",
        kind: "highlight",
        tags: ["seed_idea", "important"],
        timestamp: 1710000000000,
      },
      {
        id: "ann-import-2",
        turnIndex: 7,
        charStart: 0,
        charEnd: 50,
        text: "another highlight",
        comment: "",
        tags: ["seed_idea"],
        timestamp: 1710000500000,
      },
    ];

    it("imports sidecar annotations with correct field mapping", () => {
      const result = db.importAnnotationsJson("sess-001", sidecarData);
      expect(result.imported).toBe(2);
      expect(result.skipped).toBe(0);

      const ann = db.getAnnotation("ann-import-1")!;
      expect(ann.turn_index).toBe(5);
      expect(ann.block_index).toBe(0);
      expect(ann.char_start).toBe(100);
      expect(ann.char_end).toBe(250);
      expect(ann.text).toBe("the highlighted text");
      expect(ann.comment).toBe("my note");
      expect(ann.kind).toBe("highlight");
      // Timestamp was in ms, stored as seconds
      expect(ann.created_at).toBe(1710000000);
    });

    it("imports tags from sidecar annotations", () => {
      db.importAnnotationsJson("sess-001", sidecarData);

      const ann1 = db.getAnnotation("ann-import-1")!;
      expect(ann1.tags).toEqual(["important", "seed_idea"]);

      const ann2 = db.getAnnotation("ann-import-2")!;
      expect(ann2.tags).toEqual(["seed_idea"]);
    });

    it("skips annotations that already exist", () => {
      db.importAnnotationsJson("sess-001", sidecarData);
      const result = db.importAnnotationsJson("sess-001", sidecarData);
      expect(result.imported).toBe(0);
      expect(result.skipped).toBe(2);
    });

    it("handles annotations with no tags", () => {
      const noTags: SidecarAnnotation[] = [
        {
          id: "ann-notags",
          turnIndex: 0,
          charStart: 0,
          charEnd: 10,
          text: "no tags here",
        },
      ];
      const result = db.importAnnotationsJson("sess-001", noTags);
      expect(result.imported).toBe(1);
      const ann = db.getAnnotation("ann-notags")!;
      expect(ann.tags).toEqual([]);
    });

    it("handles missing optional fields with defaults", () => {
      const minimal: SidecarAnnotation[] = [
        {
          id: "ann-min",
          turnIndex: 0,
          charStart: 0,
          charEnd: 5,
          text: "minimal",
        },
      ];
      db.importAnnotationsJson("sess-001", minimal);
      const ann = db.getAnnotation("ann-min")!;
      expect(ann.block_index).toBe(0);
      expect(ann.comment).toBe("");
      expect(ann.kind).toBe("highlight");
    });
  });

  // -----------------------------------------------------------------------
  // Export
  // -----------------------------------------------------------------------

  describe("exportSessionAnnotations", () => {
    it("exports annotations in sidecar-compatible format", () => {
      db.upsertSession({ id: "sess-001" });
      db.upsertAnnotation({
        id: "ann-export",
        session_id: "sess-001",
        turn_index: 3,
        block_index: 1,
        char_start: 10,
        char_end: 20,
        text: "exported text",
        comment: "a comment",
        kind: "highlight",
        created_at: 1710000000,
      });
      db.addTag("ann-export", "my-tag");

      const exported = db.exportSessionAnnotations("sess-001");
      expect(exported).toHaveLength(1);

      const item = exported[0];
      expect(item.id).toBe("ann-export");
      expect(item.turnIndex).toBe(3);
      expect(item.blockIndex).toBe(1);
      expect(item.charStart).toBe(10);
      expect(item.charEnd).toBe(20);
      expect(item.text).toBe("exported text");
      expect(item.comment).toBe("a comment");
      expect(item.tags).toEqual(["my-tag"]);
      expect(item.timestamp).toBe(1710000000000); // seconds -> ms
    });
  });

  // -----------------------------------------------------------------------
  // openDb factory
  // -----------------------------------------------------------------------

  describe("openDb", () => {
    it("creates parent directories if they do not exist", () => {
      const nested = path.join(tempDir, "a", "b", "c", "test.sqlite");
      const db2 = openDb(nested);
      expect(fs.existsSync(nested)).toBe(true);
      db2.close();
    });
  });

  // -----------------------------------------------------------------------
  // replaceAnnotationTags (atomic replacement)
  // -----------------------------------------------------------------------

  describe("replaceAnnotationTags", () => {
    it("sets tags on an annotation that had none", () => {
      db.upsertSession({ id: "s1" });
      db.upsertAnnotation({
        id: "ann1",
        session_id: "s1",
        turn_index: 0,
        block_index: 0,
        char_start: 0,
        char_end: 5,
        text: "hello",
      });
      db.replaceAnnotationTags("ann1", ["foo", "bar"]);
      const ann = db.getSessionAnnotations("s1");
      expect(ann[0].tags.sort()).toEqual(["bar", "foo"]);
    });

    it("replaces existing tags atomically", () => {
      db.upsertSession({ id: "s1" });
      db.upsertAnnotation({
        id: "ann1",
        session_id: "s1",
        turn_index: 0,
        block_index: 0,
        char_start: 0,
        char_end: 5,
        text: "hello",
      });
      db.replaceAnnotationTags("ann1", ["old-tag"]);
      db.replaceAnnotationTags("ann1", ["new-tag-1", "new-tag-2"]);
      const ann = db.getSessionAnnotations("s1");
      expect(ann[0].tags.sort()).toEqual(["new-tag-1", "new-tag-2"]);
    });

    it("clears all tags when given empty array", () => {
      db.upsertSession({ id: "s1" });
      db.upsertAnnotation({
        id: "ann1",
        session_id: "s1",
        turn_index: 0,
        block_index: 0,
        char_start: 0,
        char_end: 5,
        text: "hello",
      });
      db.replaceAnnotationTags("ann1", ["tag1", "tag2"]);
      db.replaceAnnotationTags("ann1", []);
      const ann = db.getSessionAnnotations("s1");
      expect(ann[0].tags).toEqual([]);
    });
  });

  // -----------------------------------------------------------------------
  // getSessionByPath
  // -----------------------------------------------------------------------

  describe("getSessionByPath", () => {
    it("finds session by JSONL path", () => {
      db.upsertSession({ id: "s1", jsonl_path: "/path/to/s1.jsonl" });
      const found = db.getSessionByPath("/path/to/s1.jsonl");
      expect(found).not.toBeNull();
      expect(found!.id).toBe("s1");
    });

    it("returns null for unknown path", () => {
      const found = db.getSessionByPath("/no/such/file.jsonl");
      expect(found).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // upsertSession updates path on re-sync
  // -----------------------------------------------------------------------

  describe("upsertSession path updates", () => {
    it("updates jsonl_path when session already exists", () => {
      db.upsertSession({ id: "s1", jsonl_path: "/old/path.jsonl" });
      db.upsertSession({ id: "s1", jsonl_path: "/new/path.jsonl" });
      const session = db.getSession("s1");
      expect(session!.jsonl_path).toBe("/new/path.jsonl");
    });

    it("preserves existing fields when upserting with partial data", () => {
      db.upsertSession({
        id: "s1",
        jsonl_path: "/path.jsonl",
        model: "claude-opus-4-6",
        project: "/my/project",
      });
      // Upsert with only path — other fields should be preserved
      db.upsertSession({ id: "s1", jsonl_path: "/new-path.jsonl" });
      const session = db.getSession("s1");
      expect(session!.jsonl_path).toBe("/new-path.jsonl");
      expect(session!.model).toBe("claude-opus-4-6");
      expect(session!.project).toBe("/my/project");
    });
  });

  // -----------------------------------------------------------------------
  // Bug #5: FTS ghost entries via broken contentless delete
  // -----------------------------------------------------------------------

  describe("FTS ghost entries", () => {
    it("removeFtsIndex does not leave ghost tokens in FTS inverted index", () => {
      db.upsertSession({ id: "ghost-test" });
      db.indexSession("ghost-test", [{ role: "user", text: "unique_ghost_xylophone" }], 100);

      // Verify it's searchable via the JOIN path
      expect(db.searchSessions("unique_ghost_xylophone", 10).length).toBe(1);

      // Remove the FTS index
      db.removeFtsIndex("ghost-test");

      // Query FTS directly (bypass fts_map JOIN) — ghost tokens would still match
      const ghosts = db.db.query(
        "SELECT rowid FROM conversation_fts WHERE conversation_fts MATCH 'unique_ghost_xylophone'",
      ).all();

      // Ghost entries should be gone from the FTS inverted index
      expect(ghosts.length).toBe(0);
    });

    it("re-indexing does not accumulate ghost tokens", () => {
      db.upsertSession({ id: "reindex-ghost" });

      // Index, then re-index with different text 3 times
      db.indexSession("reindex-ghost", [{ role: "user", text: "phantom_alpha" }], 100);
      db.indexSession("reindex-ghost", [{ role: "user", text: "phantom_beta" }], 200);
      db.indexSession("reindex-ghost", [{ role: "user", text: "phantom_gamma" }], 300);

      // Only "phantom_gamma" should exist in the FTS inverted index
      const alphaGhosts = db.db.query(
        "SELECT rowid FROM conversation_fts WHERE conversation_fts MATCH 'phantom_alpha'",
      ).all();
      const betaGhosts = db.db.query(
        "SELECT rowid FROM conversation_fts WHERE conversation_fts MATCH 'phantom_beta'",
      ).all();
      const gammaHits = db.db.query(
        "SELECT rowid FROM conversation_fts WHERE conversation_fts MATCH 'phantom_gamma'",
      ).all();

      expect(alphaGhosts.length).toBe(0);
      expect(betaGhosts.length).toBe(0);
      expect(gammaHits.length).toBe(1);
    });
  });
});
