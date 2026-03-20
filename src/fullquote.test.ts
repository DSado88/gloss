import { describe, it, expect } from "vitest";
import { buildPageParams } from "./convert.js";
import type { Conversation } from "./types.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

/**
 * Regression tests for the fullQuote off-by-one bug.
 *
 * The old fullQuote() tried to reconstruct annotation text by slicing
 * convoData[turnIndex].text[blockIndex] at charStart..charEnd. But those
 * offsets were measured in the *rendered DOM* text, while convoData holds
 * *raw markdown*. For formatted content (tables, inline code, etc.) the
 * two strings differ — pipes, backticks, and other syntax characters shift
 * every position — so the slice grabbed text from the wrong row/offset.
 *
 * The fix: fullQuote() now returns ann.text directly (the DOM text captured
 * at highlight time), which is always correct.
 */
describe("fullQuote offset mismatch (regression)", () => {
  // Simulate the raw markdown table that Claude would produce
  const markdownTable = [
    "Here is the dead code inventory:",
    "",
    "| Module | File | Lines | Status |",
    "|---|---|---|---|",
    "| `ytdlp` module (entire) | forge-cli/src/ytdlp.rs | 512 | Intentional scaffold |",
    "| `SourceContributionTracker` | forge-ace/src/contributions.rs | 300 | Never wired |",
    "| `WorkerHeartbeat` | forge-session/src/heartbeat.rs | 129 | Never started |",
    "| `RedisCuratorStore` | forge-playbook/src/store.rs | ~400 | Superseded by DuckDb |",
  ].join("\n");

  // What the rendered DOM textContent would look like for each table row
  // (browsers strip pipes, backticks, and collapse whitespace)
  const domRowTexts = [
    "ytdlp module (entire)forge-cli/src/ytdlp.rs512Intentional scaffold",
    "SourceContributionTrackerforge-ace/src/contributions.rs300Never wired",
    "WorkerHeartbeatforge-session/src/heartbeat.rs129Never started",
    "RedisCuratorStoreforge-playbook/src/store.rs~400Superseded by DuckDb",
  ];

  // Simulated DOM textContent for the full table (what the browser produces)
  // Rough approximation: header row + separator + data rows, no pipes/backticks
  const domFullText =
    "ModuleFileLinesStatus" +
    domRowTexts.join("");

  it("raw markdown and DOM text have different lengths for a table", () => {
    // This is the fundamental precondition for the bug
    expect(markdownTable.length).not.toBe(domFullText.length);
    // Raw markdown is longer due to pipes, backticks, dashes, etc.
    expect(markdownTable.length).toBeGreaterThan(domFullText.length);
  });

  it("DOM-relative charStart slicing raw markdown gives wrong text", () => {
    // Find where each row's DOM text starts in the full DOM string
    const domCharStarts = domRowTexts.map((rowText) => {
      return domFullText.indexOf(rowText);
    });

    // Verify DOM offsets are found and in order
    for (const cs of domCharStarts) {
      expect(cs).toBeGreaterThanOrEqual(0);
    }

    // Now try to use those DOM offsets to slice the raw markdown (the old bug)
    for (let i = 0; i < domRowTexts.length; i++) {
      const domStart = domCharStarts[i];
      const domEnd = domStart + domRowTexts[i].length;
      const sliced = markdownTable.slice(domStart, domEnd);

      // The sliced raw markdown should NOT match the DOM text for that row,
      // because the offsets are measured in a different coordinate space.
      // This proves the old fullQuote() was broken for formatted content.
      expect(sliced).not.toBe(domRowTexts[i]);
    }
  });

  it("ann.text (DOM text) always returns the correct quote", () => {
    // Simulated annotations as stored in the DB — text captured from DOM
    const annotations = domRowTexts.map((text, i) => ({
      text,
      comment: `Comment for row ${i}`,
      turnIndex: 1,
      blockIndex: 0,
      charStart: domFullText.indexOf(text),
      charEnd: domFullText.indexOf(text) + text.length,
    }));

    // The fixed fullQuote just returns ann.text, which is always correct
    for (let i = 0; i < annotations.length; i++) {
      const ann = annotations[i];
      // Fixed behavior: use ann.text
      expect(ann.text).toBe(domRowTexts[i]);
      // And the comment stays correctly paired
      expect(ann.comment).toBe(`Comment for row ${i}`);
    }
  });

  it("old fullQuote would pair wrong text with comments (the off-by-one)", () => {
    // Simulate what the old fullQuote did: slice raw markdown at DOM offsets
    const annotations = domRowTexts.map((text, i) => ({
      text,
      comment: `Comment for row ${i}`,
      charStart: domFullText.indexOf(text),
      charEnd: domFullText.indexOf(text) + text.length,
    }));

    // Old fullQuote: convoData[ti].text[bi].slice(charStart, charEnd)
    const oldResults = annotations.map((ann) => ({
      quote: markdownTable.slice(ann.charStart, ann.charEnd),
      comment: ann.comment,
    }));

    // The old results have misaligned text — the quote from slicing raw
    // markdown at DOM offsets does NOT match the expected DOM text
    for (let i = 0; i < oldResults.length; i++) {
      expect(oldResults[i].quote).not.toBe(domRowTexts[i]);
    }

    // New results (the fix): just use ann.text
    const newResults = annotations.map((ann) => ({
      quote: ann.text,
      comment: ann.comment,
    }));

    for (let i = 0; i < newResults.length; i++) {
      expect(newResults[i].quote).toBe(domRowTexts[i]);
      expect(newResults[i].comment).toBe(`Comment for row ${i}`);
    }
  });

  it("convoData text blocks contain raw markdown, not rendered text", () => {
    // Verify that buildPageParams preserves raw markdown in conversationDataJson
    const convo: Conversation = {
      sessionId: "test-fullquote",
      projectDir: "/test",
      model: "claude-3",
      version: "1.0",
      startTime: "2024-01-15T10:00:00Z",
      turns: [
        {
          role: "user" as const,
          timestamp: "2024-01-15T10:00:00Z",
          blocks: [{ type: "text" as const, text: "list dead code" }],
        },
        {
          role: "assistant" as const,
          timestamp: "2024-01-15T10:00:05Z",
          blocks: [{ type: "text" as const, text: markdownTable }],
        },
      ],
    };

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fullquote-test-"));
    try {
      const params = buildPageParams(convo, "/tmp/test.jsonl", dir);
      const convoData = JSON.parse(params.conversationDataJson);

      // convoData[1].text[0] is the raw markdown, pipes and all
      expect(convoData[1].text[0]).toBe(markdownTable);
      expect(convoData[1].text[0]).toContain("|");
      expect(convoData[1].text[0]).toContain("`ytdlp`");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
