---
name: gloss-highlights
description: "Pull highlights from the current conversation into context. Use when asked for 'highlights', 'my highlights', 'gloss:highlights', or '/gloss:highlights'."
one_liner: "Retrieve highlights from the current conversation."
activation_triggers:
  - "gloss:highlights"
  - "highlights"
  - "my highlights"
  - "show highlights"
  - "what did I highlight"
  - "pull highlights"
  - When user wants to see their conversation annotations/highlights
---

# /gloss:highlights — Current Conversation Highlights

Pull highlights from the **current conversation** out of `~/.convo/db.sqlite`.

## Script

`bun <GLOSS_DIR>/src/cli.ts highlights`

Where `<GLOSS_DIR>` is the directory containing this skill (the repo root).

## Procedure

1. **Find the current session ID**:
   - Look at the working directory to build the encoded project path (replace `/` with `-`)
   - Find the most recently modified JSONL for this project:
     ```bash
     ls -t ~/.claude/projects/-<ENCODED_CWD>/*.jsonl | head -1
     ```
   - Extract the session ID from the JSONL filename (the UUID before `.jsonl`)

2. **Query highlights for this session**:
   ```bash
   bun <GLOSS_DIR>/src/cli.ts highlights --json --session "<session-id>"
   ```
   Always use `--json` so you get structured data to work with.

3. **If `<command-args>` contains a search query**, add `--search`:
   ```bash
   bun <GLOSS_DIR>/src/cli.ts highlights --json --session "<session-id>" --search "<query>"
   ```

4. **If `<command-args>` contains `--tag <name>`**, add the tag filter:
   ```bash
   bun <GLOSS_DIR>/src/cli.ts highlights --json --session "<session-id>" --tag "<name>"
   ```

5. **Present results** to the user:
   - Summarize how many highlights were found
   - For each highlight, show: the quoted text, the comment, tags, kind, and speaker (You/Claude)
   - If the user asked a question about their highlights, answer it using the data

6. **If no highlights exist**, tell the user:
   - They need to view the conversation first with `/gloss:convo` and make highlights in the browser
   - Or import existing annotation files: `bun <GLOSS_DIR>/src/cli.ts import`

## Examples

```bash
# All highlights for the current session
bun <GLOSS_DIR>/src/cli.ts highlights --json --session "a8ba3d6d-..."

# Search within session
bun <GLOSS_DIR>/src/cli.ts highlights --json --session "a8ba3d6d-..." --search "architecture"

# By tag
bun <GLOSS_DIR>/src/cli.ts highlights --json --session "a8ba3d6d-..." --tag seed_idea
```
