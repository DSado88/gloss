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
  deriveProjectNames,
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

  it("strips both anthropic/ prefix and date suffix together", () => {
    // Most common real-world format
    expect(shortenModel("anthropic/claude-3-5-sonnet-20241022")).toBe("3-5-sonnet");
    expect(shortenModel("anthropic/claude-opus-4-20250514")).toBe("opus-4");
  });

  it("handles newer model IDs with context annotations", () => {
    // claude-opus-4-6[1m] style — no date suffix, has bracket annotation
    expect(shortenModel("claude-opus-4-6")).toBe("opus-4-6");
    // With context annotation brackets — should preserve (not a date suffix)
    const result = shortenModel("claude-sonnet-4-6");
    expect(result).toBe("sonnet-4-6");
  });

  it("handles haiku models", () => {
    expect(shortenModel("claude-haiku-4-5-20251001")).toBe("haiku-4-5");
    expect(shortenModel("anthropic/claude-haiku-4-5-20251001")).toBe("haiku-4-5");
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

  it("escapes session IDs in client-side href and onclick attributes", () => {
    // Session IDs go directly into href="/c/{id}" and onclick="fn('{id}')"
    // in the client JS. A crafted ID with quotes or HTML could inject.
    const sessions: SessionRecord[] = [{
      id: 'x" onclick="alert(1)" x="',
      title: "Normal title",
      project: "/home/user/project",
      start_time: 1710000000,
      turn_count: 5,
    }];
    const html = buildServerIndex(sessions);

    // The ALL JSON should have the ID properly JSON-escaped
    const allMatch = html.match(/const ALL = (.*?);[\r\n]/s);
    expect(allMatch).not.toBeNull();
    const parsed = JSON.parse(allMatch![1].replace(/<\\\//g, "</"));
    // ID survives JSON round-trip
    expect(parsed[0].id).toBe('x" onclick="alert(1)" x="');

    // The client JS must not contain unescaped quotes from the ID in href/onclick
    // Check that the renderRecent/renderByProject functions use esc() for s.id
    // in href attributes — currently they DON'T, which is the bug.
    // After the fix, the esc() function will encode " as &quot; in HTML context.
    expect(html).toContain("esc(s.id)");
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
  it("falls back to dirProject when shortProject looks like a hash or KSUID", () => {
    const sessions: SessionRecord[] = [
      {
        id: "hash-test",
        // project ends in a 16-char hex hash → cleared by heuristic
        project: "/home/user/abcdef0123456789",
        jsonl_path: "/Users/test/.claude/projects/-Users-test-Documents-real-project/s.jsonl",
      },
      {
        id: "ksuid-test",
        // project ends in KSUID-like component → cleared
        project: "/home/user/01ABCDEFGHIJKLMNOP",
        jsonl_path: "/Users/test/.claude/projects/-Users-test-Documents-ksuid-proj/s.jsonl",
      },
      {
        id: "timestamp-test",
        // project ends in 10+ digit timestamp → cleared
        project: "/home/user/1710000000000",
      },
    ];
    const html = buildServerIndex(sessions);
    const allMatch = html.match(/const ALL = (.*?);[\r\n]/s);
    const parsed = JSON.parse(allMatch![1]);

    // Hash project → falls back to dirProject decoded from jsonl_path
    expect(parsed[0].project).toBe("real-project");
    // KSUID project → falls back to dirProject
    expect(parsed[1].project).toBe("ksuid-proj");
    // Timestamp project with no jsonl_path → empty fallback
    expect(parsed[2].project).toBe("");
  });

  it("embeds settings in the client JS block", () => {
    const sessions: SessionRecord[] = [{ id: "s1" }];
    const html = buildServerIndex(sessions, {
      embeddings_enabled: true,
      min_turns: 10,
    });
    const settingsMatch = html.match(/const SETTINGS = (.*?);[\r\n]/s);
    expect(settingsMatch).not.toBeNull();
    const settings = JSON.parse(settingsMatch![1]);
    expect(settings.embeddings_enabled).toBe(true);
    expect(settings.min_turns).toBe(10);
  });

  it("uses default settings when none provided", () => {
    const sessions: SessionRecord[] = [{ id: "s1" }];
    const html = buildServerIndex(sessions);
    const settingsMatch = html.match(/const SETTINGS = (.*?);[\r\n]/s);
    const settings = JSON.parse(settingsMatch![1]);
    expect(settings.embeddings_enabled).toBe(false);
    expect(settings.min_turns).toBe(0);
  });

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

describe("deriveProjectNames", () => {
  it("extracts friendly name from project path", () => {
    const result = deriveProjectNames("/Users/david/Documents/Programs/Grocery", null);
    expect(result.project).toBe("Grocery");
    expect(result.fullProject).toBe("/Users/david/Documents/Programs/Grocery");
  });

  it("extracts friendly name from jsonl_path when project is null", () => {
    const result = deriveProjectNames(null, "/Users/test/.claude/projects/-Users-test-Documents-Programs-TheGeneral/session.jsonl");
    expect(result.project).toBe("TheGeneral");
    expect(result.dirProject).toBe("TheGeneral");
  });

  it("prefers shortProject over dirProject", () => {
    const result = deriveProjectNames(
      "/Users/david/Documents/Programs/Grocery",
      "/Users/test/.claude/projects/-Users-test-Documents-Programs-OtherName/session.jsonl",
    );
    expect(result.project).toBe("Grocery");
  });

  it("falls back to dirProject when project ends in KSUID", () => {
    const result = deriveProjectNames(
      "/home/user/01ABCDEFGHIJKLMNOP",
      "/Users/test/.claude/projects/-Users-test-Documents-Programs-real-project/s.jsonl",
    );
    expect(result.project).toBe("real-project");
  });

  it("keeps project name that starts with digits but has non-digit suffix", () => {
    // A project named "1704067200-myproject" starts with 10+ digits but
    // is NOT a timestamp — it has a non-digit suffix. The timestamp regex
    // must use a $ anchor to avoid falsely matching this.
    const result = deriveProjectNames("/home/user/1704067200-myproject", null);
    expect(result.project).toBe("1704067200-myproject");
  });

  it("returns empty strings for null inputs", () => {
    const result = deriveProjectNames(null, null);
    expect(result.project).toBe("");
    expect(result.fullProject).toBe("");
    expect(result.dirProject).toBe("");
  });

  it("handles project path with only a trailing slash (root dir)", () => {
    const result = deriveProjectNames("/", null);
    // After stripping trailing slashes, path becomes "" → shortProject is ""
    expect(result.project).toBe("");
    expect(result.fullProject).toBe("/");
  });

  it("decodes ori/orchid temp dir paths in dirProject", () => {
    const result = deriveProjectNames(
      null,
      "/Users/test/.claude/projects/-private-tmp-ori-orchid-work-bidi-1771993919-746449/session.jsonl",
    );
    expect(result.dirProject).toBe("ori/orchid-bidi");
    expect(result.project).toBe("ori/orchid-bidi");
  });

  it("decodes ori/orchid var-folders paths (macOS /var/folders/XX/HASH/T/)", () => {
    // macOS /var/folders/ has 2 segments (XX, HASH) between "folders" and "T",
    // not 4. The encoded form is:
    //   -private-var-folders-<2char>-<hash>-T-ori-orchid-work-<project>-<timestamp>
    // Must produce "ori/orchid-<project>", not the full hash.
    const result = deriveProjectNames(
      null,
      "/Users/test/.claude/projects/-private-var-folders-6n-pxfdftt92gz067tt08tf1k6m0000gn-T-ori-orchid-work-bidi-1771993919-746449/session.jsonl",
    );
    expect(result.dirProject).toBe("ori/orchid-bidi");
    expect(result.project).toBe("ori/orchid-bidi");
  });

  it("non-orchid var-folders path does not include structural noise in dirProject", () => {
    // macOS /var/folders/XX/HASH/T/project-timestamp → encoded as:
    // -private-var-folders-6n-<hash>-T-<project>-<timestamp>
    // Bug: the backward loop finds "myproject" but parts.slice(2, i+1)
    // includes "folders-6n-hash-T-myproject" instead of just "myproject".
    const result = deriveProjectNames(
      null,
      "/Users/test/.claude/projects/-private-var-folders-6n-pxfdftt92gz067tt08tf1k6m0000gn-T-myproject-1234567890/session.jsonl",
    );
    // Should show "myproject", not "folders-6n-...-T-myproject"
    expect(result.dirProject).not.toContain("folders");
    expect(result.dirProject).toContain("myproject");
  });

  it("private-tmp with only hash segments does not return empty string", () => {
    // Bug: the backward loop used i >= 0, matching "tmp" at index 1.
    // parts.slice(2, 2) returns [] → join("") → empty string.
    // The loop should stop at i >= 2 to skip "private" and "tmp".
    const result = deriveProjectNames(
      null,
      "/Users/test/.claude/projects/-private-tmp-abc12345678/session.jsonl",
    );
    // With no meaningful non-hash segment after "private-tmp-", should fall
    // through to knownPrefixes or return the full stripped string — NOT "".
    expect(result.dirProject).not.toBe("");
  });

  it("handles Linux-style /home/ paths in dirProject (no crash, reasonable fallback)", () => {
    // decodeProjectDir only handles Users- prefixes (macOS). Linux paths
    // like -home-user-project should fall through without crashing, returning
    // the stripped string as the dirProject.
    const result = deriveProjectNames(
      null,
      "/home/user/.claude/projects/-home-user-my-project/session.jsonl",
    );
    // No special decoding for /home/ paths, so it returns the full stripped string
    expect(result.dirProject).toBe("home-user-my-project");
    // With no rawProject, falls back to dirProject
    expect(result.project).toBe("home-user-my-project");
  });

  it("handles Linux path with rawProject set (rawProject takes precedence)", () => {
    const result = deriveProjectNames(
      "/home/user/my-project",
      "/home/user/.claude/projects/-home-user-my-project/session.jsonl",
    );
    // rawProject's last segment "my-project" should be preferred
    expect(result.project).toBe("my-project");
    expect(result.fullProject).toBe("/home/user/my-project");
  });

  it("matches buildServerIndex output for same inputs", () => {
    // Verify deriveProjectNames produces the same result as buildServerIndex
    const sessions: SessionRecord[] = [{
      id: "consistency-test",
      project: "/Users/david/Documents/Programs/Grocery",
      jsonl_path: "/Users/test/.claude/projects/-Users-test-Documents-Programs-Grocery/s.jsonl",
    }];
    const html = buildServerIndex(sessions);
    const allMatch = html.match(/const ALL = (.*?);[\r\n]/s);
    const parsed = JSON.parse(allMatch![1]);

    const derived = deriveProjectNames(sessions[0].project, sessions[0].jsonl_path);
    expect(parsed[0].project).toBe(derived.project);
    expect(parsed[0].fullProject).toBe(derived.fullProject);
    expect(parsed[0].dirProject).toBe(derived.dirProject);
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

  it("parses CONVO_META with \\u003e escaping from convert.ts", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "convo-test-"));

    // Simulate the escaping that convert.ts does: > becomes \u003e
    const rawMeta = {
      session_id: "esc-test",
      short_id: "esc-test",
      project_dir: "/home/user/project-->name",
      model: "claude-3",
      start_time: "2024-06-01T12:00:00Z",
      turn_count: 5,
      user_turns: 2,
    };
    const safeMetaJson = JSON.stringify(rawMeta).replace(/>/g, "\\u003e");

    fs.writeFileSync(
      path.join(tmpDir, "esc-test.html"),
      `<!-- CONVO_META:${safeMetaJson} -->\n<html></html>`,
    );

    updateIndex(tmpDir);

    const content = fs.readFileSync(path.join(tmpDir, "index.html"), "utf-8");
    expect(content).toContain("1 sessions");
    // The project_dir should have the original > restored by JSON.parse
    expect(content).toContain("project--&gt;name");
  });

  it("ignores HTML files without CONVO_META comment", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "convo-test-"));

    // One file with meta, one without
    const meta = JSON.stringify({
      session_id: "real-one",
      short_id: "real",
      project_dir: "/tmp",
      model: "claude-3",
      start_time: "2024-06-01T12:00:00Z",
      turn_count: 5,
      user_turns: 2,
    });
    fs.writeFileSync(
      path.join(tmpDir, "real.html"),
      `<!-- CONVO_META:${meta} -->\n<html></html>`,
    );
    // Non-Gloss HTML file (no CONVO_META)
    fs.writeFileSync(
      path.join(tmpDir, "random.html"),
      "<html><body>Not a conversation</body></html>",
    );

    updateIndex(tmpDir);

    const content = fs.readFileSync(path.join(tmpDir, "index.html"), "utf-8");
    expect(content).toContain("1 sessions"); // only the one with meta
    expect(content).toContain("real");
  });

  it("escapes start_time in entry-time span (XSS via invalid timestamp fallback)", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "convo-test-"));

    // A malicious start_time that triggers the formatIndexTime fallback path
    // (invalid date → returns first 16 chars unescaped)
    const meta = JSON.stringify({
      session_id: "xss-time",
      short_id: "xss",
      project_dir: "/tmp",
      model: "claude-3",
      start_time: '<img src=x onerror=alert(1)>',
      turn_count: 1,
      user_turns: 1,
    });
    fs.writeFileSync(
      path.join(tmpDir, "xss-time.html"),
      `<!-- CONVO_META:${meta} -->\n<html></html>`,
    );

    updateIndex(tmpDir);

    const content = fs.readFileSync(path.join(tmpDir, "index.html"), "utf-8");
    // The entry-time span must NOT contain raw <img> tag
    expect(content).not.toContain("<img");
    // Should be HTML-escaped
    expect(content).toContain("&lt;img");
  });

  it("coerces turn_count/user_turns to numbers (XSS via crafted CONVO_META)", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "convo-test-"));

    // A crafted HTML file where turn_count is a string containing HTML
    const meta = JSON.stringify({
      session_id: "xss-turns",
      short_id: "xss",
      project_dir: "/tmp",
      model: "claude-3",
      start_time: "2024-01-01T00:00:00Z",
      turn_count: '<img src=x onerror=alert(1)>',
      user_turns: '<script>alert(2)</script>',
    });
    fs.writeFileSync(
      path.join(tmpDir, "xss-turns.html"),
      `<!-- CONVO_META:${meta} -->\n<html></html>`,
    );

    updateIndex(tmpDir);

    const content = fs.readFileSync(path.join(tmpDir, "index.html"), "utf-8");
    // Must NOT contain raw HTML from turn_count or user_turns
    expect(content).not.toContain("<img");
    expect(content).not.toContain("<script");
    // Should show a safe numeric value (0 or NaN, not the HTML payload)
    expect(content).toMatch(/\d+ turns \(\d+ user\)/);
  });

  it("produces empty-state when no conversation files exist", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "convo-test-"));

    updateIndex(tmpDir);

    const content = fs.readFileSync(path.join(tmpDir, "index.html"), "utf-8");
    expect(content).toContain("0 sessions");
    expect(content).toContain("No conversations rendered yet.");
  });
});

// ---------------------------------------------------------------------------
// Source toggle (MBP vs Studio)
// ---------------------------------------------------------------------------

describe("source toggle", () => {
  it("includes each session's source in the page data", () => {
    const html = buildServerIndex([
      { id: "s1", source_machine: "mbp" },
      { id: "s2", source_machine: "studio" },
    ] as any);
    expect(html).toContain('"source":"mbp"');
    expect(html).toContain('"source":"studio"');
  });

  it("renders the source chip container and toggle logic", () => {
    const html = buildServerIndex([{ id: "s1", source_machine: "mbp" }] as any);
    expect(html).toContain('id="sourceChips"');
    expect(html).toContain("buildSourceChips");
    expect(html).toContain("gloss_muted_sources");
    expect(html).toContain("toggleSource");
  });

  it("places the source row inside the settings menu, not the toolbar", () => {
    const html = buildServerIndex([{ id: "s1", source_machine: "mbp" }] as any);
    const settingsStart = html.indexOf('id="settingsDrop"');
    const settingsEnd = html.indexOf('id="settingSaved"');
    const sourceRow = html.indexOf('id="sourceRow"');
    const chips = html.indexOf('id="sourceChips"');
    expect(sourceRow).toBeGreaterThan(settingsStart);
    expect(sourceRow).toBeLessThan(settingsEnd);
    expect(chips).toBeGreaterThan(settingsStart);
    expect(chips).toBeLessThan(settingsEnd);
  });

  it("defaults source to empty string when unattributed", () => {
    const html = buildServerIndex([{ id: "s1" }] as any);
    expect(html).toContain('"source":""');
  });
});
