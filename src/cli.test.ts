import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { openDb, type ConvoDb } from "./db.js";

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "convo-cli-test-"));
}

describe("CLI commands", () => {
  let dbDir: string;
  let dbPath: string;

  beforeEach(() => {
    dbDir = makeTempDir();
    dbPath = path.join(dbDir, "test.sqlite");

    // Seed the database with a session and annotations
    const db = openDb(dbPath);
    db.upsertSession({ id: "cli-test-session" });
    db.upsertAnnotation({
      id: "ann-1",
      session_id: "cli-test-session",
      turn_index: 0,
      block_index: 0,
      char_start: 0,
      char_end: 10,
      text: "test highlight",
      comment: "test comment",
      kind: "highlight",
    });
    db.upsertAnnotation({
      id: "ann-2",
      session_id: "cli-test-session",
      turn_index: 1,
      block_index: 0,
      char_start: 0,
      char_end: 5,
      text: "hello",
      comment: "",
      kind: "decision",
    });
    db.close();
  });

  afterEach(() => {
    fs.rmSync(dbDir, { recursive: true, force: true });
  });

  // Helper: run the CLI script with CONVO_DB_PATH override
  async function runCli(args: string[], stdin?: string): Promise<{
    stdout: string;
    stderr: string;
    exitCode: number;
  }> {
    const proc = Bun.spawn(
      ["bun", path.join(import.meta.dir, "cli.ts"), ...args],
      {
        env: { ...process.env, CONVO_DB_PATH: dbPath },
        stdin: stdin ? new Blob([stdin]) : undefined,
        stdout: "pipe",
        stderr: "pipe",
      },
    );

    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    return { stdout, stderr, exitCode };
  }

  // -----------------------------------------------------------------------
  // tag command
  // -----------------------------------------------------------------------

  describe("tag", () => {
    it("sets tags on an annotation", async () => {
      const { stdout, exitCode } = await runCli(["tag", "ann-1", "foo", "bar"]);
      expect(exitCode).toBe(0);
      expect(stdout).toContain("ann-1");
      expect(stdout).toContain("foo");
      expect(stdout).toContain("bar");

      // Verify in DB
      const db = openDb(dbPath);
      const anns = db.getSessionAnnotations("cli-test-session");
      const ann = anns.find((a) => a.id === "ann-1");
      expect(ann!.tags.sort()).toEqual(["bar", "foo"]);
      db.close();
    });

    it("errors on nonexistent annotation", async () => {
      const { exitCode, stderr } = await runCli(["tag", "nonexistent", "foo"]);
      expect(exitCode).not.toBe(0);
      expect(stderr).toContain("not found");
    });
  });

  // -----------------------------------------------------------------------
  // batch-tag command
  // -----------------------------------------------------------------------

  describe("batch-tag", () => {
    it("tags multiple annotations from JSON stdin", async () => {
      const input = JSON.stringify([
        { id: "ann-1", tags: ["alpha", "beta"] },
        { id: "ann-2", tags: ["gamma"] },
      ]);
      const { stdout, exitCode } = await runCli(["batch-tag"], input);
      expect(exitCode).toBe(0);
      expect(stdout).toContain("2 annotation(s) tagged");

      // Verify in DB
      const db = openDb(dbPath);
      const anns = db.getSessionAnnotations("cli-test-session");
      const a1 = anns.find((a) => a.id === "ann-1");
      const a2 = anns.find((a) => a.id === "ann-2");
      expect(a1!.tags.sort()).toEqual(["alpha", "beta"]);
      expect(a2!.tags).toEqual(["gamma"]);
      db.close();
    });

    it("skips nonexistent annotations and reports them", async () => {
      const input = JSON.stringify([
        { id: "ann-1", tags: ["ok"] },
        { id: "nonexistent", tags: ["bad"] },
      ]);
      const { stdout, stderr, exitCode } = await runCli(["batch-tag"], input);
      expect(exitCode).toBe(0);
      expect(stdout).toContain("1 annotation(s) tagged");
      expect(stderr).toContain("nonexistent");
    });

    it("errors on invalid JSON input", async () => {
      const { exitCode, stderr } = await runCli(["batch-tag"], "not json");
      expect(exitCode).not.toBe(0);
      expect(stderr).toContain("Invalid JSON");
    });
  });

  // -----------------------------------------------------------------------
  // highlights command
  // -----------------------------------------------------------------------

  describe("highlights", () => {
    it("lists highlights for a session as JSON", async () => {
      const { stdout, exitCode } = await runCli([
        "highlights",
        "--json",
        "--session",
        "cli-test-session",
      ]);
      expect(exitCode).toBe(0);
      const data = JSON.parse(stdout);
      expect(Array.isArray(data)).toBe(true);
      expect(data.length).toBe(2);
    });

    it("--tags lists tag counts", async () => {
      // Add some tags first
      const db = openDb(dbPath);
      db.replaceAnnotationTags("ann-1", ["architecture", "pattern"]);
      db.replaceAnnotationTags("ann-2", ["architecture"]);
      db.close();

      const { stdout, exitCode } = await runCli(["highlights", "--json", "--tags"]);
      expect(exitCode).toBe(0);
      const data = JSON.parse(stdout);
      const arch = data.find((t: any) => t.name === "architecture");
      expect(arch).toBeDefined();
      expect(arch.count).toBe(2);
    });
  });
});

// ---------------------------------------------------------------------------
// annotations export / import (global backup)
// ---------------------------------------------------------------------------

describe("annotations export/import CLI", () => {
  let dbDir: string;
  let dbPath: string;

  beforeEach(() => {
    dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "convo-annexp-test-"));
    dbPath = path.join(dbDir, "test.sqlite");

    const db = openDb(dbPath);
    db.upsertSession({ id: "sess-a" });
    db.upsertSession({ id: "sess-b" });
    db.upsertAnnotation({
      id: "exp-1",
      session_id: "sess-a",
      turn_index: 2,
      block_index: 1,
      char_start: 5,
      char_end: 20,
      text: "first highlight",
      comment: "with comment",
      kind: "decision",
      speaker: "assistant",
      prefix: "before ",
      suffix: " after",
      trigger: 'User: "why?"',
    });
    db.upsertAnnotation({
      id: "exp-2",
      session_id: "sess-b",
      turn_index: 0,
      block_index: 0,
      char_start: 0,
      char_end: 4,
      text: "more",
      kind: "highlight",
    });
    db.replaceAnnotationTags("exp-1", ["arch", "studio"]);
    db.close();
  });

  afterEach(() => {
    fs.rmSync(dbDir, { recursive: true, force: true });
  });

  async function runCli(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const proc = Bun.spawn(["bun", path.join(import.meta.dir, "cli.ts"), ...args], {
      env: { ...process.env, CONVO_DB_PATH: dbPath },
      stdout: "pipe",
      stderr: "pipe",
      cwd: dbDir,
    });
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    return { stdout, stderr, exitCode };
  }

  it("exports all annotations across sessions to a JSON file", async () => {
    const outFile = path.join(dbDir, "backup.json");
    const result = await runCli(["annotations", "export", "-o", outFile]);
    expect(result.exitCode).toBe(0);

    const payload = JSON.parse(fs.readFileSync(outFile, "utf-8"));
    expect(payload.count).toBe(2);
    expect(payload.annotations).toHaveLength(2);
    const exp1 = payload.annotations.find((a: any) => a.id === "exp-1");
    expect(exp1.session_id).toBe("sess-a");
    expect(exp1.prefix).toBe("before ");
    expect(exp1.suffix).toBe(" after");
    expect(exp1.trigger).toBe('User: "why?"');
    expect(exp1.tags.sort()).toEqual(["arch", "studio"]);
  });

  it("round-trips: export, wipe, import restores everything", async () => {
    const outFile = path.join(dbDir, "backup.json");
    await runCli(["annotations", "export", "-o", outFile]);

    // Wipe annotations
    const db = openDb(dbPath);
    db.deleteAnnotation("exp-1");
    db.deleteAnnotation("exp-2");
    db.close();

    const result = await runCli(["annotations", "import", outFile]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("2 imported");

    const db2 = openDb(dbPath);
    const ann = db2.getAnnotation("exp-1")!;
    expect(ann.text).toBe("first highlight");
    expect(ann.prefix).toBe("before ");
    expect(ann.suffix).toBe(" after");
    expect(ann.trigger).toBe('User: "why?"');
    expect(ann.kind).toBe("decision");
    expect(ann.tags.sort()).toEqual(["arch", "studio"]);
    expect(db2.getAnnotation("exp-2")).not.toBeNull();
    db2.close();
  });

  it("import is idempotent — re-running skips existing annotations", async () => {
    const outFile = path.join(dbDir, "backup.json");
    await runCli(["annotations", "export", "-o", outFile]);

    const result = await runCli(["annotations", "import", outFile]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("0 imported");
    expect(result.stdout).toContain("2 skipped");
  });
});
