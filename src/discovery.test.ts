import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { scanProjectsDir, syncToDb, clearDiscoveryCache, type DiscoveredSession } from "./discovery.js";
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

    it("handles empty directory gracefully", () => {
      const { sessions } = scanProjectsDir(tempDir);
      expect(sessions).toEqual([]);
    });

    it("handles non-existent directory gracefully", () => {
      const { sessions } = scanProjectsDir(path.join(tempDir, "no-such-dir"));
      expect(sessions).toEqual([]);
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
