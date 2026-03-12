// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MODEL_NAME = "Snowflake/snowflake-arctic-embed-m-v2.0";
export const EMBEDDING_DIMS = 256;

/** Minimal interface for the db methods VectorIndex needs. */
export interface EmbeddingDb {
  loadAllEmbeddings(): {
    sessionIds: string[];
    turnIndices: number[];
    roles: string[];
    embeddings: Float32Array[];
  };
}

// ---------------------------------------------------------------------------
// EmbeddingEngine — lazy-loading singleton for ONNX model inference
// ---------------------------------------------------------------------------

/** Singleton embedding engine. Lazy-loads model on first use. */
export class EmbeddingEngine {
  private extractor: unknown | null = null;
  private readyPromise: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (err: Error) => void;
  private loaded = false;
  private failed = false;
  private disabled = false;

  constructor() {
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });

    // Allow users to opt out on constrained machines
    if (process.env.GLOSS_NO_EMBEDDINGS) {
      this.disabled = true;
      this.failed = true;
      console.log("[embeddings] Disabled via GLOSS_NO_EMBEDDINGS");
      this.rejectReady(new Error("Embeddings disabled via GLOSS_NO_EMBEDDINGS"));
      return;
    }

    this._init();
  }

  private async _init(): Promise<void> {
    try {
      // Dynamic import to avoid top-level blocking.
      // Try native ONNX runtime first, fall back to WASM if N-API fails in Bun.
      const { pipeline, env } = await import("@huggingface/transformers");
      try {
        this.extractor = await pipeline("feature-extraction", MODEL_NAME, {
          dtype: "q8",
        });
      } catch (nativeErr) {
        console.warn(`[embeddings] Native ONNX failed, trying WASM fallback: ${nativeErr instanceof Error ? nativeErr.message : nativeErr}`);
        if (env.backends?.onnx?.wasm) {
          env.backends.onnx.wasm.numThreads = 1;
        }
        this.extractor = await pipeline("feature-extraction", MODEL_NAME, {
          dtype: "q8",
          device: "wasm",
        });
      }
      this.loaded = true;
      this.resolveReady();
      console.log(`[embeddings] Model loaded: ${MODEL_NAME}`);
    } catch (err) {
      this.failed = true;
      const error = err instanceof Error ? err : new Error(String(err));
      console.error(`[embeddings] Failed to load model: ${error.message}`);
      this.rejectReady(error);
    }
  }

  /** Returns true once the model is loaded and ready. */
  isReady(): boolean {
    return this.loaded;
  }

  /** Returns true if model loading failed. */
  hasFailed(): boolean {
    return this.failed;
  }

  /** Wait for model to finish loading. */
  async waitReady(): Promise<void> {
    return this.readyPromise;
  }

  /**
   * Embed one or more text strings. Returns array of Float32Array(256).
   * Handles batching internally. Truncates input to model's max tokens.
   */
  async embed(texts: string[]): Promise<Float32Array[]> {
    if (!this.loaded || !this.extractor) {
      throw new Error("Embedding engine not ready");
    }

    if (texts.length === 0) return [];

    // Truncate each text to ~2000 chars for practical embedding size
    const truncated = texts.map((t) =>
      t.length > 2000 ? t.slice(0, 2000) : t,
    );

    const extractor = this.extractor as (
      texts: string[],
      options: { pooling: string; normalize: boolean },
    ) => Promise<{ tolist(): number[][] }>;

    const output = await extractor(truncated, {
      pooling: "cls",
      normalize: true,
    });

    const fullVectors = output.tolist();
    // Matryoshka truncation: take first 256 dims, then L2-normalize
    return fullVectors.map((vec) => truncateAndNormalize(vec));
  }

  /**
   * Embed a single query string. Applies the "query: " prefix
   * required by snowflake-arctic-embed for asymmetric retrieval.
   */
  async embedQuery(query: string): Promise<Float32Array> {
    const prefixed = `query: ${query}`;
    const results = await this.embed([prefixed]);
    return results[0];
  }

  /** Release model resources. */
  dispose(): void {
    this.extractor = null;
    this.loaded = false;
  }
}

// ---------------------------------------------------------------------------
// Vector math helpers
// ---------------------------------------------------------------------------

/** Truncate to EMBEDDING_DIMS and L2-normalize. */
function truncateAndNormalize(vec: number[]): Float32Array {
  const out = new Float32Array(EMBEDDING_DIMS);
  let norm = 0;
  for (let i = 0; i < EMBEDDING_DIMS; i++) {
    out[i] = vec[i];
    norm += vec[i] * vec[i];
  }
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < EMBEDDING_DIMS; i++) {
      out[i] /= norm;
    }
  }
  return out;
}

/** Dot product of two Float32Arrays of equal length. */
function dot(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    sum += a[i] * b[i];
  }
  return sum;
}

// ---------------------------------------------------------------------------
// VectorSearchResult
// ---------------------------------------------------------------------------

export interface VectorSearchResult {
  sessionId: string;
  turnIndex: number;
  role: string;
  score: number; // cosine similarity, 0-1
}

// ---------------------------------------------------------------------------
// VectorIndex — in-memory brute-force cosine search
// ---------------------------------------------------------------------------

/**
 * In-memory vector index for fast cosine similarity search.
 * Stores all embeddings in flat typed arrays for cache-friendly scanning.
 */
export class VectorIndex {
  private sessionIds: string[];
  private turnIndices: number[];
  private roles: string[];
  private vectors: Float32Array; // flat buffer: N × 256
  private _count: number;

  private constructor(
    sessionIds: string[],
    turnIndices: number[],
    roles: string[],
    vectors: Float32Array,
    count: number,
  ) {
    this.sessionIds = sessionIds;
    this.turnIndices = turnIndices;
    this.roles = roles;
    this.vectors = vectors;
    this._count = count;
  }

  /** Number of vectors in the index. */
  get count(): number {
    return this._count;
  }

  /** Load all embeddings from the database into memory. */
  static fromDb(db: EmbeddingDb): VectorIndex {
    const data = db.loadAllEmbeddings();
    const count = data.sessionIds.length;
    // Flatten embeddings into a single contiguous buffer
    const flat = new Float32Array(count * EMBEDDING_DIMS);
    for (let i = 0; i < count; i++) {
      flat.set(data.embeddings[i], i * EMBEDDING_DIMS);
    }
    return new VectorIndex(
      data.sessionIds,
      data.turnIndices,
      data.roles,
      flat,
      count,
    );
  }

  /** Remove all vectors for a session (used before re-indexing). */
  removeSession(sessionId: string): void {
    // Find indices to keep (everything except this session)
    const keepIndices: number[] = [];
    for (let i = 0; i < this._count; i++) {
      if (this.sessionIds[i] !== sessionId) {
        keepIndices.push(i);
      }
    }
    if (keepIndices.length === this._count) return; // nothing to remove

    const newCount = keepIndices.length;
    const newVectors = new Float32Array(newCount * EMBEDDING_DIMS);
    const newSessionIds: string[] = [];
    const newTurnIndices: number[] = [];
    const newRoles: string[] = [];

    for (let j = 0; j < keepIndices.length; j++) {
      const i = keepIndices[j];
      newSessionIds.push(this.sessionIds[i]);
      newTurnIndices.push(this.turnIndices[i]);
      newRoles.push(this.roles[i]);
      const src = this.vectors.subarray(i * EMBEDDING_DIMS, (i + 1) * EMBEDDING_DIMS);
      newVectors.set(src, j * EMBEDDING_DIMS);
    }

    this.sessionIds = newSessionIds;
    this.turnIndices = newTurnIndices;
    this.roles = newRoles;
    this.vectors = newVectors;
    this._count = newCount;
  }

  /** Add vectors for a newly-indexed session (removes stale vectors first). */
  addSession(
    sessionId: string,
    entries: Array<{
      turnIndex: number;
      role: string;
      embedding: Float32Array;
    }>,
  ): void {
    if (entries.length === 0) return;

    // Remove stale vectors for this session before appending new ones
    this.removeSession(sessionId);

    const newCount = this._count + entries.length;
    const newVectors = new Float32Array(newCount * EMBEDDING_DIMS);
    newVectors.set(this.vectors);

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      this.sessionIds.push(sessionId);
      this.turnIndices.push(entry.turnIndex);
      this.roles.push(entry.role);
      newVectors.set(entry.embedding, (this._count + i) * EMBEDDING_DIMS);
    }

    this.vectors = newVectors;
    this._count = newCount;
  }

  /**
   * Find top-K turns most similar to the query vector.
   * Returns results sorted by score descending.
   */
  search(queryVector: Float32Array, topK = 50): VectorSearchResult[] {
    if (this._count === 0) return [];

    // Score all vectors (vectors are pre-normalized, so dot = cosine sim)
    const scores: Array<{ idx: number; score: number }> = [];
    for (let i = 0; i < this._count; i++) {
      const offset = i * EMBEDDING_DIMS;
      const vec = this.vectors.subarray(offset, offset + EMBEDDING_DIMS);
      const score = dot(queryVector, vec);
      scores.push({ idx: i, score });
    }

    // Partial sort: find top K
    scores.sort((a, b) => b.score - a.score);
    const top = scores.slice(0, topK);

    return top.map(({ idx, score }) => ({
      sessionId: this.sessionIds[idx],
      turnIndex: this.turnIndices[idx],
      role: this.roles[idx],
      score,
    }));
  }

  /**
   * Aggregate turn-level results to session-level.
   * Returns sessions ranked by their best turn's score.
   */
  searchSessions(
    queryVector: Float32Array,
    topK = 30,
  ): Array<{
    sessionId: string;
    bestScore: number;
    bestTurnIndex: number;
    matchCount: number;
  }> {
    // Get more turn-level results to ensure good session coverage
    const turnResults = this.search(queryVector, topK * 5);

    // Aggregate by session
    const sessionMap = new Map<
      string,
      { bestScore: number; bestTurnIndex: number; matchCount: number }
    >();

    for (const r of turnResults) {
      const existing = sessionMap.get(r.sessionId);
      if (existing) {
        existing.matchCount++;
        if (r.score > existing.bestScore) {
          existing.bestScore = r.score;
          existing.bestTurnIndex = r.turnIndex;
        }
      } else {
        sessionMap.set(r.sessionId, {
          bestScore: r.score,
          bestTurnIndex: r.turnIndex,
          matchCount: 1,
        });
      }
    }

    // Sort by best score descending
    const results = [...sessionMap.entries()]
      .map(([sessionId, data]) => ({ sessionId, ...data }))
      .sort((a, b) => b.bestScore - a.bestScore);

    return results.slice(0, topK);
  }
}
