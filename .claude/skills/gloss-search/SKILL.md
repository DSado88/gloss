---
name: gloss-search
description: "Search highlights across all sessions by tag, text, speaker, or kind. Use when asked to 'search highlights', 'find highlights', 'gloss:search', or '/gloss:search'."
one_liner: "Search highlights across all conversations."
activation_triggers:
  - "gloss:search"
  - "search highlights"
  - "find highlights"
  - "all highlights"
  - "highlights tagged"
  - "highlights about"
  - When user wants to search or query highlights across multiple sessions
---

# /gloss:search — Search All Highlights

Search highlights across **all sessions** in `~/.convo/db.sqlite`.

Unlike `/gloss:highlights` (scoped to current session), this searches everything.

## Script

`bun <GLOSS_DIR>/src/cli.ts highlights`

Where `<GLOSS_DIR>` is the directory containing this skill (the repo root).

## Procedure

1. **Parse `<command-args>`** to determine the query type:

   | User says | CLI flags |
   |-----------|-----------|
   | `gloss:search security` | `--search "security"` |
   | `gloss:search --tag architecture` | `--tag architecture` |
   | `gloss:search --tag bug --speaker assistant` | `--tag bug --speaker assistant` |
   | `gloss:search` (no args) | `--recent 30` (last 30 days) |
   | `gloss:search --tags` | `--tags` (list all tags with counts) |

2. **Run the query**:
   ```bash
   bun <GLOSS_DIR>/src/cli.ts highlights --json <flags>
   ```

   Common patterns:
   ```bash
   # Full-text search across all sessions
   bun <GLOSS_DIR>/src/cli.ts highlights --json --search "security" -n 50

   # All highlights with a specific tag
   bun <GLOSS_DIR>/src/cli.ts highlights --json --tag architecture -n 50

   # Combined: tag + speaker
   bun <GLOSS_DIR>/src/cli.ts highlights --json --tag bug --speaker assistant -n 50

   # List all tags with counts
   bun <GLOSS_DIR>/src/cli.ts highlights --json --tags

   # Recent highlights (last N days)
   bun <GLOSS_DIR>/src/cli.ts highlights --json --recent 7

   # All highlights for a specific session
   bun <GLOSS_DIR>/src/cli.ts highlights --json --session "<session-id>"
   ```

3. **Present results** organized by relevance:
   - Group by session when results span multiple sessions
   - Show: quoted text, comment, tags, kind, speaker, session project
   - If the user asked a question, synthesize an answer from the highlights
   - If listing tags, show them sorted by count with a brief description of what each covers

4. **Suggest follow-ups** based on what was found:
   - "Run `/gloss:search --tag <tag>` to drill into a specific tag"
   - "Run `/gloss:auto-tag` to tag untagged highlights"
   - "Open a session with `/gloss:convo <session-id>` to see highlights in context"

## Examples

```
/gloss:search security
  → Searches text and comments for "security" across all sessions

/gloss:search --tag architecture
  → All highlights tagged "architecture"

/gloss:search --tags
  → Lists all tags: architecture (12), bug (8), pattern (6), ...

/gloss:search --recent 7
  → Highlights from the last week
```
