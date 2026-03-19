import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { IncrementalParser } from "./incremental-parser.js";
import { buildPageParams } from "./convert.js";
import { buildHtmlPage, safeForScript } from "./templates/html-template.js";
import { buildClientJs } from "./templates/client-js.js";
import { CSS_STYLES } from "./templates/css.js";
import { renderTurn } from "./renderer.js";
import { escape } from "./markdown.js";
import { openDb, type ConvoDb } from "./db.js";
import { scanProjectsDir, syncToDb, backfillTurnCounts, backfillFtsIndex } from "./discovery.js";
import { buildServerIndex } from "./index-page.js";
import { EmbeddingEngine, VectorIndex } from "./embeddings.js";
import { backfillEmbeddings } from "./indexer.js";
import type { Turn, TextBlock, TocEntry } from "./types.js";
import type { ServerWebSocket } from "bun";

// ---------------------------------------------------------------------------
// Session registry
// ---------------------------------------------------------------------------

interface SessionState {
  path: string;
  parser: IncrementalParser;
  byteOffset: number;
  partialLine: string;
  watcher: fs.FSWatcher | null;
  pollTimer: ReturnType<typeof setInterval> | null;
  clients: Set<ServerWebSocket<{ sessionId: string }>>;
  debounceTimer: ReturnType<typeof setTimeout> | null;
}

const sessions = new Map<string, SessionState>();

function buildTocItemHtml(entry: TocEntry): string {
  const preview = entry.preview ? escape(entry.preview) : "(no text)";
  const ts = entry.timestamp
    ? `<span class="toc-time">${escape(entry.timestamp)}</span>`
    : "";
  const label = escape(entry.label);
  return (
    `<div class="toc-item toc-${entry.role}" onclick="document.getElementById('${entry.id}').scrollIntoView({behavior:'smooth',block:'start'});closeToc();">` +
    `<div class="toc-item-header"><span class="toc-role">${label}</span>${ts}</div>` +
    `<div class="toc-item-preview">${preview}</div>` +
    `</div>`
  );
}

function buildConvoDataEntry(turn: Turn) {
  return {
    role: turn.role,
    timestamp: turn.timestamp || "",
    text: turn.blocks
      .filter((b): b is TextBlock => b.type === "text")
      .map((b) => b.text || ""),
  };
}

// ---------------------------------------------------------------------------
// Per-session file watching + incremental parse
// ---------------------------------------------------------------------------

function getOrCreateSession(sessionId: string, jsonlPath: string): SessionState {
  let state = sessions.get(sessionId);
  if (state) return state;

  const parser = new IncrementalParser();

  // Parse existing file content
  let byteOffset = 0;
  if (fs.existsSync(jsonlPath)) {
    const content = fs.readFileSync(jsonlPath, "utf-8");
    parser.feedLines(content.split("\n"));
    byteOffset = Buffer.byteLength(content, "utf-8");
  }

  state = {
    path: jsonlPath,
    parser,
    byteOffset,
    partialLine: "",
    watcher: null,
    pollTimer: null,
    clients: new Set(),
    debounceTimer: null,
  };
  sessions.set(sessionId, state);
  return state;
}

function broadcast(state: SessionState, message: object) {
  const data = JSON.stringify(message);
  for (const client of state.clients) {
    try {
      client.send(data);
    } catch {
      state.clients.delete(client);
    }
  }
}

function processFileChanges(
  state: SessionState,
  includeThinking: boolean,
  includeTools: boolean,
) {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(state.path);
  } catch {
    return;
  }
  const currentSize = stat.size;
  if (currentSize <= state.byteOffset) return;

  const fd = fs.openSync(state.path, "r");
  let newBytes: Buffer;
  try {
    newBytes = Buffer.alloc(currentSize - state.byteOffset);
    fs.readSync(fd, newBytes, 0, newBytes.length, state.byteOffset);
  } finally {
    fs.closeSync(fd);
  }
  state.byteOffset = currentSize;

  const newText = state.partialLine + newBytes.toString("utf-8");
  const lines = newText.split("\n");

  if (!newText.endsWith("\n")) {
    state.partialLine = lines.pop() || "";
  } else {
    state.partialLine = "";
    if (lines.length > 0 && lines[lines.length - 1] === "") {
      lines.pop();
    }
  }

  if (lines.length === 0) return;

  const updates = state.parser.feedLines(lines);

  for (const update of updates) {
    const allTurns = state.parser.getTurns();
    const prevTs = update.turnIndex > 0 ? allTurns[update.turnIndex - 1]?.timestamp : undefined;
    const { html, tocEntry } = renderTurn(
      update.turn,
      update.turnIndex,
      includeThinking,
      includeTools,
      prevTs,
    );

    // Skip broadcasting turns with no renderable content
    if (!html) continue;

    const tocHtml = tocEntry ? buildTocItemHtml(tocEntry) : undefined;
    const convoDataEntry = buildConvoDataEntry(update.turn);

    broadcast(state, {
      type: update.type,
      turnIndex: update.turnIndex,
      html,
      tocHtml: tocHtml || "",
      convoDataEntry,
    });
  }
}

function startWatcher(
  state: SessionState,
  includeThinking: boolean,
  includeTools: boolean,
) {
  if (state.watcher) return;

  const doProcess = () => {
    try {
      processFileChanges(state, includeThinking, includeTools);
    } catch (err) {
      console.error("Error processing file changes:", err);
    }
  };

  // Primary: fs.watch (instant notification)
  state.watcher = fs.watch(state.path, () => {
    if (state.debounceTimer) clearTimeout(state.debounceTimer);
    state.debounceTimer = setTimeout(doProcess, 50);
  });

  // Safety net: poll every 2s to catch events FSEvents drops on macOS
  state.pollTimer = setInterval(doProcess, 2000);
}

function stopWatcher(state: SessionState) {
  if (state.watcher) {
    state.watcher.close();
    state.watcher = null;
  }
  if (state.pollTimer) {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
  }
}

// ---------------------------------------------------------------------------
// Cached static assets
// ---------------------------------------------------------------------------

const clientJsContent = buildClientJs();

// Index page cache — regenerated at most every 30s
let indexHtmlCache: string | null = null;
let indexHtmlCacheTime = 0;
const INDEX_CACHE_TTL = 30_000;

function getIndexHtml(db: ConvoDb): string {
  const now = Date.now();
  if (indexHtmlCache && now - indexHtmlCacheTime < INDEX_CACHE_TTL) {
    return indexHtmlCache;
  }
  const allSessions = db.listSessions({ includeHidden: true });
  const settings = {
    embeddings_enabled: db.getSetting("embeddings_enabled") === "1",
    min_turns: parseInt(db.getSetting("min_turns") ?? "0", 10),
  };
  indexHtmlCache = buildServerIndex(allSessions, settings);
  indexHtmlCacheTime = now;
  return indexHtmlCache;
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export async function startServer(options: { port?: number } = {}): Promise<void> {
  const port = options.port ?? 3456;
  const db = openDb();

  // Discovery: scan and sync
  console.log("Scanning for conversations...");
  const { sessions: discovered } = scanProjectsDir();
  syncToDb(db, discovered);
  console.log(`Found ${discovered.length} conversations`);

  // Import legacy sidecar annotations
  importLegacySidecars(db);

  // Initialize embedding engine: CLI flag overrides, then check DB setting.
  // If the setting has never been set, default to enabled (backward compat).
  const embeddingsSetting = db.getSetting("embeddings_enabled");
  const embeddingsDisabled = process.env.GLOSS_NO_EMBEDDINGS
    ? true
    : embeddingsSetting === "0";
  // Persist the resolved state so the UI reflects reality
  if (!embeddingsSetting) {
    db.setSetting("embeddings_enabled", embeddingsDisabled ? "0" : "1");
  }
  let embeddingEngine: EmbeddingEngine | undefined;
  let vectorIndex: VectorIndex | null = null;

  if (!embeddingsDisabled) {
    embeddingEngine = new EmbeddingEngine();

    // Load existing embeddings into memory
    try {
      vectorIndex = VectorIndex.fromDb(db);
      if (vectorIndex.count > 0) {
        console.log(`Loaded ${vectorIndex.count} embeddings into vector index`);
      }
    } catch {
      // first run, no embeddings yet
    }
  }

  /** Kick off embedding backfill if engine is ready. */
  const startEmbeddingBackfill = () => {
    if (!embeddingEngine) return;
    const minTurns = parseInt(db.getSetting("min_turns") ?? "0", 10);
    if (embeddingEngine.isReady()) {
      backfillEmbeddings(db, embeddingEngine, vectorIndex, { minTurns });
    } else {
      // Wait for engine to load, then backfill
      embeddingEngine.waitReady().then(() => {
        backfillEmbeddings(db, embeddingEngine!, vectorIndex, { minTurns });
      }).catch(() => {
        // Model failed to load — skip embeddings entirely
      });
    }
  };

  // Background: count turns, then FTS, then embeddings
  const invalidateIndex = () => { indexHtmlCache = null; };
  setTimeout(() => {
    backfillTurnCounts(db, invalidateIndex);
    setTimeout(() => backfillFtsIndex(db, startEmbeddingBackfill), 2000);
  }, 500);

  // Adaptive rescan with backoff — backs off when no changes, resets on activity
  const MIN_RESCAN_MS = 60_000;
  const MAX_RESCAN_MS = 5 * 60_000;
  let rescanInterval = MIN_RESCAN_MS;

  const scheduleRescan = () => {
    setTimeout(() => {
      try {
        const { sessions: freshSessions, changedCount } = scanProjectsDir();
        syncToDb(db, freshSessions);

        if (changedCount > 0) {
          rescanInterval = MIN_RESCAN_MS; // Reset on changes
          indexHtmlCache = null; // Invalidate index page cache
        } else {
          rescanInterval = Math.min(rescanInterval * 1.5, MAX_RESCAN_MS);
        }

        // Always run backfills (incomplete indexes need catching up too)
        setTimeout(() => {
          backfillTurnCounts(db, invalidateIndex);
          setTimeout(() => backfillFtsIndex(db, startEmbeddingBackfill), 2000);
        }, 500);
      } catch {
        // best-effort
      }
      scheduleRescan();
    }, rescanInterval);
  };
  scheduleRescan();

  const includeThinking = true;
  const includeTools = true;

  const server = Bun.serve<{ sessionId: string }>({
    port,
    idleTimeout: 120, // seconds — ask endpoint shells out to claude
    async fetch(req, server) {
      const url = new URL(req.url);
      const pathname = url.pathname;

      // WebSocket upgrade: /ws/:sessionId
      if (pathname.startsWith("/ws/")) {
        const sessionId = pathname.slice(4);
        const upgraded = server.upgrade(req, { data: { sessionId } });
        if (!upgraded) {
          return new Response("WebSocket upgrade failed", { status: 400 });
        }
        return undefined;
      }

      // Static assets
      if (pathname === "/assets/style.css") {
        return new Response(CSS_STYLES, {
          headers: { "Content-Type": "text/css; charset=utf-8", "Cache-Control": "public, max-age=60" },
        });
      }
      if (pathname === "/assets/client.js") {
        return new Response(clientJsContent, {
          headers: { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "public, max-age=60" },
        });
      }
      if (pathname === "/assets/logo.png") {
        const logoPath = path.join(import.meta.dir, "..", "assets", "logo.png");
        try {
          const file = fs.readFileSync(logoPath);
          return new Response(file, {
            headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=3600" },
          });
        } catch {
          return new Response("Not found", { status: 404 });
        }
      }

      // API routes
      if (pathname.startsWith("/api/")) {
        return handleApiRoute(req, pathname, db, { embeddingEngine, vectorIndex });
      }

      // Conversation page: /c/:sessionId
      if (pathname.startsWith("/c/")) {
        const sessionId = pathname.slice(3);
        return renderConversationPage(sessionId, port, db, includeThinking, includeTools);
      }

      // Ask page: /ask?q=... — returns loading shell instantly
      if (pathname === "/ask") {
        const q = url.searchParams.get("q")?.trim();
        if (!q) return Response.redirect("/");
        const { buildAskLoadingPage } = await import("./ask-page.js");
        const html = buildAskLoadingPage(q);
        return new Response(html, {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }

      // Index page (cached, rebuilt every 30s)
      if (pathname === "/" || pathname === "/index.html") {
        return new Response(getIndexHtml(db), {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }

      return new Response("Not Found", { status: 404 });
    },

    websocket: {
      open(ws) {
        const sessionId = ws.data.sessionId;
        const session = db.getSession(sessionId);
        if (!session?.jsonl_path) return;

        const state = getOrCreateSession(sessionId, session.jsonl_path);
        state.clients.add(ws);
        // Lazy: start watcher when first client connects
        startWatcher(state, includeThinking, includeTools);
      },
      close(ws) {
        const sessionId = ws.data.sessionId;
        const state = sessions.get(sessionId);
        if (!state) return;
        state.clients.delete(ws);
        // Stop watcher when last client disconnects
        if (state.clients.size === 0) {
          stopWatcher(state);
        }
      },
      message(_ws, _message) {
        // No client-to-server messages needed yet
      },
    },
  });

  const serverUrl = `http://localhost:${port}`;
  console.log(`Convo Viewer at ${serverUrl}`);

  // Open browser on macOS
  if (process.platform === "darwin") {
    Bun.spawn(["open", serverUrl], { stdio: ["ignore", "ignore", "ignore"] });
  }

  // Cleanup on shutdown
  process.on("SIGINT", () => {
    for (const state of sessions.values()) stopWatcher(state);
    embeddingEngine?.dispose();
    db.close();
    server.stop();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    for (const state of sessions.values()) stopWatcher(state);
    embeddingEngine?.dispose();
    db.close();
    server.stop();
    process.exit(0);
  });
}

// ---------------------------------------------------------------------------
// Conversation page cache — avoids re-reading + re-parsing the same JSONL
// ---------------------------------------------------------------------------

interface ConvoPageCache {
  html: string;
  mtimeMs: number;
  annCount: number;
}

const pageCache = new Map<string, ConvoPageCache>();
const PAGE_CACHE_MAX = 30; // max cached pages

function evictOldestPage(): void {
  if (pageCache.size <= PAGE_CACHE_MAX) return;
  // Delete the first (oldest inserted) entry
  const first = pageCache.keys().next().value;
  if (first) pageCache.delete(first);
}

/** Invalidate page cache for a session (e.g. after annotation change). */
export function invalidatePageCache(sessionId: string): void {
  pageCache.delete(sessionId);
}

// ---------------------------------------------------------------------------
// Render a conversation page on demand
// ---------------------------------------------------------------------------

function renderConversationPage(
  sessionId: string,
  port: number,
  db: ConvoDb,
  includeThinking: boolean,
  includeTools: boolean,
): Response {
  const session = db.getSession(sessionId);
  if (!session?.jsonl_path || !fs.existsSync(session.jsonl_path)) {
    return new Response("Conversation not found", { status: 404 });
  }

  // Guard against OOM on very large files
  let stat: fs.Stats;
  try {
    stat = fs.statSync(session.jsonl_path);
    if (stat.size > 300 * 1024 * 1024) {
      return new Response(
        `<html><body style="font-family:system-ui;padding:40px;color:#e6edf3;background:#0d1117">` +
        `<h2>Session too large to render</h2>` +
        `<p>This JSONL is ${(stat.size / 1048576).toFixed(0)} MB — too large for in-memory rendering.</p>` +
        `<p><a href="/" style="color:#da7756">Back to index</a></p></body></html>`,
        { headers: { "Content-Type": "text/html; charset=utf-8" } },
      );
    }
  } catch {
    return new Response("Could not stat file", { status: 500 });
  }

  // Check page cache — reuse if file hasn't changed and annotation count matches
  const annCount = db.getSessionAnnotations(sessionId).length;
  const cached = pageCache.get(sessionId);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.annCount === annCount) {
    return new Response(cached.html, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  // Parse the full JSONL
  const parser = new IncrementalParser();
  const content = fs.readFileSync(session.jsonl_path, "utf-8");
  const lines = content.split("\n");
  parser.feedLines(lines);

  const meta = parser.getMetadata();
  const turns = parser.getTurns();

  if (turns.length === 0 && lines.length > 1) {
    // Debug: count parseable lines and their types
    const types = new Map<string, number>();
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        const t = obj.type ?? "unknown";
        types.set(t, (types.get(t) ?? 0) + 1);
      } catch { /* skip */ }
    }
    console.warn(
      `[gloss] Session ${sessionId}: 0 turns parsed from ${lines.length} lines (${session.jsonl_path}).` +
      ` Line types: ${[...types.entries()].map(([k, v]) => `${k}=${v}`).join(", ")}`,
    );
  }

  const convo = {
    sessionId: meta.sessionId ?? sessionId,
    projectDir: meta.projectDir,
    model: meta.model,
    version: meta.version,
    startTime: meta.startTime,
    turns,
  };

  const viewerDir = path.join(os.homedir(), ".claude", "viewer");
  const wsUrl = `ws://localhost:${port}/ws/${sessionId}`;

  // Load baked annotations from DB
  const dbAnnotations = db.exportSessionAnnotations(sessionId);
  const bakedObj: Record<string, unknown> = {};
  for (const ann of dbAnnotations) {
    bakedObj[ann.id] = ann;
  }

  const params = buildPageParams(convo, session.jsonl_path, viewerDir, {
    includeThinking,
    includeTools,
    mode: "server",
    wsUrl,
  });

  // Pass custom title from DB if set
  if (session.title) {
    params.customTitle = session.title;
  }

  // Override baked annotations with DB data
  if (dbAnnotations.length > 0) {
    params.bakedAnnotationsJson = safeForScript(JSON.stringify(bakedObj));
  }

  // Update turn count in DB
  db.upsertSession({
    id: sessionId,
    jsonl_path: session.jsonl_path,
    turn_count: convo.turns.length,
    model: convo.model ?? undefined,
    project: convo.projectDir ?? undefined,
    start_time: convo.startTime
      ? Math.floor(new Date(convo.startTime).getTime() / 1000)
      : undefined,
  });

  const html = buildHtmlPage(params);

  // Cache the rendered page
  pageCache.set(sessionId, { html, mtimeMs: stat.mtimeMs, annCount });
  evictOldestPage();

  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

// ---------------------------------------------------------------------------
// API routes
// ---------------------------------------------------------------------------

export async function handleApiRoute(
  req: Request,
  pathname: string,
  db: ConvoDb,
  search?: { embeddingEngine?: EmbeddingEngine; vectorIndex?: VectorIndex | null },
): Promise<Response> {
  const jsonHeaders = { "Content-Type": "application/json; charset=utf-8" };

  try {
    return await handleApiRouteInner(req, pathname, db, search);
  } catch (err) {
    if (err instanceof SyntaxError) {
      return new Response(JSON.stringify({ error: "Invalid JSON in request body" }), {
        status: 400,
        headers: jsonHeaders,
      });
    }
    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status: 500,
      headers: jsonHeaders,
    });
  }
}

async function handleApiRouteInner(
  req: Request,
  pathname: string,
  db: ConvoDb,
  search?: { embeddingEngine?: EmbeddingEngine; vectorIndex?: VectorIndex | null },
): Promise<Response> {
  const jsonHeaders = { "Content-Type": "application/json; charset=utf-8" };

  // GET /api/sessions/:id/annotations
  const getAnnotationsMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/annotations$/);
  if (getAnnotationsMatch && req.method === "GET") {
    const sessionId = getAnnotationsMatch[1];
    const annotations = db.getSessionAnnotations(sessionId);
    return new Response(JSON.stringify(annotations), { headers: jsonHeaders });
  }

  // POST /api/sessions/:id/annotations
  if (getAnnotationsMatch && req.method === "POST") {
    const sessionId = getAnnotationsMatch[1];
    const body = (await req.json()) as Record<string, unknown>;
    if (!body.id || typeof body.id !== "string") {
      return new Response(JSON.stringify({ error: "Missing required field: id" }), {
        status: 400, headers: jsonHeaders,
      });
    }
    db.upsertAnnotation({
      id: body.id as string,
      session_id: sessionId,
      turn_index: (body.turnIndex as number) ?? 0,
      block_index: (body.blockIndex as number) ?? 0,
      char_start: (body.charStart as number) ?? -1,
      char_end: (body.charEnd as number) ?? -1,
      text: (body.text as string) ?? "",
      comment: (body.comment as string) ?? "",
      kind: (body.kind as string) ?? "highlight",
      speaker: (body.speaker as string) ?? null,
    });
    // Replace tags atomically
    if (Array.isArray(body.tags)) {
      db.replaceAnnotationTags(body.id as string, body.tags as string[]);
    }
    // Broadcast to other WS clients on this session
    invalidatePageCache(sessionId);
    broadcastAnnotationSync(sessionId);
    return new Response(JSON.stringify({ ok: true }), { headers: jsonHeaders });
  }

  // PUT /api/sessions/:id/annotations/:annId
  const putAnnotationMatch = pathname.match(
    /^\/api\/sessions\/([^/]+)\/annotations\/([^/]+)$/,
  );
  if (putAnnotationMatch && req.method === "PUT") {
    const sessionId = putAnnotationMatch[1];
    const annId = putAnnotationMatch[2];
    const body = (await req.json()) as Record<string, unknown>;
    db.upsertAnnotation({
      id: annId,
      session_id: sessionId,
      turn_index: (body.turnIndex as number) ?? 0,
      block_index: (body.blockIndex as number) ?? 0,
      char_start: (body.charStart as number) ?? -1,
      char_end: (body.charEnd as number) ?? -1,
      text: (body.text as string) ?? "",
      comment: (body.comment as string) ?? "",
      kind: (body.kind as string) ?? "highlight",
      speaker: (body.speaker as string) ?? null,
    });
    if (Array.isArray(body.tags)) {
      db.replaceAnnotationTags(annId, body.tags as string[]);
    }
    invalidatePageCache(sessionId);
    broadcastAnnotationSync(sessionId);
    return new Response(JSON.stringify({ ok: true }), { headers: jsonHeaders });
  }

  // DELETE /api/sessions/:id/annotations/:annId
  if (putAnnotationMatch && req.method === "DELETE") {
    const annId = putAnnotationMatch[2];
    const sessionId = putAnnotationMatch[1];
    db.deleteAnnotation(annId);
    invalidatePageCache(sessionId);
    broadcastAnnotationSync(sessionId);
    return new Response(JSON.stringify({ ok: true }), { headers: jsonHeaders });
  }

  // GET /api/sessions/:id/data
  const dataMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/data$/);
  if (dataMatch && req.method === "GET") {
    const sessionId = dataMatch[1];
    const session = db.getSession(sessionId);
    if (!session?.jsonl_path || !fs.existsSync(session.jsonl_path)) {
      return new Response("Not found", { status: 404 });
    }
    // Guard against OOM — same limit as renderConversationPage
    try {
      const stat = fs.statSync(session.jsonl_path);
      if (stat.size > 300 * 1024 * 1024) {
        return new Response(JSON.stringify({ error: "Session too large" }), { status: 413, headers: jsonHeaders });
      }
    } catch {
      return new Response(JSON.stringify({ error: "Could not stat file" }), { status: 500, headers: jsonHeaders });
    }
    const parser = new IncrementalParser();
    parser.feedLines(fs.readFileSync(session.jsonl_path, "utf-8").split("\n"));
    const convoData = parser.getTurns().map((turn) => ({
      role: turn.role,
      timestamp: turn.timestamp || "",
      text: turn.blocks
        .filter((b): b is TextBlock => b.type === "text")
        .map((b) => b.text || ""),
    }));
    return new Response(JSON.stringify(convoData), { headers: jsonHeaders });
  }

  // POST /api/ask — JSON response
  if (pathname === "/api/ask" && req.method === "POST") {
    const body = (await req.json()) as Record<string, unknown>;
    const q = (body.query as string)?.trim();
    if (!q) {
      return new Response(JSON.stringify({ error: "No query" }), { status: 400, headers: jsonHeaders });
    }
    const { askQuestion } = await import("./ask.js");
    const result = await askQuestion(db, q, {
      maxSources: (body.maxSources as number) ?? undefined,
      vectorIndex: search?.vectorIndex ?? undefined,
      embeddingEngine: search?.embeddingEngine,
    });
    return new Response(JSON.stringify(result), { headers: jsonHeaders });
  }

  // POST /api/ask-html — returns rendered HTML fragment
  if (pathname === "/api/ask-html" && req.method === "POST") {
    const body = (await req.json()) as Record<string, unknown>;
    const q = (body.query as string)?.trim();
    if (!q) {
      return new Response("<div class=\"ask-error\">No query</div>", {
        status: 400, headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }
    const { askQuestion } = await import("./ask.js");
    const { buildAskResultsHtml } = await import("./ask-page.js");
    const result = await askQuestion(db, q, {
      vectorIndex: search?.vectorIndex ?? undefined,
      embeddingEngine: search?.embeddingEngine,
    });
    const html = buildAskResultsHtml(result);
    return new Response(html, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  // POST /api/ask-stream — NDJSON streaming: sources first, then Claude chunks
  if (pathname === "/api/ask-stream" && req.method === "POST") {
    const body = (await req.json()) as Record<string, unknown>;
    const q = (body.query as string)?.trim();
    if (!q) {
      return new Response(JSON.stringify({ type: "error", message: "No query" }) + "\n", {
        status: 400, headers: { "Content-Type": "application/x-ndjson" },
      });
    }
    const { askQuestionStream } = await import("./ask.js");
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        try {
          for await (const event of askQuestionStream(db, q, {
            vectorIndex: search?.vectorIndex ?? undefined,
            embeddingEngine: search?.embeddingEngine,
          })) {
            controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          controller.enqueue(encoder.encode(JSON.stringify({ type: "error", message: msg }) + "\n"));
        }
        controller.close();
      },
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "application/x-ndjson",
        "Cache-Control": "no-cache",
        "Transfer-Encoding": "chunked",
      },
    });
  }

  // GET /api/search?q=...
  if (pathname === "/api/search" && req.method === "GET") {
    const url = new URL(req.url);
    const q = url.searchParams.get("q")?.trim();
    if (!q) {
      return new Response(JSON.stringify({ results: [], indexed: db.ftsIndexedCount() }), { headers: jsonHeaders });
    }
    try {
      const results = db.searchSessions(q, 30);
      // Enrich with session metadata
      const enriched = results.map((r) => {
        const session = db.getSession(r.session_id);
        return {
          id: r.session_id,
          match_count: r.match_count,
          project: session?.project ?? "",
          title: session?.title ?? "",
          model: session?.model ?? "",
          last_modified: session?.last_modified ?? session?.start_time ?? 0,
          turn_count: session?.turn_count ?? 0,
          file_size: session?.file_size ?? 0,
        };
      });
      return new Response(JSON.stringify({ results: enriched, indexed: db.ftsIndexedCount() }), { headers: jsonHeaders });
    } catch {
      return new Response(JSON.stringify({ results: [], error: "Invalid search query", indexed: db.ftsIndexedCount() }), { headers: jsonHeaders });
    }
  }

  // PATCH /api/sessions/:id/title
  const titleMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/title$/);
  if (titleMatch && req.method === "PATCH") {
    const sessionId = titleMatch[1];
    const body = (await req.json()) as Record<string, unknown>;
    const title = (body.title as string) ?? "";
    db.db.run("UPDATE sessions SET title = ? WHERE id = ?", [title || null, sessionId]);
    invalidatePageCache(sessionId);
    indexHtmlCache = null; // title shows on index page too
    return new Response(JSON.stringify({ ok: true }), { headers: jsonHeaders });
  }

  // PATCH /api/sessions/:id/hidden
  const hiddenMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/hidden$/);
  if (hiddenMatch && req.method === "PATCH") {
    const sessionId = hiddenMatch[1];
    const body = (await req.json()) as Record<string, unknown>;
    const hidden = body.hidden ? 1 : 0;
    db.db.run("UPDATE sessions SET hidden = ? WHERE id = ?", [hidden, sessionId]);
    indexHtmlCache = null;
    return new Response(JSON.stringify({ ok: true }), { headers: jsonHeaders });
  }

  // GET /api/settings
  if (pathname === "/api/settings" && req.method === "GET") {
    const settings = {
      embeddings_enabled: db.getSetting("embeddings_enabled") === "1",
      min_turns: parseInt(db.getSetting("min_turns") ?? "0", 10),
    };
    return new Response(JSON.stringify(settings), { headers: jsonHeaders });
  }

  // PATCH /api/settings
  if (pathname === "/api/settings" && req.method === "PATCH") {
    const body = (await req.json()) as Record<string, unknown>;
    if ("embeddings_enabled" in body) {
      db.setSetting("embeddings_enabled", body.embeddings_enabled ? "1" : "0");
    }
    if ("min_turns" in body) {
      db.setSetting("min_turns", String(Math.max(0, Number(body.min_turns) || 0)));
    }
    indexHtmlCache = null;
    return new Response(JSON.stringify({ ok: true }), { headers: jsonHeaders });
  }

  return new Response("Not Found", { status: 404 });
}

function broadcastAnnotationSync(sessionId: string) {
  const state = sessions.get(sessionId);
  if (!state || state.clients.size === 0) return;
  // Broadcast a lightweight sync signal; clients can refetch if needed
  broadcast(state, { type: "annotation_sync", sessionId });
}

// ---------------------------------------------------------------------------
// Legacy sidecar import
// ---------------------------------------------------------------------------

function importLegacySidecars(db: ConvoDb) {
  const viewerDir = path.join(os.homedir(), ".claude", "viewer");
  if (!fs.existsSync(viewerDir)) return;

  let files: string[];
  try {
    files = fs.readdirSync(viewerDir).filter((f) => f.endsWith(".annotations.json"));
  } catch {
    return;
  }

  for (const file of files) {
    const sessionId = file.replace(".annotations.json", "");
    const filePath = path.join(viewerDir, file);
    try {
      const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      let annotations: any[];
      if (Array.isArray(raw)) {
        annotations = raw;
      } else {
        annotations = Object.entries(raw).map(([id, v]: [string, any]) => ({ id, ...v }));
      }
      if (annotations.length) {
        // Ensure session exists
        if (!db.getSession(sessionId)) {
          db.upsertSession({ id: sessionId });
        }
        db.importAnnotationsJson(sessionId, annotations);
      }
    } catch {
      // skip malformed files
    }
  }
}
