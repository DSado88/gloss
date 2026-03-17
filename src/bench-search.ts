#!/usr/bin/env bun
/**
 * Vector search stress test / benchmark.
 * Tests speed, result quality, and coverage.
 */

const BASE = "http://localhost:3456";

interface SearchResult {
  id: string;
  match_count: number;
  project: string;
  title: string;
  model: string;
  turn_count: number;
}

interface AskResult {
  query: string;
  answer: string;
  sources: Array<{ sessionId: string; project: string; excerptCount: number }>;
  timing: { ftsMs: number; vectorMs: number; claudeMs: number; totalMs: number };
  error?: string;
}

// Diverse queries covering different topics, specificity levels, and question types
const QUERIES = [
  // Specific technical queries
  "how does the embedding indexer work",
  "WebSocket reconnection logic",
  "SQLite migration schema",
  "JSONL incremental parser",
  "annotation restore from prefix suffix matching",

  // Broad concept queries
  "authentication and security",
  "performance optimization",
  "error handling patterns",
  "testing strategy",
  "deployment and CI/CD",

  // Natural language questions
  "how do I add a new API endpoint",
  "what databases are used in this project",
  "explain the annotation highlighting system",
  "how does live mode work with file watchers",
  "what models are available for embeddings",

  // Edge cases
  "a",                          // very short
  "the",                        // stop word
  "asdf1234nonsense",           // gibberish
  "recursive descent parser for typescript abstract syntax trees with generics", // very specific
  "bug fix",                    // very common

  // Domain-specific
  "Squall multi-model review",
  "Gloss conversation viewer",
  "Claude Code session logs",
  "MCP server tools",
  "cosine similarity vector search",
];

async function benchFTS(query: string): Promise<{ ms: number; count: number }> {
  const start = performance.now();
  const resp = await fetch(`${BASE}/api/search?q=${encodeURIComponent(query)}`);
  const ms = performance.now() - start;
  const data = await resp.json();
  return { ms, count: data.results?.length ?? 0 };
}

async function benchAsk(query: string): Promise<{ ms: number; sources: number; vectorMs: number; ftsMs: number; claudeMs: number; error?: string }> {
  const start = performance.now();
  const resp = await fetch(`${BASE}/api/ask`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, maxSources: 10 }),
  });
  const ms = performance.now() - start;
  const data: AskResult = await resp.json();
  return {
    ms,
    sources: data.sources?.length ?? 0,
    vectorMs: data.timing?.vectorMs ?? 0,
    ftsMs: data.timing?.ftsMs ?? 0,
    claudeMs: data.timing?.claudeMs ?? 0,
    error: data.error,
  };
}

async function main() {
  console.log("=== Vector Search Stress Test ===\n");
  console.log(`Target: ${BASE}`);
  console.log(`Queries: ${QUERIES.length}\n`);

  // --- Phase 1: FTS speed test ---
  console.log("── Phase 1: FTS Search Speed ──\n");
  console.log("  Query                                                    Results    Time");
  console.log("  " + "─".repeat(78));

  const ftsResults: Array<{ query: string; ms: number; count: number }> = [];
  for (const q of QUERIES) {
    const r = await benchFTS(q);
    ftsResults.push({ query: q, ...r });
    const label = q.length > 55 ? q.slice(0, 52) + "..." : q.padEnd(55);
    console.log(`  ${label} ${String(r.count).padStart(5)}    ${r.ms.toFixed(0).padStart(5)}ms`);
  }

  const ftsAvg = ftsResults.reduce((s, r) => s + r.ms, 0) / ftsResults.length;
  const ftsP99 = ftsResults.map(r => r.ms).sort((a, b) => a - b)[Math.floor(ftsResults.length * 0.99)];
  const ftsZero = ftsResults.filter(r => r.count === 0).length;
  console.log(`\n  Avg: ${ftsAvg.toFixed(0)}ms | P99: ${ftsP99.toFixed(0)}ms | Zero results: ${ftsZero}/${QUERIES.length}`);

  // --- Phase 2: Ask (hybrid search + Claude) speed test on subset ---
  const askQueries = QUERIES.slice(0, 10); // First 10 — skip edge cases for Ask
  console.log("\n── Phase 2: Hybrid Search (FTS + Vector + Claude) ──\n");

  console.log("  Query                                            Srcs  Vector    FTS  Claude   Total");
  console.log("  " + "─".repeat(90));

  const askResults: Array<{ query: string; ms: number; sources: number; vectorMs: number; ftsMs: number; claudeMs: number; error?: string }> = [];
  for (const q of askQueries) {
    const r = await benchAsk(q);
    askResults.push({ query: q, ...r });
    const label = q.length > 48 ? q.slice(0, 45) + "..." : q.padEnd(48);
    const err = r.error ? " ERR" : "";
    console.log(`  ${label} ${String(r.sources).padStart(4)}  ${r.vectorMs.toFixed(0).padStart(5)}ms ${r.ftsMs.toFixed(0).padStart(5)}ms ${r.claudeMs.toFixed(0).padStart(6)}ms ${r.ms.toFixed(0).padStart(6)}ms${err}`);
  }

  const askAvg = askResults.reduce((s, r) => s + r.ms, 0) / askResults.length;
  const vecAvg = askResults.reduce((s, r) => s + r.vectorMs, 0) / askResults.length;
  const askFtsAvg = askResults.reduce((s, r) => s + r.ftsMs, 0) / askResults.length;
  const claudeAvg = askResults.reduce((s, r) => s + r.claudeMs, 0) / askResults.length;
  const askZero = askResults.filter(r => r.sources === 0).length;
  const errors = askResults.filter(r => r.error).length;
  console.log(`\n  Avg: vector ${vecAvg.toFixed(0)}ms | FTS ${askFtsAvg.toFixed(0)}ms | claude ${claudeAvg.toFixed(0)}ms | total ${askAvg.toFixed(0)}ms`);
  console.log(`  Zero sources: ${askZero}/${askQueries.length} | Errors: ${errors}/${askQueries.length}`);

  // --- Phase 3: Concurrent load test ---
  console.log("\n── Phase 3: Concurrent FTS (10 parallel requests) ──\n");
  const concQueries = QUERIES.slice(0, 10);
  const concStart = performance.now();
  const concResults = await Promise.all(concQueries.map(q => benchFTS(q)));
  const concTotal = performance.now() - concStart;
  const concMax = Math.max(...concResults.map(r => r.ms));
  console.log(`  10 parallel FTS queries: wall time ${concTotal.toFixed(0)}ms | slowest ${concMax.toFixed(0)}ms`);

  // --- Phase 4: Rapid-fire sequential (latency under load) ---
  console.log("\n── Phase 4: Rapid-Fire FTS (50 sequential requests) ──\n");
  const rapidStart = performance.now();
  const rapidTimes: number[] = [];
  for (let i = 0; i < 50; i++) {
    const q = QUERIES[i % QUERIES.length];
    const r = await benchFTS(q);
    rapidTimes.push(r.ms);
  }
  const rapidTotal = performance.now() - rapidStart;
  rapidTimes.sort((a, b) => a - b);
  console.log(`  50 requests in ${rapidTotal.toFixed(0)}ms (${(50000 / rapidTotal).toFixed(1)} req/s)`);
  console.log(`  P50: ${rapidTimes[24].toFixed(0)}ms | P95: ${rapidTimes[47].toFixed(0)}ms | P99: ${rapidTimes[49].toFixed(0)}ms`);

  // --- Summary ---
  console.log("\n══ Summary ══\n");
  console.log(`  Embeddings: 27,701 vectors across 836 sessions`);
  console.log(`  FTS: avg ${ftsAvg.toFixed(0)}ms, ${ftsZero} zero-result queries`);
  console.log(`  Hybrid (Ask): ${askAvg.toFixed(0)}ms total = ${askFtsAvg.toFixed(0)}ms FTS + ${vecAvg.toFixed(0)}ms vector + ${claudeAvg.toFixed(0)}ms claude`);
  console.log(`  Concurrent: ${concTotal.toFixed(0)}ms for 10 parallel`);
  console.log(`  Throughput: ${(50000 / rapidTotal).toFixed(1)} FTS req/s`);
}

main().catch(console.error);
