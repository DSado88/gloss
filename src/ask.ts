import * as fs from "node:fs";
import * as os from "node:os";
import type { ConvoDb } from "./db.js";
import { IncrementalParser } from "./incremental-parser.js";
import type { Turn } from "./types.js";
import type { EmbeddingEngine, VectorIndex } from "./embeddings.js";

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
  timing: { ftsMs: number; vectorMs: number; claudeMs: number; totalMs: number };
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
const FTS5_SPECIAL = /[":*^~(){}[\]<>+\-!|&\\/]/g;

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

/** FTS5 boolean operators — must not appear as standalone tokens. */
const FTS5_OPERATORS = new Set(["or", "and", "not", "near"]);

export function sanitizeFtsQuery(input: string): string {
  // Strip all non-alphanumeric except whitespace (nuclear option for safety)
  const stripped = input.replace(FTS5_SPECIAL, " ").replace(/[^a-zA-Z0-9\s]/g, " ");
  let tokens = stripped
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 1 && !QUESTION_WORDS.has(t) && !FILLER_WORDS.has(t) && !FTS5_OPERATORS.has(t));

  if (tokens.length === 0) {
    // Fallback: use any non-trivial words from original (skip question words + operators)
    tokens = stripped.toLowerCase().split(/\s+/)
      .filter((t) => t.length > 1 && !QUESTION_WORDS.has(t) && !FTS5_OPERATORS.has(t));
    if (tokens.length === 0) {
      // Ultimate fallback: strip everything non-alphanumeric, then filter operators
      const last = input.replace(/[^a-zA-Z0-9\s]/g, "").trim().toLowerCase()
        .split(/\s+/)
        .filter((t) => t.length > 1 && !FTS5_OPERATORS.has(t));
      return last.join(" ");
    }
  }

  // Final safety: strip any remaining non-alphanumeric from each token
  tokens = tokens
    .map((t) => t.replace(/[^a-z0-9]/g, ""))
    .filter((t) => t.length > 1 && !FTS5_OPERATORS.has(t));

  if (tokens.length === 0) return "";

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
// FTS hit merging
// ---------------------------------------------------------------------------

/** Merge duplicate session hits from multiple FTS queries. Keeps best rank and sums hit counts. */
export function mergeFtsHits(
  sessionHits: Array<{ session_id: string; match_count: number; best_rank: number }>,
): Map<string, { bestRank: number; totalHits: number }> {
  const scores = new Map<string, { bestRank: number; totalHits: number }>();
  for (const h of sessionHits) {
    const existing = scores.get(h.session_id);
    if (existing) {
      if (h.best_rank < existing.bestRank) existing.bestRank = h.best_rank;
      existing.totalHits += h.match_count;
    } else {
      scores.set(h.session_id, { bestRank: h.best_rank, totalHits: h.match_count });
    }
  }
  return scores;
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
  let proc: ReturnType<typeof Bun.spawn> | undefined;
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

    proc = Bun.spawn([claudeBin, "-p", "--model", "sonnet"], {
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
    proc?.kill();
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
  options?: {
    maxSources?: number;
    contextTurns?: number;
    vectorIndex?: VectorIndex;
    embeddingEngine?: EmbeddingEngine;
  },
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

  // ------------------------------------------------------------------
  // 1-3: Run metadata, FTS, and Claude extraction in parallel
  // ------------------------------------------------------------------

  // Start Claude term extraction first (slow, ~10s)
  const termsPromise = extractSearchTerms(query);

  // Metadata search (instant — sync DB query)
  const metadataIds = searchMetadata(db, query, maxSources);

  // FTS search with sanitized query (instant — sync DB query)
  const ftsQuery = sanitizeFtsQuery(query);
  let sessionHits: Array<{ session_id: string; match_count: number; best_rank: number }> = [];
  try {
    sessionHits = db.searchSessions(ftsQuery, maxSources * 4);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[ask] FTS error for query "${ftsQuery}": ${msg}`);
  }

  // Await Claude-extracted terms, then do additional targeted FTS
  let claudeTerms: string[] = [];
  try {
    claudeTerms = await termsPromise;
    console.log(`[ask] Claude extracted terms: ${claudeTerms.join(", ")}`);
  } catch { /* non-fatal */ }

  for (const term of claudeTerms) {
    try {
      const sanitized = sanitizeFtsQuery(term);
      if (!sanitized) continue;
      const hits = db.searchSessions(sanitized, maxSources * 3);
      sessionHits.push(...hits);
    } catch { /* skip bad queries */ }
  }

  const tFts = performance.now();

  // ------------------------------------------------------------------
  // Vector search (parallel to FTS, gracefully skipped if unavailable)
  // ------------------------------------------------------------------
  let vectorSessionRanking: Array<{
    sessionId: string;
    bestScore: number;
    bestTurnIndex: number;
    matchCount: number;
  }> = [];
  let vectorMs = 0;

  if (options?.vectorIndex && options?.embeddingEngine?.isReady() && options.vectorIndex.count > 0) {
    try {
      const tVec0 = performance.now();
      const queryVec = await options.embeddingEngine.embedQuery(query);
      vectorSessionRanking = options.vectorIndex.searchSessions(queryVec, maxSources * 4);
      vectorMs = Math.round(performance.now() - tVec0);
      console.log(`[ask] Vector search: ${vectorSessionRanking.length} sessions in ${vectorMs}ms`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[ask] Vector search error: ${msg}`);
    }
  }

  // ------------------------------------------------------------------
  // RRF merge: combine FTS, vector, and metadata signals
  // ------------------------------------------------------------------
  const RRF_K = 60;

  // Build FTS session ranking (deduplicated, sorted by score)
  const filteredHits = sessionHits.filter((h) => !isExcluded(h.session_id));
  const ftsSessionScores = mergeFtsHits(filteredHits);
  // Sort FTS sessions by rank (lower = better) with hit count tiebreak
  const ftsRanked = [...ftsSessionScores.entries()]
    .sort((a, b) => {
      const ra = a[1].bestRank - (a[1].totalHits > 1 ? Math.log2(a[1].totalHits) * 1.5 : 0);
      const rb = b[1].bestRank - (b[1].totalHits > 1 ? Math.log2(b[1].totalHits) * 1.5 : 0);
      return ra - rb;
    })
    .map(([id]) => id);

  // Build vector session ranking (already sorted by bestScore desc)
  // Preserve bestTurnIndex for use in context loading
  const vectorTurnHints = new Map<string, number>();
  const vectorRanked: string[] = [];
  for (const v of vectorSessionRanking) {
    if (isExcluded(v.sessionId)) continue;
    vectorRanked.push(v.sessionId);
    vectorTurnHints.set(v.sessionId, v.bestTurnIndex);
  }

  // Metadata ranking
  const metadataRanked = metadataIds.filter((id) => !isExcluded(id));

  // Compute RRF scores
  const rrfScores = new Map<string, number>();
  const allSessionIds = new Set([...ftsRanked, ...vectorRanked, ...metadataRanked]);

  for (const id of allSessionIds) {
    let score = 0;
    const ftsPos = ftsRanked.indexOf(id);
    if (ftsPos >= 0) score += 1 / (RRF_K + ftsPos + 1);
    const vecPos = vectorRanked.indexOf(id);
    if (vecPos >= 0) score += 1 / (RRF_K + vecPos + 1);
    const metaPos = metadataRanked.indexOf(id);
    if (metaPos >= 0) score += 1 / (RRF_K + metaPos + 1);
    rrfScores.set(id, score);
  }

  // Select top N sessions by RRF score
  const finalSessionIds = [...rrfScores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxSources)
    .map(([id]) => id);

  console.log(`[ask] RRF selected ${finalSessionIds.length} sessions (FTS:${ftsRanked.length} Vec:${vectorRanked.length} Meta:${metadataRanked.length})`);

  // ------------------------------------------------------------------
  // 3. Load turn context
  // ------------------------------------------------------------------
  const sources: AskSource[] = [];

  for (const sessionId of finalSessionIds) {
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
    // Combine FTS tokens + Claude-extracted terms for better matching
    const allTerms = new Set([
      ...ftsQuery.toLowerCase().split(/\s+/).filter((t) => t !== "OR" && t.length > 1),
      ...claudeTerms.map((t) => t.toLowerCase()),
    ]);
    const keywords = [...allTerms];
    const matchingIndices: number[] = [];

    // Prioritize the vector search's best turn if available
    const vecHint = vectorTurnHints.get(sessionId);
    if (vecHint !== undefined && vecHint >= 0 && vecHint < allTurns.length) {
      matchingIndices.push(vecHint);
    }

    for (let i = 0; i < allTurns.length; i++) {
      if (i === vecHint) continue; // already added
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
    let proc: ReturnType<typeof Bun.spawn> | undefined;
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
      proc = Bun.spawn([claudeBin, "-p", "--model", "haiku"], {
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
      proc?.kill();
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
      vectorMs,
      claudeMs: Math.round(tEnd - tClaudeStart),
      totalMs: Math.round(tEnd - t0),
    },
    error: claudeError,
  };
}
