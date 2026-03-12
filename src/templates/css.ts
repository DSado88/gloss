export const CSS_STYLES = `
  :root {
    --bg: #0d1117;
    --surface: #161b22;
    --surface2: #21262d;
    --border: #30363d;
    --border-subtle: #21262d;
    --text: #e6edf3;
    --text-muted: #9eaab8;
    --text-tertiary: #7a8595;
    --user-bg: rgba(45, 212, 191, 0.08);
    --user-border: #2dd4bf;
    --user-label: #5eead4;
    --assistant-bg: rgba(218, 119, 86, 0.08);
    --assistant-border: #da7756;
    --assistant-label: #e8956e;
    --code-bg: #0d1117;
    --tool-bg: rgba(63, 185, 80, 0.05);
    --tool-border: #30363d;
    --result-bg: rgba(56, 139, 253, 0.05);
    --result-border: #30363d;
    --error-border: #f85149;
    --error-bg: rgba(248, 81, 73, 0.08);
    --accent: #6e79d6;
    --accent-hover: #8b93db;
    --accent-subtle: rgba(110, 121, 214, 0.12);
    --thinking-bg: #161b22;
    --tab-bg: rgba(255, 255, 255, 0.06);
    --tab-hover: rgba(255, 255, 255, 0.10);
  }

  @media (prefers-color-scheme: light) {
    html:not([data-theme="dark"]) {
      --bg: #f7f7f8;
      --surface: #ffffff;
      --surface2: #ececef;
      --border: #e0e0e4;
      --border-subtle: #ececef;
      --text: #111111;
      --text-muted: #555555;
      --text-tertiary: #888888;
      --user-bg: rgba(13, 148, 136, 0.06);
      --user-border: #0d9488;
      --user-label: #0f766e;
      --assistant-bg: rgba(218, 119, 86, 0.06);
      --assistant-border: #da7756;
      --assistant-label: #c4633e;
      --code-bg: #f0f0f3;
      --tool-bg: rgba(22, 163, 74, 0.05);
      --tool-border: #e0e0e4;
      --result-bg: rgba(37, 99, 235, 0.04);
      --result-border: #e0e0e4;
      --error-border: #dc2626;
      --error-bg: rgba(220, 38, 38, 0.06);
      --accent: #4f46e5;
      --accent-hover: #4338ca;
      --accent-subtle: rgba(79, 70, 229, 0.08);
      --thinking-bg: #f5f5f7;
      --tab-bg: rgba(0, 0, 0, 0.04);
      --tab-hover: rgba(0, 0, 0, 0.07);
    }
  }

  /* Manual light mode override */
  html[data-theme="light"] {
    --bg: #f7f7f8;
    --surface: #ffffff;
    --surface2: #ececef;
    --border: #e0e0e4;
    --border-subtle: #ececef;
    --text: #111111;
    --text-muted: #555555;
    --text-tertiary: #888888;
    --user-bg: rgba(13, 148, 136, 0.06);
    --user-border: #0d9488;
    --user-label: #0f766e;
    --assistant-bg: rgba(218, 119, 86, 0.06);
    --assistant-border: #da7756;
    --assistant-label: #c4633e;
    --code-bg: #f0f0f3;
    --tool-bg: rgba(22, 163, 74, 0.05);
    --tool-border: #e0e0e4;
    --result-bg: rgba(37, 99, 235, 0.04);
    --result-border: #e0e0e4;
    --error-border: #dc2626;
    --error-bg: rgba(220, 38, 38, 0.06);
    --accent: #4f46e5;
    --accent-hover: #4338ca;
    --accent-subtle: rgba(79, 70, 229, 0.08);
    --thinking-bg: #f5f5f7;
    --tab-bg: rgba(0, 0, 0, 0.04);
    --tab-hover: rgba(0, 0, 0, 0.07);
  }

  * { margin: 0; padding: 0; box-sizing: border-box; }

  body {
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
    background: var(--bg);
    color: var(--text);
    line-height: 1.55;
    padding: 0;
    font-size: 14px;
    -webkit-font-smoothing: antialiased;
  }

  .header {
    background: var(--surface);
    border-bottom: 1px solid var(--border);
    padding: 20px 24px;
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
  }

  .header-left { flex: 1; min-width: 0; }

  .header h1 {
    font-size: 18px;
    font-weight: 600;
    margin-bottom: 6px;
    letter-spacing: -0.03em;
  }

  .custom-title {
    font-size: 13px;
    color: var(--text2);
    padding: 2px 4px;
    margin: -2px -4px 4px;
    border-radius: 4px;
    border: 1px solid transparent;
    outline: none;
    min-height: 1.3em;
    transition: border-color 0.15s;
  }
  .custom-title:hover { border-color: var(--border); }
  .custom-title:focus { border-color: var(--accent); color: var(--text); }
  .custom-title:empty::before {
    content: attr(data-placeholder);
    color: var(--text-muted);
    opacity: 0.5;
  }

  .header .meta {
    font-size: 12px;
    color: var(--text-muted);
    display: flex;
    gap: 20px;
    flex-wrap: wrap;
  }

  #theme-toggle {
    background: var(--tab-bg);
    border: none;
    color: var(--text-muted);
    padding: 6px 10px;
    border-radius: 6px;
    font-size: 16px;
    cursor: pointer;
    transition: all 0.1s ease;
    line-height: 1;
    flex-shrink: 0;
    margin-top: 2px;
  }
  #theme-toggle:hover { background: var(--tab-hover); color: var(--text); }

  .controls {
    background: var(--surface);
    border-bottom: 1px solid var(--border);
    padding: 8px 24px;
    display: flex;
    justify-content: space-between;
    font-size: 13px;
    position: sticky;
    top: 0;
    z-index: 99;
    align-items: center;
  }

  .controls-left { display: flex; align-items: center; gap: 12px; }
  .controls-right { display: flex; align-items: center; gap: 10px; }

  .controls label {
    cursor: pointer;
    color: var(--text-muted);
    user-select: none;
    font-size: 13px;
    font-weight: 500;
  }

  .controls input[type="checkbox"] {
    margin-right: 4px;
  }

  .toc-toggle {
    background: var(--tab-bg);
    border: none;
    color: var(--text-muted);
    padding: 5px 12px;
    border-radius: 6px;
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    white-space: nowrap;
    font-family: inherit;
    transition: all 0.1s ease;
  }
  .toc-toggle:hover { background: var(--tab-hover); color: var(--text); }

  /* Settings dropdown */
  .settings-menu { position: relative; }
  .settings-toggle {
    background: var(--tab-bg);
    border: none;
    color: var(--text-muted);
    padding: 5px 10px;
    border-radius: 6px;
    font-size: 15px;
    cursor: pointer;
    transition: all 0.1s ease;
    line-height: 1;
  }
  .settings-toggle:hover { background: var(--tab-hover); color: var(--text); }
  .settings-dropdown {
    display: none;
    position: absolute;
    right: 0;
    top: calc(100% + 6px);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 8px 12px;
    box-shadow: 0 4px 12px rgba(0,0,0,0.15);
    z-index: 200;
    white-space: nowrap;
  }
  .settings-menu.open .settings-dropdown { display: flex; flex-direction: column; gap: 6px; }
  .settings-dropdown label {
    cursor: pointer;
    color: var(--text-muted);
    user-select: none;
    font-size: 13px;
    font-weight: 500;
    padding: 2px 0;
  }

  .conversation {
    max-width: 100%;
    margin: 0 auto;
    padding: 12px 24px 60px;
  }

  .turn {
    margin: 8px 0;
    border-radius: 8px;
    overflow: hidden;
    border: 1px solid var(--border);
    background: var(--surface);
  }

  .turn.user {
    background: var(--user-bg);
    border-left: 3px solid var(--user-border);
  }

  .turn.assistant {
    background: var(--assistant-bg);
    border-left: 3px solid var(--assistant-border);
  }

  .turn-header {
    padding: 8px 16px;
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .role-label {
    font-weight: 600;
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .user .role-label { color: var(--user-label); }
  .assistant .role-label { color: var(--assistant-label); }

  .timestamp {
    font-size: 11px;
    color: var(--text-tertiary);
  }

  .turn-body {
    padding: 4px 16px 14px;
  }

  .message-text {
    font-size: 14px;
    line-height: 1.65;
  }

  .message-text p { margin-bottom: 8px; }
  .message-text h3, .message-text h4, .message-text h5, .message-text h6 {
    margin: 12px 0 4px;
    letter-spacing: -0.01em;
  }
  .message-text li, .tool-result-rendered li { margin-left: 20px; line-height: 1.55; }
  .message-text ul, .tool-result-rendered ul { margin: 4px 0; padding: 0; }
  .message-text hr { border: none; border-top: 1px solid var(--border); margin: 12px 0; }

  .message-text table, .tool-result-rendered table {
    width: 100%;
    border-collapse: collapse;
    margin: 8px 0;
    font-size: 13px;
  }
  .message-text th, .tool-result-rendered th {
    text-align: left;
    padding: 8px 12px;
    background: var(--surface2);
    border: 1px solid var(--border);
    font-weight: 600;
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    color: var(--text-muted);
  }
  .message-text td, .tool-result-rendered td {
    padding: 6px 12px;
    border: 1px solid var(--border);
    vertical-align: top;
  }
  .message-text tr:hover, .tool-result-rendered tr:hover {
    background: var(--surface2);
  }

  .message-text code {
    background: var(--code-bg);
    padding: 2px 5px;
    border-radius: 3px;
    font-size: 12px;
    font-family: 'SF Mono', 'Fira Code', monospace;
    border: 1px solid var(--border);
  }

  .message-text pre {
    background: var(--code-bg);
    padding: 14px;
    border-radius: 6px;
    overflow-x: auto;
    margin: 8px 0;
    font-size: 13px;
    line-height: 1.5;
    border: 1px solid var(--border);
  }

  .message-text pre code {
    background: none;
    padding: 0;
    font-size: inherit;
    border: none;
  }

  .message-text a {
    color: var(--accent);
    text-decoration: none;
  }
  .message-text a:hover, .tool-result-rendered a:hover { text-decoration: underline; }

  a.file-link {
    color: var(--accent);
    text-decoration: none;
    border-bottom: 1px dashed var(--accent);
    font-family: 'SF Mono', 'Fira Code', monospace;
    font-size: 12px;
  }
  a.file-link:hover {
    border-bottom-style: solid;
  }

  /* Tool use */
  .tool-use {
    background: var(--tool-bg);
    border: 1px solid var(--border);
    border-radius: 6px;
    margin: 6px 0;
    font-size: 13px;
  }

  .tool-header {
    padding: 6px 12px;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 8px;
    user-select: none;
    transition: background 0.1s;
  }

  .tool-header:hover { background: var(--tab-hover); }

  .tool-icon { font-size: 13px; }
  .tool-name { font-weight: 600; font-family: 'SF Mono', 'Fira Code', monospace; font-size: 12px; }
  .tool-summary {
    color: var(--text-tertiary);
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 12px;
  }
  .tool-expand {
    font-size: 9px;
    transition: transform 0.2s;
    color: var(--text-muted);
  }
  .tool-use.expanded .tool-expand { transform: rotate(180deg); }

  .tool-detail {
    display: none;
    padding: 12px;
    background: var(--code-bg);
    border-top: 1px solid var(--border);
    font-size: 12px;
    max-height: 400px;
    overflow: auto;
    white-space: pre-wrap;
    word-break: break-word;
    font-family: 'SF Mono', 'Fira Code', monospace;
  }
  .tool-use.expanded .tool-detail { display: block; }

  /* Tool result */
  .tool-result {
    background: var(--result-bg);
    border: 1px solid var(--border);
    border-radius: 6px;
    margin: 4px 0;
    font-size: 13px;
  }

  .tool-result.tool-error {
    border-color: var(--error-border);
    background: var(--error-bg);
  }

  .tool-result-header {
    padding: 4px 12px;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 6px;
    user-select: none;
    color: var(--text-tertiary);
    font-size: 12px;
    transition: background 0.1s;
  }
  .tool-result-header:hover { background: var(--tab-hover); }

  .tool-result-preview {
    display: block;
    padding: 8px 12px;
    border-top: 1px solid var(--border);
    font-size: 12px;
    max-height: 150px;
    overflow: hidden;
    white-space: pre-wrap;
    word-break: break-word;
    color: var(--text-muted);
    font-family: 'SF Mono', 'Fira Code', monospace;
  }

  .tool-result-full {
    display: none;
    padding: 8px 12px;
    border-top: 1px solid var(--border);
    font-size: 12px;
    max-height: 500px;
    overflow: auto;
    white-space: pre-wrap;
    word-break: break-word;
    font-family: 'SF Mono', 'Fira Code', monospace;
  }

  .tool-result.expanded .tool-result-preview { display: none; }
  .tool-result.expanded .tool-result-full { display: block; }

  /* Thinking */
  .thinking {
    margin: 6px 0;
    border: 1px solid var(--border);
    border-radius: 6px;
    font-size: 13px;
  }

  .thinking summary {
    padding: 6px 12px;
    cursor: pointer;
    font-weight: 500;
    color: var(--text-tertiary);
    font-size: 12px;
    user-select: none;
    transition: color 0.1s;
  }
  .thinking summary:hover { color: var(--text-muted); }

  .thinking pre {
    padding: 12px;
    background: var(--thinking-bg);
    max-height: 400px;
    overflow: auto;
    white-space: pre-wrap;
    word-break: break-word;
    font-size: 12px;
    line-height: 1.55;
  }

  /* Agent result rendered as readable text — collapsed by default */
  .agent-result .tool-result-rendered {
    display: none;
    padding: 12px;
    font-size: 14px;
    line-height: 1.65;
    max-height: 600px;
    overflow: auto;
  }
  .agent-result.expanded .tool-result-rendered { display: block; max-height: none; }

  .agent-result .tool-result-rendered pre {
    background: var(--code-bg);
    padding: 12px;
    border-radius: 6px;
    overflow-x: auto;
    margin: 8px 0;
    font-size: 12px;
    border: 1px solid var(--border);
  }

  .agent-result .tool-result-rendered code {
    background: var(--code-bg);
    padding: 2px 5px;
    border-radius: 3px;
    font-size: 12px;
    font-family: 'SF Mono', 'Fira Code', monospace;
  }

  .agent-result .tool-result-rendered pre code {
    background: none;
    padding: 0;
    border: none;
  }

  .tool-result-meta {
    display: none;
    padding: 4px 12px;
    font-size: 11px;
    color: var(--text-tertiary);
    border-top: 1px solid var(--border);
    font-family: 'SF Mono', 'Fira Code', monospace;
    white-space: pre-wrap;
  }
  .tool-result.expanded .tool-result-meta { display: block; }

  /* Slash commands */
  .slash-command {
    padding: 4px 0;
  }
  .slash-cmd {
    font-family: 'SF Mono', 'Fira Code', monospace;
    background: var(--accent-subtle);
    padding: 3px 8px;
    border-radius: 4px;
    font-size: 13px;
    color: var(--accent);
    font-weight: 500;
  }

  /* Date divider between turns on different days */
  .date-divider {
    text-align: center;
    padding: 12px 0 4px;
    position: relative;
  }
  .date-divider::before {
    content: '';
    position: absolute;
    left: 0;
    right: 0;
    top: 50%;
    height: 1px;
    background: var(--border);
  }
  .date-divider span {
    position: relative;
    background: var(--bg);
    padding: 2px 14px;
    font-size: 12px;
    font-weight: 500;
    color: var(--text-muted);
    border-radius: 10px;
    border: 1px solid var(--border);
  }

  /* Session continuation divider */
  .session-divider {
    text-align: center;
    padding: 16px 0;
    color: var(--text-muted);
    font-size: 12px;
  }
  .session-divider summary {
    cursor: pointer;
    list-style: none;
    user-select: none;
  }
  .session-divider summary::-webkit-details-marker { display: none; }
  .session-divider summary span {
    background: var(--surface);
    padding: 4px 14px;
    border-radius: 20px;
    border: 1px solid var(--border);
    font-weight: 500;
    transition: all 0.1s ease;
  }
  .session-divider summary:hover span {
    border-color: var(--text-muted);
    background: var(--surface2);
  }
  .session-summary {
    text-align: left;
    font-size: 13px;
    line-height: 1.55;
    padding: 14px;
    margin-top: 10px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    max-height: 500px;
    overflow: auto;
  }

  /* Toggle visibility */
  body.hide-tools .tool-use,
  body.hide-tools .tool-result { display: none; }
  body.hide-thinking .thinking { display: none; }
  body.hide-tagging .kind-chips,
  body.hide-tagging .tags-row,
  body.hide-tagging .hl-kind-badge,
  body.hide-tagging .hl-item-tags { display: none; }

  /* ── TOC Sidebar ── */
  .toc-panel {
    position: fixed;
    top: 0; left: 0; bottom: 0;
    width: 340px;
    background: var(--surface);
    border-right: 1px solid var(--border);
    z-index: 300;
    display: none;
    flex-direction: column;
    box-shadow: 4px 0 24px rgba(0,0,0,0.15);
  }
  .toc-panel.visible { display: flex; }

  /* Slide page content right when TOC is open */
  .header, .controls, .conversation {
    transition: margin-left 0.2s ease;
  }
  body.toc-open .header,
  body.toc-open .controls,
  body.toc-open .conversation {
    margin-left: 340px;
  }
  .toc-panel-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 14px 16px;
    border-bottom: 1px solid var(--border);
  }
  .toc-panel-header h3 { font-size: 14px; font-weight: 600; margin: 0; letter-spacing: -0.01em; }
  .toc-panel-header button {
    background: none; border: none; color: var(--text-tertiary); cursor: pointer; font-size: 16px;
    transition: color 0.1s;
  }
  .toc-panel-header button:hover { color: var(--text); }
  .toc-filter {
    padding: 8px 12px;
    border-bottom: 1px solid var(--border);
    display: flex;
    gap: 6px;
  }
  .toc-filter button {
    padding: 4px 10px;
    border-radius: 6px;
    border: none;
    background: var(--tab-bg);
    color: var(--text-muted);
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
    font-family: inherit;
    transition: all 0.1s ease;
  }
  .toc-filter button:hover:not(.active) { background: var(--tab-hover); color: var(--text); }
  .toc-filter button.active { background: var(--text); color: var(--bg); }
  .toc-body {
    flex: 1;
    overflow-y: auto;
    padding: 8px;
  }
  .toc-item {
    padding: 6px 10px;
    border-radius: 6px;
    cursor: pointer;
    margin-bottom: 2px;
    transition: background 0.1s;
  }
  .toc-item:hover { background: var(--tab-hover); }
  .toc-item-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .toc-role {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .toc-user .toc-role { color: var(--user-label); }
  .toc-assistant .toc-role { color: var(--assistant-label); }
  .toc-time {
    font-size: 10px;
    color: var(--text-tertiary);
  }
  .toc-item-preview {
    font-size: 12px;
    color: var(--text-muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    line-height: 1.4;
  }
  .toc-user .toc-item-preview { color: var(--text); }

  /* ── Annotations ── */
  mark[data-annotation-id] {
    background: var(--accent-subtle);
    border-bottom: 2px solid var(--accent);
    cursor: pointer;
    border-radius: 2px;
    padding: 0 1px;
    transition: background 0.15s;
  }
  /* Hide marks wrapping whitespace between list items */
  ul > mark[data-annotation-id],
  ol > mark[data-annotation-id] {
    border-bottom: none;
    background: none;
    padding: 0;
  }
  mark[data-annotation-id]:hover,
  mark[data-annotation-id].active {
    background: rgba(94, 106, 210, 0.25);
  }

  .controls-right > button {
    background: var(--tab-bg);
    border: none;
    color: var(--text-muted);
    padding: 5px 12px;
    border-radius: 6px;
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    white-space: nowrap;
    font-family: inherit;
    transition: all 0.1s ease;
  }
  .controls-right > button:hover { background: var(--tab-hover); color: var(--text); }
  .controls-right > button:disabled { opacity: 0.3; cursor: default; }
  .controls-right > .count {
    font-size: 12px;
    color: var(--text-tertiary);
  }

  /* Comment popover */
  .comment-popover {
    position: absolute;
    z-index: 200;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 10px;
    width: 320px;
    box-shadow: 0 8px 30px rgba(0,0,0,0.2);
    display: none;
  }
  .comment-popover.visible { display: block; }
  .comment-popover textarea {
    width: 100%;
    min-height: 60px;
    background: var(--bg);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 8px;
    font-size: 13px;
    font-family: inherit;
    resize: vertical;
  }
  .comment-popover .comment-actions {
    display: flex;
    justify-content: space-between;
    margin-top: 6px;
    gap: 6px;
  }
  .comment-popover .comment-actions button {
    padding: 4px 10px;
    border-radius: 6px;
    border: none;
    background: var(--tab-bg);
    color: var(--text);
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
    font-family: inherit;
  }
  .comment-popover .comment-actions button.save { background: var(--accent); color: #fff; }
  .comment-popover .comment-actions button:hover { opacity: 0.85; }
  .comment-popover .comment-preview {
    font-size: 12px;
    color: var(--text-tertiary);
    margin-bottom: 6px;
    font-style: italic;
    max-height: 40px;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* Kind chips */
  .kind-chips {
    display: flex;
    gap: 5px;
    flex-wrap: wrap;
    margin-bottom: 6px;
  }
  .kind-chip {
    font-size: 11px;
    padding: 2px 8px;
    border-radius: 10px;
    border: 1px solid var(--border);
    background: transparent;
    color: var(--text2);
    cursor: pointer;
    font-family: inherit;
    transition: all 0.15s;
  }
  .kind-chip:hover { background: var(--surface2); }
  .kind-chip.active {
    background: var(--accent);
    color: #fff;
    border-color: var(--accent);
  }
  .tags-row input {
    width: 100%;
    font-size: 12px;
    padding: 5px 8px;
    border-radius: 5px;
    border: 1px solid var(--border);
    background: var(--surface2);
    color: var(--text);
    font-family: inherit;
    margin-bottom: 6px;
    outline: none;
  }
  .tags-row input:focus { border-color: var(--accent); }

  /* Kind badge in highlights panel */
  .hl-kind-badge {
    font-size: 10px;
    padding: 1px 6px;
    border-radius: 8px;
    background: var(--surface2);
    color: var(--text2);
    margin-left: 6px;
  }

  /* Export panel */
  .export-panel {
    display: none;
    position: fixed;
    top: 0; right: 0; bottom: 0;
    width: 380px;
    background: var(--surface);
    border-left: 1px solid var(--border);
    z-index: 300;
    flex-direction: column;
    box-shadow: -4px 0 24px rgba(0,0,0,0.15);
  }
  .export-panel.visible { display: flex; }

  body.highlights-open .header,
  body.highlights-open .controls,
  body.highlights-open .conversation {
    margin-right: 380px;
  }
  .export-panel-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 14px 16px;
    border-bottom: 1px solid var(--border);
  }
  .export-panel-header h3 { font-size: 14px; font-weight: 600; letter-spacing: -0.01em; }
  .export-panel-header button {
    background: none; border: none; color: var(--text-tertiary); cursor: pointer; font-size: 16px;
    transition: color 0.1s;
  }
  .export-panel-header button:hover { color: var(--text); }
  .export-panel-body {
    flex: 1;
    overflow: auto;
    padding: 8px;
  }
  .hl-select-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 6px 12px;
    font-size: 12px;
    color: var(--text-muted);
    border-bottom: 1px solid var(--border);
    margin-bottom: 4px;
  }
  .hl-select-all {
    display: flex;
    align-items: center;
    gap: 6px;
    cursor: pointer;
    user-select: none;
  }
  .hl-select-count { font-size: 11px; }
  .hl-checkbox {
    cursor: pointer;
    accent-color: var(--accent);
  }
  .hl-item {
    padding: 8px 12px;
    border-radius: 6px;
    cursor: pointer;
    margin-bottom: 4px;
    border-left: 3px solid var(--accent);
    background: var(--bg);
    transition: background 0.1s, opacity 0.15s;
  }
  .hl-item.hl-deselected { opacity: 0.4; }
  .hl-item:hover { background: var(--tab-hover); }
  .hl-delete {
    background: none; border: none; color: var(--text-tertiary); cursor: pointer;
    font-size: 16px; line-height: 1; padding: 0 2px; opacity: 0;
    transition: opacity 0.1s, color 0.1s;
  }
  .hl-item:hover .hl-delete { opacity: 1; }
  .hl-delete:hover { color: var(--error-border); }
  .hl-item-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 2px;
  }
  .hl-item-role {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    color: var(--text-tertiary);
    letter-spacing: 0.04em;
  }
  .hl-item-time {
    font-size: 10px;
    color: var(--text-tertiary);
  }
  .hl-item-text {
    font-size: 13px;
    color: var(--text);
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    line-height: 1.45;
  }
  .hl-item-comment {
    font-size: 12px;
    color: var(--accent);
    margin-top: 4px;
    font-style: italic;
  }
  .hl-item-tags {
    display: flex;
    gap: 4px;
    flex-wrap: wrap;
    margin-top: 4px;
  }
  .hl-tag {
    font-size: 10px;
    padding: 1px 6px;
    border-radius: 6px;
    background: var(--surface2);
    color: var(--text2);
  }
  .hl-empty {
    text-align: center;
    color: var(--text-tertiary);
    font-size: 13px;
    padding: 30px 16px;
  }
  .export-panel-footer {
    padding: 10px 16px;
    border-top: 1px solid var(--border);
    display: flex;
    gap: 8px;
    justify-content: flex-end;
  }
  .export-panel-footer button {
    padding: 6px 14px;
    border-radius: 6px;
    border: none;
    background: var(--tab-bg);
    color: var(--text);
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    font-family: inherit;
    transition: all 0.1s;
  }
  .export-panel-footer button:hover { background: var(--tab-hover); }
  .export-panel-footer button.primary { background: var(--accent); color: #fff; }
  .export-panel-footer button.primary:hover { opacity: 0.85; }
  .export-panel-footer button.primary { background: var(--accent); color: #fff; }
  .export-panel-footer button.primary:hover { background: var(--accent-hover); }

  /* ── Live mode badge ── */
  .live-badge {
    background: #e53e3e;
    color: white;
    font-size: 11px;
    font-weight: 600;
    padding: 2px 8px;
    border-radius: 4px;
    letter-spacing: 0.05em;
    animation: live-pulse 2s ease-in-out infinite;
  }
  @keyframes live-pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.6; }
  }
  .ws-disconnected .live-badge {
    background: var(--text-tertiary);
    animation: none;
  }
`;
