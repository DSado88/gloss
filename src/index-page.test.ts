import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  shortenModel,
  formatIndexTime,
  buildIndexPage,
  buildServerIndex,
  updateIndex,
} from "./index-page.js";
import type { SessionRecord } from "./db.js";

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

describe("buildServerIndex", () => {
  it("handles sessions with minimal/null fields without crashing", () => {
    // Sessions discovered before metadata backfill have mostly null fields
    const sessions: SessionRecord[] = [
      { id: "minimal-1" },
      { id: "minimal-2", jsonl_path: null, project: null, model: null, start_time: null, turn_count: null },
    ];
    const html = buildServerIndex(sessions);
    expect(html).toContain("<!DOCTYPE html>");
    // The JSON should parse correctly with default fallback values
    const allMatch = html.match(/const ALL = (.*?);[\r\n]/s);
    expect(allMatch).not.toBeNull();
    const parsed = JSON.parse(allMatch![1]);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].id).toBe("minimal-1");
    expect(parsed[0].turn_count).toBe(0);
    expect(parsed[1].project).toBe("");
  });

  it("does not embed raw </ in inline script JSON (prevents XSS via </script>)", () => {
    const sessions: SessionRecord[] = [{
      id: "xss-test",
      title: '</script><img src=x onerror=alert(1)>',
      project: "/home/user/project",
      model: "claude-3",
      start_time: 1710000000,
      turn_count: 5,
    }];
    const html = buildServerIndex(sessions);
    // Find the JSON embedded after "const ALL ="
    const allMatch = html.match(/const ALL = (.*?);[\r\n]/s);
    expect(allMatch).not.toBeNull();
    // The JSON must not contain </ which could close the script tag
    expect(allMatch![1]).not.toContain("</");
  });
});

describe("buildServerIndex project decoding", () => {
  it("decodes project from jsonl_path with hyphenated username", () => {
    const sessions: SessionRecord[] = [{
      id: "hyph-test",
      jsonl_path: "/Users/jean-paul/.claude/projects/-Users-jean-paul-Documents-Programs-myapp/session.jsonl",
    }];
    const html = buildServerIndex(sessions);
    const allMatch = html.match(/const ALL = (.*?);[\r\n]/s);
    const parsed = JSON.parse(allMatch![1]);
    // Should decode to "myapp", NOT "paul-Documents-Programs-myapp"
    expect(parsed[0].dirProject).toBe("myapp");
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

  it("escapes special chars in filenames for href attributes", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "convo-test-"));

    const meta = JSON.stringify({
      session_id: "inject-test",
      short_id: "inject",
      project_dir: "/tmp",
      model: "claude-3",
      start_time: "2024-01-01T12:00:00Z",
      turn_count: 1,
      user_turns: 1,
    });

    // File with " in name that could break the href attribute and inject handlers
    const evilName = 'test" onmouseover="alert(1).html';
    fs.writeFileSync(
      path.join(tmpDir, evilName),
      `<!-- CONVO_META:${meta} -->\n<html></html>`,
    );

    updateIndex(tmpDir);

    const content = fs.readFileSync(path.join(tmpDir, "index.html"), "utf-8");
    // The " in the filename must be &quot; — no attribute injection possible
    // Check that the real " doesn't appear as an attribute delimiter
    expect(content).not.toContain('onmouseover="alert');
  });

  it("produces empty-state when no conversation files exist", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "convo-test-"));

    updateIndex(tmpDir);

    const content = fs.readFileSync(path.join(tmpDir, "index.html"), "utf-8");
    expect(content).toContain("0 sessions");
    expect(content).toContain("No conversations rendered yet.");
  });
});
