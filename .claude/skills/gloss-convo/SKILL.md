---
name: gloss-convo
description: "Open the Gloss conversation viewer. Use when asked to 'gloss', 'view convo', 'convo', 'open conversation', 'gloss:convo', or '/gloss:convo'."
one_liner: "Launch Gloss conversation viewer."
activation_triggers:
  - "gloss:convo"
  - "gloss"
  - "convo"
  - "view convo"
  - "open conversation"
  - "export conversation"
  - When user wants to view or export a Claude conversation
---

# /gloss:convo — View Conversation

Launch the Gloss server or export a conversation to HTML.

## Script

`bun <GLOSS_DIR>/src/cli.ts`

Where `<GLOSS_DIR>` is the directory containing this skill (the repo root).

## Procedure

### Default: Start the server

If `<command-args>` is **empty** or **"this"** or **"serve"**:

```bash
bun <GLOSS_DIR>/src/cli.ts serve
```

This starts the Gloss server at `http://localhost:3456`, discovers all conversations in `~/.claude/projects/`, and opens the browser. The user can browse any conversation by clicking it.

If the server is already running (check with `curl -s -o /dev/null -w "%{http_code}" http://localhost:3456/` returning 200), just open the browser:

```bash
open http://localhost:3456
```

### Export a specific conversation

If `<command-args>` contains a **file path** or **session UUID**:

1. **Resolve the JSONL file**:
   - A **file path** -> use directly
   - A **session UUID** -> find it:
     ```bash
     find ~/.claude/projects/ -name "<session-id>.jsonl" -not -path "*/subagents/*" -type f 2>/dev/null
     ```

2. **Export**:
   ```bash
   bun <GLOSS_DIR>/src/cli.ts export "$JSONL_FILE"
   ```

3. **Open in Chrome**:
   ```bash
   open ~/.claude/viewer/<SHORT_ID>.html
   ```

4. **Report**: output path and turn count.

### Open a specific conversation in the server

If the server is running, you can open a specific conversation directly:
```bash
open http://localhost:3456/c/<session-id>
```

## Options

```
serve                  Start the server (default)
export <file>          Export to self-contained HTML
  -o, --output FILE    Output file (overrides default)
  --no-thinking        Exclude thinking blocks
  --no-tools           Exclude tool calls and results
  --port <number>      Port for server (default: 3456)
```
