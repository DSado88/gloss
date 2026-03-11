import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  shortenModel,
  formatIndexTime,
  buildIndexPage,
  updateIndex,
} from "./index-page.js";

describe("shortenModel", () => {
  it("strips claude- prefix and date suffix", () => {
    expect(shortenModel("claude-3-5-sonnet-20241022")).toBe("3-5-sonnet");
  });

  it("strips claude- prefix with date suffix", () => {
    expect(shortenModel("claude-opus-4-20250514")).toBe("opus-4");
  });

  it("strips anthropic/ prefix", () => {
    expect(shortenModel("anthropic/claude-3-haiku")).toBe("3-haiku");
  });

  it("handles model with no prefix or suffix", () => {
    expect(shortenModel("gpt-4")).toBe("gpt-4");
  });

  it("returns em dash for empty string", () => {
    expect(shortenModel("")).toBe("\u2014");
  });
});

describe("formatIndexTime", () => {
  it("formats a valid ISO timestamp", () => {
    // Use a fixed timezone-independent check: the output should contain expected components
    const result = formatIndexTime("2024-10-22T14:30:00Z");
    // Should match pattern "Mon DD, YYYY H:MM AM/PM"
    expect(result).toMatch(/^\w{3} \d{2}, \d{4} \d{1,2}:\d{2} [AP]M$/);
  });

  it("returns empty string for empty input", () => {
    expect(formatIndexTime("")).toBe("");
  });

  it("returns first 16 chars for invalid timestamp", () => {
    expect(formatIndexTime("not-a-valid-time-stamp")).toBe("not-a-valid-time");
  });
});

describe("buildIndexPage", () => {
  it("produces valid HTML with expected structure", () => {
    const entriesHtml = '<div class="index-list">test</div>';
    const html = buildIndexPage(entriesHtml, 5);

    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("<title>Claude Conversations</title>");
    expect(html).toContain("5 sessions");
    expect(html).toContain('<div class="index-list">test</div>');
    expect(html).toContain("fonts.googleapis.com");
    expect(html).toContain("Inter");
  });

  it("includes responsive CSS", () => {
    const html = buildIndexPage("", 0);
    expect(html).toContain("@media (max-width: 700px)");
    expect(html).toContain("prefers-color-scheme: light");
  });
});

describe("updateIndex", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("generates index.html from mock HTML files with CONVO_META", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "convo-test-"));

    const meta1 = JSON.stringify({
      session_id: "aaa-111",
      short_id: "aaa",
      project_dir: "/home/user/projects/myapp",
      model: "claude-3-5-sonnet-20241022",
      start_time: "2024-10-22T14:30:00Z",
      turn_count: 10,
      user_turns: 5,
    });

    const meta2 = JSON.stringify({
      session_id: "bbb-222",
      short_id: "bbb",
      project_dir: "/home/user/work/api-server",
      model: "claude-opus-4-20250514",
      start_time: "2025-05-14T09:00:00Z",
      turn_count: 20,
      user_turns: 8,
    });

    fs.writeFileSync(
      path.join(tmpDir, "aaa-111.html"),
      `<!-- CONVO_META:${meta1} -->\n<html><body>convo aaa</body></html>`,
    );
    fs.writeFileSync(
      path.join(tmpDir, "bbb-222.html"),
      `<!-- CONVO_META:${meta2} -->\n<html><body>convo bbb</body></html>`,
    );

    updateIndex(tmpDir);

    const indexPath = path.join(tmpDir, "index.html");
    expect(fs.existsSync(indexPath)).toBe(true);

    const content = fs.readFileSync(indexPath, "utf-8");
    expect(content).toContain("2 sessions");
    // bbb should appear first (more recent start_time)
    const bbbPos = content.indexOf("bbb");
    const aaaPos = content.indexOf("aaa");
    expect(bbbPos).toBeLessThan(aaaPos);

    expect(content).toContain("3-5-sonnet");
    expect(content).toContain("opus-4");
    expect(content).toContain("projects/myapp");
    expect(content).toContain("work/api-server");
    expect(content).toContain("10 turns (5 user)");
    expect(content).toContain("20 turns (8 user)");
  });

  it("skips existing index.html when scanning", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "convo-test-"));

    // Write a stale index.html that should be overwritten, not read as an entry
    fs.writeFileSync(path.join(tmpDir, "index.html"), "<html>old</html>");

    const meta = JSON.stringify({
      session_id: "ccc-333",
      short_id: "ccc",
      project_dir: "/tmp/proj",
      model: "anthropic/claude-3-haiku",
      start_time: "2024-06-01T12:00:00Z",
      turn_count: 3,
      user_turns: 1,
    });
    fs.writeFileSync(
      path.join(tmpDir, "ccc-333.html"),
      `<!-- CONVO_META:${meta} -->\n<html></html>`,
    );

    updateIndex(tmpDir);

    const content = fs.readFileSync(path.join(tmpDir, "index.html"), "utf-8");
    expect(content).toContain("1 sessions");
    expect(content).toContain("ccc");
    expect(content).toContain("3-haiku");
  });

  it("produces empty-state when no conversation files exist", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "convo-test-"));

    updateIndex(tmpDir);

    const content = fs.readFileSync(path.join(tmpDir, "index.html"), "utf-8");
    expect(content).toContain("0 sessions");
    expect(content).toContain("No conversations rendered yet.");
  });
});
