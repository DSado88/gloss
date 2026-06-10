import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

describe("mcp-server source integrity", () => {
  const src = fs.readFileSync(
    path.join(import.meta.dir, "mcp-server.ts"),
    "utf-8",
  );

  it("all tool handlers use glossFetch/glossPost, not raw fetch()", () => {
    // Raw fetch() misses the timeout, connection-refused detection, and
    // proper error messages that glossFetch provides.
    const toolSections = [...src.matchAll(/server\.tool\(\s*"(\w+)"[\s\S]*?\n\);/g)];
    expect(toolSections.length).toBeGreaterThanOrEqual(5);
    for (const m of toolSections) {
      const name = m[1];
      const body = m[0];
      const usesHelper = body.includes("glossFetch") || body.includes("glossPost");
      const usesRawFetch = /\bfetch\(/.test(body);
      expect(usesHelper).toBe(true);
      expect(usesRawFetch).toBe(false);
    }
  });

  it("read_conversation clamps end to MAX_READ_WINDOW to prevent context blowout", () => {
    // The read_conversation handler must clamp endTurn so a single call
    // can't dump an entire 1000-turn conversation into context.
    const readSection = src.match(
      /server\.tool\(\s*"read_conversation"[\s\S]*?\n\);/,
    );
    expect(readSection).not.toBeNull();
    expect(readSection![0]).toContain("MAX_READ_WINDOW");
    expect(readSection![0]).toContain("Math.min");
  });

  it("search_conversations passes maxSources to API", () => {
    // Without maxSources, the API returns default 6. The tool should
    // forward the user's requested count.
    const searchSection = src.match(
      /server\.tool\(\s*"search_conversations"[\s\S]*?\n\);/,
    );
    expect(searchSection).not.toBeNull();
    expect(searchSection![0]).toContain("maxSources");
  });

  it("list_tags uses GLOSS_URL, not undeclared BASE variable", () => {
    // Bug: list_tags handler used `${BASE}/api/tags` but BASE is never declared.
    // GLOSS_URL is the correct variable (defined at the top of the file).
    // At runtime, BASE throws ReferenceError, making list_tags completely broken.
    expect(src).not.toMatch(/\bBASE\b/);
    // Should use either glossFetch or GLOSS_URL
    expect(src).toMatch(/GLOSS_URL|glossFetch/);
  });

  it("list_tags uses glossFetch for consistent error handling", () => {
    // All other tools use glossFetch which provides timeout, connection-refused
    // detection, and proper error messages. list_tags should too.
    // Find the list_tags tool definition and check it uses glossFetch
    const listTagsSection = src.match(
      /server\.tool\(\s*"list_tags"[\s\S]*?\n\);/,
    );
    expect(listTagsSection).not.toBeNull();
    expect(listTagsSection![0]).toContain("glossFetch");
    expect(listTagsSection![0]).not.toMatch(/\bfetch\(/);
  });
});

describe("sync-before-read", () => {
  const src = fs.readFileSync(
    path.join(import.meta.dir, "mcp-server.ts"),
    "utf-8",
  );

  it("defines a debounced GLOSS_SYNC_CMD hook that triggers a server rescan", () => {
    // When the laptop queries the Studio, its freshest logs must be pushed
    // first (rsync) and the Studio told to rescan, or new sessions are
    // invisible until the next timer tick.
    expect(src).toContain("GLOSS_SYNC_CMD");
    expect(src).toContain("syncBeforeRead");
    expect(src).toContain("SYNC_DEBOUNCE_MS");
    expect(src).toMatch(/\/api\/scan/);
  });

  it("every tool handler awaits syncBeforeRead as step one", () => {
    const toolSections = [...src.matchAll(/server\.tool\(\s*"(\w+)"[\s\S]*?\n\);/g)];
    expect(toolSections.length).toBeGreaterThanOrEqual(5);
    for (const m of toolSections) {
      expect(m[0]).toContain("await syncBeforeRead()");
    }
  });
});
