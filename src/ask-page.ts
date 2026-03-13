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
    animation: answerIn 0.35s ease-out;
  }
  @keyframes answerIn {
    from { opacity: 0; transform: translateY(-6px); }
    to { opacity: 1; transform: translateY(0); }
  }
  .answer-header {
    font-size: 11px; font-weight: 600; text-transform: uppercase;
    letter-spacing: 0.05em; color: var(--text-muted); padding: 10px 16px 0;
    display: flex; align-items: center; gap: 8px;
  }
  .answer-header .answer-spinner {
    width: 12px; height: 12px; border: 2px solid var(--border);
    border-top-color: var(--accent); border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }
  .answer-body { padding: 8px 16px 14px; font-size: 14px; line-height: 1.65; }
  .answer-body p { margin-bottom: 8px; }
  .answer-body h1, .answer-body h2, .answer-body h3,
  .answer-body h4, .answer-body h5, .answer-body h6 {
    margin: 12px 0 4px; letter-spacing: -0.01em;
  }
  .answer-body li { margin-left: 20px; line-height: 1.55; }
  .answer-body ul, .answer-body ol { margin: 4px 0; padding: 0; }
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
  .answer-body a:not(.cite-badge) { color: var(--accent); text-decoration: none; }
  .answer-body a:not(.cite-badge):hover { text-decoration: underline; }

  /* Citation badges */
  .cite-badge {
    display: inline-flex; align-items: center; justify-content: center;
    min-width: 18px; height: 18px; padding: 0 4px;
    border-radius: 9px; background: var(--accent); color: #fff;
    font-size: 10px; font-weight: 700; text-decoration: none;
    vertical-align: super; margin: 0 1px; cursor: pointer;
    transition: opacity 0.15s, transform 0.15s;
    line-height: 1;
  }
  .cite-badge:hover { opacity: 0.85; transform: scale(1.1); }

  /* Error banner */
  .ask-error {
    background: var(--error-bg, rgba(255,100,100,0.1)); border: 1px solid var(--error-border, rgba(255,100,100,0.3));
    border-radius: 6px; padding: 10px 14px; margin: 16px 0;
    font-size: 13px; color: var(--text);
  }

  /* Timing */
  .ask-timing {
    font-size: 12px; color: var(--text-muted); margin: 12px 0 20px;
    animation: fadeIn 0.3s ease-out;
  }
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
  @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
  .elapsed { font-size: 12px; color: var(--text-tertiary); font-variant-numeric: tabular-nums; }

  /* Source blocks */
  .source-block {
    margin-bottom: 24px;
    opacity: 0; animation: slideIn 0.3s ease-out forwards;
  }
  @keyframes slideIn {
    from { opacity: 0; transform: translateY(10px); }
    to { opacity: 1; transform: translateY(0); }
  }
  .source-block + .source-block { border-top: 1px solid var(--border); padding-top: 24px; }
  .source-header {
    display: flex; align-items: center; gap: 8px;
    margin-bottom: 8px; flex-wrap: wrap;
  }
  .source-num {
    display: inline-flex; align-items: center; justify-content: center;
    width: 22px; height: 22px; border-radius: 50%;
    background: var(--accent); color: #fff;
    font-size: 11px; font-weight: 700; flex-shrink: 0;
  }
  .source-project { font-size: 13px; font-weight: 600; color: var(--user-label); }
  .source-title { font-size: 12px; color: var(--text-muted); font-weight: 400; }
  .source-link {
    font-size: 12px; font-family: 'SF Mono', 'Fira Code', monospace;
    color: var(--accent); text-decoration: none; margin-left: auto;
  }
  .source-link:hover { text-decoration: underline; }

  /* Source turns */
  .source-turns { display: flex; flex-direction: column; gap: 6px; }
  .source-turns .turn { margin: 0; font-size: 13px; cursor: pointer; transition: opacity 0.15s; }
  .source-turns .turn:hover { opacity: 0.8; }
  .source-turns .turn-header { padding: 6px 12px; }
  .source-turns .turn-body { padding: 2px 12px 10px; }
  .source-turns .role-label { font-size: 11px; }
  .source-turns .message-text { font-size: 13px; line-height: 1.55; }
  .source-turns .message-text p { margin-bottom: 4px; }
  .turn-link { text-decoration: none; color: inherit; display: block; }

  /* Highlight source on badge hover */
  .source-block.highlighted { box-shadow: 0 0 0 2px var(--accent); border-radius: 8px; padding: 12px; margin: -12px; margin-bottom: 12px; }

  /* Searching status */
  .search-status {
    display: flex; align-items: center; gap: 10px;
    font-size: 13px; color: var(--text-muted);
    margin: 20px 0 12px; animation: fadeIn 0.3s ease-out;
  }
  .search-status .mini-spinner {
    width: 14px; height: 14px; border: 2px solid var(--border);
    border-top-color: var(--accent); border-radius: 50%;
    animation: spin 0.8s linear infinite; flex-shrink: 0;
  }
`;

// ---------------------------------------------------------------------------
// Client-side streaming JS
// ---------------------------------------------------------------------------

function buildStreamingJs(query: string): string {
  return `
(function() {
  var q = ${JSON.stringify(query)};
  var t0 = Date.now();
  var answerArea = document.getElementById('answer-area');
  var sourcesArea = document.getElementById('sources-area');
  var statusArea = document.getElementById('status-area');
  var sourceMap = {}; // num -> {sessionId, matchTurnIndex}
  var answerText = '';
  var answerVisible = false;

  function esc(s) {
    return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  // Minimal markdown renderer for streaming
  function renderMd(text) {
    var blocks = [];
    var lines = text.split('\\n');
    var inCode = false, codeBuf = [], listTag = null;
    function flushList() { if (listTag) { blocks.push('</' + listTag + '>'); listTag = null; } }
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (line.trimStart().startsWith('\`\`\`')) {
        if (!inCode) { flushList(); inCode = true; codeBuf = []; }
        else { blocks.push('<pre><code>' + esc(codeBuf.join('\\n')) + '</code></pre>'); inCode = false; }
        continue;
      }
      if (inCode) { codeBuf.push(line); continue; }
      var trimmed = line.trim();
      if (!trimmed) { flushList(); continue; }
      var hm = trimmed.match(/^(#{1,6})\\s+(.*)/);
      if (hm) { flushList(); blocks.push('<h' + hm[1].length + '>' + inlineMd(hm[2]) + '</h' + hm[1].length + '>'); continue; }
      if (/^[-*]\\s+/.test(trimmed)) {
        if (listTag !== 'ul') { flushList(); blocks.push('<ul>'); listTag = 'ul'; }
        blocks.push('<li>' + inlineMd(trimmed.replace(/^[-*]\\s+/, '')) + '</li>'); continue;
      }
      if (/^\\d+\\.\\s+/.test(trimmed)) {
        if (listTag !== 'ol') { flushList(); blocks.push('<ol>'); listTag = 'ol'; }
        blocks.push('<li>' + inlineMd(trimmed.replace(/^\\d+\\.\\s+/, '')) + '</li>'); continue;
      }
      flushList();
      blocks.push('<p>' + inlineMd(trimmed) + '</p>');
    }
    flushList();
    if (inCode) blocks.push('<pre><code>' + esc(codeBuf.join('\\n')) + '</code></pre>');
    return blocks.join('\\n');
  }

  function inlineMd(s) {
    s = esc(s);
    s = s.replace(/\`([^\`]+)\`/g, '<code>$1</code>');
    s = s.replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>');
    s = s.replace(/\\*([^*]+)\\*/g, '<em>$1</em>');
    s = s.replace(/\\[([^\\]]+)\\]\\(([^)]+)\\)/g, '<a href="$2">$1</a>');
    return s;
  }

  // Replace [N] with citation badges
  function addCitations(html) {
    return html.replace(/\\[(\\d+)\\]/g, function(m, n) {
      var src = sourceMap[n];
      if (!src) return m;
      return '<a class="cite-badge" href="/c/' + src.sessionId + '#turn-' + src.matchTurnIndex + '" '
        + 'data-source="' + n + '" title="Source ' + n + ': ' + esc(src.project) + '" '
        + 'onmouseenter="highlightSource(' + n + ')" onmouseleave="unhighlightSource(' + n + ')" '
        + 'onclick="scrollToSource(event,' + n + ')">' + n + '</a>';
    });
  }

  function updateAnswer() {
    if (!answerText) return;
    if (!answerVisible) {
      answerArea.innerHTML = '<div class="answer-card"><div class="answer-header">Answer <div class="answer-spinner"></div></div><div class="answer-body" id="answer-body"></div></div>';
      answerVisible = true;
    }
    var body = document.getElementById('answer-body');
    if (body) body.innerHTML = addCitations(renderMd(answerText));
  }

  function renderSources(sources) {
    sourcesArea.innerHTML = '';
    var MAX_TEXT = 400;
    for (var i = 0; i < sources.length; i++) {
      var src = sources[i];
      sourceMap[src.num] = src;
      var el = document.createElement('div');
      el.className = 'source-block';
      el.id = 'source-' + src.num;
      el.style.animationDelay = (i * 60) + 'ms';

      var turnsHtml = '';
      var turns = src.turns.slice(0, 4);
      for (var j = 0; j < turns.length; j++) {
        var t = turns[j];
        var roleClass = t.role === 'human' ? 'user' : 'assistant';
        var roleLabel = t.role === 'human' ? 'YOU' : 'CLAUDE';
        var text = t.text || '';
        if (text.length > MAX_TEXT) text = text.slice(0, MAX_TEXT) + '...';
        var href = '/c/' + src.sessionId + '#turn-' + t.index;
        turnsHtml += '<a class="turn-link" href="' + href + '"><div class="turn ' + roleClass + '">'
          + '<div class="turn-header"><span class="role-label">' + roleLabel + '</span></div>'
          + '<div class="turn-body"><div class="message-text">' + renderMd(text) + '</div></div>'
          + '</div></a>';
      }

      var projName = src.project || 'unknown';
      var shortId = src.sessionId.slice(0, 8);
      var titleHtml = src.title ? ' <span class="source-title">' + esc(src.title) + '</span>' : '';

      el.innerHTML = '<div class="source-header">'
        + '<span class="source-num">' + src.num + '</span>'
        + '<span class="source-project">' + esc(projName) + '</span>' + titleHtml
        + '<a class="source-link" href="/c/' + src.sessionId + '#turn-' + src.matchTurnIndex + '">' + shortId + '&hellip; &rarr;</a>'
        + '</div>'
        + '<div class="source-turns">' + turnsHtml + '</div>';

      sourcesArea.appendChild(el);
    }
  }

  function showTiming(timing) {
    var parts = [];
    if (timing.ftsMs) parts.push('FTS ' + timing.ftsMs + 'ms');
    if (timing.vectorMs) parts.push('Vector ' + timing.vectorMs + 'ms');
    if (timing.claudeMs) parts.push('Claude ' + (timing.claudeMs / 1000).toFixed(1) + 's');
    var count = Object.keys(sourceMap).length;
    statusArea.innerHTML = '<div class="ask-timing">'
      + count + ' source' + (count !== 1 ? 's' : '') + ' in ' + (timing.totalMs / 1000).toFixed(1) + 's'
      + (parts.length ? ' <span class="timing-detail">(' + parts.join(', ') + ')</span>' : '')
      + '</div>';
  }

  // Remove spinner from answer header when done
  function finishAnswer() {
    var hdr = answerArea.querySelector('.answer-header');
    if (hdr) {
      var spinner = hdr.querySelector('.answer-spinner');
      if (spinner) spinner.remove();
    }
  }

  // Stream via NDJSON
  function doStream(query) {
    statusArea.innerHTML = '<div class="search-status"><div class="mini-spinner"></div>Searching...</div>';
    answerArea.innerHTML = '';
    sourcesArea.innerHTML = '';
    answerText = '';
    answerVisible = false;
    sourceMap = {};

    fetch('/api/ask-stream', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({query: query})
    }).then(function(resp) {
      var reader = resp.body.getReader();
      var decoder = new TextDecoder();
      var buffer = '';
      var renderTimer = null;

      function scheduleRender() {
        if (renderTimer) return;
        renderTimer = setTimeout(function() { renderTimer = null; updateAnswer(); }, 80);
      }

      function pump() {
        return reader.read().then(function(result) {
          if (result.done) {
            // Process any remaining buffer
            if (buffer.trim()) processLine(buffer);
            if (renderTimer) { clearTimeout(renderTimer); renderTimer = null; }
            updateAnswer();
            finishAnswer();
            return;
          }
          buffer += decoder.decode(result.value, {stream: true});
          var lines = buffer.split('\\n');
          buffer = lines.pop() || '';
          for (var i = 0; i < lines.length; i++) {
            if (lines[i].trim()) processLine(lines[i]);
          }
          return pump();
        });
      }

      function processLine(line) {
        try {
          var event = JSON.parse(line);
          if (event.type === 'sources') {
            renderSources(event.sources);
            var searchTime = (event.timing.ftsMs || 0) + (event.timing.vectorMs || 0);
            statusArea.innerHTML = '<div class="search-status"><div class="mini-spinner"></div>Found '
              + event.sources.length + ' source' + (event.sources.length !== 1 ? 's' : '')
              + ' in ' + searchTime + 'ms — generating answer...</div>';
          } else if (event.type === 'chunk') {
            answerText += event.text;
            scheduleRender();
          } else if (event.type === 'done') {
            showTiming(event.timing);
          } else if (event.type === 'error') {
            statusArea.innerHTML += '<div class="ask-error">' + esc(event.message) + '</div>';
          }
        } catch(e) { /* ignore parse errors on partial lines */ }
      }

      return pump();
    }).catch(function(err) {
      statusArea.innerHTML = '<div class="ask-error">Request failed: ' + esc(err.message) + '</div>';
    });
  }

  // Source highlight on badge hover
  window.highlightSource = function(n) {
    var el = document.getElementById('source-' + n);
    if (el) el.classList.add('highlighted');
  };
  window.unhighlightSource = function(n) {
    var el = document.getElementById('source-' + n);
    if (el) el.classList.remove('highlighted');
  };
  window.scrollToSource = function(e, n) {
    e.preventDefault();
    var el = document.getElementById('source-' + n);
    if (el) el.scrollIntoView({behavior: 'smooth', block: 'center'});
  };

  // Initial stream
  doStream(q);

  // Handle new searches
  document.querySelector('.ask-search-form').addEventListener('submit', function(e) {
    e.preventDefault();
    var newQ = document.querySelector('.ask-search-input').value.trim();
    if (!newQ) return;
    history.pushState(null, '', '/ask?q=' + encodeURIComponent(newQ));
    document.title = 'Ask — ' + newQ + ' — Gloss';
    doStream(newQ);
  });
})();
`;
}

// ---------------------------------------------------------------------------
// Page builders
// ---------------------------------------------------------------------------

/**
 * Streaming loading page — returned instantly by GET /ask.
 * Uses NDJSON streaming: sources appear first, then answer streams in.
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
<div class="ask-page">
  <div id="answer-area"></div>
  <div id="status-area"></div>
  <div id="sources-area"></div>
</div>
<script>${buildStreamingJs(query)}</script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Server-rendered results (used by /api/ask-html fallback)
// ---------------------------------------------------------------------------

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
    if (line.trimStart().startsWith("```")) {
      if (!inCode) { flushList(); inCode = true; codeBuf = []; }
      else { out.push(`<pre><code>${escape(codeBuf.join("\n"))}</code></pre>`); inCode = false; }
      continue;
    }
    if (inCode) { codeBuf.push(line); continue; }
    const trimmed = line.trim();
    if (!trimmed) { flushList(); continue; }
    const hMatch = trimmed.match(/^(#{1,6})\s+(.*)/);
    if (hMatch) { flushList(); out.push(`<h${hMatch[1].length}>${renderMarkdownInline(hMatch[2])}</h${hMatch[1].length}>`); continue; }
    if (/^[-*]\s+/.test(trimmed)) {
      if (listTag !== "ul") { flushList(); out.push("<ul>"); listTag = "ul"; }
      out.push(`<li>${renderMarkdownInline(trimmed.replace(/^[-*]\s+/, ""))}</li>`); continue;
    }
    if (/^\d+\.\s+/.test(trimmed)) {
      if (listTag !== "ol") { flushList(); out.push("<ol>"); listTag = "ol"; }
      out.push(`<li>${renderMarkdownInline(trimmed.replace(/^\d+\.\s+/, ""))}</li>`); continue;
    }
    flushList();
    out.push(`<p>${renderMarkdownInline(trimmed)}</p>`);
  }

  flushList();
  if (inCode) out.push(`<pre><code>${escape(codeBuf.join("\n"))}</code></pre>`);
  return out.join("\n");
}

/** Replace [N] citation markers with badge HTML */
function addCitationBadges(html: string, sources: AskPageData["sources"]): string {
  return html.replace(/\[(\d+)\]/g, (m, n) => {
    const idx = parseInt(n, 10) - 1;
    if (idx < 0 || idx >= sources.length) return m;
    const src = sources[idx];
    const project = (src.project || "unknown").split("/").pop() || src.project;
    return `<a class="cite-badge" href="/c/${src.sessionId}#turn-${src.matchTurnIndex}" title="Source ${n}: ${escape(project)}">${n}</a>`;
  });
}

/**
 * Render just the results HTML fragment (answer + timing + sources).
 * Used by the /api/ask-html endpoint.
 */
export function buildAskResultsHtml(data: AskPageData): string {
  const { answer, sources, timing, error } = data;

  const answerRendered = answer ? addCitationBadges(renderAnswerMarkdown(answer), sources) : "";

  const answerHtml = answerRendered
    ? `<div class="answer-card">
        <div class="answer-header">Answer</div>
        <div class="answer-body">${answerRendered}</div>
      </div>`
    : "";

  const errorHtml = error ? `<div class="ask-error">${escape(error)}</div>` : "";

  const sessionCount = sources.length;
  const timingParts: string[] = [];
  if (timing.ftsMs) timingParts.push(`FTS ${timing.ftsMs}ms`);
  if (timing.vectorMs) timingParts.push(`Vector ${timing.vectorMs}ms`);
  if (timing.claudeMs) timingParts.push(`Claude ${(timing.claudeMs / 1000).toFixed(1)}s`);
  const timingHtml = `<div class="ask-timing">${sessionCount} source${sessionCount !== 1 ? "s" : ""} in ${(timing.totalMs / 1000).toFixed(1)}s`
    + (timingParts.length ? ` <span class="timing-detail">(${timingParts.join(", ")})</span>` : "")
    + `</div>`;

  const MAX_SOURCE_TEXT = 400;

  const sourcesHtml = sources.map((source, i) => {
    const num = i + 1;
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
        const snippet = text.length > MAX_SOURCE_TEXT ? text.slice(0, MAX_SOURCE_TEXT) + "..." : text;
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

    const projectRaw = source.project || "unknown";
    const projectName = projectRaw.split("/").pop() || projectRaw;
    const titleDisplay = source.title ? ` <span class="source-title">${escape(source.title)}</span>` : "";
    const shortId = source.sessionId.slice(0, 8);

    return `<div class="source-block" id="source-${num}" style="animation-delay:${i * 60}ms">
      <div class="source-header">
        <span class="source-num">${num}</span>
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
</body>
</html>`;
}
