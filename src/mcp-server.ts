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

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

async function glossFetch(path: string, opts?: RequestInit): Promise<unknown> {
  const res = await fetch(`${GLOSS_URL}${path}`, opts);
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
  turns: SourceTurn[];
}

function formatSources(sources: Source[]): string {
  if (sources.length === 0) return "No matching conversations found.";

  const parts: string[] = [];
  for (const src of sources) {
    const label = src.title || src.project || src.sessionId;
    parts.push(`── Source ${src.num}: ${label} (${src.project}) ──`);
    parts.push(`   Session: ${src.sessionId}`);
    parts.push(`   Match turn: ${src.matchTurnIndex}`);
    parts.push("");
    for (const t of src.turns) {
      const role = t.role === "user" ? "Human" : "Assistant";
      const text = t.text.length > 3000
        ? t.text.slice(0, 3000) + "\n... [truncated]"
        : t.text;
      parts.push(`   [Turn ${t.index}] ${role}:`);
      parts.push(`   ${text.split("\n").join("\n   ")}`);
      parts.push("");
    }
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
    "Returns relevant conversation excerpts with surrounding context. " +
    "Use this to find past discussions, decisions, code patterns, or anything discussed in previous sessions.",
  {
    query: z.string().describe("Natural language search query"),
    maxSources: z.number().optional().describe("Max sources to return (default 10)"),
  },
  async (args) => {
    const data = (await glossPost("/api/search-sources", {
      query: args.query,
      maxSources: args.maxSources ?? 10,
    })) as { sources: Source[]; timing: { ftsMs: number; vectorMs: number } };

    const text = formatSources(data.sources);
    const timing = `\n\n[Search: FTS ${Math.round(data.timing.ftsMs)}ms, Vector ${Math.round(data.timing.vectorMs)}ms]`;
    return { content: [{ type: "text" as const, text: text + timing }] };
  },
);

// ── Tool: read_conversation ───────────────────────────────────────────────

server.tool(
  "read_conversation",
  "Read turns from a specific conversation by session ID. " +
    "Returns the text content of each turn. Use this after search to read more context from a specific session.",
  {
    sessionId: z.string().describe("The session UUID"),
    startTurn: z.number().optional().describe("First turn index to read (default 0)"),
    endTurn: z.number().optional().describe("Last turn index to read (default: all)"),
  },
  async (args) => {
    const data = (await glossFetch(
      `/api/sessions/${args.sessionId}/data`,
    )) as Array<{ role: string; timestamp: string; text: string[] }>;

    if (!data || data.length === 0) {
      return { content: [{ type: "text" as const, text: "Session not found or empty." }] };
    }

    const start = args.startTurn ?? 0;
    const end = args.endTurn ?? data.length - 1;
    const slice = data.slice(start, end + 1);

    const lines: string[] = [`Session ${args.sessionId} — turns ${start}-${end} of ${data.length - 1}:\n`];
    for (let i = 0; i < slice.length; i++) {
      const t = slice[i];
      const role = t.role === "user" ? "Human" : "Assistant";
      const text = t.text.join("\n");
      const truncated = text.length > 5000
        ? text.slice(0, 5000) + "\n... [truncated — use narrower turn range]"
        : text;
      lines.push(`── Turn ${start + i} (${role}) ──`);
      lines.push(truncated);
      lines.push("");
    }
    return { content: [{ type: "text" as const, text: lines.join("\n") }] };
  },
);

// ── Tool: get_highlights ──────────────────────────────────────────────────

server.tool(
  "get_highlights",
  "Query annotations/highlights across all conversations. " +
    "Can filter by session, tag, or search text. Returns highlighted text, comments, tags, and kinds.",
  {
    sessionId: z.string().optional().describe("Filter to a specific session UUID"),
    search: z.string().optional().describe("Full-text search within highlight text and comments"),
    tag: z.string().optional().describe("Filter by tag name"),
    recent: z.number().optional().describe("Get highlights from the last N days (default 7)"),
    limit: z.number().optional().describe("Max results (default 30)"),
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
    limit: z.number().optional().describe("Max sessions to return (default 20)"),
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

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);
