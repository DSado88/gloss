import { describe, it, expect } from "vitest";
import { decodeProjectPath, buildMemoryPage } from "./tool-viewer.js";

describe("decodeProjectPath", () => {
  it("returns null for string not starting with -", () => {
    expect(decodeProjectPath("Users-david-project")).toBeNull();
    expect(decodeProjectPath("")).toBeNull();
    expect(decodeProjectPath("some-project")).toBeNull();
  });

  it("returns null when first segment is not a known root", () => {
    // "var", "Users", "home" etc. are known roots. "Documents" is not.
    expect(decodeProjectPath("-Documents-Programs-test")).toBeNull();
    expect(decodeProjectPath("-foo-bar-baz")).toBeNull();
  });

  it("returns null for paths that do not exist on disk", () => {
    // Even with valid root prefix, nonexistent paths return null
    expect(decodeProjectPath("-Users-nonexistent_user_xyzzy_99-project")).toBeNull();
    expect(decodeProjectPath("-home-nobody_xyzzy_99-project")).toBeNull();
  });

  it("handles single-segment encoded paths", () => {
    // "-Users" → tries to decode to /Users (which exists on macOS)
    // This may return "/Users" or null depending on platform
    const result = decodeProjectPath("-Users");
    // On macOS, /Users exists → returns "/Users"
    // On Linux, /Users may not exist → returns null
    expect(result === "/Users" || result === null).toBe(true);
  });
});

describe("buildMemoryPage", () => {
  it("returns valid HTML without crashing, even with no memory files", () => {
    // buildMemoryPage reads from ~/.claude/projects/ which may or may not exist.
    // Either way, it should return valid HTML without throwing.
    const html = buildMemoryPage();
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("<title>Gloss");
    // Should contain either memory content or the empty state
    expect(
      html.includes("memory-content") || html.includes("No memory files found")
    ).toBe(true);
  });
});
