import { describe, it, expect } from "vitest";
import {
  formatTimestamp,
  renderToolUse,
  renderToolResult,
  renderTurn,
} from "./renderer.js";
import type {
  Turn,
  ToolUseBlock,
  ToolResultBlock,
} from "./types.js";

// ---------------------------------------------------------------------------
// formatTimestamp
// ---------------------------------------------------------------------------
describe("formatTimestamp", () => {
  it("formats a valid ISO timestamp to 12-hour local time", () => {
    // Use a fixed UTC time so the result is predictable when converted to local
    const result = formatTimestamp("2024-03-15T14:30:00+00:00");
    // Should produce a time string matching H:MM AM/PM pattern
    expect(result).toMatch(/^\d{1,2}:\d{2}\s[AP]M$/);
  });

  it("handles Z suffix", () => {
    const result = formatTimestamp("2024-03-15T14:30:00Z");
    expect(result).toMatch(/^\d{1,2}:\d{2}\s[AP]M$/);
  });

  it("returns empty string for invalid timestamp", () => {
    expect(formatTimestamp("not-a-date")).toBe("");
  });

  it("returns empty string for empty input", () => {
    expect(formatTimestamp("")).toBe("");
  });

  it("does not produce a leading zero on the hour", () => {
    // 5 AM UTC — regardless of timezone, the hour should not have a leading zero
    const result = formatTimestamp("2024-03-15T05:05:00Z");
    expect(result).not.toMatch(/^0/);
  });
});

// ---------------------------------------------------------------------------
// renderToolUse
// ---------------------------------------------------------------------------
describe("renderToolUse", () => {
  it("renders Read tool with file_path summary", () => {
    const block: ToolUseBlock = {
      type: "tool_use",
      name: "Read",
      input: { file_path: "/src/index.ts" },
    };
    const html = renderToolUse(block);
    expect(html).toContain("tool-use");
    expect(html).toContain("Read");
    expect(html).toContain("/src/index.ts");
    expect(html).toContain("&#9881;"); // gear icon
    expect(html).toContain("tool-detail");
  });

  it("renders Bash tool with description summary", () => {
    const block: ToolUseBlock = {
      type: "tool_use",
      name: "Bash",
      input: { command: "ls -la /tmp", description: "List temp files" },
    };
    const html = renderToolUse(block);
    expect(html).toContain("Bash");
    expect(html).toContain("List temp files");
    // Summary should use description, not command
    expect(html).toContain('<span class="tool-summary">List temp files</span>');
  });

  it("renders Bash tool with command when no description", () => {
    const block: ToolUseBlock = {
      type: "tool_use",
      name: "Bash",
      input: { command: "echo hello" },
    };
    const html = renderToolUse(block);
    expect(html).toContain("echo hello");
  });

  it("renders Edit tool with file_path summary", () => {
    const block: ToolUseBlock = {
      type: "tool_use",
      name: "Edit",
      input: { file_path: "/src/app.ts", old_string: "a", new_string: "b" },
    };
    const html = renderToolUse(block);
    expect(html).toContain("Edit");
    expect(html).toContain("/src/app.ts");
  });

  it("renders Write tool with file_path summary", () => {
    const block: ToolUseBlock = {
      type: "tool_use",
      name: "Write",
      input: { file_path: "/src/new.ts", content: "hello" },
    };
    const html = renderToolUse(block);
    expect(html).toContain("Write");
    expect(html).toContain("/src/new.ts");
  });

  it("renders Agent tool with description summary", () => {
    const block: ToolUseBlock = {
      type: "tool_use",
      name: "Agent",
      input: { description: "Search for patterns in the codebase" },
    };
    const html = renderToolUse(block);
    expect(html).toContain("Agent");
    expect(html).toContain("Search for patterns in the codebase");
  });

  it("renders unknown tool with first meaningful field", () => {
    const block: ToolUseBlock = {
      type: "tool_use",
      name: "CustomTool",
      input: { query: "find something" },
    };
    const html = renderToolUse(block);
    expect(html).toContain("CustomTool");
    expect(html).toContain("find something");
  });

  it("includes collapsed detail with full JSON input", () => {
    const block: ToolUseBlock = {
      type: "tool_use",
      name: "Read",
      input: { file_path: "/test.ts", offset: 10 },
    };
    const html = renderToolUse(block);
    expect(html).toContain("tool-detail");
    expect(html).toContain("&quot;file_path&quot;");
    expect(html).toContain("&quot;/test.ts&quot;");
  });

  it("renders Glob tool with pattern summary", () => {
    const block: ToolUseBlock = {
      type: "tool_use",
      name: "Glob",
      input: { pattern: "**/*.ts" },
    };
    const html = renderToolUse(block);
    expect(html).toContain("Glob");
    expect(html).toContain("**/*.ts");
  });

  it("renders Grep tool with pattern summary", () => {
    const block: ToolUseBlock = {
      type: "tool_use",
      name: "Grep",
      input: { pattern: "TODO", path: "/src" },
    };
    const html = renderToolUse(block);
    expect(html).toContain("Grep");
    // Grep uses pattern first (via file_path ?? pattern ?? path)
    expect(html).toContain("TODO");
  });
});

// ---------------------------------------------------------------------------
// renderToolResult
// ---------------------------------------------------------------------------
describe("renderToolResult", () => {
  it("renders short result inline", () => {
    const block: ToolResultBlock = {
      type: "tool_result",
      content: "File contents here",
    };
    const html = renderToolResult(block);
    expect(html).toContain("tool-result");
    expect(html).toContain("File contents here");
    expect(html).toContain("Result");
    expect(html).toContain("&#9654;"); // play icon
    expect(html).not.toContain("tool-error");
  });

  it("renders long result with preview and full content", () => {
    // Start with { so it doesn't get treated as agent result
    const longContent = "{" + "x".repeat(2999);
    const block: ToolResultBlock = {
      type: "tool_result",
      content: longContent,
    };
    const html = renderToolResult(block);
    expect(html).toContain("tool-result-preview");
    expect(html).toContain("tool-result-full");
    expect(html).toContain("3,000 chars");
    // Preview should be first 2000 chars + ellipsis
    expect(html).toContain("\u2026"); // ellipsis character
  });

  it("counts emoji as single code points, not UTF-16 pairs, in char display", () => {
    // "😀" is 1 code point but 2 UTF-16 code units (.length = 2)
    // 2500 emoji = 2500 code points (correct) vs 5000 .length (wrong)
    const emojiContent = "{" + "😀".repeat(2500);
    const block: ToolResultBlock = {
      type: "tool_result",
      content: emojiContent,
    };
    const html = renderToolResult(block);
    // Should show 2,501 (code points), not 5,001 (.length)
    expect(html).toContain("2,501 chars");
    expect(html).not.toContain("5,001");
    // Preview should use codePointSlice, keeping emoji intact
    expect(html).toContain("tool-result-preview");
  });

  it("renders agent result (>500 chars, not JSON) as markdown", () => {
    const agentContent = "This is a detailed report about the findings.\n".repeat(20);
    const block: ToolResultBlock = {
      type: "tool_result",
      content: agentContent,
    };
    const html = renderToolResult(block);
    expect(html).toContain("agent-result");
    expect(html).toContain("tool-result-rendered");
    expect(html).toContain("chars)");
  });

  it("does not render JSON-starting content as agent result", () => {
    const jsonContent = '{"key": "value"}' + "x".repeat(600);
    const block: ToolResultBlock = {
      type: "tool_result",
      content: jsonContent,
    };
    const html = renderToolResult(block);
    expect(html).not.toContain("agent-result");
  });

  it("renders error result with tool-error class", () => {
    const block: ToolResultBlock = {
      type: "tool_result",
      content: "Command failed with exit code 1",
      isError: true,
    };
    const html = renderToolResult(block);
    expect(html).toContain("tool-error");
    expect(html).toContain("Error");
  });

  it("includes meta when provided", () => {
    const block: ToolResultBlock = {
      type: "tool_result",
      content: "result data",
      meta: "Duration: 1.5s",
    };
    const html = renderToolResult(block);
    expect(html).toContain("tool-result-meta");
    expect(html).toContain("Duration: 1.5s");
  });
});

// ---------------------------------------------------------------------------
// renderTurn
// ---------------------------------------------------------------------------
describe("renderTurn", () => {
  it("renders a text-only user turn", () => {
    const turn: Turn = {
      role: "user",
      timestamp: "2024-03-15T10:00:00Z",
      blocks: [{ type: "text", text: "Hello, Claude!" }],
    };
    const { html, tocEntry } = renderTurn(turn, 0, true, true);
    expect(html).toContain('class="turn user"');
    expect(html).toContain('id="turn-0"');
    expect(html).toContain("You");
    expect(html).toContain("Hello, Claude!");
    expect(html).toContain("message-text");
    expect(tocEntry).not.toBeNull();
  });

  it("renders an assistant turn with Claude label", () => {
    const turn: Turn = {
      role: "assistant",
      blocks: [{ type: "text", text: "I can help with that." }],
    };
    const { html, tocEntry } = renderTurn(turn, 1, true, true);
    expect(html).toContain('class="turn assistant"');
    expect(html).toContain("Claude");
    expect(tocEntry).not.toBeNull();
    expect(tocEntry!.label).toBe("Claude");
  });

  it("renders turn with tool use and result", () => {
    const turn: Turn = {
      role: "assistant",
      blocks: [
        { type: "text", text: "Let me check." },
        {
          type: "tool_use",
          name: "Read",
          input: { file_path: "/src/app.ts" },
        },
        { type: "tool_result", content: "file contents" },
      ],
    };
    const { html } = renderTurn(turn, 2, true, true);
    expect(html).toContain("tool-use");
    expect(html).toContain("tool-result");
    expect(html).toContain("Let me check.");
  });

  it("renders turn with thinking block when includeThinking is true", () => {
    const turn: Turn = {
      role: "assistant",
      blocks: [
        { type: "thinking", text: "I need to analyze this carefully." },
        { type: "text", text: "Here is my answer." },
      ],
    };
    const { html } = renderTurn(turn, 3, true, true);
    expect(html).toContain("thinking");
    expect(html).toContain("I need to analyze this carefully.");
  });

  it("hides thinking when includeThinking is false", () => {
    const turn: Turn = {
      role: "assistant",
      blocks: [
        { type: "thinking", text: "Secret thoughts." },
        { type: "text", text: "Public response." },
      ],
    };
    const { html } = renderTurn(turn, 4, false, true);
    expect(html).not.toContain("Secret thoughts.");
    expect(html).toContain("Public response.");
  });

  it("hides tools when includeTools is false", () => {
    const turn: Turn = {
      role: "assistant",
      blocks: [
        { type: "text", text: "Let me check." },
        {
          type: "tool_use",
          name: "Read",
          input: { file_path: "/test.ts" },
        },
        { type: "tool_result", content: "content" },
      ],
    };
    const { html } = renderTurn(turn, 5, true, false);
    expect(html).not.toContain("tool-use");
    expect(html).not.toContain("tool-result");
    expect(html).toContain("Let me check.");
  });

  it("generates TOC entry for user turns", () => {
    const turn: Turn = {
      role: "user",
      timestamp: "2024-03-15T10:00:00Z",
      blocks: [{ type: "text", text: "What is the meaning of life?" }],
    };
    const { tocEntry } = renderTurn(turn, 7, true, true);
    expect(tocEntry).not.toBeNull();
    expect(tocEntry!.id).toBe("turn-7");
    expect(tocEntry!.role).toBe("user");
    expect(tocEntry!.label).toBe("You");
    expect(tocEntry!.preview).toBe("What is the meaning of life?");
  });

  it("generates TOC entry for assistant turns too", () => {
    const turn: Turn = {
      role: "assistant",
      blocks: [{ type: "text", text: "Here is my response." }],
    };
    const { tocEntry } = renderTurn(turn, 8, true, true);
    expect(tocEntry).not.toBeNull();
    expect(tocEntry!.role).toBe("assistant");
  });

  it("truncates TOC preview to 120 characters", () => {
    const longText = "A".repeat(200);
    const turn: Turn = {
      role: "user",
      blocks: [{ type: "text", text: longText }],
    };
    const { tocEntry } = renderTurn(turn, 9, true, true);
    expect(tocEntry).not.toBeNull();
    expect(tocEntry!.preview.length).toBeLessThanOrEqual(120);
  });

  it("sets data-block-index attributes on text blocks", () => {
    const turn: Turn = {
      role: "assistant",
      blocks: [
        { type: "text", text: "First paragraph." },
        { type: "text", text: "Second paragraph." },
        { type: "text", text: "Third paragraph." },
      ],
    };
    const { html } = renderTurn(turn, 10, true, true);
    expect(html).toContain('data-block-index="0"');
    expect(html).toContain('data-block-index="1"');
    expect(html).toContain('data-block-index="2"');
  });

  it("returns empty html for turns with no visible content", () => {
    const turn: Turn = {
      role: "assistant",
      blocks: [{ type: "thinking", text: "hidden thoughts" }],
    };
    const { html, tocEntry } = renderTurn(turn, 11, false, true);
    expect(html).toBe("");
    expect(tocEntry).toBeNull();
  });

  it("renders slash_command blocks", () => {
    const turn: Turn = {
      role: "user",
      blocks: [{ type: "slash_command", command: "/help" }],
    };
    const { html, tocEntry } = renderTurn(turn, 12, true, true);
    expect(html).toContain("slash-command");
    expect(html).toContain("/help");
    expect(tocEntry!.preview).toBe("/help");
  });

  it("renders session_continuation blocks", () => {
    const turn: Turn = {
      role: "user",
      blocks: [
        { type: "session_continuation", text: "Previous context summary" },
      ],
    };
    const { html, tocEntry } = renderTurn(turn, 13, true, true);
    expect(html).toContain("session-divider");
    expect(html).toContain("Session continued");
    expect(html).toContain("Previous context summary");
    expect(tocEntry!.preview).toBe("--- Session continued ---");
  });

  it("includes timestamp in the header when available", () => {
    const turn: Turn = {
      role: "user",
      timestamp: "2024-03-15T10:00:00Z",
      blocks: [{ type: "text", text: "Hi" }],
    };
    const { html } = renderTurn(turn, 14, true, true);
    expect(html).toContain('class="timestamp"');
  });

  it("omits timestamp span when timestamp is not available", () => {
    const turn: Turn = {
      role: "user",
      blocks: [{ type: "text", text: "Hi" }],
    };
    const { html } = renderTurn(turn, 15, true, true);
    // The timestamp span should be empty string, resulting in just whitespace
    expect(html).not.toContain('class="timestamp"');
  });

  it("text block index only increments for text blocks, not other types", () => {
    const turn: Turn = {
      role: "assistant",
      blocks: [
        { type: "text", text: "First text." },
        {
          type: "tool_use",
          name: "Read",
          input: { file_path: "/test.ts" },
        },
        { type: "tool_result", content: "result" },
        { type: "text", text: "Second text." },
      ],
    };
    const { html } = renderTurn(turn, 16, true, true);
    expect(html).toContain('data-block-index="0"');
    expect(html).toContain('data-block-index="1"');
    // Should not have index 2 for text blocks
    expect(html).not.toContain('data-block-index="2"');
  });

  it("renders turn with only tool blocks and produces empty TOC preview", () => {
    const turn: Turn = {
      role: "assistant",
      timestamp: "2024-03-15T10:00:00Z",
      blocks: [
        { type: "tool_use", name: "Read", input: { file_path: "/src/app.ts" } },
        { type: "tool_result", content: "file contents here" },
      ],
    };
    const { html, tocEntry } = renderTurn(turn, 5, true, true);
    // Turn should render (tool blocks are visible)
    expect(html).toContain("tool-use");
    expect(html).toContain("tool-result");
    // TOC preview should be empty (no text blocks to extract preview from)
    expect(tocEntry).not.toBeNull();
    expect(tocEntry!.preview).toBe("");
  });

  it("shows date divider when date changes from previous turn", () => {
    const turn: Turn = {
      role: "user",
      timestamp: "2024-03-16T08:00:00Z",
      blocks: [{ type: "text", text: "Good morning" }],
    };
    const { html } = renderTurn(turn, 1, true, true, "2024-03-15T22:00:00Z");
    expect(html).toContain("date-divider");
  });

  it("omits date divider when date is same as previous turn", () => {
    const turn: Turn = {
      role: "assistant",
      timestamp: "2024-03-15T22:30:00Z",
      blocks: [{ type: "text", text: "Hello" }],
    };
    const { html } = renderTurn(turn, 1, true, true, "2024-03-15T22:00:00Z");
    expect(html).not.toContain("date-divider");
  });

  it("omits date divider when timestamp is missing", () => {
    const turn: Turn = {
      role: "user",
      blocks: [{ type: "text", text: "No timestamp" }],
    };
    const { html } = renderTurn(turn, 0, true, true);
    expect(html).not.toContain("date-divider");
  });
});
