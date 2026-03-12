import { describe, it, expect } from "vitest";
import { VectorIndex, EMBEDDING_DIMS, truncateAndNormalize } from "./embeddings.js";
import type { EmbeddingDb } from "./embeddings.js";

// Helper to create a mock EmbeddingDb
function mockDb(data: {
  sessionIds: string[];
  turnIndices: number[];
  roles: string[];
  embeddings: Float32Array[];
}): EmbeddingDb {
  return { loadAllEmbeddings: () => data };
}

// Helper to create a normalized vector with given leading components
function makeVec(...values: number[]): Float32Array {
  const vec = new Float32Array(EMBEDDING_DIMS);
  for (let i = 0; i < Math.min(values.length, EMBEDDING_DIMS); i++) {
    vec[i] = values[i];
  }
  let norm = 0;
  for (let i = 0; i < EMBEDDING_DIMS; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < EMBEDDING_DIMS; i++) vec[i] /= norm;
  return vec;
}

// ---------------------------------------------------------------------------
// Bug #1: truncateAndNormalize NaN propagation from short vectors
// ---------------------------------------------------------------------------

describe("truncateAndNormalize", () => {
  it("handles vectors shorter than EMBEDDING_DIMS without producing NaN", () => {
    const shortVec = [0.5, 0.3, 0.1]; // only 3 elements, 256 expected
    const result = truncateAndNormalize(shortVec);

    expect(result.length).toBe(EMBEDDING_DIMS);
    for (let i = 0; i < result.length; i++) {
      expect(Number.isNaN(result[i])).toBe(false);
    }
    // First 3 should be non-zero (normalized), rest should be 0
    expect(result[0]).not.toBe(0);
    expect(result[3]).toBe(0);
    expect(result[255]).toBe(0);
  });

  it("handles empty vector without producing NaN", () => {
    const result = truncateAndNormalize([]);
    expect(result.length).toBe(EMBEDDING_DIMS);
    for (let i = 0; i < result.length; i++) {
      expect(Number.isNaN(result[i])).toBe(false);
    }
  });

  it("handles full-length vector correctly", () => {
    const fullVec = new Array(EMBEDDING_DIMS).fill(0);
    fullVec[0] = 1.0;
    const result = truncateAndNormalize(fullVec);
    expect(result[0]).toBeCloseTo(1.0);
    expect(Number.isNaN(result[0])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Bug #4: Score comment says 0-1 but cosine can be negative
// ---------------------------------------------------------------------------

describe("VectorIndex.search", () => {
  it("can return negative cosine similarity scores", () => {
    const v1 = makeVec(1, 0);
    const v2 = makeVec(-1, 0);
    const index = VectorIndex.fromDb(
      mockDb({
        sessionIds: ["pos", "neg"],
        turnIndices: [0, 0],
        roles: ["user", "user"],
        embeddings: [v1, v2],
      }),
    );

    const query = makeVec(1, 0);
    const results = index.search(query, 10);
    const negResult = results.find((r) => r.sessionId === "neg");
    expect(negResult).toBeDefined();
    expect(negResult!.score).toBeLessThan(0);
  });

  it("returns valid (non-NaN) scores for all results", () => {
    const v1 = makeVec(1, 0);
    const v2 = makeVec(0, 1);
    const index = VectorIndex.fromDb(
      mockDb({
        sessionIds: ["s1", "s2"],
        turnIndices: [0, 0],
        roles: ["user", "user"],
        embeddings: [v1, v2],
      }),
    );

    const query = makeVec(1, 0);
    const results = index.search(query, 10);
    for (const r of results) {
      expect(Number.isNaN(r.score)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Bug #3: Session starvation in searchSessions
// ---------------------------------------------------------------------------

describe("VectorIndex.searchSessions", () => {
  it("does not starve sessions when one has many more turns", () => {
    const sessionIds: string[] = [];
    const turnIndices: number[] = [];
    const roles: string[] = [];
    const embeddings: Float32Array[] = [];

    // "big" session: 200 turns, all somewhat aligned with query
    for (let i = 0; i < 200; i++) {
      sessionIds.push("big");
      turnIndices.push(i);
      roles.push("user");
      embeddings.push(makeVec(0.9, 0.1 * (i % 5)));
    }

    // "small" session: 2 turns, well-aligned with query
    for (let i = 0; i < 2; i++) {
      sessionIds.push("small");
      turnIndices.push(i);
      roles.push("user");
      embeddings.push(makeVec(0.85, 0.15));
    }

    const index = VectorIndex.fromDb(
      mockDb({ sessionIds, turnIndices, roles, embeddings }),
    );

    // topK=2 means searchSessions should return at most 2 sessions
    // With the old code: search(query, 2*5=10) returns top 10 turns,
    // which are all from "big" → "small" is starved out
    const query = makeVec(1, 0);
    const results = index.searchSessions(query, 2);

    const ids = results.map((r) => r.sessionId);
    expect(ids).toContain("big");
    expect(ids).toContain("small");
  });
});

// ---------------------------------------------------------------------------
// Bug #2: Unhandled promise rejection in EmbeddingEngine constructor
// ---------------------------------------------------------------------------

describe("EmbeddingEngine", () => {
  it("does not produce unhandled rejection when GLOSS_NO_EMBEDDINGS is set", async () => {
    const original = process.env.GLOSS_NO_EMBEDDINGS;
    process.env.GLOSS_NO_EMBEDDINGS = "1";

    let unhandled = false;
    const handler = () => {
      unhandled = true;
    };
    process.on("unhandledRejection", handler);

    try {
      // Dynamic import to avoid model loading in other tests
      const { EmbeddingEngine } = await import("./embeddings.js");
      const engine = new EmbeddingEngine();
      expect(engine.hasFailed()).toBe(true);
      expect(engine.isReady()).toBe(false);

      // Give event loop time to surface any unhandled rejection
      await new Promise((r) => setTimeout(r, 200));

      expect(unhandled).toBe(false);
    } finally {
      process.off("unhandledRejection", handler);
      if (original === undefined) delete process.env.GLOSS_NO_EMBEDDINGS;
      else process.env.GLOSS_NO_EMBEDDINGS = original;
    }
  });
});
