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

Opens http://localhost:3456 — all your conversations from `~/.claude/projects/` are discovered automatically, indexed in SQLite, and available to browse.

## Features

### Server (default mode)

- **Multi-session browsing** at `localhost:3456/c/<session-id>`
- **Index page** with search, Recent/By-project views, and project filter (mute noisy runners)
- **Live updates** via WebSocket — new turns appear as the JSONL grows
- **Annotation API** — highlights persist in SQLite, sync across tabs
- **Session discovery** — scans `~/.claude/projects/` on startup, rescans periodically
- **AI-powered Ask** — natural language search across all conversations at `/ask`

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

### Ask (AI search)

Type a question in the search bar on the index page to search across all your conversations. Under the hood:

- **FTS5 full-text search** on indexed conversation content, combined with metadata matching on project names and session titles
- **Claude-powered term extraction** (Sonnet) expands your question into multiple search queries
- **Ranked results** using a unified scoring system that balances BM25 relevance with content density (`log2(hits)` boost)
- **Answer synthesis** (Haiku) reads the top-scoring source turns and generates a direct answer with citations
- **Source cards** display matching turns styled as conversation excerpts — click any turn to jump directly to that point in the conversation
- **Project exclusion** filters out noisy automated sessions (configurable via `search-exclude` CLI command)

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
   ~/.convo/db.sqlite     Session index + annotation storage
        |
   server.ts              HTTP routes + WebSocket live updates
        |
   localhost:3456          Index page, conversation viewer, annotation API
```

Key modules:

| File | Role |
|------|------|
| `src/server.ts` | Multi-session HTTP + WebSocket server |
| `src/discovery.ts` | JSONL scanning and SQLite sync |
| `src/db.ts` | SQLite schema, session/annotation/settings CRUD |
| `src/cli.ts` | CLI entry point (serve, export, highlights, search-exclude) |
| `src/ask.ts` | AI-powered search: FTS, term extraction, answer synthesis |
| `src/ask-page.ts` | Ask results page rendering (answer + source cards) |
| `src/index-page.ts` | Server index page with search/filter/grouping |
| `src/incremental-parser.ts` | Streaming JSONL parser for live updates |
| `src/parser.ts` | Full JSONL-to-conversation parser |
| `src/renderer.ts` | Turn-to-HTML renderer |
| `src/convert.ts` | JSONL-to-HTML pipeline (export path) |
| `src/templates/html-template.ts` | Dual-mode HTML (server vs inline) |
| `src/templates/client-js.ts` | Client JS (annotations, WS, exports) |
| `src/templates/css.ts` | Shared styles |

## Development

```bash
bun install
bun test              # 250 tests across 12 files
bunx tsc --noEmit     # Type check
```
