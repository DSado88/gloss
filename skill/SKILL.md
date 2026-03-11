---
name: convo-html
description: "Convert Claude Code conversation JSONL logs to formatted, readable HTML. Use when asked to 'convo to html', 'export conversation', 'convert convo', 'readable html', or '/convo->html'."
one_liner: "JSONL conversation logs to clean, readable HTML."
activation_triggers:
  - "convo->html"
  - "convo to html"
  - "export conversation"
  - "convert conversation to html"
  - "conversation html"
  - "readable conversation"
  - When user wants to export or read a Claude conversation as HTML
---

# Convo -> HTML

Convert Claude Code JSONL conversation logs into formatted, readable HTML files.

## Script

`/Users/david/Documents/Programs/convo-viewer/convo_viewer.py`

## Procedure

1. **Parse arguments** from `<command-args>`:
   - A **session ID** (UUID) — find the matching JSONL
   - A **JSONL file path** — use directly
   - **Empty / "this"** — convert the current conversation

2. **Find the JSONL file**:
   - Session JSONL files live at `~/.claude/projects/<encoded-path>/<session-id>.jsonl`
   - For the current conversation, find the most recently modified JSONL for the current project:
     ```bash
     ls -t ~/.claude/projects/-Users-david-Documents-Programs-<PROJECT>/*.jsonl | head -5
     ```
   - To search by session ID:
     ```bash
     find ~/.claude/projects/ -name "<session-id>.jsonl" -not -path "*/subagents/*" -type f
     ```

3. **Convert** (outputs to `~/.claude/viewer/<short-id>.html` by default):
   ```bash
   python3 /Users/david/Documents/Programs/convo-viewer/convo_viewer.py "$JSONL_FILE"
   ```

4. **Open** the file path printed by the script:
   ```bash
   open ~/.claude/viewer/<SHORT_ID>.html
   ```

5. **Report**: output path and turn count. Mention that `open ~/.claude/viewer/index.html` lists all rendered conversations.

## Script Options

```
-o, --output FILE      Output file (overrides default ~/.claude/viewer/ location)
--no-thinking          Exclude thinking blocks
--no-tools             Exclude tool calls and results (clean reading mode)
```

## Output

Formatted HTML with:
- Dark/light mode (system preference)
- Collapsible tool calls, results, and thinking blocks
- Toggle checkboxes for tools and thinking
- Annotation system: highlight text, add kind (decision/bug/todo/etc.), tags, and comments
- Three export modes: "For Claude" (XML context bundle), Markdown, JSONL slice
- Download annotations JSON for backup/persistence across re-renders
- Clickable file paths (open Finder) and URLs (open browser)
- Rendered markdown tables, code blocks, inline formatting
- Slash commands shown as styled pills
- Session continuations as expandable dividers
- System noise stripped from user messages
- Index page at `~/.claude/viewer/index.html` catalogs all rendered sessions
