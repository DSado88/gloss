import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mergeFtsHits, sanitizeFtsQuery } from "./ask.js";
import { VectorIndex, truncateAndNormalize, EMBEDDING_DIMS } from "./embeddings.js";
import { openDb, type ConvoDb } from "./db.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ---------------------------------------------------------------------------
// Bug #7: FTS totalHits uses max instead of sum
// ---------------------------------------------------------------------------

describe("mergeFtsHits", () => {
  it("accumulates totalHits across duplicate sessions (sum, not max)", () => {
    const hits = [
      { session_id: "s1", match_count: 3, best_rank: -5.0 },
      { session_id: "s1", match_count: 2, best_rank: -3.0 },
      { session_id: "s2", match_count: 1, best_rank: -4.0 },
    ];

    const result = mergeFtsHits(hits);

    // totalHits should be 3 + 2 = 5 (sum), not max(3, 2) = 3
    const s1 = result.get("s1")!;
    expect(s1.totalHits).toBe(5);

    // bestRank should be min(-5, -3) = -5 (lower is better)
    expect(s1.bestRank).toBe(-5.0);

    // s2 should be unaffected
    const s2 = result.get("s2")!;
    expect(s2.totalHits).toBe(1);
  });

  it("handles single occurrence correctly", () => {
    const hits = [{ session_id: "s1", match_count: 7, best_rank: -2.0 }];
    const result = mergeFtsHits(hits);
    expect(result.get("s1")!.totalHits).toBe(7);
    expect(result.get("s1")!.bestRank).toBe(-2.0);
  });

  it("handles empty input", () => {
    const result = mergeFtsHits([]);
    expect(result.size).toBe(0);
  });

  it("three-way merge for the same session", () => {
    // Simulates: base FTS query + 2 Claude-extracted term queries all match the same session
    const hits = [
      { session_id: "s1", match_count: 2, best_rank: -4.0 },
      { session_id: "s1", match_count: 1, best_rank: -2.0 },
      { session_id: "s1", match_count: 3, best_rank: -6.0 },
    ];

    const result = mergeFtsHits(hits);
    const s1 = result.get("s1")!;
    expect(s1.totalHits).toBe(6); // 2 + 1 + 3
    expect(s1.bestRank).toBe(-6.0); // min of all three
  });
});

// ---------------------------------------------------------------------------
// sanitizeFtsQuery edge cases
// ---------------------------------------------------------------------------

describe("sanitizeFtsQuery", () => {
  it("strips FTS5 operators (AND/OR/NOT/NEAR)", () => {
    // "find" is a filler, "or"/"and"/"not" are operators → only "search" remains
    expect(sanitizeFtsQuery("find OR search AND NOT")).toBe("search");
  });

  it("returns empty for queries with only special characters", () => {
    expect(sanitizeFtsQuery('"()*+[]{}|')).toBe("");
  });

  it("preserves meaningful content words", () => {
    const result = sanitizeFtsQuery("webpack production configuration");
    expect(result).toContain("webpack");
    expect(result).toContain("production");
    expect(result).toContain("configuration");
  });

  it("uses OR for longer queries (4+ tokens)", () => {
    const result = sanitizeFtsQuery("webpack production configuration optimization deployment");
    expect(result).toContain(" OR ");
  });

  it("uses implicit AND for short queries (1-3 tokens)", () => {
    const result = sanitizeFtsQuery("webpack configuration");
    expect(result).not.toContain(" OR ");
    expect(result).toBe("webpack configuration");
  });

  it("handles empty input", () => {
    expect(sanitizeFtsQuery("")).toBe("");
  });

  it("strips question words and filler words", () => {
    const result = sanitizeFtsQuery("what is the relevant important database setup");
    // "what", "is", "the" are question words; "relevant", "important" are filler
    expect(result).toContain("database");
    expect(result).toContain("setup");
    expect(result).not.toContain("what");
    expect(result).not.toContain("relevant");
  });

  it("falls back gracefully when all words are stop words", () => {
    // "just about everything" — all filler words, but fallback keeps them
    const result = sanitizeFtsQuery("just about everything");
    // Fallback relaxes filler filtering — should return something
    expect(result.length).toBeGreaterThan(0);
  });

  it("strips non-ASCII characters (CJK, emoji) without crashing", () => {
    expect(sanitizeFtsQuery("こんにちは")).toBe("");
    expect(sanitizeFtsQuery("🔍 search")).toBe("search");
    expect(sanitizeFtsQuery("café database")).toBe("caf database");
  });

  it("handles extremely long queries without hanging", () => {
    const longQuery = "webpack ".repeat(500);
    const result = sanitizeFtsQuery(longQuery);
    // Should complete quickly and produce a reasonable result
    expect(result.length).toBeGreaterThan(0);
    expect(result).toContain("webpack");
  });
});

// ---------------------------------------------------------------------------
// truncateAndNormalize edge cases
// ---------------------------------------------------------------------------

describe("truncateAndNormalize", () => {
  it("handles a zero vector without division by zero", () => {
    const result = truncateAndNormalize(new Array(EMBEDDING_DIMS).fill(0));
    expect(result.length).toBe(EMBEDDING_DIMS);
    expect(result[0]).toBe(0);
    // L2 norm should be 0 (no crash from dividing by zero)
    const norm = Math.sqrt(result.reduce((s, v) => s + v * v, 0));
    expect(norm).toBe(0);
  });

  it("zero-pads vectors shorter than EMBEDDING_DIMS", () => {
    const result = truncateAndNormalize([3, 4]); // 3-4-5 triangle → norm = 5
    expect(result.length).toBe(EMBEDDING_DIMS);
    expect(result[0]).toBeCloseTo(3 / 5);
    expect(result[1]).toBeCloseTo(4 / 5);
    expect(result[2]).toBe(0); // zero-padded
  });

  it("truncates vectors longer than EMBEDDING_DIMS", () => {
    const long = new Array(512).fill(0);
    long[0] = 1;
    long[300] = 999; // beyond EMBEDDING_DIMS — should be ignored
    const result = truncateAndNormalize(long);
    expect(result.length).toBe(EMBEDDING_DIMS);
    expect(result[0]).toBe(1); // only non-zero in truncated dims → norm = 1
  });
});

// ---------------------------------------------------------------------------
// VectorIndex search
// ---------------------------------------------------------------------------

describe("VectorIndex", () => {
  let db: ConvoDb;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vec-test-"));
    db = openDb(path.join(tmpDir, "test.sqlite"));
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeVec(mainDim: number, value: number): Float32Array {
    const vec = new Float32Array(EMBEDDING_DIMS);
    vec[mainDim] = value;
    // L2-normalize
    const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
    if (norm > 0) for (let i = 0; i < vec.length; i++) vec[i] /= norm;
    return vec;
  }

  it("search returns results ranked by cosine similarity", () => {
    db.upsertSession({ id: "s1" });
    db.upsertSession({ id: "s2" });
    db.storeEmbeddings("s1", [
      { turnIndex: 0, role: "user", textHash: "a", embedding: makeVec(0, 1) },
    ], 100);
    db.storeEmbeddings("s2", [
      { turnIndex: 0, role: "user", textHash: "b", embedding: makeVec(1, 1) },
    ], 100);

    const index = VectorIndex.fromDb(db);
    expect(index.count).toBe(2);

    // Query along dim 0 — should rank s1 higher
    const query = makeVec(0, 1);
    const results = index.search(query, 10);
    expect(results.length).toBe(2);
    expect(results[0].sessionId).toBe("s1");
    expect(results[0].score).toBeCloseTo(1.0);
    expect(results[1].sessionId).toBe("s2");
    expect(results[1].score).toBeCloseTo(0.0);
  });

  it("searchSessions aggregates per-session and returns best turn index", () => {
    const index = VectorIndex.fromDb(db); // empty

    // s1: two turns, dim 0 and dim 2
    index.addSession("s1", [
      { turnIndex: 0, role: "user", embedding: makeVec(0, 1) },    // strong match
      { turnIndex: 1, role: "assistant", embedding: makeVec(2, 1) }, // weak match
    ]);
    // s2: one turn, dim 1
    index.addSession("s2", [
      { turnIndex: 0, role: "user", embedding: makeVec(1, 1) },
    ]);

    // Query along dim 0 — s1 turn 0 is the best match
    const results = index.searchSessions(makeVec(0, 1), 10);
    expect(results.length).toBe(2);
    expect(results[0].sessionId).toBe("s1");
    expect(results[0].bestTurnIndex).toBe(0);   // turn 0 had highest score
    expect(results[0].matchCount).toBe(2);       // 2 turns in the session
    expect(results[0].bestScore).toBeCloseTo(1.0);
    expect(results[1].sessionId).toBe("s2");
  });

  it("searchSessions returns empty for empty index", () => {
    const index = VectorIndex.fromDb(db);
    const results = index.searchSessions(makeVec(0, 1), 10);
    expect(results).toEqual([]);
  });

  it("addSession and removeSession update the index correctly", () => {
    const index = VectorIndex.fromDb(db); // empty
    expect(index.count).toBe(0);

    index.addSession("s1", [
      { turnIndex: 0, role: "user", embedding: makeVec(0, 1) },
      { turnIndex: 1, role: "assistant", embedding: makeVec(1, 1) },
    ]);
    expect(index.count).toBe(2);

    index.removeSession("s1");
    expect(index.count).toBe(0);
    expect(index.search(makeVec(0, 1), 10)).toEqual([]);
  });
});
