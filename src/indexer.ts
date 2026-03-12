import * as fs from "node:fs";
import * as crypto from "node:crypto";
import { IncrementalParser } from "./incremental-parser.js";
import type { ConvoDb } from "./db.js";
import type { EmbeddingEngine, VectorIndex } from "./embeddings.js";
import type { TextBlock } from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Max file size for embedding indexing (100MB). Larger files skipped. */
const EMBEDDING_INDEX_LIMIT = 100 * 1024 * 1024;

/** Max characters per turn to embed (practical truncation limit). */
const MAX_TURN_CHARS = 2000;

/** Number of turns per embedding batch call. */
const DEFAULT_BATCH_SIZE = 32;

// ---------------------------------------------------------------------------
// Turn text extraction
// ---------------------------------------------------------------------------

/** Extract embeddable text from a turn (text blocks only, no tools/thinking). */
function turnToEmbeddingText(blocks: Array<{ type: string; text?: string }>): string {
  return blocks
    .filter((b): b is TextBlock => b.type === "text")
    .map((b) => b.text || "")
    .join("\n")
    .trim();
}

/** SHA-256 hash of text for dedup/staleness detection. */
function textHash(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

// ---------------------------------------------------------------------------
// Background embedding indexer
// ---------------------------------------------------------------------------

/**
 * Background embedding indexer. Scans sessions and generates embeddings.
 * Modeled after backfillFtsIndex() in discovery.ts.
 */
export function backfillEmbeddings(
  db: ConvoDb,
  engine: EmbeddingEngine,
  vectorIndex: VectorIndex | null,
  options?: {
    batchSize?: number;
    onProgress?: (indexed: number, total: number) => void;
  },
): void {
  if (!engine.isReady()) {
    console.log("[embeddings] Engine not ready, skipping backfill");
    return;
  }

  const batchSize = options?.batchSize ?? DEFAULT_BATCH_SIZE;

  // listSessions returns sessions ordered by last_modified DESC,
  // so recent conversations get embedded first during initial backfill.
  const sessions = db.listSessions({}) as Array<{
    id: string;
    jsonl_path?: string | null;
    file_size?: number | null;
  }>;

  // Find sessions needing embedding
  const needsIndexing: Array<{ id: string; jsonl_path: string; mtime: number }> = [];
  for (const s of sessions) {
    if (!s.jsonl_path) continue;
    try {
      const stat = fs.statSync(s.jsonl_path);
      if (!stat.isFile() || stat.size > EMBEDDING_INDEX_LIMIT) continue;
      const mtime = Math.floor(stat.mtimeMs / 1000);
      if (db.embeddingNeedsIndexing(s.id, mtime)) {
        needsIndexing.push({ id: s.id, jsonl_path: s.jsonl_path, mtime });
      }
    } catch {
      continue;
    }
  }

  if (needsIndexing.length === 0) return;

  // Sort by mtime descending so recent conversations get embedded first
  needsIndexing.sort((a, b) => b.mtime - a.mtime);

  console.log(`Embedding ${needsIndexing.length} sessions...`);
  let i = 0;
  let indexed = 0;
  let totalTurns = 0;

  const processSession = async () => {
    if (i >= needsIndexing.length) {
      console.log(`Embeddings: ${indexed} sessions indexed (${totalTurns} turns)`);
      return;
    }

    const s = needsIndexing[i];
    i++;

    try {
      const content = fs.readFileSync(s.jsonl_path, "utf-8");
      const parser = new IncrementalParser();
      parser.feedLines(content.split("\n"));
      const turns = parser.getTurns();

      // Extract text and filter empty turns
      const turnTexts: Array<{ index: number; role: string; text: string; hash: string }> = [];
      for (let t = 0; t < turns.length; t++) {
        const text = turnToEmbeddingText(turns[t].blocks);
        if (!text) continue;
        const truncated = text.length > MAX_TURN_CHARS ? text.slice(0, MAX_TURN_CHARS) : text;
        turnTexts.push({
          index: t,
          role: turns[t].role,
          text: truncated,
          hash: textHash(truncated),
        });
      }

      if (turnTexts.length === 0) {
        setTimeout(processSession, 10);
        return;
      }

      // Embed in batches
      const entries: Array<{
        turnIndex: number;
        role: string;
        textHash: string;
        embedding: Float32Array;
      }> = [];

      for (let b = 0; b < turnTexts.length; b += batchSize) {
        const batch = turnTexts.slice(b, b + batchSize);
        const texts = batch.map((t) => t.text);
        const embeddings = await engine.embed(texts);
        for (let j = 0; j < batch.length; j++) {
          entries.push({
            turnIndex: batch[j].index,
            role: batch[j].role,
            textHash: batch[j].hash,
            embedding: embeddings[j],
          });
        }
      }

      // Store in DB
      db.storeEmbeddings(s.id, entries, s.mtime);

      // Update in-memory vector index if available
      if (vectorIndex) {
        vectorIndex.addSession(
          s.id,
          entries.map((e) => ({
            turnIndex: e.turnIndex,
            role: e.role,
            embedding: e.embedding,
          })),
        );
      }

      indexed++;
      totalTurns += entries.length;
      options?.onProgress?.(indexed, needsIndexing.length);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[embeddings] Error indexing session ${s.id}: ${msg}`);
    }

    // Yield to event loop between sessions
    setTimeout(processSession, 10);
  };

  processSession();
}
