// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

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
// EmbeddingEngine — subprocess-only ONNX model inference
// ---------------------------------------------------------------------------

/**
 * Embedding engine that runs the ONNX model exclusively in a subprocess
 * (embedding-worker.ts) to avoid blocking the main event loop and to
 * prevent loading the ~4 GB model twice.
 */
export class EmbeddingEngine {
  private readyPromise: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (err: Error) => void;
  private loaded = false;
  private failed = false;
  private disabled = false;

  // Subprocess state
  private subprocess: ReturnType<typeof Bun.spawn> | null = null;
  private subprocessReady = false;
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (v: Float32Array[]) => void; reject: (e: Error) => void }
  >();
  private stdoutBuffer = "";

  constructor() {
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    // Prevent unhandled rejection crash when no one calls waitReady()
    this.readyPromise.catch(() => {});

    // Allow users to opt out on constrained machines
    if (process.env.GLOSS_NO_EMBEDDINGS) {
      this.disabled = true;
      this.failed = true;
      console.log("[embeddings] Disabled via GLOSS_NO_EMBEDDINGS");
      this.rejectReady(new Error("Embeddings disabled via GLOSS_NO_EMBEDDINGS"));
      return;
    }

    this._initSubprocess();
  }

  private _initSubprocess(): void {
    try {
      const workerPath = new URL("./embedding-worker.ts", import.meta.url).pathname;
      this.subprocess = Bun.spawn(["bun", "run", workerPath], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "inherit",
      });

      // Read stdout as text stream
      const reader = this.subprocess.stdout.getReader();
      const decoder = new TextDecoder();
      const readLoop = async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            this.stdoutBuffer += decoder.decode(value, { stream: true });
            const lines = this.stdoutBuffer.split("\n");
            this.stdoutBuffer = lines.pop() || "";
            for (const line of lines) {
              if (line.trim()) this._handleMessage(line);
            }
          }
        } catch {
          // subprocess exited
        }
      };
      readLoop();

      // Handle subprocess exit
      this.subprocess.exited.then((code) => {
        this.loaded = false;
        this.subprocessReady = false;
        if (!this.failed) {
          this.failed = true;
          this.rejectReady(new Error(`Embedding subprocess exited with code ${code}`));
        }
        // Reject any pending requests
        for (const [, pending] of this.pending) {
          pending.reject(new Error("Embedding subprocess exited"));
        }
        this.pending.clear();
        this.subprocess = null;
      });
    } catch (err) {
      this.failed = true;
      const error = err instanceof Error ? err : new Error(String(err));
      console.error(`[embeddings] Failed to spawn subprocess: ${error.message}`);
      this.rejectReady(error);
    }
  }

  private _handleMessage(line: string): void {
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }

    if (msg.type === "ready") {
      this.subprocessReady = true;
      this.loaded = true;
      this.resolveReady();
      console.log("[embeddings] Subprocess model loaded");
      return;
    }

    if (msg.type === "status") {
      console.log(`[embeddings] ${msg.message}`);
      return;
    }

    // Response to an embed request: { id, embeddings } or { id, error }
    const pending = this.pending.get(msg.id);
    if (!pending) return;
    this.pending.delete(msg.id);

    if (msg.error) {
      pending.reject(new Error(msg.error));
    } else if (msg.embeddings) {
      const results = (msg.embeddings as number[][]).map(
        (vec) => new Float32Array(vec),
      );
      pending.resolve(results);
    }
  }

  /** Returns true once the subprocess model is loaded and ready. */
  isReady(): boolean {
    return this.loaded;
  }

  /** Returns true if model loading failed. */
  hasFailed(): boolean {
    return this.failed;
  }

  /** Wait for subprocess model to finish loading. */
  async waitReady(): Promise<void> {
    return this.readyPromise;
  }

  /**
   * Embed texts off the main thread via the subprocess.
   * Returns array of Float32Array(256).
   */
  async embedOffThread(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    if (this.subprocess && this.subprocessReady) {
      const id = this.nextId++;
      const promise = new Promise<Float32Array[]>((resolve, reject) => {
        this.pending.set(id, { resolve, reject });
      });
      try {
        this.subprocess.stdin.write(JSON.stringify({ id, texts }) + "\n");
      } catch (err) {
        this.pending.delete(id);
        this.subprocessReady = false;
        throw new Error("Embedding subprocess stdin write failed");
      }
      return promise;
    }
    throw new Error("Embedding subprocess not available");
  }

  /**
   * Embed a single query string. Applies the "query: " prefix
   * required by snowflake-arctic-embed for asymmetric retrieval.
   */
  async embedQuery(query: string): Promise<Float32Array> {
    if (!this.loaded) throw new Error("Embedding engine not ready");
    const results = await this.embedOffThread([`query: ${query}`]);
    return results[0];
  }

  /** Release subprocess resources. */
  dispose(): void {
    if (this.subprocess) {
      try {
        this.subprocess.kill();
      } catch {
        // already dead
      }
      this.subprocess = null;
    }
    this.subprocessReady = false;
    this.loaded = false;
  }
}

// ---------------------------------------------------------------------------
// Vector math helpers
// ---------------------------------------------------------------------------

/** Truncate to EMBEDDING_DIMS and L2-normalize. @internal exported for testing. */
export function truncateAndNormalize(vec: number[]): Float32Array {
  const out = new Float32Array(EMBEDDING_DIMS);
  let norm = 0;
  for (let i = 0; i < EMBEDDING_DIMS; i++) {
    const v = i < vec.length ? vec[i] : 0;
    out[i] = v;
    norm += v * v;
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
  score: number; // cosine similarity, -1..1 (vectors are L2-normalized, so dot = cosine)
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
   * Aggregates during the O(N) scan to avoid session starvation.
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
    if (this._count === 0) return [];

    // Aggregate per-session during the full scan — guarantees every session
    // is considered, regardless of how many turns any single session has.
    const sessionMap = new Map<
      string,
      { bestScore: number; bestTurnIndex: number; matchCount: number }
    >();

    for (let i = 0; i < this._count; i++) {
      const offset = i * EMBEDDING_DIMS;
      const vec = this.vectors.subarray(offset, offset + EMBEDDING_DIMS);
      const score = dot(queryVector, vec);

      const sessionId = this.sessionIds[i];
      const existing = sessionMap.get(sessionId);
      if (existing) {
        existing.matchCount++;
        if (score > existing.bestScore) {
          existing.bestScore = score;
          existing.bestTurnIndex = this.turnIndices[i];
        }
      } else {
        sessionMap.set(sessionId, {
          bestScore: score,
          bestTurnIndex: this.turnIndices[i],
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
