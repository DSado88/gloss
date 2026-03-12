import { renderMarkdownInline, escape } from "./markdown.js";
import type { Turn } from "./types.js";

export interface AskPageData {
  query: string;
  answer: string;           // markdown from Claude
  sources: Array<{
    sessionId: string;
    project: string;
    title: string;
    matchTurnIndex: number;
    turns: Turn[];
    startTurnIndex: number;
  }>;
  timing: { ftsMs: number; vectorMs?: number; claudeMs: number; totalMs: number };
  error?: string;
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const ASK_CSS = `
  body { font-family: 'Inter', -apple-system, sans-serif; }
  .ask-page { max-width: 900px; margin: 0 auto; padding: 0 24px 60px; }
  .ask-header {
    background: var(--surface); border-bottom: 1px solid var(--border);
    padding: 16px 24px; display: flex; align-items: center; gap: 16px;
  }
  .ask-header .logo {
    font-size: 16px; font-weight: 600; color: var(--text-muted);
    text-decoration: none; flex-shrink: 0; letter-spacing: -0.03em;
  }
  .ask-header .logo:hover { color: var(--text); }
  .ask-search-form { flex: 1; display: flex; }
  .ask-search-input {
    flex: 1; height: 36px; padding: 0 12px;
    background: var(--bg); border: 1px solid var(--border);
    border-radius: 6px; color: var(--text);
    font-size: 14px; font-family: inherit; outline: none;
  }
  .ask-search-input:focus { border-color: var(--accent); }

  /* Answer card */
  .answer-card {
    background: var(--surface); border: 1px solid var(--border);
    border-radius: 8px; margin: 20px 0 16px; overflow: hidden;
  }
  .answer-header {
    font-size: 11px; font-weight: 600; text-transform: uppercase;
    letter-spacing: 0.05em; color: var(--text-muted); padding: 10px 16px 0;
  }
  .answer-body { padding: 8px 16px 14px; font-size: 14px; line-height: 1.65; }
  .answer-body p { margin-bottom: 8px; }
  .answer-body h1, .answer-body h2, .answer-body h3,
  .answer-body h4, .answer-body h5, .answer-body h6 {
    margin: 12px 0 4px; letter-spacing: -0.01em;
  }
  .answer-body li { margin-left: 20px; line-height: 1.55; }
  .answer-body ul { margin: 4px 0; padding: 0; }
  .answer-body hr { border: none; border-top: 1px solid var(--border); margin: 12px 0; }
  .answer-body code {
    background: var(--code-bg); padding: 2px 5px; border-radius: 3px;
    font-size: 12px; font-family: 'SF Mono', 'Fira Code', monospace;
    border: 1px solid var(--border);
  }
  .answer-body pre {
    background: var(--code-bg); padding: 14px; border-radius: 6px;
    overflow-x: auto; margin: 8px 0; font-size: 13px; line-height: 1.5;
    border: 1px solid var(--border);
  }
  .answer-body pre code { background: none; padding: 0; font-size: inherit; border: none; }
  .answer-body a { color: var(--accent); text-decoration: none; }
  .answer-body a:hover { text-decoration: underline; }

  /* Error banner */
  .ask-error {
    background: var(--error-bg); border: 1px solid var(--error-border);
    border-radius: 6px; padding: 10px 14px; margin: 16px 0;
    font-size: 13px; color: var(--text);
  }

  /* Timing */
  .ask-timing { font-size: 12px; color: var(--text-muted); margin: 12px 0 20px; }
  .timing-detail { color: var(--text-tertiary); }

  /* Loading state */
  .ask-loading {
    display: flex; flex-direction: column; align-items: center;
    gap: 16px; padding: 80px 0; color: var(--text-muted); font-size: 14px;
  }
  .spinner {
    width: 28px; height: 28px; border: 3px solid var(--border);
    border-top-color: var(--accent); border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  .elapsed { font-size: 12px; color: var(--text-tertiary); font-variant-numeric: tabular-nums; }

  /* Source blocks */
  .source-block { margin-bottom: 24px; }
  .source-block + .source-block { border-top: 1px solid var(--border); padding-top: 24px; }
  .source-header {
    display: flex; align-items: baseline; gap: 8px;
    margin-bottom: 8px; flex-wrap: wrap;
  }
  .source-project { font-size: 13px; font-weight: 600; color: var(--user-label); }
  .source-title { font-size: 12px; color: var(--text-muted); font-weight: 400; }
  .source-link {
    font-size: 12px; font-family: 'SF Mono', 'Fira Code', monospace;
    color: var(--accent); text-decoration: none; margin-left: auto;
  }
  .source-link:hover { text-decoration: underline; }

  /* Source turns — reuse main conversation turn styles */
  .source-turns { display: flex; flex-direction: column; gap: 6px; }
  .source-turns .turn { margin: 0; font-size: 13px; cursor: pointer; transition: opacity 0.15s; }
  .source-turns .turn:hover { opacity: 0.8; }
  .source-turns .turn-header { padding: 6px 12px; }
  .source-turns .turn-body { padding: 2px 12px 10px; }
  .source-turns .role-label { font-size: 11px; }
  .source-turns .message-text { font-size: 13px; line-height: 1.55; }
  .source-turns .message-text p { margin-bottom: 4px; }
  .turn-link { text-decoration: none; color: inherit; display: block; }
`;

/**
 * Lightweight loading page returned instantly by GET /ask.
 * Fetches results from POST /api/ask and swaps content in.
 */
export function buildAskLoadingPage(query: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Ask — ${escapeAttr(query)} — Gloss</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/assets/style.css">
<style>${ASK_CSS}</style>
</head>
<body>
<div class="ask-header">
  <a href="/" class="logo">Gloss</a>
  <form class="ask-search-form" action="/ask" method="get">
    <input class="ask-search-input" type="text" name="q" value="${escapeAttr(query)}" placeholder="Ask your conversations..." autofocus>
  </form>
</div>
<div class="ask-page" id="results">
  <div class="ask-loading">
    <div class="spinner"></div>
    <div>Searching with AI...</div>
    <div class="elapsed"></div>
  </div>
</div>
<script>
(function() {
  var q = ${JSON.stringify(query)};
  var t0 = Date.now();
  var el = document.querySelector('.elapsed');
  var iv = setInterval(function() { el.textContent = Math.round((Date.now()-t0)/1000)+'s'; }, 1000);

  fetch('/api/ask-html', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({query: q})
  })
  .then(function(r) { return r.text(); })
  .then(function(html) {
    clearInterval(iv);
    document.getElementById('results').innerHTML = html;
  })
  .catch(function(err) {
    clearInterval(iv);
    document.getElementById('results').innerHTML = '<div style="padding:40px;text-align:center;color:var(--text-muted)">Request failed: '+err.message+'</div>';
  });

  // Handle new searches from the form
  document.querySelector('.ask-search-form').addEventListener('submit', function(e) {
    e.preventDefault();
    var newQ = document.querySelector('.ask-search-input').value.trim();
    if (!newQ) return;
    window.location.href = '/ask?q=' + encodeURIComponent(newQ);
  });
})();
</script>
</body>
</html>`;
}

/** Render Claude's answer markdown to HTML, line-by-line. */
function renderAnswerMarkdown(md: string): string {
  const lines = md.split("\n");
  const out: string[] = [];
  let inCode = false;
  let codeBuf: string[] = [];
  let listTag: "ul" | "ol" | null = null;

  function flushList() {
    if (listTag) { out.push(`</${listTag}>`); listTag = null; }
  }

  for (const line of lines) {
    // Code fences
    if (line.trimStart().startsWith("```")) {
      if (!inCode) {
        flushList();
        inCode = true;
        codeBuf = [];
      } else {
        out.push(`<pre><code>${escape(codeBuf.join("\n"))}</code></pre>`);
        inCode = false;
      }
      continue;
    }
    if (inCode) { codeBuf.push(line); continue; }

    const trimmed = line.trim();

    // Blank line
    if (!trimmed) { flushList(); continue; }

    // Heading
    const hMatch = trimmed.match(/^(#{1,6})\s+(.*)/);
    if (hMatch) {
      flushList();
      const level = hMatch[1].length;
      out.push(`<h${level}>${renderMarkdownInline(hMatch[2])}</h${level}>`);
      continue;
    }

    // Unordered list item
    if (/^[-*]\s+/.test(trimmed)) {
      if (listTag !== "ul") { flushList(); out.push("<ul>"); listTag = "ul"; }
      out.push(`<li>${renderMarkdownInline(trimmed.replace(/^[-*]\s+/, ""))}</li>`);
      continue;
    }

    // Ordered list item
    if (/^\d+\.\s+/.test(trimmed)) {
      if (listTag !== "ol") { flushList(); out.push("<ol>"); listTag = "ol"; }
      out.push(`<li>${renderMarkdownInline(trimmed.replace(/^\d+\.\s+/, ""))}</li>`);
      continue;
    }

    // Paragraph text
    flushList();
    out.push(`<p>${renderMarkdownInline(trimmed)}</p>`);
  }

  flushList();
  if (inCode) out.push(`<pre><code>${escape(codeBuf.join("\n"))}</code></pre>`);
  return out.join("\n");
}

/**
 * Render just the results HTML fragment (answer + timing + sources).
 * Used by both the full page and the /api/ask-html endpoint.
 */
export function buildAskResultsHtml(data: AskPageData): string {
  const { answer, sources, timing, error } = data;

  const answerRendered = answer ? renderAnswerMarkdown(answer) : "";

  const answerHtml = answerRendered
    ? `<div class="answer-card">
        <div class="answer-header">Answer</div>
        <div class="answer-body">${answerRendered}</div>
      </div>`
    : "";

  // Error banner (Claude failed, but we still show FTS results)
  const errorHtml = error
    ? `<div class="ask-error">${escape(error)}</div>`
    : "";

  // Timing line
  const sessionCount = sources.length;
  const timingParts: string[] = [];
  if (timing.ftsMs) timingParts.push(`FTS ${timing.ftsMs}ms`);
  if (timing.vectorMs) timingParts.push(`Vector ${timing.vectorMs}ms`);
  if (timing.claudeMs) timingParts.push(`Claude ${timing.claudeMs}ms`);
  const timingHtml = `<div class="ask-timing">Searched ${sessionCount} session${sessionCount !== 1 ? "s" : ""} in ${timing.totalMs}ms`
    + (timingParts.length ? ` <span class="timing-detail">(${timingParts.join(", ")})</span>` : "")
    + `</div>`;

  // Render each source as a mini-conversation with the same turn styling as chat view
  const MAX_SOURCE_TEXT = 400;

  const sourcesHtml = sources.map((source) => {
    const turnCards = source.turns
      .map((turn, j) => {
        if (turn.role !== "human" && turn.role !== "assistant") return "";
        const turnIndex = source.startTurnIndex + j;
        const roleClass = turn.role === "human" ? "user" : "assistant";
        const roleLabel = turn.role === "human" ? "YOU" : "CLAUDE";
        let text = "";
        for (const block of turn.blocks) {
          if (block.type === "text") text += block.text + "\n";
        }
        text = text.trim();
        if (!text) return "";
        const snippet = text.length > MAX_SOURCE_TEXT
          ? text.slice(0, MAX_SOURCE_TEXT) + "..."
          : text;
        const rendered = renderAnswerMarkdown(snippet);
        const href = `/c/${source.sessionId}#turn-${turnIndex}`;
        return `<a class="turn-link" href="${href}"><div class="turn ${roleClass}">
          <div class="turn-header"><span class="role-label">${roleLabel}</span></div>
          <div class="turn-body"><div class="message-text">${rendered}</div></div>
        </div></a>`;
      })
      .filter(Boolean)
      .slice(0, 4)
      .join("\n");

    // Shorten project path: "/Users/david/Documents/Programs/foo" → "foo"
    const projectRaw = source.project || "unknown";
    const projectName = projectRaw.split("/").pop() || projectRaw;
    const titleDisplay = source.title ? ` <span class="source-title">${escape(source.title)}</span>` : "";
    const shortId = source.sessionId.slice(0, 8);

    return `<div class="source-block">
      <div class="source-header">
        <span class="source-project">${escape(projectName)}</span>${titleDisplay}
        <a class="source-link" href="/c/${source.sessionId}#turn-${source.matchTurnIndex}">${shortId}&hellip; &rarr;</a>
      </div>
      <div class="source-turns">${turnCards}</div>
    </div>`;
  }).join("\n");

  return `${errorHtml}
${answerHtml}
${timingHtml}
${sourcesHtml}`;
}

export function buildAskPage(data: AskPageData): string {
  const { query } = data;
  const resultsHtml = buildAskResultsHtml(data);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Ask — ${escapeAttr(query)} — Gloss</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/assets/style.css">
<style>${ASK_CSS}</style>
</head>
<body class="hide-tools hide-thinking hide-tagging">
<div class="ask-header">
  <a href="/" class="logo">Gloss</a>
  <form class="ask-search-form" action="/ask" method="get">
    <input class="ask-search-input" type="text" name="q" value="${escapeAttr(query)}" placeholder="Ask your conversations..." autofocus>
  </form>
</div>
<div class="ask-page" id="results">
  ${resultsHtml}
</div>
<script>
(function() {
  var form = document.querySelector('.ask-search-form');
  var page = document.getElementById('results');
  form.addEventListener('submit', function(e) {
    e.preventDefault();
    var q = form.querySelector('input[name=q]').value.trim();
    if (!q) return;
    history.pushState(null, '', '/ask?q=' + encodeURIComponent(q));
    document.title = 'Ask — ' + q + ' — Gloss';
    page.innerHTML = '<div class="ask-loading"><div class="spinner"></div><div>Searching with AI...</div><div class="elapsed"></div></div>';
    var t0 = Date.now();
    var el = page.querySelector('.elapsed');
    var iv = setInterval(function() { el.textContent = Math.round((Date.now()-t0)/1000)+'s'; }, 1000);
    fetch('/api/ask-html', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({query: q})
    })
    .then(function(r) { return r.text(); })
    .then(function(html) { clearInterval(iv); page.innerHTML = html; })
    .catch(function(err) { clearInterval(iv); page.innerHTML = '<div class="ask-error">Failed: '+err.message+'</div>'; });
  });
})();
</script>
</body>
</html>`;
}
