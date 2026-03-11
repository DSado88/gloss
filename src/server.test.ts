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
  // API 404s
  // -----------------------------------------------------------------------

  it("unknown API routes return 404", async () => {
    const res = await fetch(`${baseUrl}/api/unknown`);
    expect(res.status).toBe(404);
  });

  it("unknown routes return 404", async () => {
    const res = await fetch(`${baseUrl}/unknown/path`);
    expect(res.status).toBe(404);
  });
});
