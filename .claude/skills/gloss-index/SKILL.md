---
name: gloss-index
description: "Open the Gloss index page to browse all conversations. Use when asked to 'browse conversations', 'list conversations', 'gloss:index', or '/gloss:index'."
one_liner: "Browse all conversations by project."
activation_triggers:
  - "gloss:index"
  - "browse conversations"
  - "list conversations"
  - "show conversations"
  - "all conversations"
  - When user wants to browse or find a specific conversation
---

# /gloss:index — Browse All Conversations

Open the Gloss index page — searchable, grouped by project, sorted by recency.

## Script

`bun <GLOSS_DIR>/src/cli.ts`

Where `<GLOSS_DIR>` is the directory containing this skill (the repo root).

## Procedure

1. **Check if the server is running**:
   ```bash
   curl -s -o /dev/null -w "%{http_code}" http://localhost:3456/
   ```

2. **If not running (non-200)**, start it:
   ```bash
   bun <GLOSS_DIR>/src/cli.ts serve
   ```

3. **Open the index**:
   ```bash
   open http://localhost:3456
   ```

4. **If `<command-args>` contains a search term**, tell the user to type it in the search bar (client-side filtering). The search matches project names, model names, and session IDs.

## Features

- **Search**: filters by project name, model, or session ID
- **Sort**: "Recent" (groups by most recent activity) or "By project" (alphabetical)
- **Project filter**: mute noisy projects (e.g. background runners), persisted in localStorage
- **Project grouping**: conversations grouped by the project directory they live in
- **Collapsible groups**: large groups auto-collapse to keep the page manageable
