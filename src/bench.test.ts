/**
 * Stress tests and benchmarks for performance-critical paths.
 *
 * Run:  bun test src/bench.test.ts
 *
 * Design principles:
 *   - Multi-iteration timing with p50/p95 (single-sample is noise)
 *   - Realistic scale (match or exceed production numbers)
 *   - Cover every hot path that touches user-perceived latency
 *   - Generous thresholds that catch major regressions (5-10x blowups)
 *   - Benchmarks print exact timings; thresholds are regression guards, not SLAs
 *   - Fuzz tests run against real subsystems, not just sanitizers
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { IncrementalParser } from "./incremental-parser.js";
import {
  VectorIndex,
  EMBEDDING_DIMS,
  truncateAndNormalize,
} from "./embeddings.js";
import type { EmbeddingDb } from "./embeddings.js";
import {
  scanProjectsDir,
  syncToDb,
  clearDiscoveryCache,
  type DiscoveredSession,
} from "./discovery.js";
import { openDb, type ConvoDb } from "./db.js";
import { mergeFtsHits, sanitizeFtsQuery } from "./ask.js";

// ---------------------------------------------------------------------------
// Timing utilities
// ---------------------------------------------------------------------------

/** Run fn N times, return sorted durations in ms. */
function bench(fn: () => void, iterations = 20): number[] {
  // Warmup
  fn();
  const times: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    fn();
    times.push(performance.now() - t0);
  }
  return times.sort((a, b) => a - b);
}

/** Async version of bench. */
async function benchAsync(fn: () => Promise<void>, iterations = 10): Promise<number[]> {
  await fn();
  const times: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    await fn();
    times.push(performance.now() - t0);
  }
  return times.sort((a, b) => a - b);
}

function p50(sorted: number[]): number {
  return sorted[Math.floor(sorted.length * 0.5)];
}
function p95(sorted: number[]): number {
  return sorted[Math.floor(sorted.length * 0.95)];
}
function fmt(sorted: number[]): string {
  return `p50=${p50(sorted).toFixed(1)}ms p95=${p95(sorted).toFixed(1)}ms min=${sorted[0].toFixed(1)}ms`;
}

function makeTempDir(prefix = "gloss-bench-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// ---------------------------------------------------------------------------
// Data generators
// ---------------------------------------------------------------------------

function randomVec(): Float32Array {
  const raw = Array.from({ length: EMBEDDING_DIMS }, () => Math.random() - 0.5);
  return truncateAndNormalize(raw);
}

function mockEmbeddingDb(numSessions: number, turnsPerSession: number): EmbeddingDb {
  const sessionIds: string[] = [];
  const turnIndices: number[] = [];
  const roles: string[] = [];
  const embeddings: Float32Array[] = [];
  for (let s = 0; s < numSessions; s++) {
    const sid = `session-${String(s).padStart(6, "0")}`;
    for (let t = 0; t < turnsPerSession; t++) {
      sessionIds.push(sid);
      turnIndices.push(t);
      roles.push(t % 2 === 0 ? "user" : "assistant");
      embeddings.push(randomVec());
    }
  }
  return { loadAllEmbeddings: () => ({ sessionIds, turnIndices, roles, embeddings }) };
}

/** Write a JSONL with N turns of realistic content size. */
function writeJsonl(filePath: string, sessionId: string, turnCount: number): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const lines: string[] = [
    JSON.stringify({ type: "summary", sessionId, cwd: "/home/user/project", version: "1.0.0" }),
  ];
  for (let i = 0; i < turnCount; i++) {
    if (i % 2 === 0) {
      lines.push(JSON.stringify({
        type: "user",
        sessionId,
        message: { content: `User message ${i}: ${"lorem ipsum dolor sit amet ".repeat(10)}` },
        timestamp: new Date(Date.now() - (turnCount - i) * 60_000).toISOString(),
      }));
    } else {
      lines.push(JSON.stringify({
        type: "assistant",
        message: {
          content: [{ type: "text", text: `Response ${i}: ${"consectetur adipiscing elit sed do eiusmod ".repeat(15)}` }],
          model: "claude-sonnet-4-20250514",
        },
        timestamp: new Date(Date.now() - (turnCount - i) * 60_000).toISOString(),
      }));
    }
  }
  fs.writeFileSync(filePath, lines.join("\n") + "\n", "utf-8");
}

/** Build lines for a large conversation without writing to disk. */
function buildConversationLines(turnCount: number): string[] {
  const lines: string[] = [
    JSON.stringify({ type: "summary", sessionId: "bench-session", cwd: "/test" }),
  ];
  for (let i = 0; i < turnCount; i++) {
    if (i % 3 === 0) {
      // User with tool result mixed in
      lines.push(JSON.stringify({
        type: "user",
        message: { content: `Question ${i}: How do I fix the ${["webpack", "vite", "esbuild"][i % 3]} config for ${["production", "development", "testing"][i % 3]}?` },
        timestamp: new Date(Date.now() - (turnCount - i) * 60_000).toISOString(),
      }));
    } else if (i % 3 === 1) {
      // Assistant with code block
      lines.push(JSON.stringify({
        type: "assistant",
        message: {
          content: [{
            type: "text",
            text: `Here's the solution:\n\n\`\`\`typescript\nconst config = {\n  mode: "production",\n  entry: "./src/index.ts",\n  output: { path: "./dist", filename: "bundle.js" },\n  module: { rules: [{ test: /\\.tsx?$/, use: "ts-loader" }] },\n  resolve: { extensions: [".ts", ".tsx", ".js"] },\n};\nexport default config;\n\`\`\`\n\nThis configures ${"the build pipeline with optimizations ".repeat(8)}`,
          }],
          model: "claude-sonnet-4-20250514",
        },
      }));
    } else {
      // Tool use + result
      lines.push(JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", id: `tool_${i}`, name: "Read", input: { file_path: `/src/file${i}.ts` } },
          ],
          model: "claude-sonnet-4-20250514",
        },
      }));
      lines.push(JSON.stringify({
        type: "user",
        message: {
          content: [
            { type: "tool_result", tool_use_id: `tool_${i}`, content: `export function handler${i}() {\n  return { status: 200 };\n}\n` },
          ],
        },
      }));
    }
  }
  return lines;
}

// ===========================================================================
// 1. VectorIndex — search at production scale
// ===========================================================================

describe("bench: VectorIndex", () => {
  // 30K vectors matches production (27K). Also test scaling to 100K.
  const SESSIONS = 2000;
  const TURNS_PER = 15;
  let index: VectorIndex;

  beforeAll(() => {
    index = VectorIndex.fromDb(mockEmbeddingDb(SESSIONS, TURNS_PER));
  });

  it("fromDb loads 30K vectors", () => {
    // Pre-generate data so we measure fromDb, not random vector generation
    const prebuilt = mockEmbeddingDb(SESSIONS, TURNS_PER);
    const times = bench(() => {
      VectorIndex.fromDb(prebuilt);
    }, 5);
    console.log(`  fromDb(30K): ${fmt(times)}`);
    expect(index.count).toBe(SESSIONS * TURNS_PER);
    expect(p95(times)).toBeLessThan(50);
  });

  it("search top-50 at 30K vectors", () => {
    const query = randomVec();
    const times = bench(() => { index.search(query, 50); }, 30);
    console.log(`  search(top-50, 30K): ${fmt(times)}`);
    expect(p50(times)).toBeLessThan(80);
    expect(p95(times)).toBeLessThan(120);

    // Correctness: sorted descending
    const results = index.search(query, 50);
    for (let i = 1; i < results.length; i++) {
      expect(results[i].score).toBeLessThanOrEqual(results[i - 1].score);
    }
  });

  it("searchSessions top-30 at 30K vectors", () => {
    const query = randomVec();
    const times = bench(() => { index.searchSessions(query, 30); }, 30);
    console.log(`  searchSessions(top-30, 30K): ${fmt(times)}`);
    expect(p50(times)).toBeLessThan(50);
    expect(p95(times)).toBeLessThan(80);
  });

  it("scales to 100K vectors without blowing up", { timeout: 30_000 }, () => {
    const bigIndex = VectorIndex.fromDb(mockEmbeddingDb(5000, 20));
    expect(bigIndex.count).toBe(100_000);

    const query = randomVec();
    const times = bench(() => { bigIndex.searchSessions(query, 30); }, 10);
    console.log(`  searchSessions(top-30, 100K): ${fmt(times)}`);
    // ~3.3x more vectors, expect ~3.3x slower (linear scan)
    expect(p50(times)).toBeLessThan(200);
  });

  it("addSession + removeSession churn", () => {
    const entries = Array.from({ length: 50 }, (_, i) => ({
      turnIndex: i,
      role: "user" as const,
      embedding: randomVec(),
    }));
    const times = bench(() => {
      index.addSession("bench-churn", entries);
      index.removeSession("bench-churn");
    });
    console.log(`  add(50)+remove churn: ${fmt(times)}`);
    expect(index.count).toBe(SESSIONS * TURNS_PER);
    expect(p95(times)).toBeLessThan(100);
  });
});

// ===========================================================================
// 2. IncrementalParser — parse throughput
// ===========================================================================

describe("bench: IncrementalParser", () => {
  it("parses 500-turn conversation", () => {
    const lines = buildConversationLines(500);
    const times = bench(() => {
      const p = new IncrementalParser();
      p.feedLines(lines);
      p.getTurns();
    });
    console.log(`  parse 500 turns: ${fmt(times)}`);
    expect(p50(times)).toBeLessThan(30);
  });

  it("parses 2000-turn conversation (heavy session)", () => {
    const lines = buildConversationLines(2000);
    const times = bench(() => {
      const p = new IncrementalParser();
      p.feedLines(lines);
      p.getTurns();
    }, 10);
    console.log(`  parse 2000 turns: ${fmt(times)}`);
    expect(p50(times)).toBeLessThan(100);
  });

  it("incremental feed (simulating live mode)", () => {
    // Feed one line at a time, like the WebSocket file watcher does
    const lines = buildConversationLines(300);
    const times = bench(() => {
      const p = new IncrementalParser();
      for (const line of lines) {
        p.feedLines([line]);
      }
    }, 10);
    console.log(`  300 incremental feeds: ${fmt(times)}`);
    expect(p50(times)).toBeLessThan(50);
  });

  it("getMetadata is O(1)", () => {
    const parser = new IncrementalParser();
    parser.feedLines(buildConversationLines(200));
    const times = bench(() => {
      for (let i = 0; i < 10_000; i++) parser.getMetadata();
    });
    console.log(`  10K getMetadata: ${fmt(times)}`);
    expect(p50(times)).toBeLessThan(10);
  });
});

// ===========================================================================
// 3. Conversation page rendering (the heaviest endpoint)
// ===========================================================================

describe("bench: Page rendering", () => {
  let renderTurn: typeof import("./renderer.js").renderTurn;
  let buildHtmlPage: typeof import("./templates/html-template.js").buildHtmlPage;
  let buildPageParams: typeof import("./convert.js").buildPageParams;

  beforeAll(async () => {
    renderTurn = (await import("./renderer.js")).renderTurn;
    buildHtmlPage = (await import("./templates/html-template.js")).buildHtmlPage;
    buildPageParams = (await import("./convert.js")).buildPageParams;
  });

  it("renderTurn × 200 (the inner loop of page generation)", () => {
    const parser = new IncrementalParser();
    parser.feedLines(buildConversationLines(200));
    const turns = parser.getTurns();

    const times = bench(() => {
      for (let i = 0; i < turns.length; i++) {
        const prev = i > 0 ? turns[i - 1]?.timestamp : undefined;
        renderTurn(turns[i], i, true, true, prev);
      }
    });
    console.log(`  renderTurn × ${turns.length}: ${fmt(times)}`);
    expect(p50(times)).toBeLessThan(200);
  });

  it("full page build: 100-turn conversation", () => {
    const parser = new IncrementalParser();
    parser.feedLines(buildConversationLines(100));
    const meta = parser.getMetadata();
    const turns = parser.getTurns();
    const convo = {
      sessionId: meta.sessionId ?? "bench-page",
      projectDir: meta.projectDir,
      model: meta.model,
      version: meta.version,
      startTime: meta.startTime,
      turns,
    };
    const tmpDir = makeTempDir();

    const times = bench(() => {
      const params = buildPageParams(convo, "/tmp/bench.jsonl", tmpDir, {
        includeThinking: true,
        includeTools: true,
        mode: "server",
        wsUrl: "ws://localhost:3456/ws/bench",
      });
      buildHtmlPage(params);
    }, 10);

    fs.rmSync(tmpDir, { recursive: true, force: true });
    console.log(`  full page build (100 turns): ${fmt(times)}`);
    expect(p50(times)).toBeLessThan(200);
  });

  it("full page build: 500-turn conversation", () => {
    const parser = new IncrementalParser();
    parser.feedLines(buildConversationLines(500));
    const meta = parser.getMetadata();
    const turns = parser.getTurns();
    const convo = {
      sessionId: "bench-page-500",
      projectDir: meta.projectDir,
      model: meta.model,
      version: meta.version,
      startTime: meta.startTime,
      turns,
    };
    const tmpDir = makeTempDir();

    const times = bench(() => {
      const params = buildPageParams(convo, "/tmp/bench.jsonl", tmpDir, {
        includeThinking: true,
        includeTools: true,
        mode: "server",
        wsUrl: "ws://localhost:3456/ws/bench",
      });
      buildHtmlPage(params);
    }, 5);

    fs.rmSync(tmpDir, { recursive: true, force: true });
    console.log(`  full page build (500 turns): ${fmt(times)}`);
    expect(p50(times)).toBeLessThan(1000);
  });
});

// ===========================================================================
// 4. Discovery — mtime cache at realistic scale
// ===========================================================================

describe("bench: Discovery", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir();
    clearDiscoveryCache();
  });

  afterEach(() => {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
  });

  it("cold vs warm scan at 1000 files", () => {
    const N = 1000;
    const projectDir = path.join(tempDir, "-Users-test-scale");
    for (let i = 0; i < N; i++) {
      writeJsonl(path.join(projectDir, `s-${i}.jsonl`), `s-${i}`, 2);
    }

    clearDiscoveryCache();
    const coldTimes = bench(() => {
      clearDiscoveryCache();
      scanProjectsDir(tempDir);
    }, 3);

    // Warm (cache populated from last cold run, re-populate)
    clearDiscoveryCache();
    scanProjectsDir(tempDir); // populate cache
    const warmTimes = bench(() => { scanProjectsDir(tempDir); }, 10);

    const speedup = p50(coldTimes) / Math.max(p50(warmTimes), 0.01);
    console.log(`  ${N} files cold: ${fmt(coldTimes)}`);
    console.log(`  ${N} files warm: ${fmt(warmTimes)}`);
    console.log(`  speedup: ${speedup.toFixed(1)}x`);

    expect(p50(warmTimes)).toBeLessThan(p50(coldTimes));
    // At 1000 files the cache should provide significant speedup
    expect(speedup).toBeGreaterThan(2);
  });

  it("detects modifications and deletions correctly", () => {
    const projectDir = path.join(tempDir, "-Users-test-delta");
    for (let i = 0; i < 10; i++) {
      writeJsonl(path.join(projectDir, `s-${i}.jsonl`), `s-${i}`, 4);
    }

    clearDiscoveryCache();
    const r1 = scanProjectsDir(tempDir);
    expect(r1.sessions).toHaveLength(10);
    expect(r1.changedCount).toBe(10); // all new

    // No changes → 0
    const r2 = scanProjectsDir(tempDir);
    expect(r2.changedCount).toBe(0);

    // Modify one file
    const target = path.join(projectDir, "s-3.jsonl");
    fs.appendFileSync(target, JSON.stringify({ type: "user", message: { content: "extra" } }) + "\n");
    const r3 = scanProjectsDir(tempDir);
    expect(r3.changedCount).toBe(1);

    // Delete two files
    fs.unlinkSync(path.join(projectDir, "s-7.jsonl"));
    fs.unlinkSync(path.join(projectDir, "s-8.jsonl"));
    const r4 = scanProjectsDir(tempDir);
    expect(r4.sessions).toHaveLength(8);
    expect(r4.changedCount).toBe(2); // 2 deletions
  });

  it("syncToDb bulk: 1000 sessions", { timeout: 15_000 }, () => {
    const sessions: DiscoveredSession[] = Array.from({ length: 1000 }, (_, i) => ({
      id: `sync-${i}`,
      path: `/tmp/sync/s-${i}.jsonl`,
      projectDir: `/home/user/proj-${i % 20}`,
      model: "claude-sonnet-4-20250514",
      startTime: new Date(Date.now() - i * 3600_000).toISOString(),
      lastModified: Date.now() - i * 1800_000,
      fileSize: 50000 + i * 100,
    }));

    const dbDir = makeTempDir("gloss-sync-bench-");
    const db = openDb(path.join(dbDir, "sync.sqlite"));

    const times = bench(() => { syncToDb(db, sessions); }, 5);
    console.log(`  syncToDb(1000 sessions): ${fmt(times)}`);
    expect(p50(times)).toBeLessThan(2000);

    // Verify data integrity
    const stored = db.listSessions({});
    expect(stored.length).toBe(1000);

    db.close();
    fs.rmSync(dbDir, { recursive: true, force: true });
  });
});

// ===========================================================================
// 5. SQLite — query performance at scale
// ===========================================================================

describe("bench: SQLite", () => {
  let db: ConvoDb;
  let dbDir: string;

  beforeAll(() => {
    dbDir = makeTempDir("gloss-db-bench-");
    db = openDb(path.join(dbDir, "bench.sqlite"));

    // Seed 1000 sessions across 20 projects
    for (let i = 0; i < 1000; i++) {
      db.upsertSession({
        id: `bench-${i}`,
        jsonl_path: `/tmp/bench/${i}.jsonl`,
        project: `/home/user/project-${i % 20}`,
        model: ["claude-sonnet-4-20250514", "claude-opus-4-6", "claude-haiku-4-5-20251001"][i % 3],
        start_time: Math.floor(Date.now() / 1000) - i * 3600,
        turn_count: 5 + (i % 100),
        last_modified: Math.floor(Date.now() / 1000) - i * 1800,
        file_size: 10000 + i * 100,
      });
    }
  });

  afterAll(() => {
    db.close();
    fs.rmSync(dbDir, { recursive: true, force: true });
  });

  it("listSessions (full table, no filter)", () => {
    const times = bench(() => { db.listSessions({}); });
    console.log(`  listSessions(all): ${fmt(times)}`);
    expect(p50(times)).toBeLessThan(20);
  });

  it("listSessions with project filter (uses idx_sessions_project)", () => {
    const times = bench(() => {
      db.listSessions({ project: "/home/user/project-7", limit: 50 });
    });
    console.log(`  listSessions(project filter): ${fmt(times)}`);
    expect(p50(times)).toBeLessThan(5);
  });

  it("annotation CRUD cycle (500 annotations)", { timeout: 30_000 }, () => {
    db.upsertSession({ id: "ann-bench" });

    // Insert
    const insertTimes = bench(() => {
      for (let i = 0; i < 500; i++) {
        db.upsertAnnotation({
          id: `ann-${i}`,
          session_id: "ann-bench",
          turn_index: i % 50,
          block_index: 0,
          char_start: 0,
          char_end: 20,
          text: `Highlighted text ${i}`,
          comment: `Comment ${i}`,
          kind: i % 3 === 0 ? "decision" : "highlight",
        });
      }
    }, 3);
    console.log(`  500 annotation upserts: ${fmt(insertTimes)}`);
    expect(p50(insertTimes)).toBeLessThan(3000);

    // Tag 250 of them
    const tagTimes = bench(() => {
      for (let i = 0; i < 250; i++) {
        db.replaceAnnotationTags(`ann-${i}`, ["perf", `tag-${i % 5}`]);
      }
    }, 3);
    console.log(`  250 tag replacements: ${fmt(tagTimes)}`);
    expect(p50(tagTimes)).toBeLessThan(2000);

    // Query by tag
    const queryTimes = bench(() => { db.getAnnotationsByTag("perf", { limit: 100 }); });
    console.log(`  getAnnotationsByTag: ${fmt(queryTimes)}`);
    expect(p50(queryTimes)).toBeLessThan(20);

    // Query all session annotations
    const sessionTimes = bench(() => { db.getSessionAnnotations("ann-bench"); });
    console.log(`  getSessionAnnotations(500): ${fmt(sessionTimes)}`);
    expect(p50(sessionTimes)).toBeLessThan(30);
  });

  it("FTS index + search (200 sessions × 20 turns)", { timeout: 15_000 }, () => {
    // Index
    const t0 = performance.now();
    for (let s = 0; s < 200; s++) {
      const tools = ["webpack", "vite", "esbuild", "rollup", "parcel", "turbopack", "swc", "babel", "tsc", "rome"];
      const turns = Array.from({ length: 20 }, (_, t) => ({
        role: t % 2 === 0 ? "user" : "assistant",
        text: t % 2 === 0
          ? `How do I configure ${tools[s % tools.length]} for production deployment on ${["AWS", "GCP", "Vercel", "Netlify"][s % 4]}?`
          : `To configure ${tools[s % tools.length]} you need to update the config file with production mode, enable tree shaking, and set up code splitting for optimal bundle size.`,
      }));
      db.indexSession(`fts-${s}`, turns, Math.floor(Date.now() / 1000));
    }
    const indexMs = performance.now() - t0;
    console.log(`  FTS index 200×20: ${indexMs.toFixed(0)}ms`);

    // Search queries of varying selectivity
    const queries = [
      "webpack production",      // selective
      "configure",               // broad
      "tree shaking bundle",     // multi-term
      "AWS deployment",          // cross-field
      "nonexistent xyzzy",       // zero hits
    ];
    for (const q of queries) {
      const times = bench(() => { db.searchSessions(q, 30); });
      const results = db.searchSessions(q, 30);
      console.log(`  FTS "${q}": ${fmt(times)} (${results.length} hits)`);
      expect(p50(times)).toBeLessThan(50);
    }
  });

  it("embedding storage + load at scale", { timeout: 30_000 }, () => {
    // Store
    const t0 = performance.now();
    for (let s = 0; s < 500; s++) {
      const entries = Array.from({ length: 10 }, (_, t) => ({
        turnIndex: t,
        role: t % 2 === 0 ? "user" : "assistant",
        textHash: `hash-${s}-${t}`,
        embedding: randomVec(),
      }));
      db.storeEmbeddings(`emb-${s}`, entries, Math.floor(Date.now() / 1000));
    }
    const storeMs = performance.now() - t0;

    // Load
    const loadTimes = bench(() => { db.loadAllEmbeddings(); }, 10);
    const data = db.loadAllEmbeddings();

    console.log(`  store 5K embeddings: ${storeMs.toFixed(0)}ms`);
    console.log(`  load 5K embeddings: ${fmt(loadTimes)} (${data.sessionIds.length} vectors)`);
    expect(data.sessionIds.length).toBe(5000);
    expect(p50(loadTimes)).toBeLessThan(200);
  });
});

// ===========================================================================
// 6. FTS sanitization fuzz — test against real FTS5
// ===========================================================================

describe("bench: FTS fuzz", () => {
  let db: ConvoDb;
  let dbDir: string;

  beforeAll(() => {
    dbDir = makeTempDir("gloss-fuzz-");
    db = openDb(path.join(dbDir, "fuzz.sqlite"));
    // Seed some FTS data so queries have something to match
    for (let i = 0; i < 20; i++) {
      db.indexSession(`fuzz-${i}`, [
        { role: "user", text: `How do I configure webpack and vite for production deployment?` },
        { role: "assistant", text: `You need to set mode to production and enable tree-shaking.` },
      ], Math.floor(Date.now() / 1000));
    }
  });

  afterAll(() => {
    db.close();
    fs.rmSync(dbDir, { recursive: true, force: true });
  });

  it("1000 random queries: sanitize then execute against FTS5", { timeout: 15_000 }, () => {
    const chars = 'abcdefghijklmnopqrstuvwxyz 0123456789!@#$%^&*()_+-=[]{}|;:",.<>?/~`\'"\\';
    let crashes = 0;
    let empties = 0;
    const t0 = performance.now();

    for (let i = 0; i < 1000; i++) {
      const len = 3 + Math.floor(Math.random() * 80);
      let raw = "";
      for (let j = 0; j < len; j++) {
        raw += chars[Math.floor(Math.random() * chars.length)];
      }
      const sanitized = sanitizeFtsQuery(raw);
      if (!sanitized.trim()) {
        empties++;
        continue;
      }
      try {
        db.searchSessions(sanitized, 10);
      } catch {
        crashes++;
      }
    }

    const ms = performance.now() - t0;
    console.log(`  1000 fuzz queries: ${ms.toFixed(0)}ms (${crashes} FTS crashes, ${empties} empty after sanitize)`);
    expect(crashes).toBe(0);
  });

  it("edge-case queries that historically broke FTS5", () => {
    const edgeCases = [
      '""',
      '"',
      "OR",
      "AND",
      "NOT",
      "NEAR",
      "NEAR/3",
      "* * *",
      "()",
      "((()))",
      "a OR",
      "OR b",
      "NOT NOT NOT",
      'a "b c" d',
      "-",
      "--",
      "---",
      "a-b-c",
      "a+b",
      "prefix*",
      "^start",
      "{col}:word",
      "a AND b OR c NOT d",
      "\\n\\t\\r",
      "\0\0\0",
      "a".repeat(1000),
      " ".repeat(100),
    ];

    for (const raw of edgeCases) {
      const sanitized = sanitizeFtsQuery(raw);
      if (!sanitized.trim()) continue;
      expect(() => {
        db.searchSessions(sanitized, 5);
      }).not.toThrow();
    }
  });
});

// ===========================================================================
// 7. mergeFtsHits — dedup at scale
// ===========================================================================

describe("bench: mergeFtsHits", () => {
  it("10K hits → 500 sessions", () => {
    const hits = Array.from({ length: 10_000 }, (_, i) => ({
      session_id: `session-${i % 500}`,
      match_count: 1 + (i % 5),
      best_rank: Math.random() * 100,
    }));

    const times = bench(() => { mergeFtsHits(hits); });
    const merged = mergeFtsHits(hits);

    console.log(`  merge 10K → ${merged.size}: ${fmt(times)}`);
    expect(merged.size).toBe(500);
    expect(p50(times)).toBeLessThan(20);
  });
});

// ===========================================================================
// 8. Server stress — concurrent requests including heavy endpoints
// ===========================================================================

describe("bench: Server stress", () => {
  let server: ReturnType<typeof Bun.serve>;
  let db: ConvoDb;
  let dbDir: string;
  let tempDir: string;
  const port = 14567;
  const baseUrl = `http://localhost:${port}`;

  beforeAll(async () => {
    tempDir = makeTempDir("gloss-stress-");
    dbDir = makeTempDir("gloss-stress-db-");
    db = openDb(path.join(dbDir, "stress.sqlite"));

    // 50 sessions with 20-turn JONLs
    const projectDir = path.join(tempDir, "-Users-test-stress");
    for (let i = 0; i < 50; i++) {
      const sid = `stress-${String(i).padStart(4, "0")}`;
      writeJsonl(path.join(projectDir, `${sid}.jsonl`), sid, 20);
      db.upsertSession({
        id: sid,
        jsonl_path: path.join(projectDir, `${sid}.jsonl`),
        project: `/test/project-${i % 5}`,
        model: "claude-sonnet-4-20250514",
        turn_count: 20,
      });
    }

    const { CSS_STYLES } = await import("./templates/css.js");
    const { buildServerIndex } = await import("./index-page.js");
    const { handleApiRoute } = await import("./server.js");
    const { buildHtmlPage } = await import("./templates/html-template.js");
    const { buildPageParams } = await import("./convert.js");
    const { IncrementalParser: IP } = await import("./incremental-parser.js");

    server = Bun.serve({
      port,
      async fetch(req) {
        const url = new URL(req.url);
        const pathname = url.pathname;
        if (pathname === "/") {
          return new Response(buildServerIndex(db.listSessions({})), {
            headers: { "Content-Type": "text/html" },
          });
        }
        if (pathname === "/assets/style.css") {
          return new Response(CSS_STYLES, { headers: { "Content-Type": "text/css" } });
        }
        if (pathname.startsWith("/c/")) {
          const sid = pathname.slice(3);
          const session = db.getSession(sid);
          if (!session?.jsonl_path || !fs.existsSync(session.jsonl_path))
            return new Response("Not found", { status: 404 });
          const parser = new IP();
          parser.feedLines(fs.readFileSync(session.jsonl_path, "utf-8").split("\n"));
          const meta = parser.getMetadata();
          const convo = {
            sessionId: meta.sessionId ?? sid,
            projectDir: meta.projectDir,
            model: meta.model,
            version: meta.version,
            startTime: meta.startTime,
            turns: parser.getTurns(),
          };
          const params = buildPageParams(convo, session.jsonl_path, tempDir, {
            includeThinking: true,
            includeTools: true,
            mode: "server",
            wsUrl: `ws://localhost:${port}/ws/${sid}`,
          });
          const html = buildHtmlPage(params);
          return new Response(html, { headers: { "Content-Type": "text/html" } });
        }
        if (pathname.startsWith("/api/")) {
          return handleApiRoute(req, pathname, db);
        }
        return new Response("Not found", { status: 404 });
      },
    });
  });

  afterAll(() => {
    server?.stop();
    db?.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
    fs.rmSync(dbDir, { recursive: true, force: true });
  });

  it("50 concurrent index page requests", async () => {
    const times = await benchAsync(async () => {
      const responses = await Promise.all(
        Array.from({ length: 50 }, () => fetch(`${baseUrl}/`)),
      );
      await Promise.all(responses.map((r) => r.text()));
      for (const r of responses) expect(r.status).toBe(200);
    }, 5);
    console.log(`  50× GET /: ${fmt(times)}`);
    expect(p95(times)).toBeLessThan(500);
  });

  it("20 concurrent conversation page renders", async () => {
    // This is the heavy one — each request parses JSONL + renders full HTML
    const sids = Array.from({ length: 20 }, (_, i) =>
      `stress-${String(i).padStart(4, "0")}`,
    );
    const times = await benchAsync(async () => {
      const responses = await Promise.all(
        sids.map((sid) => fetch(`${baseUrl}/c/${sid}`)),
      );
      await Promise.all(responses.map((r) => r.text()));
      for (const r of responses) expect(r.status).toBe(200);
    }, 5);
    console.log(`  20× GET /c/:id (20-turn): ${fmt(times)}`);
    expect(p95(times)).toBeLessThan(2000);
  });

  it("100 concurrent annotation writes, no 5xx", async () => {
    const sid = "stress-0000";
    const t0 = performance.now();
    const responses = await Promise.all(
      Array.from({ length: 100 }, (_, i) =>
        fetch(`${baseUrl}/api/sessions/${sid}/annotations`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id: `stress-ann-${i}`,
            turnIndex: i % 10,
            blockIndex: 0,
            charStart: 0,
            charEnd: 10,
            text: `Stress text ${i}`,
            kind: "highlight",
            tags: [`tag-${i % 5}`],
          }),
        }),
      ),
    );
    const ms = performance.now() - t0;
    await Promise.all(responses.map((r) => r.text()));

    const errors = responses.filter((r) => r.status >= 500);
    console.log(`  100× POST annotation: ${ms.toFixed(0)}ms (${errors.length} errors)`);
    expect(errors.length).toBe(0);

    // Verify all persisted
    const getRes = await fetch(`${baseUrl}/api/sessions/${sid}/annotations`);
    const anns = (await getRes.json()) as any[];
    expect(anns.length).toBe(100);

    // Cleanup
    await Promise.all(
      Array.from({ length: 100 }, (_, i) =>
        fetch(`${baseUrl}/api/sessions/${sid}/annotations/stress-ann-${i}`, { method: "DELETE" }),
      ),
    );
  });

  it("mixed read/write storm (200 requests)", async () => {
    const sid = "stress-0001";
    const t0 = performance.now();
    const responses = await Promise.all(
      Array.from({ length: 200 }, (_, i) => {
        if (i % 4 === 0) {
          return fetch(`${baseUrl}/api/sessions/${sid}/annotations`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              id: `mixed-${i}`,
              turnIndex: i % 10,
              blockIndex: 0,
              charStart: 0,
              charEnd: 5,
              text: `M${i}`,
              kind: "highlight",
            }),
          });
        }
        if (i % 4 === 1) return fetch(`${baseUrl}/api/sessions/${sid}/annotations`);
        if (i % 4 === 2) return fetch(`${baseUrl}/`);
        return fetch(`${baseUrl}/assets/style.css`);
      }),
    );
    const ms = performance.now() - t0;
    await Promise.all(responses.map((r) => r.text()));

    const serverErrors = responses.filter((r) => r.status >= 500);
    console.log(`  200× mixed r/w: ${ms.toFixed(0)}ms (${serverErrors.length} 5xx)`);
    expect(serverErrors.length).toBe(0);

    // Cleanup
    const anns = (await (await fetch(`${baseUrl}/api/sessions/${sid}/annotations`)).json()) as any[];
    await Promise.all(
      anns.map((a: any) =>
        fetch(`${baseUrl}/api/sessions/${sid}/annotations/${a.id}`, { method: "DELETE" }),
      ),
    );
  });
});
