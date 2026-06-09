#!/usr/bin/env bun
/**
 * Claude Code Backup — export all config, MCP servers, skills, commands,
 * agents, memory, and optionally conversations to a timestamped archive.
 *
 * Usage:
 *   bun scripts/backup.ts [destination] [--full]
 *
 * Options:
 *   destination  Target directory (default: ./claude-backup-YYYYMMDD-HHMMSS)
 *   --full       Include conversation JSONL files (~15GB) and Gloss DB
 *
 * Without --full, only backs up config (~8MB): settings, skills, commands,
 * agents, MCP configs, memory files, and plugins.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const args = process.argv.slice(2);
const full = args.includes("--full");
const destArg = args.find((a) => !a.startsWith("--"));

const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const destDir = destArg ?? `claude-backup-${timestamp}`;

const home = os.homedir();
const claudeDir = path.join(home, ".claude");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let fileCount = 0;
let totalBytes = 0;

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function copyFile(src: string, destPath: string) {
  try {
    const stat = fs.statSync(src);
    if (stat.size > 500 * 1024 * 1024) {
      console.log(`  SKIP (too large): ${src} (${(stat.size / 1048576).toFixed(0)}MB)`);
      return;
    }
    ensureDir(path.dirname(destPath));
    fs.copyFileSync(src, destPath);
    fileCount++;
    totalBytes += stat.size;
  } catch {
    // skip missing/unreadable files
  }
}

function copyDir(srcDir: string, destDirPath: string, opts?: { filter?: (name: string) => boolean; maxDepth?: number; currentDepth?: number }) {
  if (!fs.existsSync(srcDir)) return;
  const depth = opts?.currentDepth ?? 0;
  if (opts?.maxDepth !== undefined && depth > opts.maxDepth) return;

  try {
    const entries = fs.readdirSync(srcDir, { withFileTypes: true });
    for (const entry of entries) {
      if (opts?.filter && !opts.filter(entry.name)) continue;
      const srcPath = path.join(srcDir, entry.name);
      const dstPath = path.join(destDirPath, entry.name);
      if (entry.isDirectory()) {
        copyDir(srcPath, dstPath, { ...opts, currentDepth: depth + 1 });
      } else if (entry.isFile()) {
        copyFile(srcPath, dstPath);
      }
    }
  } catch {
    // skip unreadable dirs
  }
}

// ---------------------------------------------------------------------------
// Backup manifest
// ---------------------------------------------------------------------------

console.log(`\nClaude Code Backup → ${destDir}`);
console.log(`Mode: ${full ? "FULL (config + conversations)" : "CONFIG ONLY"}\n`);

ensureDir(destDir);

// 1. Global config
console.log("1/8  Global config...");
copyFile(path.join(home, ".claude.json"), path.join(destDir, "global", ".claude.json"));
copyFile(path.join(claudeDir, "settings.json"), path.join(destDir, "global", "settings.json"));
copyFile(path.join(claudeDir, "settings.local.json"), path.join(destDir, "global", "settings.local.json"));

// Claude Desktop config
const desktopConfig = path.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
copyFile(desktopConfig, path.join(destDir, "global", "claude_desktop_config.json"));

// 2. Skills
console.log("2/8  Skills...");
copyDir(path.join(claudeDir, "skills"), path.join(destDir, "global", "skills"), {
  filter: (name) => !name.startsWith("."),
});

// 3. Commands
console.log("3/8  Commands...");
copyDir(path.join(claudeDir, "commands"), path.join(destDir, "global", "commands"));

// 4. Agents
console.log("4/8  Agents...");
copyDir(path.join(claudeDir, "agents"), path.join(destDir, "global", "agents"));

// 5. Plugins
console.log("5/8  Plugins...");
copyDir(path.join(claudeDir, "plugins"), path.join(destDir, "global", "plugins"), {
  filter: (name) => !name.startsWith(".") && name !== "cache",
  maxDepth: 2,
});
// Copy installed_plugins.json specifically
copyFile(
  path.join(claudeDir, "plugins", "installed_plugins.json"),
  path.join(destDir, "global", "plugins", "installed_plugins.json"),
);

// 6. Memory files (from all projects)
console.log("6/8  Memory...");
const projectsDir = path.join(claudeDir, "projects");
if (fs.existsSync(projectsDir)) {
  const projDirs = fs.readdirSync(projectsDir, { withFileTypes: true }).filter((d) => d.isDirectory());
  for (const d of projDirs) {
    const memDir = path.join(projectsDir, d.name, "memory");
    if (fs.existsSync(memDir)) {
      copyDir(memDir, path.join(destDir, "memory", d.name));
    }
    // Also copy project-level CLAUDE.md if exists
    const claudeMd = path.join(projectsDir, d.name, "CLAUDE.md");
    if (fs.existsSync(claudeMd)) {
      copyFile(claudeMd, path.join(destDir, "memory", d.name, "CLAUDE.md"));
    }
  }
}

// 7. Project configs (.mcp.json, .claude/settings, .claude/skills, .claude/commands, .claude/agents)
console.log("7/8  Project configs...");
// Scan real project directories
const programsDirs = [path.join(home, "Documents", "Programs")];
for (const progDir of programsDirs) {
  if (!fs.existsSync(progDir)) continue;
  const dirs = fs.readdirSync(progDir, { withFileTypes: true }).filter((d) => d.isDirectory());
  for (const d of dirs) {
    const projRoot = path.join(progDir, d.name);
    const projDest = path.join(destDir, "projects", d.name);

    // .mcp.json
    const mcpJson = path.join(projRoot, ".mcp.json");
    if (fs.existsSync(mcpJson)) copyFile(mcpJson, path.join(projDest, ".mcp.json"));

    // .claude/ subdirs
    const projClaude = path.join(projRoot, ".claude");
    if (!fs.existsSync(projClaude)) continue;

    for (const subdir of ["skills", "commands", "agents"]) {
      const src = path.join(projClaude, subdir);
      if (fs.existsSync(src)) copyDir(src, path.join(projDest, ".claude", subdir));
    }
    // settings files
    for (const file of ["settings.json", "settings.local.json", "mcp.json"]) {
      const src = path.join(projClaude, file);
      if (fs.existsSync(src)) copyFile(src, path.join(projDest, ".claude", file));
    }
    // CLAUDE.md
    for (const file of ["CLAUDE.md"]) {
      const src = path.join(projRoot, file);
      if (fs.existsSync(src)) copyFile(src, path.join(projDest, file));
    }
  }
}

// 8. Conversations (--full only)
if (full) {
  console.log("8/8  Conversations (this may take a while)...");
  if (fs.existsSync(projectsDir)) {
    const projDirs = fs.readdirSync(projectsDir, { withFileTypes: true }).filter((d) => d.isDirectory());
    for (const d of projDirs) {
      const projPath = path.join(projectsDir, d.name);
      const jsonls = fs.readdirSync(projPath).filter((f) => f.endsWith(".jsonl"));
      for (const jsonl of jsonls) {
        copyFile(path.join(projPath, jsonl), path.join(destDir, "conversations", d.name, jsonl));
      }
    }
  }
  // Gloss DB + embeddings. The SQLite DB may be live (WAL mode) — raw copies
  // of db.sqlite/-wal/-shm can tear; snapshot via VACUUM INTO instead.
  const convoDir = path.join(home, ".convo");
  if (fs.existsSync(convoDir)) {
    const convoFiles = fs.readdirSync(convoDir);
    for (const f of convoFiles) {
      if (f === "db.sqlite" || f === "db.sqlite-wal" || f === "db.sqlite-shm") continue;
      copyFile(path.join(convoDir, f), path.join(destDir, "gloss", f));
    }
    const dbFile = path.join(convoDir, "db.sqlite");
    if (fs.existsSync(dbFile)) {
      try {
        const { openDb } = await import("../src/db.js");
        const db = openDb(dbFile);
        const snapshotPath = path.join(destDir, "gloss", "db.sqlite");
        db.backupTo(snapshotPath);
        db.close();
        const snapStat = fs.statSync(snapshotPath);
        fileCount++;
        totalBytes += snapStat.size;
        console.log("  Gloss DB snapshotted via VACUUM INTO");
      } catch (e) {
        console.error(`  Gloss DB snapshot failed: ${e}`);
      }
    }
  }
} else {
  console.log("8/8  Conversations — skipped (use --full to include)");
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

const sizeMB = (totalBytes / 1048576).toFixed(1);
console.log(`\nDone! ${fileCount} files, ${sizeMB} MB → ${destDir}`);

// Write manifest
const manifest = {
  timestamp: new Date().toISOString(),
  mode: full ? "full" : "config",
  fileCount,
  totalBytes,
  hostname: os.hostname(),
  user: os.userInfo().username,
  platform: process.platform,
};
fs.writeFileSync(path.join(destDir, "manifest.json"), JSON.stringify(manifest, null, 2));
console.log("Manifest written to manifest.json\n");
