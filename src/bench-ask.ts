#!/usr/bin/env bun
/**
 * Semantic search quality benchmark.
 * Tests recall, precision, and edge cases across the Ask pipeline.
 *
 * Informed by 2026 arxiv findings:
 * - 256-dim embeddings have theoretical limits (~352 unique doc combos) [2508.21038]
 * - RRF k=60 is standard; per-token FTS compensates for embedding limits [2508.01405]
 * - Weak retrieval paths degrade fusion results ("weakest link") [2508.01405]
 * - RAG Fusion gains can be neutralized by re-ranking/truncation [2603.02153]
 */

const BASE = "http://localhost:3456";

interface TestCase {
  name: string;
  query: string;
  /** Substrings that MUST appear in the answer (case-insensitive) */
  expectPresent: string[];
  /** Substrings that ideally appear (scored but not hard fail) */
  expectIdeal?: string[];
  /** Minimum number of sources expected */
  minSources?: number;
  /** Category for grouping results */
  category: string;
}

// ---------------------------------------------------------------------------
// Test cases — designed from real database content (11,897 sessions, 25+ projects)
// ---------------------------------------------------------------------------

const TESTS: TestCase[] = [
  // ── Category: Synonym / Conceptual Matching ──
  // Tests whether vector search bridges terminology gaps
  {
    name: "synonym: 'document store' → SQLite/DuckDB",
    query: "What document stores or data persistence layers are used?",
    expectPresent: ["sqlite"],
    expectIdeal: ["duckdb", "qdrant", "indexeddb"],
    minSources: 5,
    category: "synonym",
  },
  {
    name: "synonym: 'real-time updates' → WebSocket/file watcher",
    query: "How do we push real-time updates to the browser when data changes on disk?",
    expectPresent: ["websocket"],
    expectIdeal: ["file watcher", "watch", "fs.watch", "live"],
    minSources: 3,
    category: "synonym",
  },
  {
    name: "synonym: 'ML inference' → local LLM/ONNX",
    query: "How is machine learning inference handled locally without a GPU?",
    expectPresent: ["model"],
    expectIdeal: ["quantiz", "onnx", "ollama", "gguf", "cpu", "inference"],
    minSources: 2,
    category: "synonym",
  },

  // ── Category: Cross-Project Survey ──
  // Tests breadth of recall across many projects
  {
    name: "survey: programming languages across projects",
    query: "What programming languages and runtimes are used across all projects?",
    expectPresent: ["typescript"],
    expectIdeal: ["bun", "rust", "python", "react"],
    minSources: 5,
    category: "survey",
  },
  {
    name: "survey: databases across projects",
    query: "What databases have we worked with across all projects?",
    expectPresent: ["sqlite", "qdrant"],
    expectIdeal: ["duckdb", "indexeddb", "notion"],
    minSources: 5,
    category: "survey",
  },
  {
    name: "survey: what has Claude helped build",
    query: "What are the main projects and tools that Claude has helped build?",
    expectPresent: [],
    expectIdeal: ["convo-viewer", "gloss", "orchid", "cortex", "squall", "fb-monitor", "epoch"],
    minSources: 8,
    category: "survey",
  },

  // ── Category: Specific Implementation Detail ──
  // Tests ability to find precise technical details
  {
    name: "specific: annotation restore algorithm",
    query: "How does the annotation prefix/suffix matching work for restoring highlights?",
    expectPresent: ["prefix", "suffix"],
    expectIdeal: ["tier", "charstart", "fuzzy", "restore"],
    minSources: 1,
    category: "specific",
  },
  {
    name: "specific: ONNX embedding subprocess",
    query: "How does the ONNX embedding model load and run in a subprocess?",
    expectPresent: ["onnx"],
    expectIdeal: ["subprocess", "worker", "256", "dimension"],
    minSources: 1,
    category: "specific",
  },
  {
    name: "specific: incremental JSONL parser",
    query: "How does the incremental JSONL parser handle partial lines and streaming?",
    expectPresent: ["incremental"],
    expectIdeal: ["partial", "line", "feed", "parser"],
    minSources: 1,
    category: "specific",
  },

  // ── Category: Rare / Niche Topics ──
  // Tests recall for topics in only a few sessions
  {
    name: "rare: tantivy full-text search",
    query: "What work has been done with tantivy for full-text search?",
    expectPresent: ["tantivy"],
    expectIdeal: ["bm25", "rust", "index"],
    minSources: 1,
    category: "rare",
  },
  {
    name: "rare: mutation testing with greptar",
    query: "How does the mutation testing tool work for finding untested code?",
    expectPresent: [],
    expectIdeal: ["mutation", "greptar", "inject", "revert", "test"],
    minSources: 1,
    category: "rare",
  },
  {
    name: "rare: Squall multi-model code review",
    query: "How does the multi-model code review system dispatch to different AI models?",
    expectPresent: [],
    expectIdeal: ["squall", "model", "review", "grok", "codex", "gemini", "kimi"],
    minSources: 1,
    category: "rare",
  },

  // ── Category: Conceptual Leap ──
  // Query uses abstract language; answer requires concrete matches
  {
    name: "conceptual: error resilience",
    query: "How do we handle failures gracefully when external services are unavailable?",
    expectPresent: [],
    expectIdeal: ["retry", "timeout", "fallback", "error", "catch"],
    minSources: 3,
    category: "conceptual",
  },
  {
    name: "conceptual: developer experience tooling",
    query: "What developer experience and productivity tooling has been built?",
    expectPresent: [],
    expectIdeal: ["cli", "hook", "auto", "skill", "gloss", "viewer"],
    minSources: 3,
    category: "conceptual",
  },

  // ── Category: Disambiguation ──
  // Same word means different things in different projects
  {
    name: "disambig: 'sessions' (DB vs conversations)",
    query: "How are sessions managed and stored?",
    expectPresent: ["session"],
    expectIdeal: ["sqlite", "jsonl", "discovery"],
    minSources: 3,
    category: "disambiguation",
  },

  // ── Category: Edge Cases ──
  // Stress-tests the search pipeline
  {
    name: "edge: single character query",
    query: "x",
    expectPresent: [],
    expectIdeal: [],
    minSources: 0,
    category: "edge",
  },
  {
    name: "edge: gibberish",
    query: "xyzzy42foobarbaz",
    expectPresent: [],
    expectIdeal: [],
    minSources: 0,
    category: "edge",
  },
  {
    name: "edge: very long specific query",
    query: "recursive descent parser for typescript abstract syntax trees with generic type parameters and conditional types in a bun runtime environment",
    expectPresent: [],
    expectIdeal: ["typescript", "parser", "bun"],
    minSources: 1,
    category: "edge",
  },
  {
    name: "edge: question with only stop words",
    query: "what is the thing that does the stuff with the other thing",
    expectPresent: [],
    expectIdeal: [],
    minSources: 0,
    category: "edge",
  },

  // ── Category: Cross-Reference ──
  // Requires connecting information across sessions/projects
  {
    name: "xref: Orchid vs cortex data aggregation",
    query: "How do Orchid and cortex differ in their approach to aggregating data from multiple sources?",
    expectPresent: [],
    expectIdeal: ["orchid", "cortex"],
    minSources: 3,
    category: "cross-reference",
  },

  // ── Category: Project-Dominant (from agent findings) ──
  // Topics that cluster heavily in one project — tests if search finds them
  {
    name: "project-dominant: Facebook scraping",
    query: "How does the Facebook marketplace monitoring system work?",
    expectPresent: ["facebook"],
    expectIdeal: ["marketplace", "scraping", "playwright", "fb-monitor", "monitor"],
    minSources: 3,
    category: "project-dominant",
  },
  {
    name: "project-dominant: podcast transcription",
    query: "How is podcast audio transcribed and processed?",
    expectPresent: [],
    expectIdeal: ["podcast", "transcri", "whisper", "audio", "stt"],
    minSources: 2,
    category: "project-dominant",
  },
  {
    name: "project-dominant: Tauri desktop app",
    query: "What Tauri desktop applications have been built and how are they structured?",
    expectPresent: ["tauri"],
    expectIdeal: ["rust", "webview", "frontend", "desktop"],
    minSources: 2,
    category: "project-dominant",
  },

  // ── Category: Low-Count / Niche (from agent: segfault=7, protobuf=5, wasm=12) ──
  {
    name: "niche: WebAssembly usage",
    query: "Has WebAssembly or WASM been used in any projects?",
    expectPresent: [],
    expectIdeal: ["wasm", "webassembly"],
    minSources: 1,
    category: "niche",
  },
  {
    name: "niche: SwiftUI development",
    query: "What SwiftUI or iOS development has been done?",
    expectPresent: [],
    expectIdeal: ["swift", "ios", "apple", "macos"],
    minSources: 1,
    category: "niche",
  },
  {
    name: "niche: voice activity detection",
    query: "How does the voice activity detection system work?",
    expectPresent: [],
    expectIdeal: ["vad", "silero", "audio", "speech"],
    minSources: 1,
    category: "niche",
  },

  // ── Category: Ambiguous Terms (from agent: "linear" could be math or Linear app) ──
  {
    name: "ambiguous: Linear the project tool",
    query: "How is Linear used for project management and issue tracking?",
    expectPresent: ["linear"],
    expectIdeal: ["issue", "ticket", "project", "track"],
    minSources: 2,
    category: "ambiguous",
  },
  {
    name: "ambiguous: race conditions vs deadlocks",
    query: "What concurrency bugs have been encountered — race conditions, deadlocks, or thread safety issues?",
    expectPresent: [],
    expectIdeal: ["race", "deadlock", "concurren", "mutex", "lock", "thread"],
    minSources: 3,
    category: "ambiguous",
  },

  // ── Category: Recall-at-Depth (tests if survey finds things buried in 11K sessions) ──
  {
    name: "recall: Mac Studio infrastructure",
    query: "How is the Mac Studio configured as a development server?",
    expectPresent: [],
    expectIdeal: ["mac studio", "launchd", "ssh", "service", "deploy"],
    minSources: 2,
    category: "recall",
  },
  {
    name: "recall: Iceland project",
    query: "What was the Iceland project about?",
    expectPresent: ["iceland"],
    expectIdeal: ["trip", "travel", "plan"],
    minSources: 1,
    category: "recall",
  },
];

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

interface TestResult {
  test: TestCase;
  answer: string;
  sources: number;
  presentHits: string[];
  presentMisses: string[];
  idealHits: string[];
  idealMisses: string[];
  ftsMs: number;
  vectorMs: number;
  claudeMs: number;
  totalMs: number;
  error?: string;
}

async function runTest(test: TestCase): Promise<TestResult> {
  const t0 = performance.now();
  try {
    const resp = await fetch(`${BASE}/api/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: test.query }),
    });
    const data = await resp.json();
    const answer = (data.answer || "").toLowerCase();
    const wallMs = performance.now() - t0;

    const presentHits = test.expectPresent.filter((s) => answer.includes(s.toLowerCase()));
    const presentMisses = test.expectPresent.filter((s) => !answer.includes(s.toLowerCase()));
    const idealHits = (test.expectIdeal || []).filter((s) => answer.includes(s.toLowerCase()));
    const idealMisses = (test.expectIdeal || []).filter((s) => !answer.includes(s.toLowerCase()));

    return {
      test,
      answer: data.answer || "",
      sources: data.sources?.length ?? 0,
      presentHits,
      presentMisses,
      idealHits,
      idealMisses,
      ftsMs: data.timing?.ftsMs ?? 0,
      vectorMs: data.timing?.vectorMs ?? 0,
      claudeMs: data.timing?.claudeMs ?? 0,
      totalMs: data.timing?.totalMs ?? Math.round(wallMs),
      error: data.error,
    };
  } catch (e) {
    return {
      test,
      answer: "",
      sources: 0,
      presentHits: [],
      presentMisses: test.expectPresent,
      idealHits: [],
      idealMisses: test.expectIdeal || [],
      ftsMs: 0,
      vectorMs: 0,
      claudeMs: 0,
      totalMs: Math.round(performance.now() - t0),
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

function grade(r: TestResult): { pass: boolean; score: number; max: number } {
  const presentMax = r.test.expectPresent.length;
  const idealMax = (r.test.expectIdeal || []).length;
  const max = presentMax + idealMax;

  // Present items are required (2 points each), ideal are bonus (1 point each)
  const presentScore = r.presentHits.length * 2;
  const idealScore = r.idealHits.length;
  const score = presentScore + idealScore;
  const maxScore = presentMax * 2 + idealMax;

  // Source count check
  const minSources = r.test.minSources ?? 0;
  const sourcesOk = r.sources >= minSources;

  // Pass = all required present + enough sources
  const pass = r.presentMisses.length === 0 && sourcesOk && !r.error;

  return { pass, score, max: maxScore };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const iterations = parseInt(args.find((a) => a.match(/^\d+$/)) || "1", 10);
  const filterCat = args.find((a) => !a.match(/^\d+$/));

  const tests = filterCat
    ? TESTS.filter((t) => t.category.includes(filterCat))
    : TESTS;

  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║            Semantic Search Quality Benchmark                ║");
  console.log("╚══════════════════════════════════════════════════════════════╝");
  console.log(`  Target: ${BASE}`);
  console.log(`  Tests: ${tests.length} | Iterations: ${iterations}`);
  console.log(`  Arxiv insights applied: per-token FTS, k=60 RRF, 256-dim limits`);
  console.log();

  for (let iter = 0; iter < iterations; iter++) {
    if (iterations > 1) {
      console.log(`\n━━━ Iteration ${iter + 1}/${iterations} ━━━\n`);
    }

    const results: TestResult[] = [];
    let lastCategory = "";

    for (const test of tests) {
      if (test.category !== lastCategory) {
        lastCategory = test.category;
        console.log(`\n── ${test.category.toUpperCase()} ──`);
      }

      process.stdout.write(`  ⏳ ${test.name}...`);
      const result = await runTest(test);
      results.push(result);

      const { pass, score, max } = grade(result);
      const icon = result.error ? "💥" : pass ? "✅" : "⚠️";
      const scoreStr = max > 0 ? ` [${score}/${max}]` : "";
      const timeStr = `${result.totalMs.toFixed(0)}ms (fts:${result.ftsMs} vec:${result.vectorMs} claude:${result.claudeMs})`;
      const srcStr = `${result.sources} sources`;

      // Clear the line and rewrite
      process.stdout.write(`\r  ${icon} ${test.name}${scoreStr} — ${srcStr} — ${timeStr}\n`);

      if (result.presentMisses.length > 0) {
        console.log(`     ❌ Missing required: ${result.presentMisses.join(", ")}`);
      }
      if (result.idealMisses.length > 0) {
        console.log(`     ○ Missing ideal: ${result.idealMisses.join(", ")}`);
      }
      if (result.error) {
        console.log(`     💥 Error: ${result.error}`);
      }
    }

    // ── Summary ──
    console.log("\n══ Summary ══\n");

    const passed = results.filter((r) => grade(r).pass).length;
    const failed = results.filter((r) => !grade(r).pass && !r.error).length;
    const errored = results.filter((r) => !!r.error).length;
    const totalScore = results.reduce((s, r) => s + grade(r).score, 0);
    const totalMax = results.reduce((s, r) => s + grade(r).max, 0);

    console.log(`  Pass: ${passed}/${results.length} | Fail: ${failed} | Error: ${errored}`);
    console.log(`  Score: ${totalScore}/${totalMax} (${totalMax > 0 ? ((totalScore / totalMax) * 100).toFixed(1) : 0}%)`);

    // Timing stats
    const ftsTimes = results.map((r) => r.ftsMs).filter((t) => t > 0);
    const vecTimes = results.map((r) => r.vectorMs).filter((t) => t > 0);
    const claudeTimes = results.map((r) => r.claudeMs).filter((t) => t > 0);
    const totalTimes = results.map((r) => r.totalMs);

    const avg = (arr: number[]) => arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
    const p95 = (arr: number[]) => {
      if (arr.length === 0) return 0;
      const sorted = [...arr].sort((a, b) => a - b);
      return sorted[Math.floor(sorted.length * 0.95)];
    };

    console.log(`\n  Timing (avg / p95):`);
    console.log(`    FTS:    ${avg(ftsTimes).toFixed(0)}ms / ${p95(ftsTimes).toFixed(0)}ms`);
    console.log(`    Vector: ${avg(vecTimes).toFixed(0)}ms / ${p95(vecTimes).toFixed(0)}ms`);
    console.log(`    Claude: ${avg(claudeTimes).toFixed(0)}ms / ${p95(claudeTimes).toFixed(0)}ms`);
    console.log(`    Total:  ${avg(totalTimes).toFixed(0)}ms / ${p95(totalTimes).toFixed(0)}ms`);

    // Category breakdown
    console.log("\n  By category:");
    const categories = [...new Set(results.map((r) => r.test.category))];
    for (const cat of categories) {
      const catResults = results.filter((r) => r.test.category === cat);
      const catPassed = catResults.filter((r) => grade(r).pass).length;
      const catScore = catResults.reduce((s, r) => s + grade(r).score, 0);
      const catMax = catResults.reduce((s, r) => s + grade(r).max, 0);
      const pct = catMax > 0 ? ((catScore / catMax) * 100).toFixed(0) : "-";
      console.log(`    ${cat.padEnd(20)} ${catPassed}/${catResults.length} pass  ${catScore}/${catMax} (${pct}%)`);
    }

    // Source distribution
    const srcCounts = results.map((r) => r.sources);
    console.log(`\n  Sources: avg=${avg(srcCounts).toFixed(1)} min=${Math.min(...srcCounts)} max=${Math.max(...srcCounts)}`);
  }
}

main().catch(console.error);
