import { CSS_STYLES } from "./css.js";
import { buildClientJs } from "./client-js.js";

export interface HtmlPageParams {
  title: string;
  metaHtml: string;
  conversationHtml: string;
  tocHtml: string;
  sessionId: string;
  jsonlPath: string;
  metaComment: string;
  conversationDataJson: string;
  bakedAnnotationsJson: string;
  extraScript?: string;
}

export function safeForScript(s: string): string {
  return s.replace(/<\//g, "<\\/");
}

export function buildHtmlPage(params: HtmlPageParams): string {
  const clientJs = buildClientJs(params.sessionId, params.jsonlPath);

  return `<!DOCTYPE html>
<html lang="en">
${params.metaComment}
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${params.title}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
${CSS_STYLES}
</style>
</head>
<body class="hide-tools hide-thinking hide-tagging">
<div class="header">
  <div class="header-left">
    <h1>${params.title}</h1>
    <div class="meta">
      ${params.metaHtml}
    </div>
  </div>
  <button id="theme-toggle" onclick="cycleTheme()" title="Toggle dark/light mode">&#9790;</button>
</div>
<div class="controls">
  <div class="controls-left">
    <button class="toc-toggle" onclick="toggleToc()" title="Table of Contents">&#9776; TOC</button>
  </div>
  <div class="controls-right">
    <button id="btn-highlight" onclick="annotate()" disabled title="Select text then press h, or click this button">Highlight</button>
    <button id="btn-export" onclick="toggleExport()">Highlights</button>
    <span class="count" id="annotation-count"></span>
    <span style="border-left: 1px solid var(--border); height: 16px;"></span>
    <div class="settings-menu">
      <button class="settings-toggle" onclick="this.parentElement.classList.toggle('open')" title="Display settings">&#9881;</button>
      <div class="settings-dropdown">
        <label><input type="checkbox" id="toggle-tools" onchange="document.body.classList.toggle('hide-tools', !this.checked)"> Show tools</label>
        <label><input type="checkbox" id="toggle-thinking" onchange="document.body.classList.toggle('hide-thinking', !this.checked)"> Show thinking</label>
        <label><input type="checkbox" id="toggle-tagging" onchange="document.body.classList.toggle('hide-tagging', !this.checked)"> Tags &amp; kinds</label>
      </div>
    </div>
  </div>
</div>

<div class="toc-panel" id="toc-panel">
  <div class="toc-panel-header">
    <h3>Table of Contents</h3>
    <button onclick="toggleToc()">&#10005;</button>
  </div>
  <div class="toc-filter">
    <button class="active" onclick="filterToc('all', this)">All</button>
    <button onclick="filterToc('user', this)">You</button>
    <button onclick="filterToc('assistant', this)">Claude</button>
  </div>
  <div class="toc-body" id="toc-body">
    ${params.tocHtml}
  </div>
</div>
<div class="conversation">
${params.conversationHtml}
</div>

<div class="comment-popover" id="comment-popover">
  <div class="comment-preview" id="comment-preview"></div>
  <div class="kind-chips" id="kind-chips"></div>
  <div class="tags-row">
    <input type="text" id="tags-input" placeholder="Tags (comma-separated)">
  </div>
  <textarea id="comment-input" placeholder="Add a comment..." rows="3"></textarea>
  <div class="comment-actions">
    <button onclick="removeAnnotation()">Remove</button>
    <div>
      <button onclick="closePopover()">Cancel</button>
      <button class="save" onclick="saveComment()">Save</button>
    </div>
  </div>
</div>

<div class="export-panel" id="export-panel">
  <div class="export-panel-header">
    <h3>Highlights</h3>
    <button onclick="toggleExport()">&#10005;</button>
  </div>
  <div class="export-panel-body">
    <div id="highlights-list"></div>
  </div>
  <div class="export-panel-footer">
    <button onclick="copyJsonlSlice(this)" title="Copy exchange-window JSONL to clipboard">Slice</button>
    <button onclick="copyMarkdownExport(this)">Markdown</button>
    <button onclick="copyXmlExport(this)" class="primary" title="Structured XML optimized for Claude context injection">For Claude</button>
    <button onclick="downloadAnnotations()" title="Download annotations JSON for backup/bake-in">&#8615;</button>
  </div>
</div>

<script type="application/json" id="conversation-data">${params.conversationDataJson}</script>
<script type="application/json" id="baked-annotations">${params.bakedAnnotationsJson}</script>

<script>
${clientJs}
</script>
${params.extraScript ? `<script>\n${params.extraScript}\n</script>` : ""}
</body>
</html>
`;
}
