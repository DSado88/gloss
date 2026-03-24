import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

describe("mcp-server source integrity", () => {
  const src = fs.readFileSync(
    path.join(import.meta.dir, "mcp-server.ts"),
    "utf-8",
  );

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
