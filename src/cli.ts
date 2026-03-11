#!/usr/bin/env node
import { program } from "commander";
import { convertJsonlToHtml } from "./convert.js";

// ── Serve command (default mode) ──
program
  .name("convo-viewer")
  .description("Claude conversation viewer — serve or export JSONL conversations");

program
  .command("serve", { isDefault: true })
  .description("Start the conversation viewer server (default)")
  .option("--port <number>", "Port (default: 3456)", parseInt)
  .action(async (options) => {
    const { startServer } = await import("./server.js");
    await startServer({ port: options.port });
  });

// ── Export command (static HTML) ──
program
  .command("export")
  .description("Export conversation to self-contained HTML")
  .argument("<input...>", "JSONL file(s)")
  .option("-o, --output <file>", "Output file (single input only)")
  .option("--no-thinking", "Exclude thinking blocks")
  .option("--no-tools", "Exclude tool calls and results")
  .action(async (inputs: string[], options) => {
    if (options.output && inputs.length > 1) {
      console.error("Error: --output cannot be used with multiple input files");
      process.exit(1);
    }
    for (const input of inputs) {
      convertJsonlToHtml(input, options.output, {
        includeThinking: options.thinking,
        includeTools: options.tools,
      });
    }
  });

// ── Import annotations subcommand ──
program
  .command("import")
  .description("Import annotation sidecar JSON files into ~/.convo/db.sqlite")
  .argument("[files...]", "Annotation JSON files (default: scan ~/.claude/viewer/)")
  .action(async (files: string[]) => {
    const { openDb } = await import("./db.js");
    const fs = await import("node:fs");
    const path = await import("node:path");
    const os = await import("node:os");

    const db = openDb();
    let totalImported = 0;
    let totalSkipped = 0;

    // If no files specified, scan the viewer directory
    if (!files.length) {
      const viewerDir = path.join(os.homedir(), ".claude", "viewer");
      if (fs.existsSync(viewerDir)) {
        const entries = fs.readdirSync(viewerDir);
        files = entries
          .filter((f: string) => f.endsWith(".annotations.json"))
          .map((f: string) => path.join(viewerDir, f));
      }
    }

    if (!files.length) {
      console.log("No annotation files found.");
      db.close();
      return;
    }

    for (const file of files) {
      const filePath = path.resolve(file);
      if (!fs.existsSync(filePath)) {
        console.error(`  Skipping: ${file} (not found)`);
        continue;
      }

      try {
        const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
        let annotations;
        if (Array.isArray(raw)) {
          annotations = raw;
        } else {
          // Dict keyed by annotation ID — inject the key as `id`
          annotations = Object.entries(raw).map(([id, v]: [string, any]) => ({ id, ...v }));
        }

        // Extract session ID from filename (e.g., "a8ba3d6d-...annotations.json")
        const basename = path.basename(filePath);
        const sessionId = basename.replace(".annotations.json", "");

        // Ensure session exists
        if (!db.getSession(sessionId)) {
          db.upsertSession({ id: sessionId });
        }

        const result = db.importAnnotationsJson(sessionId, annotations as any[]);
        console.log(`  ${basename}: ${result.imported} imported, ${result.skipped} skipped`);
        totalImported += result.imported;
        totalSkipped += result.skipped;
      } catch (e) {
        console.error(`  Error reading ${file}: ${e}`);
      }
    }

    console.log(`\nTotal: ${totalImported} imported, ${totalSkipped} skipped`);
    db.close();
  });

// ── Highlights subcommand ──
program
  .command("highlights")
  .description("Search and list highlights from ~/.convo/db.sqlite")
  .option("-s, --search <query>", "Full-text search query")
  .option("-t, --tag <tag>", "Filter by tag")
  .option("--session <id>", "Filter by session ID")
  .option("--speaker <role>", "Filter by speaker (user/assistant)")
  .option("-n, --limit <n>", "Max results", parseInt, 20)
  .option("--recent [days]", "Show recent highlights (default: 7 days)")
  .option("--tags", "List all tags with counts")
  .option("--sessions", "List all sessions")
  .option("--json", "Output as JSON")
  .action(async (options) => {
    const { openDb } = await import("./db.js");
    const db = openDb();

    // List tags mode
    if (options.tags) {
      const tags = db.listTags();
      if (options.json) {
        console.log(JSON.stringify(tags, null, 2));
      } else if (!tags.length) {
        console.log("No tags found.");
      } else {
        for (const t of tags) {
          console.log(`  ${t.name} (${t.count})`);
        }
      }
      db.close();
      return;
    }

    // List sessions mode
    if (options.sessions) {
      const sessions = db.listSessions({ limit: options.limit });
      if (options.json) {
        console.log(JSON.stringify(sessions, null, 2));
      } else if (!sessions.length) {
        console.log("No sessions found. Run a render first to populate the database.");
      } else {
        for (const s of sessions) {
          const time = s.start_time
            ? new Date(s.start_time * 1000).toLocaleDateString()
            : "unknown";
          const project = s.project || "";
          console.log(`  ${s.id.slice(0, 8)}  ${time}  ${s.turn_count || "?"}t  ${project}`);
        }
      }
      db.close();
      return;
    }

    // Query annotations
    let annotations;

    if (options.recent !== undefined) {
      const days = typeof options.recent === "string" ? parseInt(options.recent) : 7;
      annotations = db.getRecentAnnotations({ days, limit: options.limit });
    } else if (options.tag) {
      annotations = db.getAnnotationsByTag(options.tag, { limit: options.limit });
    } else if (options.search) {
      annotations = db.searchAnnotations(options.search, {
        sessionId: options.session,
        speaker: options.speaker,
        limit: options.limit,
      });
    } else if (options.session) {
      annotations = db.getSessionAnnotations(options.session);
    } else {
      // Default: recent highlights
      annotations = db.getRecentAnnotations({ days: 30, limit: options.limit });
    }

    if (options.json) {
      console.log(JSON.stringify(annotations, null, 2));
    } else if (!annotations.length) {
      console.log("No highlights found.");
    } else {
      for (const a of annotations) {
        const tags = a.tags.length ? ` [${a.tags.join(", ")}]` : "";
        const kind = a.kind !== "highlight" ? ` (${a.kind})` : "";
        const session = a.session_id.slice(0, 8);
        const speaker = a.speaker || "?";
        const time = a.created_at
          ? new Date(a.created_at * 1000).toLocaleDateString()
          : "";

        console.log(`\n  ${session} | ${speaker} | ${time}${kind}${tags}`);

        // Truncate display text to terminal width
        const text = a.text.replace(/\n/g, " ").slice(0, 120);
        console.log(`  "${text}${a.text.length > 120 ? "..." : ""}"`);

        if (a.comment) {
          const comment = a.comment.replace(/\n/g, " ").slice(0, 100);
          console.log(`  → ${comment}${a.comment.length > 100 ? "..." : ""}`);
        }
      }
      console.log(`\n  ${annotations.length} highlight(s)`);
    }

    db.close();
  });

// ── Tag subcommand ──
program
  .command("tag")
  .description("Add or replace tags on annotations")
  .argument("<annotation-id>", "Annotation ID")
  .argument("<tags...>", "Tags to set (replaces existing tags)")
  .action(async (annotationId: string, tags: string[]) => {
    const { openDb } = await import("./db.js");
    const db = openDb();

    const ann = db.getAnnotation(annotationId);
    if (!ann) {
      console.error(`Annotation not found: ${annotationId}`);
      db.close();
      process.exit(1);
    }

    db.replaceAnnotationTags(annotationId, tags);
    console.log(`  ${annotationId}: tags set to [${tags.join(", ")}]`);
    db.close();
  });

// ── Batch tag subcommand (JSON input for auto-tagging) ──
program
  .command("batch-tag")
  .description("Batch-apply tags from JSON on stdin: [{id, tags}]")
  .action(async () => {
    const { openDb } = await import("./db.js");
    const db = openDb();

    let input = "";
    for await (const chunk of Bun.stdin.stream()) {
      input += new TextDecoder().decode(chunk);
    }

    let items: { id: string; tags: string[] }[];
    try {
      items = JSON.parse(input);
    } catch {
      console.error("Invalid JSON on stdin. Expected: [{id, tags}]");
      db.close();
      process.exit(1);
    }

    let updated = 0;
    for (const item of items) {
      const ann = db.getAnnotation(item.id);
      if (!ann) {
        console.error(`  Skipping ${item.id}: not found`);
        continue;
      }
      db.replaceAnnotationTags(item.id, item.tags);
      console.log(`  ${item.id}: [${item.tags.join(", ")}]`);
      updated++;
    }
    console.log(`\n${updated} annotation(s) tagged`);
    db.close();
  });

program.parse();
