import { describe, it, expect } from "vitest";
import { mergeFtsHits, sanitizeFtsQuery } from "./ask.js";

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
});
