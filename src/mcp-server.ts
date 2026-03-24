/**
 * Gloss MCP Server — exposes conversation search, reading, and highlights
 * to Claude Code via the Model Context Protocol.
 *
 * Talks to the running Gloss HTTP server (default localhost:3456) to get
 * full hybrid search (FTS + vector + RRF fusion) without duplicating
 * the embedding engine.
 *
 * Usage:
 *   claude mcp add --transport stdio gloss -- bun /path/to/gloss/src/mcp-server.ts
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const GLOSS_URL = process.env.GLOSS_URL ?? "http://localhost:3456";
const FETCH_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

async function glossFetch(path: string, opts?: RequestInit): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(`${GLOSS_URL}${path}`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      ...opts,
    });
  } catch (e) {
    if (e instanceof TypeError && (e.message.includes("ECONNREFUSED") || e.message.includes("fetch failed"))) {
      throw new Error(`Gloss server is not running on ${GLOSS_URL}. Start it with: bun src/cli.ts serve`);
    }
    if (e instanceof DOMException && e.name === "TimeoutError") {
      throw new Error(`Gloss server timed out after ${FETCH_TIMEOUT_MS / 1000}s`);
    }
    throw e;
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Gloss API ${res.status}: ${text}`);
  }
  return res.json();
}

async function glossPost(path: string, body: Record<string, unknown>): Promise<unknown> {
  return glossFetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// Format helpers — turn API responses into clean readable text
// ---------------------------------------------------------------------------

interface SourceTurn {
  role: string;
  index: number;
  text: string;
}

interface Source {
  num: number;
  sessionId: string;
  project: string;
  title: string;
  matchTurnIndex: number;
  startTurnIndex?: number;
  endTurnIndex?: number;
  score?: number;
  matchedTokens?: string[];
  turns: SourceTurn[];
}

/** Truncate text at a semantic boundary (paragraph/sentence/code block). */
function smartTruncate(text: string, limit: number): string {
  if (text.length <= limit) return text;

  let cut = text.slice(0, limit);

  // Don't break inside a fenced code block — close it if needed
  const openFences = (cut.match(/^```/gm) || []).length;
  if (openFences % 2 !== 0) {
    // Odd number of fences = unclosed block. Try to include the closing fence.
    const nextFence = text.indexOf("\n```", limit);
    if (nextFence >= 0 && nextFence < limit + 500) {
      // Close fence is nearby — include it
      const fenceEnd = text.indexOf("\n", nextFence + 1);
      cut = text.slice(0, fenceEnd >= 0 ? fenceEnd : nextFence + 4);
    } else {
      // Close fence is far away — append one
      cut += "\n```";
    }
  }

  // Try to cut at a paragraph boundary
  const lastDoubleNewline = cut.lastIndexOf("\n\n");
  if (lastDoubleNewline > limit * 0.6) {
    cut = cut.slice(0, lastDoubleNewline);
  }

  return cut + "\n... [truncated]";
}

function formatSources(sources: Source[], verbose: boolean): string {
  if (sources.length === 0) return "No matching conversations found.";

  const parts: string[] = [];
  for (const src of sources) {
    const label = src.title || src.project || src.sessionId;
    const proj = src.project.split("/").pop() || src.project;
    const scorePart = src.score != null ? ` | relevance: ${src.score}` : "";
    const rangePart = src.startTurnIndex != null && src.endTurnIndex != null
      ? ` | turns ${src.startTurnIndex}-${src.endTurnIndex}`
      : "";
    const tokensPart = src.matchedTokens?.length
      ? ` | matched: ${src.matchedTokens.slice(0, 6).join(", ")}`
      : "";

    parts.push(`── Source ${src.num}: ${label} [${proj}]${scorePart} ──`);
    parts.push(`   Session: ${src.sessionId} | Match: turn ${src.matchTurnIndex}${rangePart}${tokensPart}`);

    if (verbose) {
      for (const t of src.turns) {
        const role = t.role === "user" ? "Human" : "Assistant";
        const text = smartTruncate(t.text, 3000);
        parts.push(`   [Turn ${t.index}] ${role}:`);
        parts.push(`   ${text.split("\n").join("\n   ")}`);
        parts.push("");
      }
    } else {
      for (const t of src.turns) {
        const role = t.role === "user" ? "Human" : "Assistant";
        const preview = t.text.slice(0, 200).replace(/\n/g, " ").trim();
        parts.push(`   [Turn ${t.index}] ${role}: ${preview}${t.text.length > 200 ? "..." : ""}`);
      }
      parts.push("");
    }
  }
  if (!verbose) {
    parts.push("[Use read_conversation with a sessionId + startTurn to see full context]");
  }
  return parts.join("\n");
}

interface SessionEntry {
  id: string;
  project?: string;
  title?: string;
  model?: string;
  turn_count?: number;
  last_modified?: number;
  file_size?: number;
}

function formatSessionList(sessions: SessionEntry[]): string {
  if (sessions.length === 0) return "No sessions found.";

  const lines: string[] = [`Found ${sessions.length} sessions:\n`];
  for (const s of sessions) {
    const title = s.title ? ` "${s.title}"` : "";
    const project = s.project ?? "unknown";
    const turns = s.turn_count ?? 0;
    const model = s.model ?? "unknown";
    const date = s.last_modified
      ? new Date(s.last_modified * 1000).toLocaleDateString()
      : "?";
    lines.push(`• ${s.id}${title}`);
    lines.push(`  Project: ${project} | Model: ${model} | ${turns} turns | ${date}`);
  }
  return lines.join("\n");
}

interface Annotation {
  id: string;
  session_id: string;
  text: string;
  comment?: string;
  kind?: string;
  speaker?: string;
  turn_index: number;
  tags: string[];
  session_title?: string;
  session_project?: string;
  created_at?: number;
}

function formatAnnotations(annotations: Annotation[]): string {
  if (annotations.length === 0) return "No highlights found.";

  const lines: string[] = [`Found ${annotations.length} highlights:\n`];
  for (const a of annotations) {
    const label = a.session_title || a.session_project || a.session_id;
    const tags = a.tags.length > 0 ? ` [${a.tags.join(", ")}]` : "";
    const kind = a.kind ? ` (${a.kind})` : "";
    lines.push(`── ${label} — turn ${a.turn_index}${kind}${tags} ──`);
    lines.push(`"${a.text}"`);
    if (a.comment) lines.push(`Note: ${a.comment}`);
    lines.push(`Session: ${a.session_id}`);
    lines.push("");
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: "gloss",
  version: "1.0.0",
});

// ── Tool: search ──────────────────────────────────────────────────────────

server.tool(
  "search_conversations",
  "Search across all Claude Code conversations using hybrid FTS + vector semantic search. " +
    "Returns full turn excerpts from the top matching conversations. " +
    "Use read_conversation to expand context around a specific match.",
  {
    query: z.string().describe("Natural language search query"),
    maxSources: z.number().int().min(1).max(20).optional().describe("Max sources to return (default 6)"),
    brief: z.boolean().optional().describe("Return short previews instead of full excerpts (default false)"),
  },
  async (args) => {
    const data = (await glossPost("/api/search-sources", {
      query: args.query,
      maxSources: args.maxSources ?? 6,
    })) as { sources: Source[]; timing: { ftsMs: number; vectorMs: number } };

    const text = formatSources(data.sources, !(args.brief ?? false));
    const timing = `\n\n[Search: FTS ${Math.round(data.timing.ftsMs)}ms, Vector ${Math.round(data.timing.vectorMs)}ms]`;
    return { content: [{ type: "text" as const, text: text + timing }] };
  },
);

// ── Tool: read_conversation ───────────────────────────────────────────────

const MAX_READ_WINDOW = 30;

server.tool(
  "read_conversation",
  "Read turns from a specific conversation by session ID. " +
    "Returns the text content of each turn (max 30 turns per call). " +
    "Use this after search to read more context from a specific session.",
  {
    sessionId: z.string().describe("The session UUID"),
    startTurn: z.number().int().min(0).optional().describe("First turn index to read (default 0)"),
    endTurn: z.number().int().min(0).optional().describe("Last turn index to read (default: startTurn + 30)"),
  },
  async (args) => {
    const id = encodeURIComponent(args.sessionId);
    const start = args.startTurn ?? 0;
    const end = args.endTurn ?? start + MAX_READ_WINDOW - 1;
    // Clamp window to prevent context blowout
    const clampedEnd = Math.min(end, start + MAX_READ_WINDOW - 1);

    const data = (await glossFetch(
      `/api/sessions/${id}/data?start=${start}&end=${clampedEnd}`,
    )) as { turns: Array<{ role: string; timestamp: string; text: string[] }>; totalTurns: number; start: number; end: number };

    if (!data.turns || data.turns.length === 0) {
      return { content: [{ type: "text" as const, text: "Session not found or empty." }] };
    }

    const lines: string[] = [`Session ${args.sessionId} — turns ${data.start}-${data.end} of ${data.totalTurns - 1}:\n`];
    for (let i = 0; i < data.turns.length; i++) {
      const t = data.turns[i];
      const role = t.role === "user" ? "Human" : "Assistant";
      const text = t.text.join("\n");
      const truncated = text.length > 5000
        ? text.slice(0, 5000) + "\n... [truncated — use narrower turn range]"
        : text;
      lines.push(`── Turn ${data.start + i} (${role}) ──`);
      lines.push(truncated);
      lines.push("");
    }
    if (data.totalTurns > clampedEnd + 1) {
      lines.push(`[${data.totalTurns - clampedEnd - 1} more turns available — use startTurn=${clampedEnd + 1} to continue]`);
    }
    return { content: [{ type: "text" as const, text: lines.join("\n") }] };
  },
);

// ── Tool: get_highlights ──────────────────────────────────────────────────

server.tool(
  "get_highlights",
  "Query annotations/highlights across all conversations. " +
    "Filters compose: combine session, tag, search, and recency together. " +
    "Returns highlighted text, comments, tags, and kinds.",
  {
    sessionId: z.string().optional().describe("Filter to a specific session UUID"),
    search: z.string().optional().describe("Full-text search within highlight text and comments"),
    tag: z.string().optional().describe("Filter by tag name"),
    recent: z.number().int().min(1).optional().describe("Only highlights from the last N days"),
    limit: z.number().int().min(1).max(100).optional().describe("Max results (default 30)"),
  },
  async (args) => {
    const params = new URLSearchParams();
    if (args.search) params.set("q", args.search);
    if (args.sessionId) params.set("session", args.sessionId);
    if (args.tag) params.set("tag", args.tag);
    if (args.recent) params.set("days", String(args.recent));
    params.set("limit", String(args.limit ?? 30));

    const data = (await glossFetch(
      `/api/highlights?${params.toString()}`,
    )) as Annotation[];

    return { content: [{ type: "text" as const, text: formatAnnotations(data) }] };
  },
);

// ── Tool: list_sessions ───────────────────────────────────────────────────

server.tool(
  "list_sessions",
  "List available conversation sessions. " +
    "Useful for browsing what's been worked on recently or finding sessions by project.",
  {
    project: z.string().optional().describe("Filter by project name (substring match)"),
    limit: z.number().int().min(1).max(100).optional().describe("Max sessions to return (default 20)"),
  },
  async (args) => {
    const params = new URLSearchParams();
    if (args.project) params.set("project", args.project);
    params.set("limit", String(args.limit ?? 20));

    const data = (await glossFetch(
      `/api/sessions?${params.toString()}`,
    )) as SessionEntry[];

    return { content: [{ type: "text" as const, text: formatSessionList(data) }] };
  },
);

// ── Tool: list_tags ────────────────────────────────────────────────────────

server.tool(
  "list_tags",
  "List all annotation tags with usage counts. " +
    "Use this to discover available tags before filtering highlights with get_highlights(tag=...).",
  {},
  async () => {
    const res = await fetch(`${BASE}/api/tags`);
    if (!res.ok) return { content: [{ type: "text" as const, text: "Failed to fetch tags" }] };
    const tags = (await res.json()) as Array<{ name: string; count: number; color?: string }>;
    if (tags.length === 0) {
      return { content: [{ type: "text" as const, text: "No tags found. Highlights haven't been tagged yet." }] };
    }
    const lines = [`${tags.length} tags:\n`];
    for (const t of tags) {
      lines.push(`  ${t.name} (${t.count})`);
    }
    return { content: [{ type: "text" as const, text: lines.join("\n") }] };
  },
);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);
