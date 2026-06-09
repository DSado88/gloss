import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { openDb, type ConvoDb } from "./db.js";
import { runDoctor, type DoctorReport } from "./doctor.js";
import { clearDiscoveryCache } from "./discovery.js";

const UUID_A = "d0c70a1b-1111-4222-8333-444455556666";

function writeJsonl(filePath: string, sessionId: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const lines = [
    JSON.stringify({ type: "summary", sessionId, cwd: "/home/user/project", version: "1.0.0" }),
    JSON.stringify({ type: "user", sessionId, message: { content: "Hello" }, timestamp: "2024-01-15T10:30:00Z" }),
  ];
  fs.writeFileSync(filePath, lines.join("\n") + "\n", "utf-8");
}

function findingCodes(report: DoctorReport): string[] {
  return report.findings.map((f) => f.code);
}

describe("gloss doctor", () => {
  let projectsDir: string;
  let dbDir: string;
  let db: ConvoDb;

  beforeEach(() => {
    projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-projects-"));
    dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-db-"));
    db = openDb(path.join(dbDir, "test.sqlite"));
    clearDiscoveryCache();
  });

  afterEach(() => {
    db.close();
    fs.rmSync(projectsDir, { recursive: true, force: true });
    fs.rmSync(dbDir, { recursive: true, force: true });
  });

  it("reports clean on a healthy corpus", () => {
    const p = path.join(projectsDir, "-Users-x-proj", `${UUID_A}.jsonl`);
    writeJsonl(p, UUID_A);
    const stat = fs.statSync(p);
    db.upsertSession({ id: UUID_A, jsonl_path: p, file_size: stat.size, turn_count: 1 });
    db.indexSession(UUID_A, [{ role: "user", text: "Hello" }], stat.mtimeMs, stat.size);

    const report = runDoctor(db, projectsDir);
    expect(report.hasCritical).toBe(false);
    expect(report.totals.jsonlFiles).toBe(1);
    expect(report.totals.dbSessions).toBe(1);
  });

  it("reports duplicate sessionIds", () => {
    writeJsonl(path.join(projectsDir, "-Users-x-a", `${UUID_A}.jsonl`), UUID_A);
    writeJsonl(path.join(projectsDir, "-Users-x-b", `${UUID_A}.jsonl`), UUID_A);

    const report = runDoctor(db, projectsDir);
    expect(report.totals.duplicateSessionIds).toBe(1);
    expect(findingCodes(report)).toContain("duplicate-session-ids");
  });

  it("flags a DB session whose canonical file is an agent file while a main file exists (critical)", () => {
    const mainPath = path.join(projectsDir, "-Users-x-proj", `${UUID_A}.jsonl`);
    const agentPath = path.join(projectsDir, "-Users-x-proj", "agent-aaa.jsonl");
    writeJsonl(mainPath, UUID_A);
    writeJsonl(agentPath, UUID_A);
    db.upsertSession({ id: UUID_A, jsonl_path: agentPath });

    const report = runDoctor(db, projectsDir);
    expect(findingCodes(report)).toContain("agent-file-canonical");
    expect(report.hasCritical).toBe(true);
  });

  it("flags DB sessions whose jsonl_path no longer exists", () => {
    db.upsertSession({ id: "gone", jsonl_path: path.join(projectsDir, "-Users-x-proj", "gone.jsonl") });

    const report = runDoctor(db, projectsDir);
    const finding = report.findings.find((f) => f.code === "missing-jsonl");
    expect(finding).toBeDefined();
    expect(finding!.count).toBe(1);
  });

  it("flags stale FTS and embedding indexes", () => {
    const p = path.join(projectsDir, "-Users-x-proj", `${UUID_A}.jsonl`);
    writeJsonl(p, UUID_A);
    const stat = fs.statSync(p);
    db.upsertSession({ id: UUID_A, jsonl_path: p, file_size: stat.size, turn_count: 5 });
    // Indexed at a different mtime/size than the file's current state → stale
    db.indexSession(UUID_A, [{ role: "user", text: "old" }], stat.mtimeMs - 5000, stat.size - 1);

    const report = runDoctor(db, projectsDir);
    expect(findingCodes(report)).toContain("stale-fts");
  });

  it("counts empty JSONL files", () => {
    fs.mkdirSync(path.join(projectsDir, "-Users-x-proj"), { recursive: true });
    fs.writeFileSync(path.join(projectsDir, "-Users-x-proj", "empty.jsonl"), "");
    writeJsonl(path.join(projectsDir, "-Users-x-proj", `${UUID_A}.jsonl`), UUID_A);

    const report = runDoctor(db, projectsDir);
    expect(report.totals.emptyFiles).toBe(1);
  });

  it("counts files missing a trailing newline (mid-write)", () => {
    const p = path.join(projectsDir, "-Users-x-proj", `${UUID_A}.jsonl`);
    writeJsonl(p, UUID_A);
    fs.appendFileSync(p, '{"type":"user","partial', "utf-8"); // torn write, no newline

    const report = runDoctor(db, projectsDir);
    expect(report.totals.missingTrailingNewline).toBe(1);
  });

  it("reports annotation count and missing backup as a warning when annotations exist", () => {
    db.upsertSession({ id: "s" });
    // Bypass journaling so no backup file exists (simulate pre-upgrade data)
    db.db.run(
      "INSERT INTO annotations (id, session_id, turn_index, char_start, char_end, text) VALUES (?, ?, ?, ?, ?, ?)",
      ["a", "s", 0, 0, 5, "text"],
    );

    const report = runDoctor(db, projectsDir);
    expect(report.totals.annotations).toBe(1);
    expect(findingCodes(report)).toContain("no-annotation-backup");
  });

  it("notes the last annotation backup when the journal exists", () => {
    db.upsertSession({ id: "s" });
    db.upsertAnnotation({
      id: "a", session_id: "s", turn_index: 0, char_start: 0, char_end: 5, text: "text",
    });

    const report = runDoctor(db, projectsDir);
    expect(findingCodes(report)).not.toContain("no-annotation-backup");
    expect(report.totals.lastAnnotationBackup).toBeTruthy();
  });
});

describe("doctor CLI", () => {
  let projectsDir: string;
  let dbDir: string;
  let dbPath: string;

  beforeEach(() => {
    projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-cli-projects-"));
    dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-cli-db-"));
    dbPath = path.join(dbDir, "test.sqlite");
  });

  afterEach(() => {
    fs.rmSync(projectsDir, { recursive: true, force: true });
    fs.rmSync(dbDir, { recursive: true, force: true });
  });

  async function runCli(args: string[]): Promise<{ stdout: string; exitCode: number }> {
    const proc = Bun.spawn(["bun", path.join(import.meta.dir, "cli.ts"), ...args], {
      env: { ...process.env, CONVO_DB_PATH: dbPath, GLOSS_PROJECTS_DIR: projectsDir },
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    return { stdout, exitCode };
  }

  it("--json emits a machine-readable report", async () => {
    writeJsonl(path.join(projectsDir, "-Users-x-proj", `${UUID_A}.jsonl`), UUID_A);
    const { stdout, exitCode } = await runCli(["doctor", "--json"]);
    expect(exitCode).toBe(0);
    const report = JSON.parse(stdout);
    expect(report.totals.jsonlFiles).toBe(1);
    expect(Array.isArray(report.findings)).toBe(true);
  });

  it("--strict exits non-zero on critical findings", async () => {
    const mainPath = path.join(projectsDir, "-Users-x-proj", `${UUID_A}.jsonl`);
    const agentPath = path.join(projectsDir, "-Users-x-proj", "agent-bbb.jsonl");
    writeJsonl(mainPath, UUID_A);
    writeJsonl(agentPath, UUID_A);
    const db = openDb(dbPath);
    db.upsertSession({ id: UUID_A, jsonl_path: agentPath });
    db.close();

    const { exitCode } = await runCli(["doctor", "--strict"]);
    expect(exitCode).not.toBe(0);
  });

  it("--strict exits zero on a healthy corpus", async () => {
    writeJsonl(path.join(projectsDir, "-Users-x-proj", `${UUID_A}.jsonl`), UUID_A);
    const { exitCode } = await runCli(["doctor", "--strict"]);
    expect(exitCode).toBe(0);
  });
});
