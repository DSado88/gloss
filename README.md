# convo-viewer

Convert Claude Code JSONL conversation logs into readable, annotatable HTML files.

## Why

As conversations go on for hundreds of turns, it's easy to forget how they started. Context compaction erases detail, memory fades, and scrolling back to find that one thing Claude said is impractical.

On top of that, LLMs are constantly producing high-quality framing, synthesis, and articulation — but it's all trapped in the conversation it was generated in. Unless you copy and paste it somewhere, after a few days or weeks it's hard to remember which conversation something happened in, and harder still to find the specific moments that stuck out.

convo-viewer solves this by letting you scrub through the full uncompacted record, highlight the moments that matter, and export them back into Claude Code. It's capture infrastructure for long-running AI sessions — making sure the good stuff doesn't evaporate.

The core loop: **converse > review > annotate > extract > feed forward**.

## Features

- Dark/light mode (follows system preference)
- Collapsible tool calls, results, and thinking blocks
- Toggle checkboxes for tools, thinking, and tags/kinds
- **Annotations**: highlight text, add comments — press `h` with text selected
- **Exports**: "For Claude" (XML context bundle), Markdown, JSONL slice, raw JSON download
- Full-text reconstruction from conversation data (even old truncated annotations)
- Clickable file paths and URLs
- Rendered markdown tables, code blocks, inline formatting
- Slash commands shown as styled pills
- Session continuations as expandable dividers
- Index page at `~/.claude/viewer/index.html` catalogs all rendered sessions
- **Live mode**: watch a conversation in real time as it happens

## Usage

### Static render

```bash
# Render a JSONL file to HTML
bun src/cli.ts <session.jsonl>

# Render without tool calls or thinking blocks
bun src/cli.ts --no-tools --no-thinking <session.jsonl>

# Custom output path
bun src/cli.ts -o output.html <session.jsonl>
```

Output goes to `~/.claude/viewer/<short-id>.html` by default.

### Live mode

```bash
# Watch a conversation as it happens
bun src/cli.ts --live <session.jsonl>

# Custom port
bun src/cli.ts --live --port 8080 <session.jsonl>
```

Opens a browser with real-time updates via WebSocket. New turns appear automatically as the JSONL file grows. Click the LIVE badge to jump to the bottom.

### Python version

The original Python script still works independently:

```bash
python3 convo_viewer.py <session.jsonl>
```

## Annotations

Select text and press `h` to highlight. A popover lets you add a comment. Annotations persist in localStorage and can be downloaded as a sidecar JSON file (`<session-id>.annotations.json`) for portability across re-renders.

### Export formats

| Format | What | Use case |
|--------|------|----------|
| **For Claude** | XML `<context_bundle>` with `<highlight>`, `<trigger>`, `<quote>`, `<note>` | Paste into Claude Code to give it context from a previous session |
| **Markdown** | Numbered list with speaker, timestamp, quoted text, and comments | Documentation, notes, sharing |
| **JSONL Slice** | Full turn text for annotated exchanges + their conversation partner | Raw material for further processing |
| **Download** | Raw annotations JSON with all metadata and offsets | Backup, portability across re-renders |

## Setup

```bash
bun install
```

## Development

```bash
# Run tests
bun test

# Type check
bunx tsc --noEmit
```
