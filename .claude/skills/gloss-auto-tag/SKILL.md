---
name: gloss-auto-tag
description: "Auto-tag highlights in the current conversation using AI analysis. Use when asked to 'auto-tag', 'tag my highlights', 'gloss:auto-tag', or '/gloss:auto-tag'."
one_liner: "AI-powered auto-tagging of conversation highlights."
activation_triggers:
  - "gloss:auto-tag"
  - "auto-tag"
  - "auto tag"
  - "tag my highlights"
  - "tag highlights"
  - When user wants Claude to automatically categorize/tag their highlights
---

# /gloss:auto-tag — Auto-Tag Highlights

Read highlights from the current session, analyze them, and apply semantic tags automatically.

## Script

`bun <GLOSS_DIR>/src/cli.ts`

Where `<GLOSS_DIR>` is the directory containing this skill (the repo root).

## Procedure

1. **Find the current session ID**:
   - Use the working directory to build the encoded project path (replace `/` with `-`)
   - Find the most recently modified JSONL:
     ```bash
     ls -t ~/.claude/projects/-<ENCODED_CWD>/*.jsonl | head -1
     ```
   - Extract the session ID from the filename

2. **Fetch all highlights for this session**:
   ```bash
   bun <GLOSS_DIR>/src/cli.ts highlights --json --session "<session-id>"
   ```

3. **If no highlights exist**, tell the user they need to make highlights first via `/gloss:convo`.

4. **Analyze each highlight** and assign tags. Consider:
   - **The highlighted text** — what topic does it cover?
   - **The comment** — did the user add context?
   - **The kind** — decision, bug, constraint, todo, question, insight, highlight
   - **The speaker** — user vs assistant gives context on what's being captured
   - **Existing tags** — preserve any tags the user already set manually

   Use these tag categories as a guide (but don't force-fit — use whatever tags genuinely match):

   | Category | Example tags |
   |----------|-------------|
   | Topic | `architecture`, `testing`, `security`, `performance`, `refactoring`, `api-design` |
   | Technology | `typescript`, `rust`, `sqlite`, `websocket`, `css`, `react` |
   | Action | `action-item`, `follow-up`, `blocked`, `resolved`, `deferred` |
   | Quality | `pattern`, `anti-pattern`, `best-practice`, `gotcha`, `workaround` |
   | Scope | `breaking-change`, `config`, `migration`, `dependency`, `docs` |

5. **Build the tag payload** — a JSON array of `{id, tags}` objects:
   ```json
   [
     {"id": "a1b2c3d4", "tags": ["architecture", "pattern", "typescript"]},
     {"id": "e5f6g7h8", "tags": ["bug", "sqlite", "resolved"]}
   ]
   ```

   Rules:
   - **Merge** with existing tags — don't drop tags the user already set
   - Keep tags lowercase, hyphenated (e.g., `api-design` not `API Design`)
   - 2-5 tags per highlight is ideal; don't over-tag
   - If a highlight already has good tags, skip it

6. **Apply tags via batch-tag**:
   ```bash
   echo '<json-array>' | bun <GLOSS_DIR>/src/cli.ts batch-tag
   ```

7. **Report results**:
   - Show each highlight with its new tags
   - Summarize: "Tagged N highlights with M unique tags"
   - List the unique tags used for easy reference

## Example Output

```
Tagged 8 highlights with 14 unique tags:

  a1b2c3d4: "The server-first pivot makes live the default..."
    → [architecture, server, pivot] (was: [])

  e5f6g7h8: "replaceAnnotationTags() transaction in Step 7"
    → [sqlite, bug, codex-finding] (was: [bug])

Unique tags: architecture, server, pivot, sqlite, bug, codex-finding, ...
```
