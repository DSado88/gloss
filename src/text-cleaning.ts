const SYSTEM_NOISE_PATTERNS: RegExp[] = [
  /<task-notification>[\s\S]*?<\/task-notification>/g,
  /<system-reminder>[\s\S]*?<\/system-reminder>/g,
  /<command-message>[\s\S]*?<\/command-message>/g,
  /<command-name>[\s\S]*?<\/command-name>/g,
  /<command-args>[\s\S]*?<\/command-args>/g,
  /<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g,
  /<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g,
  /Read the output file to retrieve the result:.*/g,
];

const SYSTEM_ONLY_PREFIXES: string[] = [
  "Base directory for this skill:",
  "This session is being continued from a previous conversation",
];

export function cleanUserText(text: string): string {
  let cleaned = text;
  for (const pattern of SYSTEM_NOISE_PATTERNS) {
    cleaned = cleaned.replace(new RegExp(pattern.source, pattern.flags), "");
  }
  cleaned = cleaned.replace(/\n{3,}/g, "\n\n").trim();
  return cleaned;
}

export function isSystemNoise(text: string): boolean {
  const cleaned = cleanUserText(text);
  if (!cleaned) return true;
  return SYSTEM_ONLY_PREFIXES.some((prefix) => cleaned.startsWith(prefix));
}
