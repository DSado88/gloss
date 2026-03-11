/**
 * Client-side JavaScript for the conversation viewer HTML page.
 *
 * This is injected into the generated HTML and runs in the browser.
 * It handles: TOC, annotations, highlights, export, popover, tagging, etc.
 *
 * The function takes sessionId and jsonlPath as parameters so they can be
 * interpolated into the script at build time.
 */
export function buildClientJs(sessionId: string, jsonlPath: string): string {
  return `
// ── TOC ──
function toggleToc() {
  document.getElementById('toc-panel').classList.toggle('visible');
  document.body.classList.toggle('toc-open');
}
function closeToc() {
  // Keep TOC open — user can close manually
}
function filterToc(filter, btn) {
  // Update active button
  document.querySelectorAll('.toc-filter button').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  // Show/hide items
  document.querySelectorAll('.toc-item').forEach(item => {
    if (filter === 'all') {
      item.style.display = '';
    } else if (filter === 'user') {
      item.style.display = item.classList.contains('toc-user') ? '' : 'none';
    } else if (filter === 'assistant') {
      item.style.display = item.classList.contains('toc-assistant') ? '' : 'none';
    }
  });
}

// ── Conversation data (for trigger capture and JSONL slice export) ──
const convoData = JSON.parse(document.getElementById('conversation-data')?.textContent || '[]');

// ── Annotation state ──
const bakedAnnotations = JSON.parse(document.getElementById('baked-annotations')?.textContent || '{}');
const storedAnnotations = JSON.parse(localStorage.getItem('annotations_${sessionId}') || '{}');
const annotations = Object.assign({}, bakedAnnotations, storedAnnotations);
let activeAnnotationId = null;
let savedRange = null;

// Restore saved annotations on load
document.addEventListener('DOMContentLoaded', () => {
  restoreAnnotations();
  updateCount();
  document.addEventListener('selectionchange', onSelectionChange);
});

// Keyboard shortcut: Cmd/Ctrl+Shift+H
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'h') {
    e.preventDefault();
    annotate();
  }
});

function genId() {
  return 'a' + Math.random().toString(36).slice(2, 10);
}

function onSelectionChange() {
  const sel = window.getSelection();
  const hasSelection = sel && !sel.isCollapsed && sel.toString().trim();
  const btn = document.getElementById('btn-highlight');
  btn.disabled = !hasSelection;
  if (hasSelection) {
    savedRange = sel.getRangeAt(0).cloneRange();
  }
}

// ── Walk text nodes in a range and wrap each in <mark> ──
function getTextNodesInRange(range) {
  const nodes = [];
  // Clamp range to ensure we have proper boundaries
  const ancestor = range.commonAncestorContainer.nodeType === 1
    ? range.commonAncestorContainer
    : range.commonAncestorContainer.parentElement;
  const walker = document.createTreeWalker(ancestor, NodeFilter.SHOW_TEXT, null);
  let node;
  while ((node = walker.nextNode())) {
    // Check if this text node is within the range
    if (range.comparePoint(node, 0) > 0) break; // node is after range end
    if (range.comparePoint(node, node.textContent.length) < 0) continue; // node is before range start
    if (node.textContent.trim()) nodes.push(node);
  }
  return nodes;
}

function wrapTextNodes(range, id) {
  const textNodes = getTextNodesInRange(range);
  if (!textNodes.length) return;
  const first = textNodes[0];
  const last = textNodes[textNodes.length - 1];

  textNodes.forEach((textNode) => {
    let startOffset = 0;
    let endOffset = textNode.textContent.length;

    // First node: start from selection start (only if startContainer is this text node)
    if (textNode === first && range.startContainer === textNode) startOffset = range.startOffset;
    // Last node: end at selection end (only if endContainer is this text node)
    if (textNode === last && range.endContainer === textNode) endOffset = range.endOffset;

    // Split if partial
    if (startOffset > 0) {
      textNode = textNode.splitText(startOffset);
      endOffset -= startOffset;
    }
    if (endOffset < textNode.textContent.length) {
      textNode.splitText(endOffset);
    }

    const mark = document.createElement('mark');
    mark.setAttribute('data-annotation-id', id);
    mark.onclick = () => openPopover(id);
    textNode.parentNode.insertBefore(mark, textNode);
    mark.appendChild(textNode);
  });
}

// ── Compute trigger context ──
function computeTrigger(ann) {
  if (ann.trigger) return ann.trigger;
  const ti = ann.turnIndex ?? -1;
  if (ti < 0 || !convoData.length) return '';
  if (ann.role === 'Claude' && ti > 0) {
    for (let i = ti - 1; i >= 0; i--) {
      if (convoData[i].role === 'user' && convoData[i].text.length) {
        return 'User: "' + convoData[i].text[0].replace(/\\n/g, ' ').slice(0, 150) + '"';
      }
    }
  } else if (ann.role === 'You' && ti < convoData.length - 1) {
    for (let i = ti + 1; i < convoData.length; i++) {
      if (convoData[i].role === 'assistant' && convoData[i].text.length) {
        return 'Claude: "' + convoData[i].text[0].replace(/\\n/g, ' ').slice(0, 150) + '"';
      }
    }
  }
  return '';
}

// ── Highlight selected text ──
function annotate() {
  // Use saved range (survives button click clearing the selection)
  const sel = window.getSelection();
  let range;
  if (sel && !sel.isCollapsed && sel.toString().trim()) {
    range = sel.getRangeAt(0);
  } else if (savedRange) {
    range = savedRange;
  } else {
    return;
  }

  const convo = document.querySelector('.conversation');
  if (!convo.contains(range.commonAncestorContainer)) return;

  const id = genId();
  const text = range.toString().trim();

  // Find the turn context
  const turnEl = range.startContainer.parentElement?.closest('.turn');
  const role = turnEl?.querySelector('.role-label')?.textContent || '?';
  const time = turnEl?.querySelector('.timestamp')?.textContent || '';
  const turnId = turnEl?.id || '';
  const turnIndex = turnId ? parseInt(turnId.replace('turn-', ''), 10) : -1;

  // Find block index and character offsets
  const startNode = range.startContainer.nodeType === 3 ? range.startContainer : range.startContainer.childNodes[range.startOffset] || range.startContainer;
  const msgText = startNode.parentElement?.closest('.message-text[data-block-index]');
  const blockIndex = msgText ? parseInt(msgText.getAttribute('data-block-index'), 10) : 0;

  // Compute char offsets within the message-text element
  let charStart = -1, charEnd = -1;
  if (msgText) {
    const tw = document.createTreeWalker(msgText, NodeFilter.SHOW_TEXT, null);
    let offset = 0, n;
    while ((n = tw.nextNode())) {
      if (n === range.startContainer) { charStart = offset + range.startOffset; }
      if (n === range.endContainer) { charEnd = offset + range.endOffset; break; }
      offset += n.textContent.length;
    }
  }

  // Compute prefix/suffix from convoData
  let prefix = '', suffix = '';
  if (turnIndex >= 0 && convoData[turnIndex] && convoData[turnIndex].text[blockIndex]) {
    const blockText = convoData[turnIndex].text[blockIndex];
    // Use indexOf on rendered text as fallback for offset mapping
    const idx = blockText.indexOf(text.slice(0, 60));
    if (idx >= 0) {
      prefix = blockText.slice(Math.max(0, idx - 50), idx);
      suffix = blockText.slice(idx + text.length, idx + text.length + 50);
    }
  }

  // Compute trigger (preceding user msg for Claude, next assistant for user)
  let trigger = '';
  if (turnIndex >= 0 && convoData.length) {
    if (role === 'Claude' && turnIndex > 0) {
      for (let i = turnIndex - 1; i >= 0; i--) {
        if (convoData[i].role === 'user' && convoData[i].text.length) {
          trigger = 'User: "' + convoData[i].text[0].replace(/\\n/g, ' ').slice(0, 150) + '"';
          break;
        }
      }
    } else if (role === 'You' && turnIndex < convoData.length - 1) {
      for (let i = turnIndex + 1; i < convoData.length; i++) {
        if (convoData[i].role === 'assistant' && convoData[i].text.length) {
          trigger = 'Claude: "' + convoData[i].text[0].replace(/\\n/g, ' ').slice(0, 150) + '"';
          break;
        }
      }
    }
  }

  // Wrap all text nodes in the range
  wrapTextNodes(range, id);

  savedRange = null;
  if (sel) sel.removeAllRanges();

  // Store annotation
  annotations[id] = {
    text: text,
    comment: '',
    role: role,
    time: time,
    turnId: turnId,
    turnIndex: turnIndex,
    blockIndex: blockIndex,
    charStart: charStart,
    charEnd: charEnd,
    prefix: prefix,
    suffix: suffix,
    trigger: trigger,
    kind: 'highlight',
    tags: [],
    created: new Date().toISOString()
  };
  save();
  updateCount();

  // Refresh highlights panel if open
  const panel = document.getElementById('export-panel');
  if (panel.classList.contains('visible')) buildExport();

  // Open popover to add comment
  openPopover(id);
}

// ── Kind chips ──
const ANNOTATION_KINDS = [
  { key: 'highlight', label: 'Highlight' },
  { key: 'decision', label: 'Decision' },
  { key: 'bug', label: 'Bug' },
  { key: 'constraint', label: 'Constraint' },
  { key: 'todo', label: 'TODO' },
  { key: 'question', label: 'Question' },
  { key: 'insight', label: 'Insight' },
];

function renderKindChips(selectedKind) {
  return ANNOTATION_KINDS.map(k =>
    \`<button class="kind-chip \${k.key === selectedKind ? 'active' : ''}" onclick="setKind('\${k.key}')">\${k.label}<\\/button>\`
  ).join('');
}

function setKind(kind) {
  if (!activeAnnotationId) return;
  annotations[activeAnnotationId].kind = kind;
  document.getElementById('kind-chips').innerHTML = renderKindChips(kind);
  save();
  const panel = document.getElementById('export-panel');
  if (panel.classList.contains('visible')) buildExport();
}

// ── Comment popover ──
function openPopover(id) {
  const mark = document.querySelector(\`mark[data-annotation-id="\${id}"]\`);
  if (!mark) return;

  // Deactivate previous, activate all marks for this annotation
  document.querySelectorAll('mark.active').forEach(m => m.classList.remove('active'));
  document.querySelectorAll(\`mark[data-annotation-id="\${id}"]\`).forEach(m => m.classList.add('active'));
  activeAnnotationId = id;

  const ann = annotations[id];
  const popover = document.getElementById('comment-popover');
  const preview = document.getElementById('comment-preview');
  const input = document.getElementById('comment-input');

  preview.textContent = '"' + (ann?.text || '').slice(0, 120) + '"';
  document.getElementById('kind-chips').innerHTML = renderKindChips(ann?.kind || 'highlight');
  document.getElementById('tags-input').value = (ann?.tags || []).join(', ');
  input.value = ann?.comment || '';

  // Position near the mark
  const rect = mark.getBoundingClientRect();
  const scrollY = window.scrollY;
  popover.style.top = (rect.bottom + scrollY + 8) + 'px';
  popover.style.left = Math.min(rect.left, window.innerWidth - 340) + 'px';
  popover.classList.add('visible');

  setTimeout(() => input.focus(), 50);
}

function closePopover() {
  document.getElementById('comment-popover').classList.remove('visible');
  document.querySelectorAll('mark.active').forEach(m => m.classList.remove('active'));
  activeAnnotationId = null;
}

function saveComment() {
  if (!activeAnnotationId) return;
  const input = document.getElementById('comment-input');
  annotations[activeAnnotationId].comment = input.value;
  const tagsStr = document.getElementById('tags-input').value;
  annotations[activeAnnotationId].tags = tagsStr.split(',').map(t => t.trim()).filter(Boolean);
  save();
  closePopover();
  const panel = document.getElementById('export-panel');
  if (panel.classList.contains('visible')) buildExport();
}

function removeAnnotation(targetId) {
  const id = targetId || activeAnnotationId;
  if (!id) return;
  // Remove all marks with this ID (cross-element highlights produce multiple)
  document.querySelectorAll(\`mark[data-annotation-id="\${id}"]\`).forEach(mark => {
    const parent = mark.parentNode;
    while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
    parent.removeChild(mark);
  });
  delete annotations[id];
  save();
  updateCount();
  closePopover();
  // Refresh highlights panel if open
  const panel = document.getElementById('export-panel');
  if (panel.classList.contains('visible')) buildExport();
}

// ── Persistence ──
function save() {
  localStorage.setItem('annotations_${sessionId}', JSON.stringify(annotations));
}

function restoreAnnotations() {
  // Migrate v1 → v2 schema (add defaults for missing fields)
  let migrated = false;
  for (const [id, ann] of Object.entries(annotations)) {
    if (ann.turnIndex === undefined) {
      ann.turnIndex = ann.turnId ? parseInt(ann.turnId.replace('turn-', ''), 10) : -1;
      migrated = true;
    }
    if (ann.blockIndex === undefined) { ann.blockIndex = 0; migrated = true; }
    if (ann.charStart === undefined) { ann.charStart = -1; migrated = true; }
    if (ann.charEnd === undefined) { ann.charEnd = -1; migrated = true; }
    if (ann.prefix === undefined) { ann.prefix = ''; migrated = true; }
    if (ann.suffix === undefined) { ann.suffix = ''; migrated = true; }
    if (ann.trigger === undefined) { ann.trigger = ''; migrated = true; }
    if (ann.kind === undefined) { ann.kind = 'highlight'; migrated = true; }
    if (ann.tags === undefined) { ann.tags = []; migrated = true; }
  }
  if (migrated) save();

  // Re-create <mark> elements from stored annotations
  for (const [id, ann] of Object.entries(annotations)) {
    if (document.querySelector(\`mark[data-annotation-id="\${id}"]\`)) continue;
    if (!ann.text) continue;

    // Tier 1: Precise match using block index + char offsets
    if (ann.charStart >= 0 && ann.turnId) {
      const turnEl = document.getElementById(ann.turnId);
      if (turnEl) {
        const msgText = turnEl.querySelector(\`.message-text[data-block-index="\${ann.blockIndex}"]\`);
        if (msgText && wrapByOffset(msgText, ann.charStart, ann.charEnd, id)) continue;
      }
    }

    // Tier 2/3: Text search in turn container (handles legacy + fuzzy)
    const container = ann.turnId
      ? document.getElementById(ann.turnId)
      : document.querySelector('.conversation');
    if (!container) continue;

    const textNodes = [];
    let totalLen = 0;
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null);
    let node;
    while ((node = walker.nextNode())) {
      textNodes.push({ node, offset: totalLen, len: node.textContent.length });
      totalLen += node.textContent.length;
    }

    const fullText = textNodes.map(t => t.node.textContent).join('');
    const idx = fullText.indexOf(ann.text);
    if (idx === -1) continue;

    const endIdx = idx + ann.text.length;
    const nodesToWrap = [];
    for (const t of textNodes) {
      const nodeStart = t.offset;
      const nodeEnd = t.offset + t.len;
      if (nodeEnd <= idx || nodeStart >= endIdx) continue;
      const wrapStart = Math.max(idx, nodeStart) - nodeStart;
      const wrapEnd = Math.min(endIdx, nodeEnd) - nodeStart;
      nodesToWrap.push({ node: t.node, start: wrapStart, end: wrapEnd });
    }

    for (let i = nodesToWrap.length - 1; i >= 0; i--) {
      const { node: tn, start: s, end: e } = nodesToWrap[i];
      let target = tn;
      if (s > 0) target = tn.splitText(s);
      if (e - s < target.textContent.length) target.splitText(e - s);
      const mark = document.createElement('mark');
      mark.setAttribute('data-annotation-id', id);
      mark.onclick = () => openPopover(id);
      target.parentNode.insertBefore(mark, target);
      mark.appendChild(target);
    }
  }
}

function wrapByOffset(container, charStart, charEnd, id) {
  // Wrap text at precise character offsets within a container element
  const textNodes = [];
  let totalLen = 0;
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null);
  let node;
  while ((node = walker.nextNode())) {
    textNodes.push({ node, offset: totalLen, len: node.textContent.length });
    totalLen += node.textContent.length;
  }
  if (charStart >= totalLen || charEnd > totalLen) return false;

  const nodesToWrap = [];
  for (const t of textNodes) {
    const nodeStart = t.offset;
    const nodeEnd = t.offset + t.len;
    if (nodeEnd <= charStart || nodeStart >= charEnd) continue;
    const wrapStart = Math.max(charStart, nodeStart) - nodeStart;
    const wrapEnd = Math.min(charEnd, nodeEnd) - nodeStart;
    nodesToWrap.push({ node: t.node, start: wrapStart, end: wrapEnd });
  }
  if (!nodesToWrap.length) return false;

  for (let i = nodesToWrap.length - 1; i >= 0; i--) {
    const { node: tn, start: s, end: e } = nodesToWrap[i];
    let target = tn;
    if (s > 0) target = tn.splitText(s);
    if (e - s < target.textContent.length) target.splitText(e - s);
    const mark = document.createElement('mark');
    mark.setAttribute('data-annotation-id', id);
    mark.onclick = () => openPopover(id);
    target.parentNode.insertBefore(mark, target);
    mark.appendChild(target);
  }
  return true;
}

function updateCount() {
  const n = Object.keys(annotations).length;
  document.getElementById('annotation-count').textContent = n ? n + ' annotation' + (n > 1 ? 's' : '') : '';
}

// Close popover on outside click
document.addEventListener('mousedown', (e) => {
  const popover = document.getElementById('comment-popover');
  if (popover.classList.contains('visible') && !popover.contains(e.target) && !e.target.closest('mark[data-annotation-id]')) {
    closePopover();
  }
});

// ── Export ──
function toggleExport() {
  const panel = document.getElementById('export-panel');
  const isVisible = panel.classList.toggle('visible');
  document.body.classList.toggle('highlights-open', isVisible);
  if (isVisible) buildExport();
}

function sortedAnnotationIds() {
  const ids = Object.keys(annotations);
  ids.sort((a, b) => {
    const ma = document.querySelector(\`mark[data-annotation-id="\${a}"]\`);
    const mb = document.querySelector(\`mark[data-annotation-id="\${b}"]\`);
    if (!ma || !mb) return 0;
    return (ma.getBoundingClientRect().top + window.scrollY) - (mb.getBoundingClientRect().top + window.scrollY);
  });
  return ids;
}

function buildExport() {
  const list = document.getElementById('highlights-list');
  const ids = sortedAnnotationIds();

  if (!ids.length) {
    list.innerHTML = '<div class="hl-empty">Select text and click Highlight to annotate<\\/div>';
    return;
  }

  list.innerHTML = ids.map(id => {
    const ann = annotations[id];
    const quote = (ann.text || '').replace(/\\n/g, ' ').slice(0, 200);
    const comment = ann.comment ? \`<div class="hl-item-comment">\${ann.comment}<\\/div>\` : '';
    const time = ann.time ? \`<span class="hl-item-time">\${ann.time}<\\/span>\` : '';
    const kindBadge = (ann.kind && ann.kind !== 'highlight') ? \`<span class="hl-kind-badge">\${ann.kind}<\\/span>\` : '';
    const tagsHtml = (ann.tags && ann.tags.length) ? \`<div class="hl-item-tags">\${ann.tags.map(t => \`<span class="hl-tag">\${t}<\\/span>\`).join('')}<\\/div>\` : '';
    return \`<div class="hl-item" onclick="scrollToHighlight('\${id}')" onmouseenter="hoverHighlight('\${id}',true)" onmouseleave="hoverHighlight('\${id}',false)">
      <div class="hl-item-header"><span class="hl-item-role">\${ann.role || '?'}\${kindBadge}<\\/span><span style="display:flex;align-items:center;gap:6px">\${time}<button class="hl-delete" onclick="event.stopPropagation();removeAnnotation('\${id}')" title="Delete highlight">&times;<\\/button><\\/span><\\/div>
      <div class="hl-item-text">\${quote}<\\/div>
      \${comment}
      \${tagsHtml}
    <\\/div>\`;
  }).join('');
}

function scrollToHighlight(id) {
  const mark = document.querySelector(\`mark[data-annotation-id="\${id}"]\`);
  if (mark) {
    mark.scrollIntoView({ behavior: 'smooth', block: 'center' });
    // Flash it
    document.querySelectorAll('mark.active').forEach(m => m.classList.remove('active'));
    document.querySelectorAll(\`mark[data-annotation-id="\${id}"]\`).forEach(m => m.classList.add('active'));
    setTimeout(() => {
      document.querySelectorAll(\`mark[data-annotation-id="\${id}"]\`).forEach(m => m.classList.remove('active'));
    }, 2000);
  } else {
    // Mark not in DOM (page reload) — scroll to the turn instead
    const ann = annotations[id];
    if (ann?.turnId) {
      const turn = document.getElementById(ann.turnId);
      if (turn) {
        turn.scrollIntoView({ behavior: 'smooth', block: 'start' });
        turn.style.outline = '2px solid rgba(255, 179, 0, 0.6)';
        turn.style.outlineOffset = '4px';
        setTimeout(() => { turn.style.outline = ''; turn.style.outlineOffset = ''; }, 2000);
      }
    }
  }
}

function hoverHighlight(id, on) {
  document.querySelectorAll(\`mark[data-annotation-id="\${id}"]\`).forEach(m => {
    m.classList.toggle('active', on);
  });
}

const JSONL_SOURCE = '${jsonlPath}';

// ── Clipboard helper ──
function copyToClipboard(text, btn) {
  navigator.clipboard.writeText(text);
  if (btn) {
    const orig = btn.textContent;
    btn.textContent = 'Copied!';
    setTimeout(() => btn.textContent = orig, 1500);
  }
}

function escXml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Copy for Claude (XML context bundle) ──
function copyXmlExport(btn) {
  const ids = sortedAnnotationIds();
  if (!ids.length) return;

  const source = JSONL_SOURCE.split('/').pop();
  const date = new Date().toISOString().slice(0, 10);
  const kindOrder = ['decision', 'constraint', 'bug', 'todo', 'question', 'insight', 'highlight'];

  // Group by kind
  const grouped = {};
  ids.forEach(id => {
    const ann = annotations[id];
    const k = ann.kind || 'highlight';
    (grouped[k] = grouped[k] || []).push({ id, ann });
  });

  let xml = \`<context_bundle source="\${escXml(source)}" date="\${date}">\\n\`;

  kindOrder.forEach(kind => {
    if (!grouped[kind]) return;
    grouped[kind].forEach(({ id, ann }) => {
      const turnIdx = ann.turnIndex ?? -1;
      const speaker = ann.role || '?';
      const quote = (ann.text || '').replace(/\\n/g, ' ');

      xml += \`  <highlight turn="\${turnIdx}" speaker="\${speaker}" kind="\${kind}"\`;
      if (ann.tags && ann.tags.length) xml += \` tags="\${ann.tags.join(',')}"\`;
      xml += \`>\\n\`;

      const trigger = computeTrigger(ann);
      if (trigger) xml += \`    <trigger>\${escXml(trigger)}<\\/trigger>\\n\`;
      xml += \`    <quote>\${escXml(quote)}<\\/quote>\\n\`;
      if (ann.comment) xml += \`    <note>\${escXml(ann.comment)}<\\/note>\\n\`;
      xml += \`  <\\/highlight>\\n\`;
    });
  });

  xml += \`<\\/context_bundle>\`;
  copyToClipboard(xml, btn);
}

// ── Copy Markdown ──
function copyMarkdownExport(btn) {
  const ids = sortedAnnotationIds();
  if (!ids.length) return;

  const title = document.querySelector('.header h1')?.textContent || 'Conversation';
  let out = \`## Highlights from \${title}\\n\`;
  out += 'Source: \\\`' + JSONL_SOURCE + '\\\`\\n\\n';

  ids.forEach((id, i) => {
    const ann = annotations[id];
    const speaker = ann.role || '?';
    const time = ann.time ? \`, \${ann.time}\` : '';
    const turnRef = ann.turnIndex ?? (ann.turnId ? ann.turnId.replace('turn-', '') : '?');
    const kindLabel = (ann.kind && ann.kind !== 'highlight') ? \` [\${ann.kind}]\` : '';
    const quote = ann.text.replace(/\\n/g, ' ');

    out += \`\${i + 1}. [\${speaker}\${time}, turn #\${turnRef}]\${kindLabel} "\${quote}"\\n\`;

    const trigger = computeTrigger(ann);
    if (trigger) out += \`   Context: \${trigger}\\n\`;
    if (ann.comment) out += \`   > \${ann.comment}\\n\`;
    if (ann.tags?.length) out += \`   Tags: \${ann.tags.join(', ')}\\n\`;
    out += \`\\n\`;
  });

  copyToClipboard(out, btn);
}

// ── Copy JSONL Slice (exchange windows) ──
function copyJsonlSlice(btn) {
  const ids = sortedAnnotationIds();
  if (!ids.length) return;

  const turnIndices = new Set();
  ids.forEach(id => {
    const ann = annotations[id];
    const ti = ann.turnIndex ?? -1;
    if (ti >= 0) {
      turnIndices.add(ti);
      // Include exchange partner
      if (ann.role === 'Claude' && ti > 0) turnIndices.add(ti - 1);
      if (ann.role === 'You' && ti < convoData.length - 1) turnIndices.add(ti + 1);
    }
  });

  const sorted = Array.from(turnIndices).sort((a, b) => a - b);
  const lines = sorted.map(ti => {
    if (ti < convoData.length) {
      const turn = convoData[ti];
      return JSON.stringify({
        role: turn.role,
        timestamp: turn.timestamp,
        text: turn.text.join('\\n\\n')
      });
    }
    return null;
  }).filter(Boolean);

  copyToClipboard(lines.join('\\n'), btn);
}

// ── Download annotations JSON (for bake-in) ──
function downloadAnnotations() {
  const data = JSON.stringify(annotations, null, 2);
  const blob = new Blob([data], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = '${sessionId}.annotations.json';
  a.click();
  URL.revokeObjectURL(url);
}
`;
}
