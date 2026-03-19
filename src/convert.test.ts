import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { convertJsonlToHtml, buildPageParams } from "./convert.js";
import type { Conversation } from "./types.js";

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "convo-viewer-test-"));
}

function writeFixtureJsonl(dir: string, filename = "test.jsonl"): string {
  const lines = [
    JSON.stringify({
      type: "summary",
      sessionId: "abcd1234-5678-90ab-cdef-1234567890ab",
      cwd: "/home/user/project",
      version: "1.0.0",
    }),
    JSON.stringify({
      type: "user",
      sessionId: "abcd1234-5678-90ab-cdef-1234567890ab",
      message: { content: "Hello, Claude!" },
      timestamp: "2024-01-15T10:30:00Z",
    }),
    JSON.stringify({
      type: "assistant",
      message: {
        content: [{ type: "text", text: "Hello! How can I help?" }],
        model: "claude-sonnet-4-20250514",
      },
      timestamp: "2024-01-15T10:30:05Z",
    }),
  ];
  const filePath = path.join(dir, filename);
  fs.writeFileSync(filePath, lines.join("\n") + "\n", "utf-8");
  return filePath;
}

describe("convertJsonlToHtml", () => {
  let tempDirs: string[] = [];

  beforeEach(() => {
    tempDirs = [];
  });

  afterEach(() => {
    for (const dir of tempDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("converts a JSONL file to HTML with explicit output path", () => {
    const dir = makeTempDir();
    tempDirs.push(dir);
    const inputFile = writeFixtureJsonl(dir);
    const outputFile = path.join(dir, "output.html");

    const result = convertJsonlToHtml(inputFile, outputFile);

    expect(result).toBe(outputFile);
    expect(fs.existsSync(outputFile)).toBe(true);

    const content = fs.readFileSync(outputFile, "utf-8");
    expect(content).toContain("<!DOCTYPE html>");
    expect(content).toContain("<html lang=\"en\">");
    expect(content).toContain("</html>");
  });

  it("uses input basename with .html extension when no session id and no output specified", () => {
    const dir = makeTempDir();
    tempDirs.push(dir);
    // Create a JSONL with no sessionId so it falls through to basename logic
    const filePath = path.join(dir, "myconvo.jsonl");
    const lines = [
      JSON.stringify({
        type: "user",
        message: { content: "Test" },
      }),
    ];
    fs.writeFileSync(filePath, lines.join("\n") + "\n", "utf-8");

    const result = convertJsonlToHtml(filePath);
    const expectedPath = path.join(dir, "myconvo.html");

    expect(result).toBe(expectedPath);
    expect(fs.existsSync(expectedPath)).toBe(true);

    // Clean up
    fs.unlinkSync(expectedPath);
  });

  it("exits with error for non-existent input file", () => {
    const mockExit = vi
      .spyOn(process, "exit")
      .mockImplementation(() => { throw new Error("process.exit called"); });
    const mockError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    expect(() =>
      convertJsonlToHtml("/nonexistent/path/file.jsonl")
    ).toThrow("process.exit called");

    expect(mockError).toHaveBeenCalledWith(
      "Error: File not found: /nonexistent/path/file.jsonl"
    );

    mockExit.mockRestore();
    mockError.mockRestore();
  });

  it("includes metadata summary line in console output", () => {
    const dir = makeTempDir();
    tempDirs.push(dir);
    const inputFile = writeFixtureJsonl(dir);
    const outputFile = path.join(dir, "output.html");

    const mockLog = vi.spyOn(console, "log").mockImplementation(() => {});

    convertJsonlToHtml(inputFile, outputFile);

    expect(mockLog).toHaveBeenCalledWith(
      expect.stringContaining("test.jsonl ->")
    );
    expect(mockLog).toHaveBeenCalledWith(
      expect.stringContaining("turns")
    );

    mockLog.mockRestore();
  });

  it("escapes --> in metadata to prevent HTML comment breakage", () => {
    const convo: Conversation = {
      sessionId: "test-sess",
      projectDir: "/home/user/project-->exploit",
      model: "claude-3",
      version: "1.0",
      startTime: "2024-01-15T10:00:00Z",
      turns: [{ role: "user" as const, timestamp: "2024-01-15T10:00:00Z", blocks: [{ type: "text" as const, text: "Hi" }] }],
    };
    const dir = makeTempDir();
    tempDirs.push(dir);
    const params = buildPageParams(convo, "/tmp/test.jsonl", dir);
    // Extract the JSON from the meta comment
    const jsonStr = params.metaComment.match(/CONVO_META:(\{.*\})/)?.[1];
    expect(jsonStr).toBeDefined();
    // The JSON content must not contain --> (breaks HTML comments)
    expect(jsonStr).not.toContain("-->");
    // But parsing should recover the original value
    const parsed = JSON.parse(jsonStr!);
    expect(parsed.project_dir).toBe("/home/user/project-->exploit");
  });

  it("respects includeThinking and includeTools options", () => {
    const dir = makeTempDir();
    tempDirs.push(dir);
    const inputFile = writeFixtureJsonl(dir);
    const outputFile = path.join(dir, "output.html");

    // Should not throw with either option set to false
    const result = convertJsonlToHtml(inputFile, outputFile, {
      includeThinking: false,
      includeTools: false,
    });

    expect(result).toBe(outputFile);
    expect(fs.existsSync(outputFile)).toBe(true);
  });
});
