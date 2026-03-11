import { describe, it, expect } from "vitest";
import { IncrementalParser } from "./incremental-parser.js";

describe("IncrementalParser — live update scenarios", () => {
  function makeSummaryLine(sessionId = "test-session") {
    return JSON.stringify({
      type: "summary",
      sessionId,
      cwd: "/test",
      version: "1.0.0",
    });
  }

  function makeUserLine(content: string, ts?: string) {
    return JSON.stringify({
      type: "user",
      message: { content },
      timestamp: ts ?? "2024-01-15T10:30:00Z",
    });
  }

  function makeAssistantLine(text: string, ts?: string) {
    return JSON.stringify({
      type: "assistant",
      message: {
        content: [{ type: "text", text }],
        model: "claude-sonnet-4-20250514",
      },
      timestamp: ts ?? "2024-01-15T10:30:05Z",
    });
  }

  it("feedLines returns new_turn updates for new messages", () => {
    const parser = new IncrementalParser();

    // Initial load
    const updates1 = parser.feedLines([
      makeSummaryLine(),
      makeUserLine("Hello"),
    ]);
    // Summary + user = at least 1 turn
    expect(updates1.length).toBeGreaterThanOrEqual(1);

    // Simulate live append — new assistant turn
    const updates2 = parser.feedLines([
      makeAssistantLine("Hi there!"),
    ]);
    expect(updates2.length).toBeGreaterThanOrEqual(1);

    const lastUpdate = updates2[updates2.length - 1];
    expect(lastUpdate.type).toBe("new_turn");
    expect(lastUpdate.turn.role).toBe("assistant");
  });

  it("accumulates turns correctly across multiple feedLines calls", () => {
    const parser = new IncrementalParser();

    parser.feedLines([makeSummaryLine(), makeUserLine("First")]);
    const count1 = parser.getTurns().length;

    parser.feedLines([makeAssistantLine("Response 1")]);
    const count2 = parser.getTurns().length;
    expect(count2).toBe(count1 + 1);

    parser.feedLines([makeUserLine("Second"), makeAssistantLine("Response 2")]);
    const count3 = parser.getTurns().length;
    expect(count3).toBe(count2 + 2);
  });

  it("handles empty lines gracefully", () => {
    const parser = new IncrementalParser();
    const updates = parser.feedLines(["", "", ""]);
    expect(updates).toEqual([]);
  });

  it("handles malformed JSON lines gracefully", () => {
    const parser = new IncrementalParser();
    // Should not throw
    const updates = parser.feedLines([
      makeSummaryLine(),
      "not valid json",
      makeUserLine("Hello"),
    ]);
    // Should still parse the valid lines
    expect(parser.getTurns().length).toBeGreaterThanOrEqual(1);
  });

  it("extracts metadata from summary line", () => {
    const parser = new IncrementalParser();
    parser.feedLines([
      JSON.stringify({
        type: "summary",
        sessionId: "abc-123",
        cwd: "/home/user/project",
        version: "2.0.0",
      }),
    ]);
    const meta = parser.getMetadata();
    expect(meta.sessionId).toBe("abc-123");
    expect(meta.projectDir).toBe("/home/user/project");
  });

  it("simulates full live session: initial load then incremental appends", () => {
    const parser = new IncrementalParser();

    // Simulating what the server does: read file, split into lines, feedLines
    const initialLines = [
      makeSummaryLine("live-session"),
      makeUserLine("Start of conversation"),
      makeAssistantLine("Welcome!"),
    ];
    parser.feedLines(initialLines);
    expect(parser.getTurns().length).toBe(2); // user + assistant

    // Time passes, user sends another message (appended to file)
    const update1 = parser.feedLines([makeUserLine("Follow up question")]);
    expect(update1.some((u) => u.type === "new_turn")).toBe(true);
    expect(parser.getTurns().length).toBe(3);

    // Assistant responds
    const update2 = parser.feedLines([makeAssistantLine("Here's my answer")]);
    expect(update2.some((u) => u.type === "new_turn")).toBe(true);
    expect(parser.getTurns().length).toBe(4);
  });
});
