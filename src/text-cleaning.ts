/**
 * System noise patterns and cleaning functions.
 *
 * User messages in Claude Code conversations contain injected system
 * content (reminders, task notifications, command metadata, etc.) that
 * should be stripped before display.
 */

/** Patterns for system-injected noise in user messages. */
export const SYSTEM_NOISE_PATTERNS: RegExp[] = [
  // Task notifications (background task completions)
  /<task-notification>[\s\S]*?<\/task-notification>/g,
  // System reminders (injected by Claude Code infra)
  /<system-reminder>[\s\S]*?<\/system-reminder>/g,
  // Slash command metadata
  /<command-message>[\s\S]*?<\/command-message>/g,
  /<command-name>[\s\S]*?<\/command-name>/g,
  /<command-args>[\s\S]*?<\/command-args>/g,
  // Local command infrastructure
  /<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g,
  /<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g,
  // Tool output file references
  /Read the output file to retrieve the result:.*/g,
];

/** User messages that are entirely system content (no real user text). */
export const SYSTEM_ONLY_PREFIXES: string[] = [
  "Base directory for this skill:",
  "This session is being continued from a previous conversation",
];

/**
 * Strip system-injected noise from user message text.
 *
 * Returns the cleaned text (may be empty if it was all noise).
 */
export function cleanUserText(text: string): string {
  let cleaned = text;
  for (const pattern of SYSTEM_NOISE_PATTERNS) {
    // Reset lastIndex since we reuse global regexps
    pattern.lastIndex = 0;
    cleaned = cleaned.replace(pattern, "");
  }
  // Collapse leftover whitespace
  cleaned = cleaned.replace(/\n{3,}/g, "\n\n").trim();
  return cleaned;
}

/** Check if a user text block is entirely system noise. */
export function isSystemNoise(text: string): boolean {
  const cleaned = cleanUserText(text);
  if (!cleaned) return true;
  for (const prefix of SYSTEM_ONLY_PREFIXES) {
    if (cleaned.startsWith(prefix)) return true;
  }
  return false;
}
