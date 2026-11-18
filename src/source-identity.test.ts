import { describe, it, expect, beforeAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createHash } from "node:crypto";
import { openDb, type ConvoDb } from "./db.js";
import { handleApiRoute } from "./server.js";
import { IncrementalParser } from "./incremental-parser.js";

// A client that keeps several projects apart (GEG Research's hub) must know
// which file, and which version of it, a search result or a read came from,
// and which transcript line each turn began at. These fields are additive:
// older clients ignore them.

const SID = "11111111-1111-4111-8111-111111111111";
const LINES = [
  { type: "user", sessionId: SID, uuid: "u-0", cwd: "/work/sandbox", message: { content: "Find the lighthouse keeper" } },
  { type: "assistant", sessionId: SID, uuid: "a-1", message: { content: [{ type: "text", text: "Looking." }, { type: "tool_use", id: "t1", name: "WebSearch", input: {} }] } },
  { type: "user", sessionId: SID, uuid: "r-2", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "page" }] } },
  { type: "assistant", sessionId: SID, uuid: "a-3", message: { content: [{ type: "text", text: "Found the lighthouse keeper." }] } },
];

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

describe("source identity", () => {
  let file: string;
  let db: ConvoDb;

  beforeAll(() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gloss-source-identity-"));
    file = path.join(dir, "claude", "sandbox", "chat_a", `${SID}.jsonl`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, LINES.map((l) => JSON.stringify(l)).join("\n") + "\n");
    db = openDb(path.join(dir, "test.sqlite"));
    db.upsertSession({ id: SID, jsonl_path: file, project: "/work/sandbox", turn_count: 2 });
    const stat = fs.statSync(file);
    db.indexSession(SID, [{ role: "user", text: "Find the lighthouse keeper" }, { role: "assistant", text: "Looking.\nFound the lighthouse keeper." }], stat.mtimeMs, stat.size);
  });

  it("a turn carries the uuid of the transcript line that began it", () => {
    const p = new IncrementalParser();
    p.feedLines(LINES.map((l) => JSON.stringify(l)));
    expect(p.getTurns().map((t) => t.uuid)).toEqual(["u-0", "a-1"]);
    const bare = new IncrementalParser();
    bare.feedLines([JSON.stringify({ type: "user", message: { content: "no uuid" } })]);
    expect(bare.getTurns()[0].uuid).toBeUndefined();
  });

  it("a read names the file and the exact bytes it read, and each turn's uuid", async () => {
    const res = await handleApiRoute(new Request(`http://x/api/sessions/${SID}/data`), `/api/sessions/${SID}/data`, db);
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    const bytes = fs.readFileSync(file);
    expect(data.source).toEqual({ path: file, sha256: sha256(bytes), size: bytes.length });
    expect(data.turns.map((t: any) => t.uuid)).toEqual(["u-0", "a-1"]);
    expect(data.turns[1].text).toEqual(["Looking.", "Found the lighthouse keeper."]);
  });

  it("a search names each source's file and the exact bytes it read, and each turn's uuid", async () => {
    const req = new Request("http://x/api/search-sources", { method: "POST", body: JSON.stringify({ query: "lighthouse keeper" }) });
    const res = await handleApiRoute(req, "/api/search-sources", db);
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    const s = data.sources.find((x: any) => x.sessionId === SID);
    const bytes = fs.readFileSync(file);
    expect(s.source).toEqual({ path: file, sha256: sha256(bytes), size: bytes.length });
    expect(s.turns.map((t: any) => [t.index, t.uuid])).toEqual(s.turns.map((t: any) => [t.index, ["u-0", "a-1"][t.index]]));
  });
});
