import { describe, it, expect, afterEach } from "vitest";
import { writeFileSync, unlinkSync, mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { buildConversation } from "./parser.js";
import { IncrementalParser } from "./incremental-parser.js";

function writeTempJsonl(lines: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), "parser-test-"));
  const file = join(dir, "test.jsonl");
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return file;
}

const tempFiles: string[] = [];

function createJsonl(lines: unknown[]): string {
  const f = writeTempJsonl(lines);
  tempFiles.push(f);
  return f;
}

afterEach(() => {
  for (const f of tempFiles) {
    try { unlinkSync(f); } catch { /* ignore */ }
  }
  tempFiles.length = 0;
});

describe("buildConversation", () => {
  it("parses basic user + assistant messages", () => {
    const file = createJsonl([
      { type: "user", message: { content: "Hello" }, timestamp: "2024-01-01T00:00:00Z" },
      { type: "assistant", message: { content: "Hi there!" }, timestamp: "2024-01-01T00:00:01Z" },
    ]);
    const conv = buildConversation(file);
    expect(conv.turns).toHaveLength(2);
    expect(conv.turns[0].role).toBe("user");
    expect(conv.turns[0].blocks).toHaveLength(1);
    expect(conv.turns[0].blocks[0]).toEqual({ type: "text", text: "Hello" });
    expect(conv.turns[1].role).toBe("assistant");
    expect(conv.turns[1].blocks[0]).toEqual({ type: "text", text: "Hi there!" });
  });

  it("extracts metadata (sessionId from root, model, cwd, version)", () => {
    const file = createJsonl([
      { type: "user", sessionId: "sess-123", cwd: "/home/user", version: "1.0.0", message: { content: "Hi", model: "claude-3" }, timestamp: "2024-06-01T12:00:00Z" },
      { type: "assistant", message: { content: "Hello" }, timestamp: "2024-06-01T12:00:01Z" },
    ]);
    const conv = buildConversation(file);
    expect(conv.sessionId).toBe("sess-123");
    expect(conv.projectDir).toBe("/home/user");
    expect(conv.version).toBe("1.0.0");
    expect(conv.model).toBe("claude-3");
    expect(conv.startTime).toBe("2024-06-01T12:00:00Z");
  });

  it("extracts sessionId from message.sessionId", () => {
    const file = createJsonl([
      { type: "user", message: { content: "Hi", sessionId: "msg-sess-456" }, timestamp: "2024-01-01T00:00:00Z" },
    ]);
    const conv = buildConversation(file);
    expect(conv.sessionId).toBe("msg-sess-456");
  });

  it("prefers message.sessionId over root sessionId", () => {
    const file = createJsonl([
      { type: "user", sessionId: "root-id", message: { content: "Hi", sessionId: "msg-id" }, timestamp: "2024-01-01T00:00:00Z" },
    ]);
    const conv = buildConversation(file);
    expect(conv.sessionId).toBe("msg-id");
  });

  it("handles string content for user and assistant", () => {
    const file = createJsonl([
      { type: "user", message: { content: "Question?" }, timestamp: "t1" },
      { type: "assistant", message: { content: "Answer." }, timestamp: "t2" },
    ]);
    const conv = buildConversation(file);
    expect(conv.turns[0].blocks[0]).toEqual({ type: "text", text: "Question?" });
    expect(conv.turns[1].blocks[0]).toEqual({ type: "text", text: "Answer." });
  });

  it("handles array content with text blocks", () => {
    const file = createJsonl([
      {
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "Part 1" },
            { type: "text", text: "Part 2" },
          ],
        },
        timestamp: "t1",
      },
    ]);
    const conv = buildConversation(file);
    expect(conv.turns[0].blocks).toHaveLength(2);
    expect(conv.turns[0].blocks[0]).toEqual({ type: "text", text: "Part 1" });
    expect(conv.turns[0].blocks[1]).toEqual({ type: "text", text: "Part 2" });
  });

  it("extracts tool_use blocks", () => {
    const file = createJsonl([
      {
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", name: "read_file", input: { path: "/tmp/f" }, id: "tu-1" },
          ],
        },
        timestamp: "t1",
      },
    ]);
    const conv = buildConversation(file);
    expect(conv.turns[0].blocks[0]).toEqual({
      type: "tool_use",
      name: "read_file",
      input: { path: "/tmp/f" },
      id: "tu-1",
    });
  });

  it("extracts tool_result blocks with string content", () => {
    const file = createJsonl([
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "Let me check." }] },
        timestamp: "t1",
      },
      {
        type: "user",
        message: {
          content: [
            { type: "tool_result", content: "file contents here", tool_use_id: "tu-1" },
          ],
        },
        timestamp: "t2",
      },
    ]);
    const conv = buildConversation(file);
    // Tool-result-only user message should be folded into assistant turn
    expect(conv.turns).toHaveLength(1);
    expect(conv.turns[0].blocks[1]).toEqual({
      type: "tool_result",
      content: "file contents here",
      meta: null,
      isError: false,
      toolUseId: "tu-1",
    });
  });

  it("extracts tool_result blocks with array content", () => {
    const file = createJsonl([
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "Checking" }] },
        timestamp: "t1",
      },
      {
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              content: [
                { type: "text", text: "line 1" },
                { type: "text", text: "line 2" },
              ],
              tool_use_id: "tu-2",
            },
          ],
        },
        timestamp: "t2",
      },
    ]);
    const conv = buildConversation(file);
    expect(conv.turns).toHaveLength(1);
    const block = conv.turns[0].blocks[1];
    expect(block.type).toBe("tool_result");
    if (block.type === "tool_result") {
      expect(block.content).toBe("line 1\nline 2");
      expect(block.meta).toBeNull();
    }
  });

  it("separates tool_result metadata (agentId, usage)", () => {
    const file = createJsonl([
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "Running" }] },
        timestamp: "t1",
      },
      {
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              content: [
                { type: "text", text: "actual result" },
                { type: "text", text: "agentId: agent-42" },
                { type: "text", text: "<usage>some usage data</usage>" },
              ],
              tool_use_id: "tu-3",
            },
          ],
        },
        timestamp: "t2",
      },
    ]);
    const conv = buildConversation(file);
    const block = conv.turns[0].blocks[1];
    expect(block.type).toBe("tool_result");
    if (block.type === "tool_result") {
      expect(block.content).toBe("actual result");
      expect(block.meta).toBe("agentId: agent-42\n<usage>some usage data</usage>");
    }
  });

  it("handles error tool results (is_error: true)", () => {
    const file = createJsonl([
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "Trying" }] },
        timestamp: "t1",
      },
      {
        type: "user",
        message: {
          content: [
            { type: "tool_result", content: "Error: file not found", is_error: true, tool_use_id: "tu-err" },
          ],
        },
        timestamp: "t2",
      },
    ]);
    const conv = buildConversation(file);
    const block = conv.turns[0].blocks[1];
    expect(block.type).toBe("tool_result");
    if (block.type === "tool_result") {
      expect(block.isError).toBe(true);
      expect(block.content).toBe("Error: file not found");
    }
  });

  it("detects slash commands", () => {
    const file = createJsonl([
      {
        type: "user",
        message: { content: "<command-name>/help</command-name><command-args>topic</command-args>" },
        timestamp: "t1",
      },
    ]);
    const conv = buildConversation(file);
    expect(conv.turns[0].blocks[0]).toEqual({
      type: "slash_command",
      command: "/help topic",
    });
  });

  it("detects slash command without args", () => {
    const file = createJsonl([
      {
        type: "user",
        message: { content: "<command-name>/clear</command-name>" },
        timestamp: "t1",
      },
    ]);
    const conv = buildConversation(file);
    expect(conv.turns[0].blocks[0]).toEqual({
      type: "slash_command",
      command: "/clear",
    });
  });

  it("detects session continuation", () => {
    const file = createJsonl([
      {
        type: "user",
        message: { content: "This session is being continued from a previous conversation. Here is the summary..." },
        timestamp: "t1",
      },
    ]);
    const conv = buildConversation(file);
    expect(conv.turns[0].blocks[0]).toEqual({
      type: "session_continuation",
      text: "This session is being continued from a previous conversation. Here is the summary...",
    });
  });

  it("filters system noise from user messages (skips entirely)", () => {
    const file = createJsonl([
      {
        type: "user",
        message: { content: "<system-reminder>You are a helpful assistant.</system-reminder>" },
        timestamp: "t1",
      },
      { type: "assistant", message: { content: "Response" }, timestamp: "t2" },
    ]);
    const conv = buildConversation(file);
    // Pure noise user message should be skipped entirely — no empty turn created
    expect(conv.turns).toHaveLength(1);
    expect(conv.turns[0].role).toBe("assistant");
  });

  it("filters system noise from array content user text blocks", () => {
    const file = createJsonl([
      {
        type: "user",
        message: {
          content: [
            { type: "text", text: "<system-reminder>noise</system-reminder>" },
            { type: "text", text: "Real question" },
          ],
        },
        timestamp: "t1",
      },
    ]);
    const conv = buildConversation(file);
    expect(conv.turns[0].blocks).toHaveLength(1);
    expect(conv.turns[0].blocks[0]).toEqual({ type: "text", text: "Real question" });
  });

  it("folds tool_result-only user messages into preceding assistant turn", () => {
    const file = createJsonl([
      {
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "Let me read that file." },
            { type: "tool_use", name: "read", input: {}, id: "tu-10" },
          ],
        },
        timestamp: "t1",
      },
      {
        type: "user",
        message: {
          content: [
            { type: "tool_result", content: "file data", tool_use_id: "tu-10" },
          ],
        },
        timestamp: "t2",
      },
    ]);
    const conv = buildConversation(file);
    expect(conv.turns).toHaveLength(1);
    expect(conv.turns[0].role).toBe("assistant");
    expect(conv.turns[0].blocks).toHaveLength(3);
    expect(conv.turns[0].blocks[2].type).toBe("tool_result");
  });

  it("does not fold tool_result user messages if they also have user text", () => {
    const file = createJsonl([
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "Working..." }] },
        timestamp: "t1",
      },
      {
        type: "user",
        message: {
          content: [
            { type: "tool_result", content: "result", tool_use_id: "tu-20" },
            { type: "text", text: "Also, I have a question" },
          ],
        },
        timestamp: "t2",
      },
    ]);
    const conv = buildConversation(file);
    expect(conv.turns).toHaveLength(2);
    expect(conv.turns[1].role).toBe("user");
  });

  it("merges consecutive same-role messages into one turn", () => {
    const file = createJsonl([
      { type: "user", message: { content: "First message" }, timestamp: "t1" },
      { type: "user", message: { content: "Second message" }, timestamp: "t2" },
      { type: "assistant", message: { content: "Reply" }, timestamp: "t3" },
    ]);
    const conv = buildConversation(file);
    expect(conv.turns).toHaveLength(2);
    expect(conv.turns[0].role).toBe("user");
    expect(conv.turns[0].blocks).toHaveLength(2);
    expect(conv.turns[0].timestamp).toBe("t1"); // keeps first timestamp
    expect(conv.turns[1].role).toBe("assistant");
  });

  it("skips malformed JSONL lines without crashing", () => {
    const dir = mkdtempSync(join(tmpdir(), "parser-test-"));
    const file = join(dir, "bad.jsonl");
    const content = [
      "not valid json",
      JSON.stringify({ type: "user", message: { content: "Valid" }, timestamp: "t1" }),
      "{broken",
      JSON.stringify({ type: "assistant", message: { content: "Also valid" }, timestamp: "t2" }),
    ].join("\n");
    writeFileSync(file, content);
    tempFiles.push(file);

    const conv = buildConversation(file);
    expect(conv.turns).toHaveLength(2);
    expect(conv.turns[0].blocks[0]).toEqual({ type: "text", text: "Valid" });
    expect(conv.turns[1].blocks[0]).toEqual({ type: "text", text: "Also valid" });
  });

  it("skips non-user/non-assistant message types", () => {
    const file = createJsonl([
      { type: "system", message: { content: "System prompt" }, timestamp: "t0" },
      { type: "user", message: { content: "Hello" }, timestamp: "t1" },
    ]);
    const conv = buildConversation(file);
    expect(conv.turns).toHaveLength(1);
    expect(conv.turns[0].role).toBe("user");
  });

  it("handles thinking blocks", () => {
    const file = createJsonl([
      {
        type: "assistant",
        message: {
          content: [
            { type: "thinking", thinking: "Let me think about this..." },
            { type: "text", text: "Here is my answer." },
          ],
        },
        timestamp: "t1",
      },
    ]);
    const conv = buildConversation(file);
    expect(conv.turns[0].blocks).toHaveLength(2);
    expect(conv.turns[0].blocks[0]).toEqual({ type: "thinking", text: "Let me think about this..." });
    expect(conv.turns[0].blocks[1]).toEqual({ type: "text", text: "Here is my answer." });
  });

  it("extracts metadata from non-user/assistant lines", () => {
    const file = createJsonl([
      { type: "system", sessionId: "sess-from-system", cwd: "/project", version: "2.0" },
      { type: "user", message: { content: "Hi", model: "claude-4" }, timestamp: "t1" },
    ]);
    const conv = buildConversation(file);
    expect(conv.sessionId).toBe("sess-from-system");
    expect(conv.projectDir).toBe("/project");
    expect(conv.version).toBe("2.0");
  });

  it("returns null metadata when not present", () => {
    const file = createJsonl([
      { type: "user", message: { content: "Hi" }, timestamp: "t1" },
    ]);
    const conv = buildConversation(file);
    expect(conv.sessionId).toBeNull();
    expect(conv.projectDir).toBeNull();
    expect(conv.model).toBeNull();
    expect(conv.version).toBeNull();
  });

  it("handles empty file", () => {
    const dir = mkdtempSync(join(tmpdir(), "parser-test-"));
    const file = join(dir, "empty.jsonl");
    writeFileSync(file, "");
    tempFiles.push(file);

    const conv = buildConversation(file);
    expect(conv.turns).toHaveLength(0);
    expect(conv.sessionId).toBeNull();
  });

  it("handles tool_result with string content in array items", () => {
    const file = createJsonl([
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "Checking" }] },
        timestamp: "t1",
      },
      {
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              content: ["raw string item"],
              tool_use_id: "tu-str",
            },
          ],
        },
        timestamp: "t2",
      },
    ]);
    const conv = buildConversation(file);
    const block = conv.turns[0].blocks[1];
    expect(block.type).toBe("tool_result");
    if (block.type === "tool_result") {
      expect(block.content).toBe("raw string item");
    }
  });

  it("handles non-string text fields inside tool_result content arrays", () => {
    const file = createJsonl([
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "Running" }] },
        timestamp: "t1",
      },
      {
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              content: [
                { type: "text", text: 42 },
                { type: "text", text: "real result" },
              ],
              tool_use_id: "tu-num",
            },
          ],
        },
        timestamp: "t2",
      },
    ]);
    // Should not crash on non-string text inside tool_result content
    const conv = buildConversation(file);
    expect(conv.turns).toHaveLength(1);
    const block = conv.turns[0].blocks[1];
    expect(block.type).toBe("tool_result");
    if (block.type === "tool_result") {
      expect(block.content).toContain("real result");
    }
  });

  it("detects slash commands in array-format user content", () => {
    const file = createJsonl([
      {
        type: "user",
        message: {
          content: [
            { type: "text", text: "<command-name>/review</command-name><command-args>PR #42</command-args>" },
          ],
        },
        timestamp: "t1",
      },
    ]);
    const conv = buildConversation(file);
    expect(conv.turns[0].blocks).toHaveLength(1);
    expect(conv.turns[0].blocks[0]).toEqual({
      type: "slash_command",
      command: "/review PR #42",
    });
  });

  it("detects session continuation in array-format user content", () => {
    const file = createJsonl([
      {
        type: "user",
        message: {
          content: [
            { type: "text", text: "This session is being continued from a previous conversation. Here is the summary..." },
            { type: "text", text: "<system-reminder>some reminder</system-reminder>" },
          ],
        },
        timestamp: "t1",
      },
    ]);
    const conv = buildConversation(file);
    expect(conv.turns[0].blocks).toHaveLength(1);
    expect(conv.turns[0].blocks[0]).toEqual({
      type: "session_continuation",
      text: "This session is being continued from a previous conversation. Here is the summary...",
    });
  });

  it("survives JSONL lines that parse as non-object JSON values (null, true, 42)", () => {
    const dir = mkdtempSync(join(tmpdir(), "parser-test-"));
    const file = join(dir, "json-primitives.jsonl");
    const content = [
      "null",
      "true",
      "42",
      '"just a string"',
      "[1, 2, 3]",
      JSON.stringify({ type: "user", message: { content: "Real message" }, timestamp: "t1" }),
    ].join("\n");
    writeFileSync(file, content);
    tempFiles.push(file);

    const conv = buildConversation(file);
    expect(conv.turns).toHaveLength(1);
    expect(conv.turns[0].blocks[0]).toEqual({ type: "text", text: "Real message" });
  });

  it("coerces non-string metadata fields (model, version, cwd, sessionId) to strings", () => {
    const file = createJsonl([
      { type: "user", sessionId: 999, cwd: 42, version: 2,
        message: { content: "Hi", model: 3, sessionId: 888 }, timestamp: "t1" },
    ]);
    const conv = buildConversation(file);
    // All metadata should be strings, not numbers — escape() crashes on non-strings
    expect(typeof conv.model).toBe("string");
    expect(conv.model).toBe("3");
    expect(typeof conv.version).toBe("string");
    expect(conv.version).toBe("2");
    expect(typeof conv.projectDir).toBe("string");
    expect(conv.projectDir).toBe("42");
    expect(typeof conv.sessionId).toBe("string");
    expect(conv.sessionId).toBe("888"); // message.sessionId preferred over root
  });

  it("coerces non-string timestamp to string (prevents silent data loss)", () => {
    const file = createJsonl([
      { type: "user", message: { content: "Hi" }, timestamp: 1710000000 },
      { type: "assistant", message: { content: "Hello" }, timestamp: 1710000005 },
    ]);
    const conv = buildConversation(file);
    expect(conv.turns).toHaveLength(2);
    // Timestamp should be a string, not a number
    expect(typeof conv.turns[0].timestamp).toBe("string");
    expect(conv.turns[0].timestamp).toBe("1710000000");
    // startTime metadata should also be a string
    expect(typeof conv.startTime).toBe("string");
    expect(conv.startTime).toBe("1710000000");
  });

  it("coerces non-string tool_use_id in tool_result to string", () => {
    const file = createJsonl([
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "checking" }] },
        timestamp: "t1",
      },
      {
        type: "user",
        message: {
          content: [
            { type: "tool_result", content: "data", tool_use_id: 42 },
          ],
        },
        timestamp: "t2",
      },
    ]);
    const conv = buildConversation(file);
    const block = conv.turns[0].blocks[1];
    expect(block.type).toBe("tool_result");
    if (block.type === "tool_result") {
      expect(typeof block.toolUseId).toBe("string");
      expect(block.toolUseId).toBe("42");
    }
  });

  it("coerces non-string tool_use name/id to strings (prevents renderer crash)", () => {
    const file = createJsonl([
      {
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", name: 42, input: { x: 1 }, id: 999 },
          ],
        },
        timestamp: "t1",
      },
    ]);
    const conv = buildConversation(file);
    expect(conv.turns).toHaveLength(1);
    const block = conv.turns[0].blocks[0];
    expect(block.type).toBe("tool_use");
    if (block.type === "tool_use") {
      // Must be strings, not numbers — escape() in the renderer would crash on numbers
      expect(typeof block.name).toBe("string");
      expect(typeof block.id).toBe("string");
      expect(block.name).toBe("42");
      expect(block.id).toBe("999");
    }
  });

  it("handles thinking blocks with non-string thinking field (e.g. number)", () => {
    const file = createJsonl([
      {
        type: "assistant",
        message: {
          content: [
            { type: "thinking", thinking: 42 },
            { type: "text", text: "My answer" },
          ],
        },
        timestamp: "t1",
      },
    ]);
    // Should not crash — non-string thinking fields should be coerced or skipped
    const conv = buildConversation(file);
    expect(conv.turns).toHaveLength(1);
    // The text block should still be present
    const textBlocks = conv.turns[0].blocks.filter(b => b.type === "text");
    expect(textBlocks).toHaveLength(1);
  });

  it("handles text blocks with non-string text field (e.g. number)", () => {
    const file = createJsonl([
      {
        type: "assistant",
        message: {
          content: [
            { type: "text", text: 123 },
            { type: "text", text: "Real text" },
          ],
        },
        timestamp: "t1",
      },
    ]);
    const conv = buildConversation(file);
    expect(conv.turns).toHaveLength(1);
    const textBlocks = conv.turns[0].blocks.filter(b => b.type === "text");
    expect(textBlocks.length).toBeGreaterThanOrEqual(1);
  });

  it("cleans user text removing system noise tags but keeping real content", () => {
    const file = createJsonl([
      {
        type: "user",
        message: { content: "Hello <task-notification>ignored</task-notification> world" },
        timestamp: "t1",
      },
    ]);
    const conv = buildConversation(file);
    expect(conv.turns[0].blocks[0]).toEqual({ type: "text", text: "Hello  world" });
  });
});

// ---------------------------------------------------------------------------
// Incremental parsing (feedLines called multiple times)
// ---------------------------------------------------------------------------

describe("IncrementalParser incremental feeding", () => {
  it("folds tool_result across separate feedLines batches", () => {
    const parser = new IncrementalParser();

    // Batch 1: assistant with tool_use
    const batch1 = parser.feedLines([
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "Let me check." },
            { type: "tool_use", name: "Read", input: { file_path: "/f" }, id: "tu-1" },
          ],
        },
        timestamp: "t1",
      }),
    ]);
    expect(batch1).toHaveLength(1);
    expect(batch1[0].type).toBe("new_turn");
    expect(parser.getTurns()).toHaveLength(1);

    // Batch 2: user tool_result only (should fold into assistant turn)
    const batch2 = parser.feedLines([
      JSON.stringify({
        type: "user",
        message: {
          content: [
            { type: "tool_result", content: "file contents", tool_use_id: "tu-1" },
          ],
        },
        timestamp: "t2",
      }),
    ]);
    expect(batch2).toHaveLength(1);
    expect(batch2[0].type).toBe("update_turn");
    expect(batch2[0].turnIndex).toBe(0);
    // Still one turn — tool_result folded into assistant
    expect(parser.getTurns()).toHaveLength(1);
    expect(parser.getTurns()[0].role).toBe("assistant");
    expect(parser.getTurns()[0].blocks).toHaveLength(3);
  });

  it("merges consecutive same-role messages across batches", () => {
    const parser = new IncrementalParser();

    parser.feedLines([
      JSON.stringify({ type: "user", message: { content: "First" }, timestamp: "t1" }),
    ]);
    expect(parser.getTurns()).toHaveLength(1);

    // Second user message in separate batch should merge
    const updates = parser.feedLines([
      JSON.stringify({ type: "user", message: { content: "Second" }, timestamp: "t2" }),
    ]);
    expect(updates[0].type).toBe("update_turn");
    expect(parser.getTurns()).toHaveLength(1);
    expect(parser.getTurns()[0].blocks).toHaveLength(2);
  });

  it("accumulates metadata across batches", () => {
    const parser = new IncrementalParser();

    // Batch 1: system line with sessionId + cwd
    parser.feedLines([
      JSON.stringify({ type: "system", sessionId: "sess-inc", cwd: "/project", version: "1.0" }),
    ]);

    // Batch 2: user message with model
    parser.feedLines([
      JSON.stringify({ type: "user", message: { content: "Hi", model: "claude-4" }, timestamp: "t1" }),
    ]);

    const meta = parser.getMetadata();
    expect(meta.sessionId).toBe("sess-inc");
    expect(meta.projectDir).toBe("/project");
    expect(meta.model).toBe("claude-4");
    expect(meta.startTime).toBe("t1");
  });

  it("handles tool_result with empty content", () => {
    const file = createJsonl([
      { type: "user", message: { content: "Run this" }, timestamp: "t1" },
      {
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", id: "tu1", name: "Bash", input: { command: "true" } },
            { type: "tool_result", tool_use_id: "tu1", content: "" },
          ],
        },
        timestamp: "t2",
      },
    ]);
    const conv = buildConversation(file);
    // The tool_result should exist with empty content, not crash
    const toolResults = conv.turns.flatMap((t) => t.blocks).filter((b) => b.type === "tool_result");
    expect(toolResults.length).toBe(1);
    expect((toolResults[0] as any).content).toBe("");
  });

  it("preserves unicode in thinking blocks (emoji, CJK, combining marks)", () => {
    const thinkingText = "Let me analyze 🧠 this: 中文テスト, café résumé";
    const file = createJsonl([
      { type: "user", message: { content: "Question" }, timestamp: "t1" },
      {
        type: "assistant",
        message: {
          content: [
            { type: "thinking", thinking: thinkingText },
            { type: "text", text: "Answer" },
          ],
        },
        timestamp: "t2",
      },
    ]);
    const conv = buildConversation(file);
    const thinking = conv.turns[1].blocks.find((b) => b.type === "thinking");
    expect(thinking).toBeDefined();
    expect((thinking as any).text).toBe(thinkingText);
    // Verify specific unicode characters survived round-trip
    expect((thinking as any).text).toContain("🧠");
    expect((thinking as any).text).toContain("中文");
    expect((thinking as any).text).toContain("café");
  });

  it("skips messages where content is an object (not string/array)", () => {
    // Malformed JSONL: content is a plain object instead of string or array.
    // The parser should skip these gracefully, not crash.
    const file = createJsonl([
      { type: "user", message: { content: "valid question" }, timestamp: "t1" },
      {
        type: "assistant",
        message: { content: { type: "text", text: "this is wrong format" } },
        timestamp: "t2",
      },
      { type: "assistant", message: { content: "valid answer" }, timestamp: "t3" },
    ]);
    const conv = buildConversation(file);
    // The object-content message should be skipped (no blocks → no turn)
    // Valid messages should still parse: user + assistant (the valid ones)
    expect(conv.turns).toHaveLength(2);
    expect(conv.turns[0].role).toBe("user");
    expect(conv.turns[1].role).toBe("assistant");
    expect(conv.turns[1].blocks[0]).toHaveProperty("text", "valid answer");
  });

  it("skips messages where content is a number", () => {
    const file = createJsonl([
      { type: "user", message: { content: "hello" }, timestamp: "t1" },
      { type: "assistant", message: { content: 42 }, timestamp: "t2" },
      { type: "assistant", message: { content: "real answer" }, timestamp: "t3" },
    ]);
    const conv = buildConversation(file);
    // content:42 is neither string nor array → message skipped
    expect(conv.turns).toHaveLength(2);
    expect(conv.turns[0].role).toBe("user");
    expect(conv.turns[1].role).toBe("assistant");
    expect(conv.turns[1].blocks[0]).toHaveProperty("text", "real answer");
  });

  it("treats is_error string 'false' as not-error (coerce to boolean correctly)", () => {
    // Bug: the parser uses `(block.is_error as boolean) ?? false` which only
    // handles null/undefined. If is_error is the string "false" (from malformed
    // JSONL), ?? doesn't trigger because "false" is not nullish. The truthy
    // string "false" causes the result to be incorrectly marked as an error.
    const file = createJsonl([
      {
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "Running command" },
            { type: "tool_use", id: "tu1", name: "Bash", input: { command: "ls" } },
            // is_error is the STRING "false" — should be treated as not-error
            { type: "tool_result", content: "file.txt", is_error: "false", tool_use_id: "tu1" },
          ],
        },
        timestamp: "t1",
      },
    ]);
    const conv = buildConversation(file);
    const toolResults = conv.turns.flatMap((t) => t.blocks).filter((b) => b.type === "tool_result");
    expect(toolResults.length).toBe(1);
    // The string "false" must be coerced to boolean false, not left as truthy string
    expect((toolResults[0] as any).isError).toBe(false);
  });

  it("handles messages with missing message field (active session partial write)", () => {
    // During active writes, a line might be flushed with only the type/timestamp
    // fields before the message payload is written. These should be skipped.
    const file = createJsonl([
      { type: "user", timestamp: "t1" },  // no message field at all
      { type: "user", message: { content: "actual question" }, timestamp: "t2" },
      { type: "assistant", message: null, timestamp: "t3" },  // message is null
      { type: "assistant", message: { content: "actual answer" }, timestamp: "t4" },
    ]);
    const conv = buildConversation(file);
    // Both messages without content should be skipped
    expect(conv.turns).toHaveLength(2);
    expect(conv.turns[0].blocks[0]).toHaveProperty("text", "actual question");
    expect(conv.turns[1].blocks[0]).toHaveProperty("text", "actual answer");
  });
});
