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
  "i", "me", "my", "we", "us", "our", "it", "its", "this", "that",
]);

/** FTS5 special characters that need stripping. */
const FTS5_SPECIAL = /[":*^~(){}[\]<>+\-!|&\\]/g;

/**
 * Convert a natural-language question into a valid FTS5 query.
 * Strips question words, punctuation, and special chars, then joins
 * remaining tokens with implicit AND (space-separated in FTS5).
 */
/** Common filler words beyond question words */
const FILLER_WORDS = new Set([
  "lets", "let", "about", "all", "both", "and", "or", "but",
  "just", "also", "very", "really", "some", "any", "every",
  "everything", "anything", "something", "nothing",
  "relevant", "related", "important", "please", "need", "want",
  "gather", "find", "show", "give", "get", "tell", "look",
]);

export function sanitizeFtsQuery(input: string): string {
  const stripped = input.replace(FTS5_SPECIAL, " ").replace(/[.,;:!?]/g, " ");
  let tokens = stripped
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 1 && !QUESTION_WORDS.has(t) && !FILLER_WORDS.has(t));

  if (tokens.length === 0) {
    // Fallback: use any non-trivial words from original (skip question words only)
    tokens = stripped.toLowerCase().split(/\s+/)
      .filter((t) => t.length > 1 && !QUESTION_WORDS.has(t));
    if (tokens.length === 0) {
      return input.replace(/[^a-zA-Z0-9\s]/g, "").trim();
    }
  }

  // For short queries (1-3 tokens), use implicit AND (all must match)
  // For longer queries, use OR to be more permissive
  if (tokens.length <= 3) {
    return tokens.join(" ");
  }
  return tokens.join(" OR ");
}

// ---------------------------------------------------------------------------
// Turn text extraction (for prompt building)
// ---------------------------------------------------------------------------

const MAX_TURN_CHARS = 1000;

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

// ---------------------------------------------------------------------------
// Claude-powered query extraction (step 3)
// ---------------------------------------------------------------------------

async function extractSearchTerms(query: string): Promise<string[]> {
  try {
    const home = process.env.HOME || os.homedir();
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (k !== "CLAUDECODE" && v !== undefined) env[k] = v;
    }
    env.HOME = home;
    if (!env.PATH) env.PATH = `/usr/local/bin:/usr/bin:/bin:${home}/.local/bin`;
    const claudeBin = `${home}/.local/bin/claude`;

    const prompt = `Extract 2-5 focused search terms or short phrases from this question. These will be used for full-text search in a conversation database. Return ONLY the terms, one per line, no numbering or explanation. Prefer specific nouns and project names over generic verbs.

Question: ${query}`;

    const proc = Bun.spawn([claudeBin, "-p", "--model", "sonnet"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env,
    });
    proc.stdin.write(prompt);
    proc.stdin.flush();
    proc.stdin.end();

    const result = await Promise.race([
      new Response(proc.stdout).text(),
      new Promise<string>((_, reject) =>
        setTimeout(() => reject(new Error("timeout")), 15_000),
      ),
    ]);

    await proc.exited;
    return result
      .trim()
      .split("\n")
      .map((l) => l.trim().replace(/^[-*\d.]+\s*/, ""))
      .filter((l) => l.length > 1 && l.length < 60);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Session metadata search (step 1)
// ---------------------------------------------------------------------------

function searchMetadata(
  db: ConvoDb,
  query: string,
  limit: number,
): string[] {
  // Extract meaningful words for LIKE matching
  const words = query
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !QUESTION_WORDS.has(w) && !FILLER_WORDS.has(w));

  if (words.length === 0) return [];

  // Search project paths and titles
  const conditions = words.map(() => "(LOWER(project) LIKE ? OR LOWER(title) LIKE ?)").join(" OR ");
  const params: string[] = [];
  for (const w of words) {
    params.push(`%${w}%`, `%${w}%`);
  }

  try {
    const rows = db.db.query(
      `SELECT id FROM sessions WHERE ${conditions} ORDER BY coalesce(last_modified, imported_at) DESC LIMIT ?`,
    ).all(...params, limit) as Array<{ id: string }>;
    return rows.map((r) => r.id);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Main pipeline
// ---------------------------------------------------------------------------

export async function askQuestion(
  db: ConvoDb,
  query: string,
  options?: { maxSources?: number; contextTurns?: number },
): Promise<AskResult> {
  const t0 = performance.now();
  const maxSources = options?.maxSources ?? 6;
  const contextTurns = options?.contextTurns ?? 1;

  // Load excluded project patterns (e.g. "think-tank*" excludes all think-tank variants)
  const excludedPatterns = db.getSearchExcludedProjects();
  function isExcluded(sessionId: string): boolean {
    if (excludedPatterns.length === 0) return false;
    const session = db.getSession(sessionId);
    if (!session?.project) return false;
    const proj = session.project.toLowerCase();
    return excludedPatterns.some((pattern) => {
      const p = pattern.toLowerCase();
      if (p.endsWith("*")) return proj.includes(p.slice(0, -1));
      return proj.includes(p);
    });
  }

  // Helper: merge hits into a session scores map
  function mergeHits(
    hits: Array<{ session_id: string; match_count: number; best_rank: number }>,
    scores: Map<string, { bestRank: number; totalHits: number; metadataBoost: boolean }>,
    metaSet: Set<string>,
  ): void {
    for (const h of hits) {
      if (isExcluded(h.session_id)) continue;
      const existing = scores.get(h.session_id);
      if (existing) {
        if (h.best_rank < existing.bestRank) existing.bestRank = h.best_rank;
        // Use max hit count across queries, not sum — avoids double-counting
        // when the same session matches multiple extracted terms
        if (h.match_count > existing.totalHits) existing.totalHits = h.match_count;
      } else {
        scores.set(h.session_id, {
          bestRank: h.best_rank,
          totalHits: h.match_count,
          metadataBoost: metaSet.has(h.session_id),
        });
      }
    }
  }

  // Helper: select top session IDs from a scores map
  function selectTopSessions(
    scores: Map<string, { bestRank: number; totalHits: number; metadataBoost: boolean }>,
    metaIds: string[],
    limit: number,
  ): string[] {
    // Two-pass selection: first guarantee metadata matches get slots (they matched
    // project name/title which is high-signal), then fill remaining slots by score.
    function computeScore(s: { bestRank: number; totalHits: number; metadataBoost: boolean }): number {
      const hitsBoost = s.totalHits > 1 ? Math.log2(s.totalHits) * 1.5 : 0;
      return s.bestRank - hitsBoost;
    }

    const metadataEntries = [...scores.entries()]
      .filter(([, s]) => s.metadataBoost)
      .sort((a, b) => computeScore(a[1]) - computeScore(b[1]));
    const ftsEntries = [...scores.entries()]
      .filter(([, s]) => !s.metadataBoost)
      .sort((a, b) => computeScore(a[1]) - computeScore(b[1]));

    // Reserve up to half the slots for metadata, fill rest with FTS
    const metadataSlots = Math.min(metadataEntries.length, Math.ceil(limit / 2));
    const ftsSlots = limit - metadataSlots;

    const selectedMeta = metadataEntries.slice(0, metadataSlots).map(([id]) => id);
    const selectedFts = ftsEntries
      .filter(([id]) => !selectedMeta.includes(id))
      .slice(0, ftsSlots)
      .map(([id]) => id);

    return [...selectedMeta, ...selectedFts];
  }

  // Helper: load context for a single session (async for file I/O parallelism)
  async function loadSessionContext(
    sessionId: string,
    keywords: string[],
  ): Promise<AskSource[]> {
    const session = db.getSession(sessionId);
    if (!session?.jsonl_path) return [];

    // Skip files that are too large or missing
    let stat: fs.Stats;
    try {
      stat = fs.statSync(session.jsonl_path);
    } catch {
      return [];
    }
    if (stat.size > MAX_FILE_SIZE) return [];

    // Parse the JSONL — use async file read for parallelism
    let allTurns: Turn[];
    try {
      const file = Bun.file(session.jsonl_path);
      const content = await file.text();
      const parser = new IncrementalParser();
      parser.feedLines(content.split("\n"));
      allTurns = parser.getTurns();
    } catch {
      return [];
    }

    // Find turns matching query keywords via simple text search
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

    const results: AskSource[] = [];
    for (const [lo, hi] of merged) {
      const turnSlice = allTurns.slice(lo, hi + 1);
      const matchIdx = topMatches.find((i) => i >= lo && i <= hi) ?? lo;
      results.push({
        sessionId,
        project: session.project ?? "unknown",
        title: session.title ?? sessionId.slice(0, 8),
        matchTurnIndex: matchIdx,
        turns: turnSlice,
        startTurnIndex: lo,
      });
    }
    return results;
  }

  // ------------------------------------------------------------------
  // 1. Fire Claude term extraction (slow, ~10s) — DON'T AWAIT YET
  // ------------------------------------------------------------------
  const termsPromise = extractSearchTerms(query);

  // ------------------------------------------------------------------
  // 2. Run FTS + metadata search (sync, instant)
  // ------------------------------------------------------------------

  // Metadata search (instant — sync DB query)
  const metadataIds = searchMetadata(db, query, maxSources);

  // FTS search with sanitized query (instant — sync DB query)
  const ftsQuery = sanitizeFtsQuery(query);
  const initialHits: Array<{ session_id: string; match_count: number; best_rank: number }> = [];
  try {
    initialHits.push(...db.searchSessions(ftsQuery, maxSources * 4));
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[ask] FTS error for query "${ftsQuery}": ${msg}`);
  }

  const tFts = performance.now();

  // ------------------------------------------------------------------
  // 3. Initial RRF merge WITHOUT Claude terms
  // ------------------------------------------------------------------
  const metadataSet = new Set(metadataIds);
  const initialScores = new Map<string, { bestRank: number; totalHits: number; metadataBoost: boolean }>();

  mergeHits(initialHits, initialScores, metadataSet);

  // Add metadata-only sessions (no FTS hits) with a neutral rank
  for (const id of metadataIds) {
    if (!initialScores.has(id) && !isExcluded(id)) {
      initialScores.set(id, { bestRank: 0, totalHits: 0, metadataBoost: true });
    }
  }

  const initialSessionIds = selectTopSessions(initialScores, metadataIds, maxSources);

  console.log(`[ask] Initial selection (pre-Claude terms): ${initialSessionIds.length} sessions`);

  // ------------------------------------------------------------------
  // 4. Start context loading in PARALLEL with Claude term extraction
  // ------------------------------------------------------------------
  // Use FTS-only keywords for initial context matching (Claude terms not ready yet)
  const ftsKeywords = ftsQuery.toLowerCase().split(/\s+/).filter((t) => t !== "OR" && t.length > 1);

  const contextPromise = Promise.all(
    initialSessionIds.map((id) => loadSessionContext(id, ftsKeywords)),
  );

  // ------------------------------------------------------------------
  // 5. Await Claude terms (likely already resolved by now, ~10s elapsed)
  // ------------------------------------------------------------------
  let claudeTerms: string[] = [];
  try {
    claudeTerms = await termsPromise;
    console.log(`[ask] Claude extracted terms: ${claudeTerms.join(", ")}`);
  } catch { /* non-fatal */ }

  // ------------------------------------------------------------------
  // 6. Await initial context loading
  // ------------------------------------------------------------------
  const initialSourceArrays = await contextPromise;
  const sources: AskSource[] = initialSourceArrays.flat();

  // ------------------------------------------------------------------
  // 7. Check if Claude terms reveal additional sessions not in initial set
  // ------------------------------------------------------------------
  const initialSet = new Set(initialSessionIds);
  const claudeHits: Array<{ session_id: string; match_count: number; best_rank: number }> = [];

  for (const term of claudeTerms) {
    try {
      const sanitized = sanitizeFtsQuery(term);
      if (!sanitized) continue;
      const hits = db.searchSessions(sanitized, maxSources * 3);
      claudeHits.push(...hits);
    } catch { /* skip bad queries */ }
  }

  if (claudeHits.length > 0) {
    // Rebuild scores with all hits (initial + Claude-derived)
    const fullScores = new Map<string, { bestRank: number; totalHits: number; metadataBoost: boolean }>();
    mergeHits(initialHits, fullScores, metadataSet);
    mergeHits(claudeHits, fullScores, metadataSet);

    // Add metadata-only sessions
    for (const id of metadataIds) {
      if (!fullScores.has(id) && !isExcluded(id)) {
        fullScores.set(id, { bestRank: 0, totalHits: 0, metadataBoost: true });
      }
    }

    const finalSessionIds = selectTopSessions(fullScores, metadataIds, maxSources);

    // Find NEW sessions that Claude terms surfaced (not in initial set)
    const newSessionIds = finalSessionIds.filter((id) => !initialSet.has(id));

    if (newSessionIds.length > 0) {
      console.log(`[ask] Claude terms surfaced ${newSessionIds.length} additional sessions`);

      // Combine FTS + Claude keywords for richer matching in new sessions
      const allKeywords = [
        ...ftsKeywords,
        ...claudeTerms.map((t) => t.toLowerCase()),
      ];
      const uniqueKeywords = [...new Set(allKeywords)];

      // Load additional contexts in parallel
      const additionalSourceArrays = await Promise.all(
        newSessionIds.map((id) => loadSessionContext(id, uniqueKeywords)),
      );
      sources.push(...additionalSourceArrays.flat());
    }

    console.log(`[ask] Final selection: ${finalSessionIds.length} sessions (${initialSessionIds.length} initial + ${newSessionIds.length} new)`);
  } else {
    console.log(`[ask] Final selection: ${initialSessionIds.length} sessions (no additional from Claude terms)`);
  }

  // ------------------------------------------------------------------
  // 4. Build prompt (cap total excerpt size to ~20K chars)
  // ------------------------------------------------------------------
  const MAX_EXCERPT_CHARS = 20_000;
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
      const proc = Bun.spawn([claudeBin, "-p", "--model", "haiku"], {
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
          setTimeout(() => reject(new Error(`claude timed out after ${CLAUDE_TIMEOUT_MS / 1000}s`)), CLAUDE_TIMEOUT_MS),
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
