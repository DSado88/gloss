import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { openDb, type ConvoDb } from "./db.js";
import { handleApiRoute } from "./server.js";

// ---------------------------------------------------------------------------
// Test fixture: a minimal projects dir with one JSONL conversation
// ---------------------------------------------------------------------------

const SESSION_ID = "test-session-00000000-0000-0000-0000-000000000001";

function writeFixtureJsonl(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${SESSION_ID}.jsonl`);
  const lines = [
    JSON.stringify({
      type: "summary",
      sessionId: SESSION_ID,
      cwd: "/home/user/project",
      version: "1.0.0",
    }),
    JSON.stringify({
      type: "user",
      sessionId: SESSION_ID,
      message: { content: "Hello, Claude!" },
      timestamp: "2024-01-15T10:30:00Z",
    }),
    JSON.stringify({
      type: "assistant",
      message: {
        content: [{ type: "text", text: "Hello! How can I help you today?" }],
        model: "claude-sonnet-4-20250514",
      },
      timestamp: "2024-01-15T10:30:05Z",
    }),
  ];
  fs.writeFileSync(filePath, lines.join("\n") + "\n", "utf-8");
  return filePath;
}

// ---------------------------------------------------------------------------
// Server integration tests
// ---------------------------------------------------------------------------

describe("server routes", () => {
  let tempDir: string;
  let dbDir: string;
  let db: ConvoDb;
  let baseUrl: string;
  let server: ReturnType<typeof Bun.serve>;
  const port = 13457; // unusual port to avoid conflicts

  beforeAll(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "convo-server-test-"));
    dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "convo-server-db-"));

    // Write a fixture JSONL
    const projectDir = path.join(tempDir, "-Users-test-project");
    const jsonlPath = writeFixtureJsonl(projectDir);

    // Seed the database
    db = openDb(path.join(dbDir, "test.sqlite"));
    db.upsertSession({
      id: SESSION_ID,
      jsonl_path: jsonlPath,
      project: "/home/user/project",
      model: "claude-sonnet-4-20250514",
      start_time: Math.floor(new Date("2024-01-15T10:30:00Z").getTime() / 1000),
      turn_count: 2,
    });

    const { buildClientJs } = await import("./templates/client-js.js");
    const { CSS_STYLES } = await import("./templates/css.js");
    const { buildServerIndex } = await import("./index-page.js");
    const { buildHtmlPage } = await import("./templates/html-template.js");
    const { buildPageParams } = await import("./convert.js");
    const { IncrementalParser } = await import("./incremental-parser.js");

    const clientJsContent = buildClientJs();

    server = Bun.serve({
      port,
      async fetch(req) {
        const url = new URL(req.url);
        const pathname = url.pathname;

        if (pathname === "/assets/style.css") {
          return new Response(CSS_STYLES, {
            headers: { "Content-Type": "text/css; charset=utf-8" },
          });
        }
        if (pathname === "/assets/client.js") {
          return new Response(clientJsContent, {
            headers: { "Content-Type": "application/javascript; charset=utf-8" },
          });
        }

        // Use the real API handler
        if (pathname.startsWith("/api/")) {
          return handleApiRoute(req, pathname, db);
        }

        if (pathname.startsWith("/c/")) {
          const sessionId = pathname.slice(3);
          const session = db.getSession(sessionId);
          if (!session?.jsonl_path || !fs.existsSync(session.jsonl_path)) {
            return new Response("Conversation not found", { status: 404 });
          }
          const parser = new IncrementalParser();
          const content = fs.readFileSync(session.jsonl_path, "utf-8");
          parser.feedLines(content.split("\n"));
          const meta = parser.getMetadata();
          const convo = {
            sessionId: meta.sessionId ?? sessionId,
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
            wsUrl: `ws://localhost:${port}/ws/${sessionId}`,
          });
          const html = buildHtmlPage(params);
          return new Response(html, {
            headers: { "Content-Type": "text/html; charset=utf-8" },
          });
        }

        if (pathname === "/" || pathname === "/index.html") {
          const allSessions = db.listSessions({ limit: 200 });
          const html = buildServerIndex(allSessions);
          return new Response(html, {
            headers: { "Content-Type": "text/html; charset=utf-8" },
          });
        }

        return new Response("Not Found", { status: 404 });
      },
    });

    baseUrl = `http://localhost:${port}`;
  });

  afterAll(() => {
    server?.stop();
    db?.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
    fs.rmSync(dbDir, { recursive: true, force: true });
  });

  // -----------------------------------------------------------------------
  // Index
  // -----------------------------------------------------------------------

  it("GET / returns 200 with HTML", async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain("<!DOCTYPE html>");
  });

  it("GET / lists the seeded session", async () => {
    const body = await (await fetch(`${baseUrl}/`)).text();
    expect(body).toContain(SESSION_ID.slice(0, 8));
  });

  // -----------------------------------------------------------------------
  // Static assets
  // -----------------------------------------------------------------------

  it("GET /assets/style.css returns CSS", async () => {
    const res = await fetch(`${baseUrl}/assets/style.css`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/css");
    const body = await res.text();
    expect(body.length).toBeGreaterThan(100);
  });

  it("GET /assets/client.js returns JavaScript", async () => {
    const res = await fetch(`${baseUrl}/assets/client.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("javascript");
    const body = await res.text();
    expect(body.length).toBeGreaterThan(100);
  });

  // -----------------------------------------------------------------------
  // Conversation page
  // -----------------------------------------------------------------------

  it("GET /c/:id returns 200 for valid session", async () => {
    const res = await fetch(`${baseUrl}/c/${SESSION_ID}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
  });

  it("GET /c/:id returns 404 for unknown session", async () => {
    const res = await fetch(`${baseUrl}/c/nonexistent-session-id`);
    expect(res.status).toBe(404);
  });

  it("GET /c/ with path traversal attempt returns 404, not file contents", async () => {
    // Session IDs are DB keys, not file paths. Path traversal in the
    // session ID should match no DB record → 404.
    const traversalAttempts = [
      "../../../etc/passwd",
      "..%2F..%2F..%2Fetc%2Fpasswd",
      "../../src/server.ts",
      "%2e%2e%2f%2e%2e%2f",
    ];
    for (const attempt of traversalAttempts) {
      const res = await fetch(`${baseUrl}/c/${attempt}`);
      expect(res.status).toBe(404);
    }
  });

  it("conversation page uses external assets (server mode)", async () => {
    const body = await (await fetch(`${baseUrl}/c/${SESSION_ID}`)).text();
    expect(body).toContain('href="/assets/style.css"');
    expect(body).toContain('src="/assets/client.js"');
    expect(body).toContain('data-mode="server"');
  });

  it("conversation page includes page-config JSON", async () => {
    const body = await (await fetch(`${baseUrl}/c/${SESSION_ID}`)).text();
    expect(body).toContain('id="page-config"');
    const match = body.match(/id="page-config">(.*?)<\/script/s);
    expect(match).not.toBeNull();
    const config = JSON.parse(match![1]);
    expect(config.sessionId).toBe(SESSION_ID);
    expect(config.mode).toBe("server");
    expect(config.wsUrl).toContain("/ws/");
  });

  it("conversation page contains the conversation content", async () => {
    const body = await (await fetch(`${baseUrl}/c/${SESSION_ID}`)).text();
    expect(body).toContain("Hello, Claude!");
    expect(body).toContain("Hello! How can I help you today?");
  });

  // -----------------------------------------------------------------------
  // Annotation CRUD API
  // -----------------------------------------------------------------------

  describe("annotation CRUD", () => {
    const ANN_ID = "test-ann-001";

    it("POST creates an annotation", async () => {
      const res = await fetch(`${baseUrl}/api/sessions/${SESSION_ID}/annotations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: ANN_ID,
          turnIndex: 0,
          blockIndex: 0,
          charStart: 0,
          charEnd: 5,
          text: "Hello",
          comment: "greeting",
          kind: "highlight",
          speaker: "user",
          tags: ["test-tag"],
        }),
      });
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.ok).toBe(true);
    });

    it("GET returns the created annotation", async () => {
      const res = await fetch(`${baseUrl}/api/sessions/${SESSION_ID}/annotations`);
      const data = await res.json() as any;
      const ann = data.find((a: any) => a.id === ANN_ID);
      expect(ann).toBeDefined();
      expect(ann.text).toBe("Hello");
      expect(ann.comment).toBe("greeting");
      expect(ann.tags).toContain("test-tag");
    });

    it("PUT updates an annotation", async () => {
      const res = await fetch(
        `${baseUrl}/api/sessions/${SESSION_ID}/annotations/${ANN_ID}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            turnIndex: 0,
            blockIndex: 0,
            charStart: 0,
            charEnd: 5,
            text: "Hello",
            comment: "updated comment",
            kind: "decision",
            speaker: "user",
            tags: ["updated-tag"],
          }),
        },
      );
      expect(res.status).toBe(200);

      // Verify the update
      const getRes = await fetch(`${baseUrl}/api/sessions/${SESSION_ID}/annotations`);
      const data = await getRes.json() as any;
      const ann = data.find((a: any) => a.id === ANN_ID);
      expect(ann.comment).toBe("updated comment");
      expect(ann.kind).toBe("decision");
      expect(ann.tags).toEqual(["updated-tag"]);
    });

    it("DELETE removes an annotation", async () => {
      const res = await fetch(
        `${baseUrl}/api/sessions/${SESSION_ID}/annotations/${ANN_ID}`,
        { method: "DELETE" },
      );
      expect(res.status).toBe(200);

      // Verify deletion
      const getRes = await fetch(`${baseUrl}/api/sessions/${SESSION_ID}/annotations`);
      const data = await getRes.json() as any;
      const ann = data.find((a: any) => a.id === ANN_ID);
      expect(ann).toBeUndefined();
    });

    it("POST with tags does atomic tag replacement", async () => {
      // Create annotation with initial tags
      await fetch(`${baseUrl}/api/sessions/${SESSION_ID}/annotations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "tag-test-ann",
          turnIndex: 1,
          blockIndex: 0,
          charStart: 0,
          charEnd: 3,
          text: "Hi!",
          tags: ["alpha", "beta"],
        }),
      });

      // Update with different tags — should replace, not append
      await fetch(
        `${baseUrl}/api/sessions/${SESSION_ID}/annotations/tag-test-ann`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            turnIndex: 1,
            blockIndex: 0,
            charStart: 0,
            charEnd: 3,
            text: "Hi!",
            tags: ["gamma"],
          }),
        },
      );

      const getRes = await fetch(`${baseUrl}/api/sessions/${SESSION_ID}/annotations`);
      const data = await getRes.json() as any;
      const ann = data.find((a: any) => a.id === "tag-test-ann");
      expect(ann.tags).toEqual(["gamma"]);
      // "alpha" and "beta" should be gone
      expect(ann.tags).not.toContain("alpha");
      expect(ann.tags).not.toContain("beta");

      // Cleanup
      await fetch(
        `${baseUrl}/api/sessions/${SESSION_ID}/annotations/tag-test-ann`,
        { method: "DELETE" },
      );
    });
  });

  // -----------------------------------------------------------------------
  // Malformed request handling
  // -----------------------------------------------------------------------

  it("POST annotation without required id field returns 400", async () => {
    const res = await fetch(`${baseUrl}/api/sessions/${SESSION_ID}/annotations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        turnIndex: 0,
        charStart: 0,
        charEnd: 5,
        text: "hello",
        // deliberately omitting id
      }),
    });
    expect(res.status).toBe(400);
    const data = await res.json() as any;
    expect(data.error).toBeDefined();
  });

  it("POST annotation for nonexistent session returns 404, not 500", async () => {
    const res = await fetch(`${baseUrl}/api/sessions/nonexistent-session-xyz/annotations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "orphan-ann",
        turnIndex: 0,
        charStart: 0,
        charEnd: 5,
        text: "test",
      }),
    });
    expect(res.status).toBe(404);
    const data = await res.json() as any;
    expect(data.error).toContain("Session");
  });

  it("POST annotation with malformed JSON returns 400, not 500", async () => {
    const res = await fetch(`${baseUrl}/api/sessions/${SESSION_ID}/annotations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not valid json{{{",
    });
    expect(res.status).toBe(400);
    const data = await res.json() as any;
    expect(data.error).toBeDefined();
  });

  it("POST annotation with JSON null body returns 400, not 500", async () => {
    // JSON.parse("null") returns null. Accessing null.id throws TypeError.
    // The handler should return 400 (bad request), not 500 (crash).
    const res = await fetch(`${baseUrl}/api/sessions/${SESSION_ID}/annotations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "null",
    });
    expect(res.status).toBe(400);
  });

  it("PUT annotation with malformed JSON returns 400", async () => {
    const res = await fetch(
      `${baseUrl}/api/sessions/${SESSION_ID}/annotations/some-ann-id`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: "{broken",
      },
    );
    expect(res.status).toBe(400);
  });

  it("PATCH title with malformed JSON returns 400", async () => {
    const res = await fetch(
      `${baseUrl}/api/sessions/${SESSION_ID}/title`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: "{{invalid}}",
      },
    );
    expect(res.status).toBe(400);
  });

  // -----------------------------------------------------------------------
  // Session data API
  // -----------------------------------------------------------------------

  it("GET /api/sessions/:id/data returns conversation turns", async () => {
    const res = await fetch(`${baseUrl}/api/sessions/${SESSION_ID}/data`);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(Array.isArray(data.turns)).toBe(true);
    expect(data.turns.length).toBeGreaterThan(0);
    expect(data.turns[0]).toHaveProperty("role");
    expect(data.turns[0]).toHaveProperty("text");
    expect(data.totalTurns).toBeGreaterThan(0);
  });

  it("GET /api/sessions/:id/data clamps out-of-range start/end params", async () => {
    // start > totalTurns should be clamped so metadata stays consistent
    const res = await fetch(`${baseUrl}/api/sessions/${SESSION_ID}/data?start=999`);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    // start should be clamped to a valid index (not exceed totalTurns - 1)
    expect(data.start).toBeLessThanOrEqual(data.totalTurns - 1);
    expect(data.start).toBeGreaterThanOrEqual(0);
    // end should not be less than start
    expect(data.end).toBeGreaterThanOrEqual(data.start);
    expect(data.end).toBeLessThanOrEqual(data.totalTurns - 1);
  });

  it("GET /api/sessions/:id/data handles negative end param gracefully", async () => {
    const res = await fetch(`${baseUrl}/api/sessions/${SESSION_ID}/data?end=-1`);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    // Negative end should be clamped to 0, not produce confusing metadata
    expect(data.end).toBeGreaterThanOrEqual(0);
  });

  it("GET /api/sessions/:id/data returns 404 JSON for nonexistent session", async () => {
    const res = await fetch(`${baseUrl}/api/sessions/nonexistent-xyz/data`);
    expect(res.status).toBe(404);
    // API endpoints should return JSON consistently, not plain text
    const data = await res.json() as any;
    expect(data.error).toBeDefined();
  });

  it("GET /api/sessions/:id/data with start > end clamps end to start", async () => {
    // When start > end, the server should clamp end = start (single-turn result)
    const res = await fetch(`${baseUrl}/api/sessions/${SESSION_ID}/data?start=1&end=0`);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.start).toBeLessThanOrEqual(data.end);
    expect(data.turns.length).toBeLessThanOrEqual(1);
  });

  // -----------------------------------------------------------------------
  // Search API
  // -----------------------------------------------------------------------

  it("GET /api/search with empty q returns empty results", async () => {
    const res = await fetch(`${baseUrl}/api/search`);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.results).toEqual([]);
    expect(data).toHaveProperty("indexed");
  });

  it("GET /api/search with valid q returns 200 (even with no FTS data)", async () => {
    const res = await fetch(`${baseUrl}/api/search?q=hello`);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(Array.isArray(data.results)).toBe(true);
  });

  it("GET /api/search with FTS-special-char query returns results without crashing", async () => {
    // FTS5 special chars are now sanitized by searchSessions, so this
    // returns empty results gracefully instead of throwing
    const res = await fetch(`${baseUrl}/api/search?q=${encodeURIComponent('"unclosed')}`);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.results).toEqual([]);
  });

  // -----------------------------------------------------------------------
  // Settings API
  // -----------------------------------------------------------------------

  it("GET /api/settings returns settings object", async () => {
    const res = await fetch(`${baseUrl}/api/settings`);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data).toHaveProperty("embeddings_enabled");
    expect(data).toHaveProperty("min_turns");
    expect(typeof data.min_turns).toBe("number");
  });

  it("PATCH /api/settings updates min_turns", async () => {
    const res = await fetch(`${baseUrl}/api/settings`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ min_turns: 5 }),
    });
    expect(res.status).toBe(200);

    const getRes = await fetch(`${baseUrl}/api/settings`);
    const data = await getRes.json() as any;
    expect(data.min_turns).toBe(5);

    // Reset to 0
    await fetch(`${baseUrl}/api/settings`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ min_turns: 0 }),
    });
  });

  it("GET /api/settings returns all writeable settings including resume and terminal", async () => {
    // PATCH can write resume_enabled, terminal_app, resume_dangerous_mode.
    // GET must return them too — otherwise clients can't read back what they wrote.
    await fetch(`${baseUrl}/api/settings`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        resume_enabled: true,
        terminal_app: "iTerm",
        resume_dangerous_mode: true,
      }),
    });

    const getRes = await fetch(`${baseUrl}/api/settings`);
    const data = await getRes.json() as any;
    expect(data.resume_enabled).toBe(true);
    expect(data.terminal_app).toBe("iTerm");
    expect(data.resume_dangerous_mode).toBe(true);

    // Reset
    await fetch(`${baseUrl}/api/settings`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        resume_enabled: false,
        terminal_app: "Terminal",
        resume_dangerous_mode: false,
      }),
    });
  });

  // -----------------------------------------------------------------------
  // Title + Hidden API
  // -----------------------------------------------------------------------

  it("PATCH /api/sessions/:id/title sets and clears title", async () => {
    // Set title
    const setRes = await fetch(`${baseUrl}/api/sessions/${SESSION_ID}/title`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "My Session Name" }),
    });
    expect(setRes.status).toBe(200);

    // Verify it was set
    const session1 = db.getSession(SESSION_ID);
    expect(session1!.title).toBe("My Session Name");

    // Clear title with empty string
    await fetch(`${baseUrl}/api/sessions/${SESSION_ID}/title`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "" }),
    });
    const session2 = db.getSession(SESSION_ID);
    expect(session2!.title).toBeNull();
  });

  it("PATCH /api/sessions/:id/hidden toggles hidden flag", async () => {
    // Hide
    const hideRes = await fetch(`${baseUrl}/api/sessions/${SESSION_ID}/hidden`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hidden: true }),
    });
    expect(hideRes.status).toBe(200);
    expect(db.getSession(SESSION_ID)!.hidden).toBe(1);

    // Unhide
    await fetch(`${baseUrl}/api/sessions/${SESSION_ID}/hidden`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hidden: false }),
    });
    expect(db.getSession(SESSION_ID)!.hidden).toBe(0);
  });

  // -----------------------------------------------------------------------
  // API 404s
  // -----------------------------------------------------------------------

  it("GET /api/sessions/:id/annotations returns empty array for nonexistent session", async () => {
    const res = await fetch(`${baseUrl}/api/sessions/nonexistent-xyz/annotations`);
    expect(res.status).toBe(200);
    const data = await res.json() as any[];
    expect(data).toEqual([]);
  });

  it("DELETE to annotation collection endpoint (no annId) returns 404", async () => {
    const res = await fetch(`${baseUrl}/api/sessions/${SESSION_ID}/annotations`, {
      method: "DELETE",
    });
    expect(res.status).toBe(404);
  });

  it("unknown API routes return 404", async () => {
    const res = await fetch(`${baseUrl}/api/unknown`);
    expect(res.status).toBe(404);
  });

  it("unknown routes return 404", async () => {
    const res = await fetch(`${baseUrl}/unknown/path`);
    expect(res.status).toBe(404);
  });

  // -----------------------------------------------------------------------
  // Tags API
  // -----------------------------------------------------------------------

  it("GET /api/tags returns empty array when no tags exist", async () => {
    const res = await fetch(`${baseUrl}/api/tags`);
    expect(res.status).toBe(200);
    const data = await res.json() as any[];
    expect(Array.isArray(data)).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Highlights API
  // -----------------------------------------------------------------------

  it("GET /api/highlights returns 200 with default parameters", async () => {
    const res = await fetch(`${baseUrl}/api/highlights`);
    expect(res.status).toBe(200);
    const data = await res.json() as any[];
    expect(Array.isArray(data)).toBe(true);
  });

  it("GET /api/highlights with query returns 200", async () => {
    const res = await fetch(`${baseUrl}/api/highlights?q=test&limit=10`);
    expect(res.status).toBe(200);
    const data = await res.json() as any[];
    expect(Array.isArray(data)).toBe(true);
  });

  it("GET /api/highlights with NaN limit does not crash", async () => {
    const res = await fetch(`${baseUrl}/api/highlights?limit=abc`);
    expect(res.status).toBe(200);
    const data = await res.json() as any[];
    expect(Array.isArray(data)).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Sessions list API
  // -----------------------------------------------------------------------

  it("GET /api/sessions returns session list", async () => {
    const res = await fetch(`${baseUrl}/api/sessions`);
    expect(res.status).toBe(200);
    const data = await res.json() as any[];
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThan(0);
    expect(data[0]).toHaveProperty("id");
    expect(data[0]).toHaveProperty("project");
  });

  it("GET /api/sessions with project filter returns filtered results", async () => {
    const res = await fetch(`${baseUrl}/api/sessions?project=nonexistent_xyz`);
    expect(res.status).toBe(200);
    const data = await res.json() as any[];
    expect(data).toEqual([]);
  });

  it("GET /api/sessions with negative limit does not bypass server cap", async () => {
    // SQLite treats LIMIT -1 as "no limit" — the server must clamp to [0, 200]
    const res = await fetch(`${baseUrl}/api/sessions?limit=-1`);
    expect(res.status).toBe(200);
    const data = await res.json() as any[];
    // Should NOT get unlimited results — must be capped
    expect(data.length).toBeLessThanOrEqual(200);
    // With our fixture's 1 session, this just verifies it doesn't crash
    expect(data.length).toBeGreaterThanOrEqual(0);
  });

  it("GET /api/sessions with NaN limit uses default", async () => {
    const res = await fetch(`${baseUrl}/api/sessions?limit=abc`);
    expect(res.status).toBe(200);
    const data = await res.json() as any[];
    expect(Array.isArray(data)).toBe(true);
  });
});
