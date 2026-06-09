import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { openDb, type ConvoDb } from "./db.js";
import { resolveRemoteConfig, guardRequest, isAuthorized, buildAuthCookie, OS_ENDPOINTS } from "./remote-guard.js";
import { createRequestHandler } from "./server.js";

const TOKEN = "test-secret-token-1234567890";

function makeReq(url: string, init?: RequestInit): Request {
  return new Request(url, init);
}

// ---------------------------------------------------------------------------
// resolveRemoteConfig
// ---------------------------------------------------------------------------

describe("resolveRemoteConfig", () => {
  it("defaults to local mode when GLOSS_REMOTE is unset", () => {
    const cfg = resolveRemoteConfig({});
    expect(cfg.remote).toBe(false);
    expect(cfg.disableOsEndpoints).toBe(false);
    expect(cfg.bindHost).toBeUndefined();
  });

  it("enables remote mode with GLOSS_REMOTE=1 and a token", () => {
    const cfg = resolveRemoteConfig({ GLOSS_REMOTE: "1", GLOSS_AUTH_TOKEN: TOKEN });
    expect(cfg.remote).toBe(true);
    expect(cfg.authToken).toBe(TOKEN);
  });

  it("throws when GLOSS_REMOTE=1 without GLOSS_AUTH_TOKEN", () => {
    expect(() => resolveRemoteConfig({ GLOSS_REMOTE: "1" })).toThrow(/GLOSS_AUTH_TOKEN/);
  });

  it("disables OS endpoints by default in remote mode", () => {
    const cfg = resolveRemoteConfig({ GLOSS_REMOTE: "1", GLOSS_AUTH_TOKEN: TOKEN });
    expect(cfg.disableOsEndpoints).toBe(true);
  });

  it("allows explicit GLOSS_DISABLE_OS_ENDPOINTS=0 override in remote mode", () => {
    const cfg = resolveRemoteConfig({
      GLOSS_REMOTE: "1",
      GLOSS_AUTH_TOKEN: TOKEN,
      GLOSS_DISABLE_OS_ENDPOINTS: "0",
    });
    expect(cfg.disableOsEndpoints).toBe(false);
  });

  it("passes through GLOSS_BIND_HOST", () => {
    const cfg = resolveRemoteConfig({ GLOSS_BIND_HOST: "100.109.110.36" });
    expect(cfg.bindHost).toBe("100.109.110.36");
  });
});

// ---------------------------------------------------------------------------
// isAuthorized / guardRequest (pure)
// ---------------------------------------------------------------------------

describe("guardRequest", () => {
  const cfg = resolveRemoteConfig({ GLOSS_REMOTE: "1", GLOSS_AUTH_TOKEN: TOKEN });
  const localCfg = resolveRemoteConfig({});

  it("local mode allows everything without a token", () => {
    expect(guardRequest(makeReq("http://x/"), "/", localCfg)).toBeNull();
    expect(guardRequest(makeReq("http://x/api/resume", { method: "POST" }), "/api/resume", localCfg)).toBeNull();
  });

  it("remote mode rejects missing token with 401", () => {
    const res = guardRequest(makeReq("http://x/"), "/", cfg);
    expect(res?.status).toBe(401);
  });

  it("remote mode rejects a wrong token with 401", () => {
    const res = guardRequest(
      makeReq("http://x/", { headers: { authorization: "Bearer nope" } }),
      "/",
      cfg,
    );
    expect(res?.status).toBe(401);
  });

  it("accepts Authorization: Bearer token", () => {
    const req = makeReq("http://x/", { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(isAuthorized(req, cfg)).toBe(true);
    expect(guardRequest(req, "/", cfg)).toBeNull();
  });

  it("accepts gloss_token cookie", () => {
    const req = makeReq("http://x/", { headers: { cookie: `other=1; gloss_token=${TOKEN}` } });
    expect(isAuthorized(req, cfg)).toBe(true);
  });

  it("accepts ?token= query parameter", () => {
    const req = makeReq(`http://x/?token=${TOKEN}`);
    expect(isAuthorized(req, cfg)).toBe(true);
  });

  it("blocks all OS endpoints with 403 even when authenticated", () => {
    for (const ep of OS_ENDPOINTS) {
      const req = makeReq(`http://x${ep}`, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      const res = guardRequest(req, ep, cfg);
      expect(res?.status).toBe(403);
    }
  });

  it("covers exactly the four spec endpoints", () => {
    expect([...OS_ENDPOINTS].sort()).toEqual(
      ["/api/backup", "/api/pick-folder", "/api/resume", "/api/spawn-quick"].sort(),
    );
  });

  it("buildAuthCookie produces an HttpOnly cookie", () => {
    const cookie = buildAuthCookie(cfg);
    expect(cookie).toContain(`gloss_token=${TOKEN}`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Path=/");
  });
});

// ---------------------------------------------------------------------------
// Integration: real request handler behind a Bun server
// ---------------------------------------------------------------------------

const SESSION_ID = "guard-session-00000000-0000-0000-0000-000000000001";

function writeFixtureJsonl(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${SESSION_ID}.jsonl`);
  const lines = [
    JSON.stringify({ type: "summary", sessionId: SESSION_ID, cwd: "/home/user/project", version: "1.0.0" }),
    JSON.stringify({ type: "user", sessionId: SESSION_ID, message: { content: "Hello" }, timestamp: "2024-01-15T10:30:00Z" }),
    JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "Hi there" }], model: "claude-sonnet-4-20250514" },
      timestamp: "2024-01-15T10:30:05Z",
    }),
  ];
  fs.writeFileSync(filePath, lines.join("\n") + "\n", "utf-8");
  return filePath;
}

describe("remote mode server integration", () => {
  let tempDir: string;
  let dbDir: string;
  let db: ConvoDb;
  let server: ReturnType<typeof Bun.serve>;
  let baseUrl: string;
  const port = 13561;

  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gloss-guard-test-"));
    dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "gloss-guard-db-"));
    const jsonlPath = writeFixtureJsonl(path.join(tempDir, "-Users-test-project"));

    db = openDb(path.join(dbDir, "test.sqlite"));
    db.upsertSession({ id: SESSION_ID, jsonl_path: jsonlPath, project: "/home/user/project", turn_count: 2 });

    const remoteCfg = resolveRemoteConfig({ GLOSS_REMOTE: "1", GLOSS_AUTH_TOKEN: TOKEN });
    const handler = createRequestHandler({ db, port, remoteCfg });

    server = Bun.serve<{ sessionId: string }>({
      port,
      fetch: (req, srv) => handler(req, srv),
      websocket: {
        open() {},
        close() {},
        message() {},
      },
    });
    baseUrl = `http://localhost:${port}`;
  });

  afterAll(() => {
    server.stop(true);
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
    fs.rmSync(dbDir, { recursive: true, force: true });
  });

  it("rejects unauthenticated index with 401", async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(401);
  });

  it("rejects unauthenticated API route with 401", async () => {
    const res = await fetch(`${baseUrl}/api/sessions`);
    expect(res.status).toBe(401);
  });

  it("serves a conversation page with a Bearer token", async () => {
    const res = await fetch(`${baseUrl}/c/${SESSION_ID}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Hi there");
  });

  it("serves API routes with a Bearer token", async () => {
    const res = await fetch(`${baseUrl}/api/sessions`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
  });

  it("sets a session cookie when authenticating via ?token=", async () => {
    const res = await fetch(`${baseUrl}/?token=${TOKEN}`, { redirect: "manual" });
    expect(res.status).toBe(200);
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("gloss_token=");
  });

  it("accepts the cookie on subsequent requests", async () => {
    const res = await fetch(`${baseUrl}/api/sessions`, {
      headers: { cookie: `gloss_token=${TOKEN}` },
    });
    expect(res.status).toBe(200);
  });

  it("rejects unauthenticated WebSocket route with 401", async () => {
    const res = await fetch(`${baseUrl}/ws/${SESSION_ID}`);
    expect(res.status).toBe(401);
  });

  it("upgrades an authenticated WebSocket connection", async () => {
    const ws = new WebSocket(`ws://localhost:${port}/ws/${SESSION_ID}?token=${TOKEN}`);
    const opened = await new Promise<boolean>((resolve) => {
      ws.onopen = () => resolve(true);
      ws.onerror = () => resolve(false);
      setTimeout(() => resolve(false), 3000);
    });
    ws.close();
    expect(opened).toBe(true);
  });

  it.each(["/api/resume", "/api/spawn-quick", "/api/pick-folder", "/api/backup"])(
    "blocks %s with 403 even when authenticated",
    async (endpoint) => {
      const res = await fetch(`${baseUrl}${endpoint}`, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(403);
    },
  );
});

describe("local mode server integration", () => {
  let dbDir: string;
  let db: ConvoDb;
  let server: ReturnType<typeof Bun.serve>;
  let baseUrl: string;
  const port = 13562;

  beforeAll(() => {
    dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "gloss-guard-local-db-"));
    db = openDb(path.join(dbDir, "test.sqlite"));
    const remoteCfg = resolveRemoteConfig({});
    const handler = createRequestHandler({ db, port, remoteCfg });
    server = Bun.serve<{ sessionId: string }>({
      port,
      fetch: (req, srv) => handler(req, srv),
      websocket: { open() {}, close() {}, message() {} },
    });
    baseUrl = `http://localhost:${port}`;
  });

  afterAll(() => {
    server.stop(true);
    db.close();
    fs.rmSync(dbDir, { recursive: true, force: true });
  });

  it("does not require a token", async () => {
    const res = await fetch(`${baseUrl}/api/sessions`);
    expect(res.status).toBe(200);
  });

  it("does not block OS endpoints (resume returns 400 without session, not 403)", async () => {
    const res = await fetch(`${baseUrl}/api/resume`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});
