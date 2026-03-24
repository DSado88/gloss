import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { ConvoDb, openDb } from "./db.js";
import { getSummary, buildExcerpt } from "./summary.js";

// Helpers
function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "summary-test-"));
}

function makeJsonl(dir: string, sessionId: string, turns: Array<{ role: string; text: string }>): string {
  const filePath = path.join(dir, `${sessionId}.jsonl`);
  const lines: string[] = [];
  for (const t of turns) {
    const type = t.role === "user" ? "user" : "assistant";
    lines.push(JSON.stringify({
      type,
      message: { role: type === "user" ? "human" : "assistant", content: [{ type: "text", text: t.text }] },
      uuid: `${sessionId}-${lines.length}`,
      sessionId,
    }));
  }
  fs.writeFileSync(filePath, lines.join("\n") + "\n");
  return filePath;
}

describe("buildExcerpt", () => {
  let dir: string;

  beforeEach(() => { dir = tmpDir(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it("returns null for empty file", () => {
    const f = path.join(dir, "empty.jsonl");
    fs.writeFileSync(f, "");
    expect(buildExcerpt(f)).toBeNull();
  });

  it("extracts all turns when < 4", () => {
    const f = makeJsonl(dir, "s1", [
      { role: "user", text: "How do I fix the bug?" },
      { role: "assistant", text: "Let me check the code." },
    ]);
    const excerpt = buildExcerpt(f);
    expect(excerpt).not.toBeNull();
    expect(excerpt).toContain("[User] How do I fix the bug?");
    expect(excerpt).toContain("[Claude] Let me check the code.");
    expect(excerpt).toContain("Summarize this developer-Claude conversation");
  });

  it("extracts first 2 + last 2 turns for long conversations", () => {
    const turns = [
      { role: "user", text: "Turn 0 - first user message" },
      { role: "assistant", text: "Turn 1 - first assistant reply" },
      { role: "user", text: "Turn 2 - middle user" },
      { role: "assistant", text: "Turn 3 - middle assistant" },
      { role: "user", text: "Turn 4 - middle user 2" },
      { role: "assistant", text: "Turn 5 - middle assistant 2" },
      { role: "user", text: "Turn 6 - second to last" },
      { role: "assistant", text: "Turn 7 - last assistant reply" },
    ];
    const f = makeJsonl(dir, "s2", turns);
    const excerpt = buildExcerpt(f);
    expect(excerpt).not.toBeNull();
    // Should have first 2
    expect(excerpt).toContain("Turn 0");
    expect(excerpt).toContain("Turn 1");
    // Should have last 2
    expect(excerpt).toContain("Turn 6");
    expect(excerpt).toContain("Turn 7");
    // Should NOT have middle turns
    expect(excerpt).not.toContain("Turn 2");
    expect(excerpt).not.toContain("Turn 3");
    expect(excerpt).not.toContain("Turn 4");
    expect(excerpt).not.toContain("Turn 5");
  });

  it("returns null for conversation with only tool calls (no text)", () => {
    // Some conversations are purely tool-driven with no user text or assistant text
    const f = path.join(dir, "tools-only.jsonl");
    const lines = [
      JSON.stringify({
        type: "user",
        message: {
          content: [
            { type: "tool_result", tool_use_id: "tu1", content: "file contents here" },
          ],
        },
        sessionId: "tools-only",
      }),
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", id: "tu2", name: "Bash", input: { command: "ls" } },
          ],
        },
        sessionId: "tools-only",
      }),
    ];
    fs.writeFileSync(f, lines.join("\n") + "\n");
    const excerpt = buildExcerpt(f);
    // No text blocks → no excerpt content → should return null
    expect(excerpt).toBeNull();
  });

  it("truncates long turns to 500 chars", () => {
    const longText = "x".repeat(1000);
    const f = makeJsonl(dir, "s3", [
      { role: "user", text: longText },
      { role: "assistant", text: "short reply" },
    ]);
    const excerpt = buildExcerpt(f);
    expect(excerpt).not.toBeNull();
    // Should be truncated with ...
    expect(excerpt).toContain("...");
    // Should NOT contain the full 1000 chars
    expect(excerpt!.indexOf("x".repeat(501))).toBe(-1);
  });

  it("handles single-turn conversation", () => {
    const f = makeJsonl(dir, "s-single", [
      { role: "user", text: "One lonely question" },
    ]);
    const excerpt = buildExcerpt(f);
    expect(excerpt).not.toBeNull();
    expect(excerpt).toContain("[User] One lonely question");
    // Should NOT contain [Claude] since there's only one turn
    expect(excerpt).not.toContain("[Claude]");
  });

  it("returns null for nonexistent file", () => {
    expect(buildExcerpt("/tmp/nonexistent_summary_test_xyz.jsonl")).toBeNull();
  });

  it("extracts text from turns with mixed tool+text blocks, skips tool-only turns", () => {
    const f = path.join(dir, "mixed.jsonl");
    const lines = [
      // Turn 0: user text
      JSON.stringify({
        type: "user",
        message: { content: [{ type: "text", text: "Please fix the bug" }] },
        sessionId: "mixed",
      }),
      // Turn 1: assistant with both text and tool_use — only text should appear in excerpt
      JSON.stringify({
        type: "assistant",
        message: { content: [
          { type: "text", text: "Let me check the code" },
          { type: "tool_use", id: "tu1", name: "Read", input: { file_path: "/src/app.ts" } },
        ] },
        sessionId: "mixed",
      }),
      // Turn 2: user with only tool_result (no text) — should be folded/skipped by parser
      JSON.stringify({
        type: "user",
        message: { content: [
          { type: "tool_result", tool_use_id: "tu1", content: "file contents here" },
        ] },
        sessionId: "mixed",
      }),
      // Turn 3: assistant with text
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "I found the issue" }] },
        sessionId: "mixed",
      }),
    ];
    fs.writeFileSync(f, lines.join("\n") + "\n");
    const excerpt = buildExcerpt(f);
    expect(excerpt).not.toBeNull();
    // Text content should appear
    expect(excerpt).toContain("[User] Please fix the bug");
    // Parser merges consecutive assistant turns (tool_result folding + same-role merge)
    // so both text blocks end up in the same [Claude] turn
    expect(excerpt).toContain("[Claude] Let me check the code");
    expect(excerpt).toContain("I found the issue");
    // Tool content should NOT appear in excerpt
    expect(excerpt).not.toContain("file contents here");
    expect(excerpt).not.toContain("app.ts");
  });

  it("returns null for file with only summary/metadata lines", () => {
    // A file with only a summary line and no user/assistant messages
    const f = path.join(dir, "meta-only.jsonl");
    fs.writeFileSync(f, JSON.stringify({
      type: "summary",
      sessionId: "meta-only",
      cwd: "/test",
      version: "1.0.0",
    }) + "\n");
    expect(buildExcerpt(f)).toBeNull();
  });
});

describe("getSummary", () => {
  let dir: string;
  let dbPath: string;
  let db: ConvoDb;

  beforeEach(() => {
    dir = tmpDir();
    dbPath = path.join(dir, "test.sqlite");
    db = openDb(dbPath);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("returns idle for session with no summary", () => {
    const f = makeJsonl(dir, "abc", [{ role: "user", text: "hi" }, { role: "assistant", text: "hello" }]);
    db.upsertSession({ id: "abc", jsonl_path: f, last_modified: Math.floor(Date.now() / 1000) });
    const result = getSummary(db, "abc");
    expect(result.status).toBe("idle");
    expect(result.summary).toBeNull();
  });

  it("returns cached summary when source mtime matches", () => {
    const f = makeJsonl(dir, "def", [{ role: "user", text: "hi" }, { role: "assistant", text: "hello" }]);
    const stat = fs.statSync(f);
    const mtime = Math.floor(stat.mtimeMs);

    db.upsertSession({ id: "def", jsonl_path: f, last_modified: Math.floor(Date.now() / 1000) });
    db.setSummaryDone("def", "Test summary", mtime);

    const result = getSummary(db, "def");
    expect(result.status).toBe("done");
    expect(result.summary).toBe("Test summary");
    expect(result.cached).toBe(true);
  });

  it("clears stale summary when file mtime changed", () => {
    const f = makeJsonl(dir, "ghi", [{ role: "user", text: "hi" }, { role: "assistant", text: "hello" }]);
    const oldMtime = 1000000; // Clearly different from actual file mtime

    db.upsertSession({ id: "ghi", jsonl_path: f, last_modified: Math.floor(Date.now() / 1000) });
    db.setSummaryDone("ghi", "Old summary", oldMtime);

    const result = getSummary(db, "ghi");
    expect(result.status).toBe("idle"); // Cleared because mtime doesn't match
    expect(result.cached).toBe(false);

    // Verify DB was cleared
    const session = db.getSession("ghi");
    expect(session?.summary).toBeNull();
  });

  it("returns error for missing session", () => {
    const result = getSummary(db, "nonexistent");
    expect(result.status).toBe("error");
    expect(result.error).toContain("not found");
  });
});

describe("DB summary methods", () => {
  let dir: string;
  let db: ConvoDb;

  beforeEach(() => {
    dir = tmpDir();
    db = openDb(path.join(dir, "test.sqlite"));
    db.upsertSession({ id: "test-1", jsonl_path: "/tmp/test.jsonl" });
  });

  afterEach(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  });

  it("setSummaryGenerating marks status", () => {
    db.setSummaryGenerating("test-1");
    const s = db.getSession("test-1");
    expect(s?.summary_status).toBe("generating");
  });

  it("setSummaryDone stores summary and mtime", () => {
    db.setSummaryDone("test-1", "A great summary", 123456789);
    const s = db.getSession("test-1");
    expect(s?.summary).toBe("A great summary");
    expect(s?.summary_source_mtime).toBe(123456789);
    expect(s?.summary_status).toBe("done");
    expect(s?.summary_error).toBeNull();
  });

  it("setSummaryError stores error", () => {
    db.setSummaryError("test-1", "Timed out");
    const s = db.getSession("test-1");
    expect(s?.summary_status).toBe("error");
    expect(s?.summary_error).toBe("Timed out");
  });

  it("clearSummary resets all fields", () => {
    db.setSummaryDone("test-1", "Some summary", 999);
    db.clearSummary("test-1");
    const s = db.getSession("test-1");
    expect(s?.summary).toBeNull();
    expect(s?.summary_source_mtime).toBeNull();
    expect(s?.summary_status).toBe("idle");
    expect(s?.summary_error).toBeNull();
  });
});
