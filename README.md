# Gloss

A conversation viewer and annotation tool for Claude Code sessions. Browse, search, highlight, and export from any conversation — live or historical.

## Why

As conversations go on for hundreds of turns, it's easy to forget how they started. Context compaction erases detail, memory fades, and scrolling back to find that one thing Claude said is impractical.

On top of that, LLMs are constantly producing high-quality framing, synthesis, and articulation — but it's all trapped in the conversation it was generated in. Unless you copy and paste it somewhere, after a few days or weeks it's hard to remember which conversation something happened in, and harder still to find the specific moments that stuck out.

Gloss solves this by letting you scrub through the full uncompacted record, highlight the moments that matter, and export them back into Claude Code. It's capture infrastructure for long-running AI sessions — making sure the good stuff doesn't evaporate.

The core loop: **converse > review > annotate > extract > feed forward**.

## Quick Start

```bash
bun install
bun src/cli.ts serve
```

Opens http://localhost:3456 — all your conversations from `~/.claude/projects/` are discovered automatically, indexed in SQLite, and available to browse. On first launch, Gloss will start building the full-text and vector search indexes in the background.

## Features

### Server (default mode)

- **Multi-session browsing** at `localhost:3456/c/<session-id>`
- **Index page** with search, Recent/By-project views, project filter, and min-turns filter
- **Live updates** via WebSocket — new turns appear as the JSONL grows
- **Annotation API** — highlights persist in SQLite, sync across tabs
- **Session discovery** — scans `~/.claude/projects/` on startup, rescans periodically with adaptive backoff
- **Semantic search** — hybrid FTS + vector search with AI-powered answers at `/ask`
- **Copy resume** — one-click copy of `claude --resume <uuid>` from the index page

### Semantic Search (Ask)

Type a natural language question in the search bar on the index page. Gloss uses a three-stage retrieval pipeline:

**1. Retrieval (FTS + Vector, ~50ms)**

- **FTS5 full-text search** — per-token queries ensure each concept gets proper representation instead of being drowned by generic words in a combined OR query
- **Vector similarity** — 256-dimensional [Snowflake Arctic Embed](https://huggingface.co/Snowflake/snowflake-arctic-embed-m-v2.0) embeddings, cosine similarity search across all indexed turns
- **Metadata matching** — project names and session titles
- **RRF fusion** (k=60) — combines all ranking signals fairly so no single retriever dominates

**2. Context assembly**

Top-ranked sessions are loaded and the most relevant turns are extracted with surrounding context windows. This produces a focused evidence set for the LLM.

**3. Answer synthesis (~5-15s)**

Claude Haiku reads the evidence and generates a direct answer with numbered source citations. The answer streams in real-time. Source cards below the answer link directly to the referenced turns in their conversations.

#### Vector indexing

Embeddings are generated locally using `@huggingface/transformers` — no API calls, no external services. The model runs in a subprocess to avoid blocking the server.

**First-run expectations:**
- Model download: ~100MB on first launch (cached after that)
- Indexing speed: ~50 sessions/minute depending on conversation length
- A typical collection of ~800 sessions takes 15-20 minutes to fully index
- Indexing runs in the background — the server is usable immediately, search quality improves as more sessions get indexed

**What gets indexed:**
- Sessions with 3+ turns by default (configurable via Settings > Min turns on the index page)
- Files between 10KB and 50MB
- Each turn is truncated to 2,000 characters before embedding
- Embeddings are stored as 1KB BLOBs in SQLite (256 × float32)

**Recommendation:** Set the min turns filter to **5-7** if you have many short test/debug sessions. This avoids wasting indexing time on throwaway conversations and keeps the vector index focused on substantive sessions. You can change this in Settings on the index page — it applies to both the visible session list and what gets vectorized.

**Disabling embeddings:**

```bash
bun src/cli.ts serve --no-embeddings    # Skip vector indexing entirely
```

FTS search still works without embeddings. Vector search adds recall for semantic/synonym queries (e.g., finding "database" when the conversation says "SQLite") but FTS handles exact keyword matches well on its own.

### Viewer

- Dark/light mode (follows system preference)
- Collapsible tool calls, results, and thinking blocks
- Toggle checkboxes for tools, thinking, and tags/kinds
- Rendered markdown tables, code blocks, inline formatting
- Clickable file paths and URLs
- Slash commands shown as styled pills
- Session continuations as expandable dividers

### Annotations

- Select text and press `h` to highlight
- Add comments, assign kinds (decision, bug, constraint, todo, question, insight)
- Tag highlights for organization
- Three-tier restore: precise (char offsets) > fuzzy (prefix/suffix) > legacy (text search)

### Export formats

| Format | What | Use case |
|--------|------|----------|
| **For Claude** | XML `<context_bundle>` with `<highlight>`, `<trigger>`, `<quote>`, `<note>` | Paste into Claude Code to give it context from a previous session |
| **Markdown** | Numbered list with speaker, timestamp, quoted text, and comments | Documentation, notes, sharing |
| **JSONL Slice** | Full turn text for annotated exchanges + their conversation partner | Raw material for further processing |
| **Download** | Raw annotations JSON with all metadata and offsets | Backup, portability |

### Static export

Self-contained HTML files with CSS/JS inlined — works via `file://` with no server needed.

```bash
bun src/cli.ts export <session.jsonl>
bun src/cli.ts export --no-tools --no-thinking <session.jsonl>
bun src/cli.ts export -o output.html <session.jsonl>
```

## CLI

```
bun src/cli.ts serve                       # Start the server (default)
bun src/cli.ts serve --port 8080           # Custom port
bun src/cli.ts serve --no-embeddings       # Disable vector indexing
bun src/cli.ts export <file>               # Export to self-contained HTML
bun src/cli.ts export -o out.html          # Custom output path
bun src/cli.ts highlights --json           # Query highlights from SQLite
bun src/cli.ts highlights --tags           # List all tags with counts
bun src/cli.ts import                      # Import sidecar .annotations.json files
bun src/cli.ts search-exclude list         # Show excluded project patterns
bun src/cli.ts search-exclude add "foo*"   # Exclude projects matching pattern
bun src/cli.ts search-exclude remove "foo*"
```

## Slash Commands

When working in the Gloss repo, these skills are available:

| Command | Description |
|---------|-------------|
| `/gloss:convo` | Start server or export a conversation |
| `/gloss:index` | Browse all conversations |
| `/gloss:highlights` | Pull highlights from the current session |
| `/gloss:search` | Search highlights across all sessions |
| `/gloss:auto-tag` | AI-powered auto-tagging of highlights |

## Architecture

```
~/.claude/projects/       JSONL session logs (source of truth)
        |
   discovery.ts           Scans for sessions, extracts metadata from first 32KB
        |
   ~/.convo/db.sqlite     Session index + annotations + embeddings
        |
   server.ts              HTTP routes + WebSocket live updates
        |                  Background: turn counts, FTS indexing, vector indexing
        |
   localhost:3456          Index page, conversation viewer, Ask, annotation API
```

Key modules:

| File | Role |
|------|------|
| `src/server.ts` | Multi-session HTTP + WebSocket server |
| `src/discovery.ts` | JSONL scanning, SQLite sync, turn counting |
| `src/db.ts` | SQLite schema, session/annotation/embedding/FTS CRUD |
| `src/cli.ts` | CLI entry point (serve, export, highlights, search-exclude) |
| `src/ask.ts` | Hybrid search pipeline: FTS + vector + RRF fusion + Haiku synthesis |
| `src/ask-page.ts` | Streaming Ask UI with answer + source cards |
| `src/embeddings.ts` | Embedding engine (subprocess) + in-memory vector index |
| `src/indexer.ts` | Background embedding backfill with batching and progress logging |
| `src/index-page.ts` | Server index page with search/filter/grouping |
| `src/incremental-parser.ts` | Streaming JSONL parser for live updates |
| `src/parser.ts` | Full JSONL-to-conversation parser |
| `src/renderer.ts` | Turn-to-HTML renderer |
| `src/convert.ts` | JSONL-to-HTML pipeline (export path) |
| `src/templates/html-template.ts` | Dual-mode HTML (server vs inline) |
| `src/templates/client-js.ts` | Client JS (annotations, WS, exports) |
| `src/templates/css.ts` | Shared styles |

## How Ask works (detailed)

```
User question
     |
     v
 Per-token FTS queries ──────────┐
 (each keyword searched           |
  individually for coverage)      |
                                  |── RRF fusion (k=60) ──> Top N sessions
 Vector cosine search ───────────┤
 (256-dim Arctic Embed,           |
  "query:" prefix encoding)       |
                                  |
 Metadata LIKE matching ─────────┘
 (project names, titles)
     |
     v
 Load source turns + context windows
     |
     v
 Claude Haiku (-p --model haiku)
 reads evidence, streams answer
 with numbered citations
```

The `-p` flag pipes the prompt via stdin to the Claude CLI. Haiku was chosen for synthesis because it's fast (~5-15s) and the retrieval pipeline has already done the hard work of finding relevant content — the LLM just needs to read and summarize.

## Development

```bash
bun install
bun test              # Run tests
bunx tsc --noEmit     # Type check
```
