import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  getOrCreateSession,
  releaseClient,
  __sessionCount,
} from "./server.js";

// A SessionState holds a fully-parsed conversation in memory. If a session is
// never evicted when its last viewer disconnects, every conversation ever
// opened accumulates for the life of the process — the heap-growth leak that
// drives GC (multi-core) CPU spikes.

describe("session eviction on last disconnect", () => {
  let dir: string;
  let jsonlPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "convo-evict-"));
    jsonlPath = path.join(dir, "s.jsonl");
    fs.writeFileSync(
      jsonlPath,
      [
        JSON.stringify({ type: "user", message: { content: "hi" } }),
        JSON.stringify({
          type: "assistant",
          message: { content: [{ type: "text", text: "hello" }] },
        }),
      ].join("\n") + "\n",
      "utf-8",
    );
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("frees the SessionState when the last client disconnects", () => {
    const before = __sessionCount();

    const sessionId = "evict-test-1";
    const state = getOrCreateSession(sessionId, jsonlPath);
    const fakeWs = {} as any; // only used as a Set membership token
    state.clients.add(fakeWs);

    expect(__sessionCount()).toBe(before + 1);

    // Last (only) client disconnects
    releaseClient(sessionId, fakeWs);

    // State must be evicted, not just have its timers stopped
    expect(__sessionCount()).toBe(before);
  });

  it("keeps the SessionState while other clients are still connected", () => {
    const before = __sessionCount();

    const sessionId = "evict-test-2";
    const state = getOrCreateSession(sessionId, jsonlPath);
    const wsA = {} as any;
    const wsB = {} as any;
    state.clients.add(wsA);
    state.clients.add(wsB);

    expect(__sessionCount()).toBe(before + 1);

    // One of two clients leaves — session must stay alive
    releaseClient(sessionId, wsA);
    expect(__sessionCount()).toBe(before + 1);

    // Last client leaves — now it is evicted
    releaseClient(sessionId, wsB);
    expect(__sessionCount()).toBe(before);
  });
});
