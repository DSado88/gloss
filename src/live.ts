import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { IncrementalParser } from "./incremental-parser.js";
import { buildPageParams } from "./convert.js";
import { buildHtmlPage } from "./templates/html-template.js";
import { buildLiveClientJs } from "./templates/live-client-js.js";
import { renderTurn } from "./renderer.js";
import { escape } from "./markdown.js";
import type { Turn, TextBlock, TocEntry } from "./types.js";

/**
 * Build a TOC item HTML string for a single TocEntry.
 * Mirrors the logic in buildPageParams / convert.ts.
 */
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

/**
 * Build a ConvoDataEntry from a Turn (matches the shape used in convert.ts).
 */
function buildConvoDataEntry(turn: Turn) {
  return {
    role: turn.role,
    timestamp: turn.timestamp || "",
    text: turn.blocks
      .filter((b): b is TextBlock => b.type === "text")
      .map((b) => b.text || ""),
  };
}

export async function startLiveServer(
  inputFile: string,
  options: {
    port?: number;
    includeThinking?: boolean;
    includeTools?: boolean;
  } = {}
): Promise<void> {
  const port = options.port ?? 3456;
  const includeThinking = options.includeThinking ?? true;
  const includeTools = options.includeTools ?? true;
  const inputPath = path.resolve(inputFile);

  if (!fs.existsSync(inputPath)) {
    console.error(`Error: File not found: ${inputFile}`);
    process.exit(1);
  }

  // Parse the full existing file
  const parser = new IncrementalParser();
  const initialContent = fs.readFileSync(inputPath, "utf-8");
  const initialLines = initialContent.split("\n");
  parser.feedLines(initialLines);

  // Track byte offset for incremental reads
  let byteOffset = Buffer.byteLength(initialContent, "utf-8");

  // Build initial HTML page with live client JS injected
  const meta = parser.getMetadata();
  const convo = {
    sessionId: meta.sessionId,
    projectDir: meta.projectDir,
    model: meta.model,
    version: meta.version,
    startTime: meta.startTime,
    turns: parser.getTurns(),
  };

  const viewerDir = path.join(os.homedir(), ".claude", "viewer");
  const wsUrl = `ws://localhost:${port}/ws`;
  const liveClientJs = buildLiveClientJs(wsUrl);

  const params = buildPageParams(convo, inputPath, viewerDir, {
    includeThinking,
    includeTools,
    extraScript: liveClientJs,
  });

  const initialHtml = buildHtmlPage(params);

  // Track connected WebSocket clients
  const clients = new Set<any>();

  // Buffer for partial lines from file reads
  let partialLine = "";

  // Debounce timer for file watch events
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  function broadcast(message: object) {
    const data = JSON.stringify(message);
    for (const client of clients) {
      try {
        client.send(data);
      } catch {
        clients.delete(client);
      }
    }
  }

  function processFileChanges() {
    const stat = fs.statSync(inputPath);
    const currentSize = stat.size;

    if (currentSize <= byteOffset) return;

    // Read new bytes
    const fd = fs.openSync(inputPath, "r");
    const newBytes = Buffer.alloc(currentSize - byteOffset);
    fs.readSync(fd, newBytes, 0, newBytes.length, byteOffset);
    fs.closeSync(fd);
    byteOffset = currentSize;

    const newText = partialLine + newBytes.toString("utf-8");

    // Split into lines, keeping the last partial line buffered
    const lines = newText.split("\n");
    // If the text doesn't end with \n, the last element is a partial line
    if (!newText.endsWith("\n")) {
      partialLine = lines.pop() || "";
    } else {
      partialLine = "";
      // Remove trailing empty element from split
      if (lines.length > 0 && lines[lines.length - 1] === "") {
        lines.pop();
      }
    }

    if (lines.length === 0) return;

    const updates = parser.feedLines(lines);

    for (const update of updates) {
      const { html, tocEntry } = renderTurn(
        update.turn,
        update.turnIndex,
        includeThinking,
        includeTools
      );

      const tocHtml = tocEntry ? buildTocItemHtml(tocEntry) : undefined;
      const convoDataEntry = buildConvoDataEntry(update.turn);

      broadcast({
        type: update.type,
        turnIndex: update.turnIndex,
        html: html || "",
        tocHtml: tocHtml || "",
        convoDataEntry,
      });
    }
  }

  // Start Bun.serve with HTTP + WebSocket
  const server = Bun.serve({
    port,
    fetch(req, server) {
      const url = new URL(req.url);

      // WebSocket upgrade
      if (url.pathname === "/ws") {
        const upgraded = server.upgrade(req);
        if (!upgraded) {
          return new Response("WebSocket upgrade failed", { status: 400 });
        }
        return undefined;
      }

      // Serve initial HTML
      if (url.pathname === "/" || url.pathname === "/index.html") {
        return new Response(initialHtml, {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }

      return new Response("Not Found", { status: 404 });
    },
    websocket: {
      open(ws) {
        clients.add(ws);
      },
      close(ws) {
        clients.delete(ws);
      },
      message(_ws, _message) {
        // No client-to-server messages needed
      },
    },
  });

  // Watch the JSONL file for changes
  const watcher = fs.watch(inputPath, () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      try {
        processFileChanges();
      } catch (err) {
        console.error("Error processing file changes:", err);
      }
    }, 50);
  });

  const filename = path.basename(inputPath);
  const url = `http://localhost:${port}`;
  console.log(`Live viewer at ${url} -- watching ${filename}`);

  // Open browser on macOS
  if (process.platform === "darwin") {
    Bun.spawn(["open", url], { stdio: ["ignore", "ignore", "ignore"] });
  }

  // Keep the process alive and handle cleanup
  process.on("SIGINT", () => {
    watcher.close();
    server.stop();
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    watcher.close();
    server.stop();
    process.exit(0);
  });
}
