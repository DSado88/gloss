import * as fs from "node:fs";
import * as os from "node:os";
import type { ConvoDb } from "./db.js";
import { IncrementalParser } from "./incremental-parser.js";
import type { Turn } from "./types.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface AskSource {
  sessionId: string;
  project: string;
  title: string;
  matchTurnIndex: number;
  turns: Turn[];
  startTurnIndex: number;
}

export interface AskResult {
  query: string;
  answer: string;
  sources: AskSource[];
  timing: { ftsMs: number; claudeMs: number; totalMs: number };
  error?: string;
}

// ---------------------------------------------------------------------------
// FTS query sanitizer
// ---------------------------------------------------------------------------

const QUESTION_WORDS = new Set([
  "what", "where", "when", "why", "how", "who", "which",
  "is", "are", "was", "were", "do", "does", "did",
  "can", "could", "would", "should", "will",
  "the", "a", "an", "in", "on", "at", "to", "for", "of", "with",
  "i", "me", "my", "it", "its", "this", "that",
]);

/** FTS5 special characters that need stripping. */
const FTS5_SPECIAL = /[":*^~(){}[\]<>+\-!|&\\]/g;

/**
 * Convert a natural-language question into a valid FTS5 query.
 * Strips question words, punctuation, and special chars, then joins
 * remaining tokens with implicit AND (space-separated in FTS5).
 */
export function sanitizeFtsQuery(input: string): string {
  const stripped = input.replace(FTS5_SPECIAL, " ");
  const tokens = stripped
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 1 && !QUESTION_WORDS.has(t));

  if (tokens.length === 0) {
    // Fallback: use any non-trivial words from original
    const fallback = stripped.split(/\s+/).filter((t) => t.length > 1);
    return fallback.join(" ") || input.replace(/[^a-zA-Z0-9\s]/g, "").trim();
  }

  return tokens.join(" ");
}

// ---------------------------------------------------------------------------
// Turn text extraction (for prompt building)
// ---------------------------------------------------------------------------

const MAX_TURN_CHARS = 1500;

function turnToPlainText(turn: Turn): string {
  const parts: string[] = [];
  let chars = 0;
  for (const block of turn.blocks) {
    if (chars >= MAX_TURN_CHARS) break;
    switch (block.type) {
      case "text": {
        const remaining = MAX_TURN_CHARS - chars;
        const text = block.text.length > remaining
          ? block.text.slice(0, remaining) + "..."
          : block.text;
        parts.push(text);
        chars += text.length;
        break;
      }
      case "tool_use":
        parts.push(`[Tool: ${block.name}]`);
        chars += 20;
        break;
      // Skip tool_result, thinking, slash_command for prompt brevity
    }
  }
  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Main pipeline
// ---------------------------------------------------------------------------

const MAX_FILE_SIZE = 200 * 1024 * 1024; // 200 MB
const CLAUDE_TIMEOUT_MS = 60_000;

export async function askQuestion(
  db: ConvoDb,
  query: string,
  options?: { maxSources?: number; contextTurns?: number },
): Promise<AskResult> {
  const t0 = performance.now();
  const maxSources = options?.maxSources ?? 5;
  const contextTurns = options?.contextTurns ?? 1;

  // ------------------------------------------------------------------
  // 1. FTS search (session-level — more robust against FTS corruption)
  // ------------------------------------------------------------------
  const ftsQuery = sanitizeFtsQuery(query);
  let sessionHits: Array<{ session_id: string; match_count: number; best_rank: number }> = [];
  try {
    sessionHits = db.searchSessions(ftsQuery, maxSources);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[ask] FTS error for query "${ftsQuery}": ${msg}`);
  }
  const tFts = performance.now();

  const sessionIds = sessionHits.map((h) => h.session_id);

  // ------------------------------------------------------------------
  // 3. Load turn context
  // ------------------------------------------------------------------
  const sources: AskSource[] = [];

  for (const sessionId of sessionIds) {
    const session = db.getSession(sessionId);
    if (!session?.jsonl_path) continue;

    // Skip files that are too large or missing
    let stat: fs.Stats;
    try {
      stat = fs.statSync(session.jsonl_path);
    } catch {
      continue;
    }
    if (stat.size > MAX_FILE_SIZE) continue;

    // Parse the JSONL
    let allTurns: Turn[];
    try {
      const content = fs.readFileSync(session.jsonl_path, "utf-8");
      const parser = new IncrementalParser();
      parser.feedLines(content.split("\n"));
      allTurns = parser.getTurns();
    } catch {
      continue;
    }

    // Find turns matching query keywords via simple text search
    const keywords = ftsQuery.toLowerCase().split(/\s+/).filter(Boolean);
    const matchingIndices: number[] = [];
    for (let i = 0; i < allTurns.length; i++) {
      const text = turnToPlainText(allTurns[i]).toLowerCase();
      if (keywords.some((kw) => text.includes(kw))) {
        matchingIndices.push(i);
      }
    }

    // If no keyword matches, take the first human turn as a fallback
    if (matchingIndices.length === 0 && allTurns.length > 0) {
      matchingIndices.push(0);
    }

    // Build context windows, keep up to 3 best matches per session
    const topMatches = matchingIndices.slice(0, 3);
    const windows: Array<[number, number]> = [];
    for (const idx of topMatches) {
      const lo = Math.max(0, idx - contextTurns);
      const hi = Math.min(allTurns.length - 1, idx + contextTurns);
      windows.push([lo, hi]);
    }

    // Merge overlapping windows
    windows.sort((a, b) => a[0] - b[0]);
    const merged: Array<[number, number]> = [];
    for (const [lo, hi] of windows) {
      if (merged.length > 0 && lo <= merged[merged.length - 1][1] + 1) {
        merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], hi);
      } else {
        merged.push([lo, hi]);
      }
    }

    for (const [lo, hi] of merged) {
      const turnSlice = allTurns.slice(lo, hi + 1);
      const matchIdx = topMatches.find((i) => i >= lo && i <= hi) ?? lo;
      sources.push({
        sessionId,
        project: session.project ?? "unknown",
        title: session.title ?? sessionId.slice(0, 8),
        matchTurnIndex: matchIdx,
        turns: turnSlice,
        startTurnIndex: lo,
      });
    }
  }

  // ------------------------------------------------------------------
  // 4. Build prompt (cap total excerpt size to ~30K chars)
  // ------------------------------------------------------------------
  const MAX_EXCERPT_CHARS = 30_000;
  let totalChars = 0;
  const excerptParts: string[] = [];

  for (const src of sources) {
    if (totalChars >= MAX_EXCERPT_CHARS) break;
    const turnXml = src.turns.map((turn, j) => {
      const idx = src.startTurnIndex + j;
      const text = turnToPlainText(turn);
      return `    <turn index="${idx}" role="${turn.role}">\n${text}\n    </turn>`;
    }).join("\n");

    const sessionXml = `  <session id="${src.sessionId}" project="${src.project}" title="${src.title}">\n${turnXml}\n  </session>`;
    totalChars += sessionXml.length;
    excerptParts.push(sessionXml);
  }
  const excerpts = excerptParts.join("\n");

  const prompt = `<query>${query}</query>

<excerpts>
${excerpts}
</excerpts>

You are a search assistant for a developer's conversation history with Claude Code.
Answer the query by synthesizing information from the excerpts above.
Be concise and specific. Cite sources using [/c/${"{sessionId}"}#turn-{turnIndex}] format.
If the excerpts don't contain relevant information, say so honestly.
Use markdown formatting in your answer.`;

  // ------------------------------------------------------------------
  // 5. Shell out to claude
  // ------------------------------------------------------------------
  let answer = "";
  let claudeError: string | undefined;
  const tClaudeStart = performance.now();

  if (sources.length > 0) {
    try {
      // Unset CLAUDECODE to avoid nested session detection, ensure HOME/PATH
      const home = process.env.HOME || os.homedir();
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) {
        if (k !== "CLAUDECODE" && v !== undefined) env[k] = v;
      }
      env.HOME = home;
      if (!env.PATH) env.PATH = `/usr/local/bin:/usr/bin:/bin:${home}/.local/bin`;
      const claudeBin = `${home}/.local/bin/claude`;
      const proc = Bun.spawn([claudeBin, "-p"], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        env,
      });

      // Write prompt to stdin and close
      proc.stdin.write(prompt);
      proc.stdin.flush();
      proc.stdin.end();

      // Read stdout with timeout
      const stdoutPromise = new Response(proc.stdout).text();
      const stderrPromise = new Response(proc.stderr).text();

      const result = await Promise.race([
        stdoutPromise,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("claude timed out after 60s")), CLAUDE_TIMEOUT_MS),
        ),
      ]);

      answer = result.trim();

      // Check exit code
      const exitCode = await proc.exited;
      if (exitCode !== 0) {
        const stderr = await stderrPromise;
        claudeError = `claude exited with code ${exitCode}: ${stderr.slice(0, 500)}`;
        if (!answer) answer = "";
      }
    } catch (e) {
      claudeError = e instanceof Error ? e.message : String(e);
    }
  } else {
    answer = "No matching conversations found for your query.";
  }

  const tEnd = performance.now();

  // ------------------------------------------------------------------
  // 6. Return result
  // ------------------------------------------------------------------
  return {
    query,
    answer,
    sources,
    timing: {
      ftsMs: Math.round(tFts - t0),
      claudeMs: Math.round(tEnd - tClaudeStart),
      totalMs: Math.round(tEnd - t0),
    },
    error: claudeError,
  };
}
