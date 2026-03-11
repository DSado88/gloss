import type { Turn, TocEntry } from "./types.js";

export function formatTimestamp(ts: string): string {
  return "";
}

export function renderTurn(
  turn: Turn,
  index: number,
  thinking: boolean,
  tools: boolean
): { html: string; tocEntry: TocEntry | null } {
  return { html: "", tocEntry: null };
}
