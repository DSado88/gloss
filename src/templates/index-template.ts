export function buildIndexPage(entriesHtml: string, count: number): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Claude Conversations</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  :root {
    --bg: #0d1117;
    --surface: #161b22;
    --surface2: #21262d;
    --text: #e6edf3;
    --text2: #7d8590;
    --border: #30363d;
    --accent: #da7756;
  }
  @media (prefers-color-scheme: light) {
    :root {
      --bg: #f6f8fa;
      --surface: #ffffff;
      --surface2: #f0f2f5;
      --text: #1f2328;
      --text2: #656d76;
      --border: #d0d7de;
      --accent: #c2613a;
    }
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
    background: var(--bg);
    color: var(--text);
    -webkit-font-smoothing: antialiased;
    padding: 40px 24px;
    max-width: 960px;
    margin: 0 auto;
  }
  h1 {
    font-size: 1.5rem;
    font-weight: 600;
    margin-bottom: 4px;
  }
  .meta {
    color: var(--text2);
    font-size: 0.82rem;
    margin-bottom: 24px;
  }
  .index-list {
    display: flex;
    flex-direction: column;
    gap: 1px;
    background: var(--border);
    border-radius: 8px;
    overflow: hidden;
  }
  .index-entry {
    display: grid;
    grid-template-columns: 80px 1fr 140px 160px 90px;
    gap: 12px;
    align-items: center;
    padding: 12px 16px;
    background: var(--surface);
    text-decoration: none;
    color: inherit;
    transition: background 0.15s;
  }
  .index-entry:hover {
    background: var(--surface2);
  }
  .entry-id {
    font-family: 'SF Mono', 'Fira Code', monospace;
    font-size: 0.82rem;
    color: var(--accent);
    font-weight: 500;
  }
  .entry-project {
    font-size: 0.85rem;
    color: var(--text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .entry-model {
    font-size: 0.8rem;
    color: var(--text2);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .entry-time {
    font-size: 0.8rem;
    color: var(--text2);
    white-space: nowrap;
  }
  .entry-turns {
    font-size: 0.8rem;
    color: var(--text2);
    text-align: right;
    white-space: nowrap;
  }
  .empty {
    text-align: center;
    padding: 40px;
    color: var(--text2);
    background: var(--surface);
    border-radius: 8px;
  }
  @media (max-width: 700px) {
    .index-entry {
      grid-template-columns: 70px 1fr 80px;
    }
    .entry-model, .entry-time {
      display: none;
    }
  }
</style>
</head>
<body>
  <h1>Claude Conversations</h1>
  <div class="meta">${count} sessions</div>
  ${entriesHtml}
</body>
</html>`;
}
