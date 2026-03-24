import { describe, expect, it } from "vitest";
import { cleanUserText, isSystemNoise } from "./text-cleaning.js";

describe("cleanUserText", () => {
  it("strips <system-reminder> blocks", () => {
    const input =
      "Hello <system-reminder>secret stuff\nmultiline</system-reminder> world";
    expect(cleanUserText(input)).toBe("Hello  world");
  });

  it("strips <task-notification> blocks", () => {
    const input =
      "<task-notification>task done</task-notification>Actual message";
    expect(cleanUserText(input)).toBe("Actual message");
  });

  it("strips <command-message> blocks", () => {
    const input = "<command-message>cmd payload</command-message>rest";
    expect(cleanUserText(input)).toBe("rest");
  });

  it("strips <command-name> blocks", () => {
    const input = "<command-name>/help</command-name>rest";
    expect(cleanUserText(input)).toBe("rest");
  });

  it("strips <command-args> blocks", () => {
    const input = "<command-args>some args</command-args>rest";
    expect(cleanUserText(input)).toBe("rest");
  });

  it("strips <local-command-caveat> blocks", () => {
    const input =
      "<local-command-caveat>caveat\ntext</local-command-caveat>rest";
    expect(cleanUserText(input)).toBe("rest");
  });

  it("strips <local-command-stdout> blocks", () => {
    const input =
      "<local-command-stdout>output\nlines</local-command-stdout>rest";
    expect(cleanUserText(input)).toBe("rest");
  });

  it("strips tool output file references", () => {
    const input =
      "Read the output file to retrieve the result: /tmp/foo.txt";
    expect(cleanUserText(input)).toBe("");
  });

  it("preserves real user text while stripping noise", () => {
    const input =
      "Please fix the bug <system-reminder>You are Claude.</system-reminder> in main.ts";
    expect(cleanUserText(input)).toBe("Please fix the bug  in main.ts");
  });

  it("collapses multiple newlines", () => {
    const input = "line1\n\n\n\n\nline2";
    expect(cleanUserText(input)).toBe("line1\n\nline2");
  });

  it("strips multiple noise patterns at once", () => {
    const input =
      "<system-reminder>reminder</system-reminder><task-notification>notif</task-notification>real text<command-name>/run</command-name>";
    expect(cleanUserText(input)).toBe("real text");
  });

  it("returns empty string for all-noise input", () => {
    const input =
      "<system-reminder>all noise</system-reminder>";
    expect(cleanUserText(input)).toBe("");
  });
});

describe("isSystemNoise", () => {
  it("returns true for pure noise", () => {
    expect(
      isSystemNoise("<system-reminder>noise</system-reminder>")
    ).toBe(true);
  });

  it("returns false for real text", () => {
    expect(isSystemNoise("Hello, can you help me?")).toBe(false);
  });

  it("returns true for system-only prefix: Base directory", () => {
    expect(
      isSystemNoise("Base directory for this skill: /some/path")
    ).toBe(true);
  });

  it("returns true for system-only prefix: session continuation", () => {
    expect(
      isSystemNoise(
        "This session is being continued from a previous conversation. Here is the summary..."
      )
    ).toBe(true);
  });

  it("returns false for text that contains noise but also real content", () => {
    expect(
      isSystemNoise(
        "<system-reminder>noise</system-reminder>But I also have a real question"
      )
    ).toBe(false);
  });

  it("returns true for empty string", () => {
    expect(isSystemNoise("")).toBe(true);
  });

  it("returns true for whitespace-only string", () => {
    expect(isSystemNoise("   \n\n  ")).toBe(true);
  });

  it("returns false when system prefix appears mid-text (not at start)", () => {
    // SYSTEM_ONLY_PREFIXES should only match at the START of cleaned text.
    // If the prefix string appears in the middle, it's real user content.
    expect(
      isSystemNoise("Please explain: Base directory for this skill: /home/user")
    ).toBe(false);
    expect(
      isSystemNoise("Question about: This session is being continued from a previous conversation")
    ).toBe(false);
  });

  it("returns true for system prefix with leading whitespace (trimmed)", () => {
    // cleanUserText trims whitespace, so leading spaces shouldn't prevent detection
    expect(
      isSystemNoise("   Base directory for this skill: /home/user/project")
    ).toBe(true);
  });
});
