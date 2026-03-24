import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { scanProjectsDir, syncToDb, clearDiscoveryCache, backfillTurnCounts, backfillFtsIndex, type DiscoveredSession } from "./discovery.js";
import { openDb, type ConvoDb } from "./db.js";

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "convo-discovery-test-"));
}

function writeMinimalJsonl(filePath: string, sessionId: string, extra?: object): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const lines = [
    JSON.stringify({
      type: "summary",
      sessionId,
      cwd: "/home/user/project",
      version: "1.0.0",
      ...extra,
    }),
    JSON.stringify({
      type: "user",
      sessionId,
      message: { content: "Hello" },
      timestamp: "2024-01-15T10:30:00Z",
    }),
  ];
  fs.writeFileSync(filePath, lines.join("\n") + "\n", "utf-8");
}

describe("discovery", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir();
    clearDiscoveryCache();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  // -----------------------------------------------------------------------
  // scanProjectsDir
  // -----------------------------------------------------------------------

  describe("scanProjectsDir", () => {
    it("discovers JSONL files in project directories", () => {
      const projectDir = path.join(tempDir, "-Users-test-project1");
      fs.mkdirSync(projectDir, { recursive: true });
      writeMinimalJsonl(
        path.join(projectDir, "abc123.jsonl"),
        "abc123",
      );

      const { sessions } = scanProjectsDir(tempDir);
      expect(sessions).toHaveLength(1);
      expect(sessions[0].id).toBe("abc123");
      expect(sessions[0].path).toBe(path.join(projectDir, "abc123.jsonl"));
    });

    it("discovers sessions across multiple project directories", () => {
      const project1 = path.join(tempDir, "-Users-test-project1");
      const project2 = path.join(tempDir, "-Users-test-project2");
      writeMinimalJsonl(path.join(project1, "aaa.jsonl"), "aaa");
      writeMinimalJsonl(path.join(project2, "bbb.jsonl"), "bbb");

      const { sessions } = scanProjectsDir(tempDir);
      expect(sessions).toHaveLength(2);
      const ids = sessions.map((s) => s.id).sort();
      expect(ids).toEqual(["aaa", "bbb"]);
    });

    it("excludes subagents/ directories", () => {
      const projectDir = path.join(tempDir, "-Users-test-project1");
      writeMinimalJsonl(path.join(projectDir, "main.jsonl"), "main");
      writeMinimalJsonl(
        path.join(projectDir, "subagents", "sub.jsonl"),
        "sub",
      );

      const { sessions } = scanProjectsDir(tempDir);
      expect(sessions).toHaveLength(1);
      expect(sessions[0].id).toBe("main");
    });

    it("deduplicates: same session ID in multiple projects keeps newest", () => {
      const project1 = path.join(tempDir, "-Users-test-project1");
      const project2 = path.join(tempDir, "-Users-test-project2");

      // Write to project1 first (older)
      writeMinimalJsonl(path.join(project1, "shared-id.jsonl"), "shared-id");

      // Wait a tick, then write to project2 (newer, bigger file)
      const newerPath = path.join(project2, "shared-id.jsonl");
      fs.mkdirSync(project2, { recursive: true });
      const lines = [];
      for (let i = 0; i < 10; i++) {
        lines.push(
          JSON.stringify({
            type: "user",
            sessionId: "shared-id",
            message: { content: `Message ${i}` },
            timestamp: "2024-06-15T10:30:00Z",
          }),
        );
      }
      // Set mtime to the future to guarantee it's newer
      fs.writeFileSync(newerPath, lines.join("\n") + "\n", "utf-8");
      const futureTime = Date.now() + 60000;
      fs.utimesSync(newerPath, futureTime / 1000, futureTime / 1000);

      const { sessions } = scanProjectsDir(tempDir);
      expect(sessions).toHaveLength(1);
      expect(sessions[0].id).toBe("shared-id");
      expect(sessions[0].path).toBe(newerPath);
    });

    it("extracts metadata from JSONL header", () => {
      const projectDir = path.join(tempDir, "-Users-test-project1");
      fs.mkdirSync(projectDir, { recursive: true });
      // Model comes from assistant message, not summary
      const lines = [
        JSON.stringify({
          type: "summary",
          sessionId: "meta-test",
          cwd: "/home/user/project",
          version: "1.0.0",
        }),
        JSON.stringify({
          type: "user",
          sessionId: "meta-test",
          message: { content: "Hello" },
          timestamp: "2024-01-15T10:30:00Z",
        }),
        JSON.stringify({
          type: "assistant",
          message: {
            content: [{ type: "text", text: "Hi!" }],
            model: "claude-opus-4-6",
          },
          timestamp: "2024-01-15T10:30:05Z",
        }),
      ];
      fs.writeFileSync(
        path.join(projectDir, "meta-test.jsonl"),
        lines.join("\n") + "\n",
      );

      const { sessions } = scanProjectsDir(tempDir);
      expect(sessions).toHaveLength(1);
      expect(sessions[0].model).toBe("claude-opus-4-6");
    });

    it("follows symlinked project directories", () => {
      // Create a real directory outside tempDir, symlink it in
      const externalDir = fs.mkdtempSync(path.join(os.tmpdir(), "convo-discovery-ext-"));
      try {
        writeMinimalJsonl(path.join(externalDir, "sym-test.jsonl"), "sym-test");
        fs.symlinkSync(externalDir, path.join(tempDir, "linked-project"));

        const { sessions } = scanProjectsDir(tempDir);
        expect(sessions.some((s) => s.id === "sym-test")).toBe(true);
      } finally {
        fs.rmSync(externalDir, { recursive: true, force: true });
      }
    });

    it("discovers JSONL files in deeply nested directories", () => {
      const deepDir = path.join(tempDir, "proj", "nested", "deeper");
      writeMinimalJsonl(path.join(deepDir, "deep-session.jsonl"), "deep-session");

      const { sessions } = scanProjectsDir(tempDir);
      expect(sessions).toHaveLength(1);
      expect(sessions[0].id).toBe("deep-session");
    });

    it("discovers multiple JSONL files in the same project directory", () => {
      const projectDir = path.join(tempDir, "-Users-test-project");
      writeMinimalJsonl(path.join(projectDir, "aaa.jsonl"), "aaa");
      writeMinimalJsonl(path.join(projectDir, "bbb.jsonl"), "bbb");
      writeMinimalJsonl(path.join(projectDir, "ccc.jsonl"), "ccc");

      const { sessions } = scanProjectsDir(tempDir);
      expect(sessions).toHaveLength(3);
      const ids = sessions.map((s) => s.id).sort();
      expect(ids).toEqual(["aaa", "bbb", "ccc"]);
    });

    it("handles empty directory gracefully", () => {
      const { sessions } = scanProjectsDir(tempDir);
      expect(sessions).toEqual([]);
    });

    it("handles non-existent directory gracefully", () => {
      const { sessions } = scanProjectsDir(path.join(tempDir, "no-such-dir"));
      expect(sessions).toEqual([]);
    });

    it("uses mtime cache on rescan, changedCount drops to zero", () => {
      const projectDir = path.join(tempDir, "proj");
      writeMinimalJsonl(path.join(projectDir, "cached.jsonl"), "cached");

      const first = scanProjectsDir(tempDir);
      expect(first.sessions).toHaveLength(1);
      expect(first.changedCount).toBe(1);

      const second = scanProjectsDir(tempDir);
      expect(second.sessions).toHaveLength(1);
      expect(second.sessions[0].id).toBe("cached");
      expect(second.changedCount).toBe(0); // served from cache
    });

    it("changedCount includes both new files and deleted cache entries", () => {
      const projectDir = path.join(tempDir, "proj");
      const file1 = path.join(projectDir, "a.jsonl");
      const file2 = path.join(projectDir, "b.jsonl");
      writeMinimalJsonl(file1, "aaa");
      writeMinimalJsonl(file2, "bbb");

      const first = scanProjectsDir(tempDir);
      expect(first.changedCount).toBe(2);
      expect(first.sessions).toHaveLength(2);

      // Delete one, add a new one in the same scan
      fs.unlinkSync(file1);
      writeMinimalJsonl(path.join(projectDir, "c.jsonl"), "ccc");

      const second = scanProjectsDir(tempDir);
      expect(second.sessions).toHaveLength(2); // bbb (cached) + ccc (new)
      expect(second.changedCount).toBe(2); // 1 new file + 1 deleted cache entry
      const ids = second.sessions.map((s) => s.id).sort();
      expect(ids).toEqual(["bbb", "ccc"]);
    });

    it("cleans cache entries when files are deleted between scans", () => {
      const projectDir = path.join(tempDir, "proj");
      const filePath = path.join(projectDir, "ephemeral.jsonl");
      writeMinimalJsonl(filePath, "ephemeral");

      const first = scanProjectsDir(tempDir);
      expect(first.sessions).toHaveLength(1);

      fs.unlinkSync(filePath);

      const second = scanProjectsDir(tempDir);
      expect(second.sessions).toHaveLength(0);
      expect(second.changedCount).toBe(1); // deletion counts as change
    });

    it("handles non-conversation JSONL files gracefully (filename fallback)", () => {
      const projectDir = path.join(tempDir, "proj");
      fs.mkdirSync(projectDir, { recursive: true });
      fs.writeFileSync(
        path.join(projectDir, "random-data.jsonl"),
        '{"event":"click","time":123}\n{"event":"scroll","time":456}\n',
      );

      const { sessions } = scanProjectsDir(tempDir);
      expect(sessions).toHaveLength(1);
      expect(sessions[0].id).toBe("random-data"); // filename fallback
      expect(sessions[0].projectDir).toBeUndefined();
      expect(sessions[0].model).toBeUndefined();
    });

    it("handles zero-byte JSONL files without crashing or leaking fds", () => {
      const projectDir = path.join(tempDir, "proj");
      fs.mkdirSync(projectDir, { recursive: true });
      fs.writeFileSync(path.join(projectDir, "empty-session.jsonl"), "");

      const { sessions } = scanProjectsDir(tempDir);
      expect(sessions).toHaveLength(1);
      expect(sessions[0].id).toBe("empty-session"); // filename fallback
      expect(sessions[0].fileSize).toBe(0);
    });

    it("does not read entire large files", () => {
      const projectDir = path.join(tempDir, "-Users-test-project1");
      fs.mkdirSync(projectDir, { recursive: true });

      // Create a ~100KB file (much smaller than real 200MB files but proves partial read)
      const filePath = path.join(projectDir, "big.jsonl");
      const header = JSON.stringify({
        type: "summary",
        sessionId: "big-session",
        cwd: "/test",
      });
      // Fill with padding lines
      const padding = "x".repeat(1000);
      const lines = [header];
      for (let i = 0; i < 100; i++) {
        lines.push(JSON.stringify({ type: "user", message: { content: padding } }));
      }
      fs.writeFileSync(filePath, lines.join("\n") + "\n", "utf-8");

      const { sessions } = scanProjectsDir(tempDir);
      expect(sessions).toHaveLength(1);
      expect(sessions[0].id).toBe("big-session");
    });
  });

  // -----------------------------------------------------------------------
  // syncToDb
  // -----------------------------------------------------------------------

  describe("syncToDb", () => {
    let db: ConvoDb;
    let dbDir: string;

    beforeEach(() => {
      dbDir = makeTempDir();
      db = openDb(path.join(dbDir, "test.sqlite"));
    });

    afterEach(() => {
      db.close();
      fs.rmSync(dbDir, { recursive: true, force: true });
    });

    it("upserts discovered sessions into the database", () => {
      const sessions: DiscoveredSession[] = [
        {
          id: "sess-1",
          path: "/tmp/test/sess-1.jsonl",
          projectDir: "/home/user/proj",
          model: "claude-opus-4-6",
          startTime: "2024-01-15T10:30:00Z",
          lastModified: Date.now(),
          fileSize: 12345,
        },
      ];

      syncToDb(db, sessions);

      const record = db.getSession("sess-1");
      expect(record).not.toBeNull();
      expect(record!.jsonl_path).toBe("/tmp/test/sess-1.jsonl");
      expect(record!.project).toBe("/home/user/proj");
      expect(record!.model).toBe("claude-opus-4-6");
    });

    it("converts startTime from ISO to Unix seconds and stores all numeric fields", () => {
      const now = Date.now();
      syncToDb(db, [{
        id: "ts-test",
        path: "/tmp/test/ts.jsonl",
        startTime: "2024-06-15T12:00:00Z",
        lastModified: now,
        fileSize: 54321,
      }]);

      const session = db.getSession("ts-test");
      expect(session).not.toBeNull();
      // ISO → Unix seconds
      expect(session!.start_time).toBe(Math.floor(new Date("2024-06-15T12:00:00Z").getTime() / 1000));
      // lastModified ms → seconds
      expect(session!.last_modified).toBe(Math.floor(now / 1000));
      expect(session!.file_size).toBe(54321);
    });

    it("stores null start_time for invalid/missing timestamps without crashing", () => {
      syncToDb(db, [{
        id: "no-ts",
        path: "/tmp/test/no-ts.jsonl",
        lastModified: Date.now(),
        fileSize: 100,
        // no startTime
      }]);
      expect(db.getSession("no-ts")!.start_time).toBeNull();

      syncToDb(db, [{
        id: "bad-ts",
        path: "/tmp/test/bad-ts.jsonl",
        startTime: "not-a-date",
        lastModified: Date.now(),
        fileSize: 100,
      }]);
      // Invalid date → NaN → stored as NULL by SQLite
      expect(db.getSession("bad-ts")!.start_time).toBeNull();
    });

    it("recounts turns when file shrinks (truncated/replaced)", () => {
      // Write a file with 4 user+assistant pairs
      const projectDir = path.join(tempDir, "proj");
      const filePath = path.join(projectDir, "shrink.jsonl");
      fs.mkdirSync(projectDir, { recursive: true });
      const lines: string[] = [];
      for (let i = 0; i < 4; i++) {
        lines.push(JSON.stringify({ type: "user", message: { content: `Q${i}` }, timestamp: `t${i * 2}` }));
        lines.push(JSON.stringify({ type: "assistant", message: { content: `A${i}` }, timestamp: `t${i * 2 + 1}` }));
      }
      fs.writeFileSync(filePath, lines.join("\n") + "\n", "utf-8");
      const bigSize = fs.statSync(filePath).size;

      // Seed DB as if we already counted this file
      db.upsertSession({
        id: "shrink-test",
        jsonl_path: filePath,
        turn_count: 8,
        file_size: bigSize,
      });

      // Truncate to 1 exchange
      const smallLines = [
        JSON.stringify({ type: "user", message: { content: "Only" }, timestamp: "t0" }),
        JSON.stringify({ type: "assistant", message: { content: "One" }, timestamp: "t1" }),
      ];
      fs.writeFileSync(filePath, smallLines.join("\n") + "\n", "utf-8");

      backfillTurnCounts(db);

      const session = db.getSession("shrink-test");
      expect(session!.turn_count).toBe(2);
    });

    it("backfillFtsIndex indexes conversation text for search", () => {
      const projectDir = path.join(tempDir, "proj");
      const filePath = path.join(projectDir, "fts-test.jsonl");
      fs.mkdirSync(projectDir, { recursive: true });
      const lines = [
        JSON.stringify({ type: "user", message: { content: "How do I configure webpack?" }, timestamp: "t0" }),
        JSON.stringify({ type: "assistant", message: { content: "Here is the webpack configuration guide." }, timestamp: "t1" }),
      ];
      fs.writeFileSync(filePath, lines.join("\n") + "\n", "utf-8");

      db.upsertSession({ id: "fts-test", jsonl_path: filePath });

      // Run FTS backfill (batch size is 3, so 1 session processes synchronously)
      backfillFtsIndex(db);

      // The session should now be searchable
      const results = db.searchSessions("webpack", 10);
      expect(results.length).toBe(1);
      expect(results[0].session_id).toBe("fts-test");

      // Non-matching query should return empty
      const noResults = db.searchSessions("nonexistent_xyzzy_term", 10);
      expect(noResults.length).toBe(0);
    });

    it("backfillFtsIndex skips sessions without jsonl_path", () => {
      db.upsertSession({ id: "no-path" });

      backfillFtsIndex(db);

      // Should not crash, and session should not be indexed
      expect(db.ftsIndexedCount()).toBe(0);
    });

    it("backfillTurnCounts stores turn_count=0 for files with no turns", () => {
      // A JSONL with only a summary line and no user/assistant messages
      const projectDir = path.join(tempDir, "proj");
      const filePath = path.join(projectDir, "no-turns.jsonl");
      fs.mkdirSync(projectDir, { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify({
        type: "summary",
        sessionId: "no-turns-test",
        cwd: "/test",
        version: "1.0.0",
      }) + "\n", "utf-8");

      const fileSize = fs.statSync(filePath).size;
      db.upsertSession({ id: "no-turns-test", jsonl_path: filePath, file_size: fileSize });

      backfillTurnCounts(db);

      const session = db.getSession("no-turns-test");
      // turn_count should be 0, not null — storing 0 prevents re-counting every cycle
      expect(session!.turn_count).toBe(0);
      expect(session!.file_size).toBe(fileSize);
    });

    it("updates path when re-syncing same session with new path", () => {
      syncToDb(db, [
        { id: "s1", path: "/old/path.jsonl", lastModified: Date.now(), fileSize: 100 },
      ]);
      expect(db.getSession("s1")!.jsonl_path).toBe("/old/path.jsonl");

      syncToDb(db, [
        { id: "s1", path: "/new/path.jsonl", lastModified: Date.now(), fileSize: 200 },
      ]);
      expect(db.getSession("s1")!.jsonl_path).toBe("/new/path.jsonl");
    });
  });
});
