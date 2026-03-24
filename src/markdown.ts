/**
 * Lightweight markdown-to-HTML engine for conversation rendering.
 *
 * Handles fenced code blocks, tables, inline formatting (bold, italic,
 * inline code, links), headers, lists, horizontal rules, paragraphs,
 * and auto-linking of URLs and file paths.
 */

import { homedir } from "os";

const PRE_OPEN = "\x00PRE_OPEN\x00";
const PRE_CLOSE = "\x00PRE_CLOSE\x00";
const SENTINEL_SPLIT_RE = new RegExp(
  `(${PRE_OPEN.replace(/\x00/g, "\\x00")}.*?${PRE_CLOSE.replace(/\x00/g, "\\x00")})`,
  "gs",
);

/** HTML-escape the five standard entities. */
export function escape(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

function parseRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());
}

/**
 * Convert markdown table lines into an HTML `<table>`.
 *
 * Expects at least a header row and a separator row.
 */
export function renderMdTable(lines: string[]): string {
  if (lines.length < 2) return lines.join("\n");

  const headers = parseRow(lines[0]);

  // Verify the separator row (|---|---|)
  if (!/^\s*\|?[\s:_-]+(\|[\s:_-]+)+\|?\s*$/.test(lines[1])) {
    return lines.join("\n");
  }

  const parts: string[] = ["<table>"];
  parts.push("<thead><tr>");
  for (const h of headers) parts.push(`<th>${applyInlineFormatting(escape(h))}</th>`);
  parts.push("</tr></thead>");

  parts.push("<tbody>");
  for (const rowLine of lines.slice(2)) {
    const cells = parseRow(rowLine);
    parts.push("<tr>");
    for (const cell of cells) parts.push(`<td>${applyInlineFormatting(escape(cell))}</td>`);
    parts.push("</tr>");
  }
  parts.push("</tbody></table>");
  return parts.join("");
}

/**
 * Find markdown tables in `text` and convert them, leaving the rest
 * untouched.
 */
export function processTables(text: string): string {
  const lines = text.split("\n");
  const result: string[] = [];
  let tableBuf: string[] = [];
  let inTable = false;

  for (const line of lines) {
    if (/^\s*\|.*\|\s*$/.test(line)) {
      tableBuf.push(line);
      inTable = true;
    } else {
      if (inTable) {
        result.push(renderMdTable(tableBuf));
        tableBuf = [];
        inTable = false;
      }
      result.push(line);
    }
  }
  if (tableBuf.length) result.push(renderMdTable(tableBuf));

  return result.join("\n");
}

// ---------------------------------------------------------------------------
// File-path linking
// ---------------------------------------------------------------------------

/** Convert a file-path match string to a clickable `file://` link. */
export function linkFilepath(match: string): string {
  let hrefPath = match;
  if (hrefPath.startsWith("~")) {
    hrefPath = homedir() + hrefPath.slice(1);
  }
  return `<a href="file://${hrefPath}" class="file-link">${match}</a>`;
}

// ---------------------------------------------------------------------------
// Inline formatting helpers (shared between table cells and regular text)
// ---------------------------------------------------------------------------

function applyBoldItalic(text: string): string {
  text = text.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  text = text.replace(/(?<!\w)\*([^*]+?)\*(?!\w)/g, "<em>$1</em>");
  return text;
}

function applyAutoLinks(text: string): string {
  // Auto-link bare URLs (not already inside an <a> tag)
  text = text.replace(
    /(?<!href=")(?<!">)(https?:\/\/[^\s<>)]+)/g,
    (_, url: string) => {
      // Strip trailing sentence punctuation that isn't part of the URL
      const cleaned = url.replace(/[.,;:!?]+$/, "");
      const trailing = url.slice(cleaned.length);
      return `<a href="${cleaned}" target="_blank" rel="noopener">${cleaned}</a>${trailing}`;
    },
  );
  // Auto-link file paths
  text = text.replace(
    /(?<!["\w])(\/(?:Users|private|tmp|var|opt|etc|home)[\/\w._-]+(?:\.\w+)?|~\/[\/\w._-]+(?:\.\w+)?)/g,
    (_, p1: string) => linkFilepath(p1),
  );
  return text;
}

function applyTableInlineFormatting(piece: string): string {
  // Inline code (with escaping of inner content)
  piece = piece.replace(
    /`([^`]+)`/g,
    (_, code: string) => `<code>${escape(code)}</code>`,
  );
  piece = applyBoldItalic(piece);
  piece = applyAutoLinks(piece);
  return piece;
}

function applyInlineFormatting(text: string): string {
  // Extract inline code spans into placeholders so their content
  // is not processed by bold/italic/link regexes
  const codeSpans: string[] = [];
  let p = text.replace(/`([^`]+)`/g, (_, code: string) => {
    const idx = codeSpans.length;
    codeSpans.push(`<code>${code}</code>`);
    return `\x01IC${idx}\x01`;
  });

  // Bold and italic (* variants)
  p = applyBoldItalic(p);
  // Bold __text__ and italic _text_ (underscore variants, not inside words)
  p = p.replace(/__(.+?)__/g, "<strong>$1</strong>");
  p = p.replace(/(?<!\w)_([^_]+?)_(?!\w)/g, "<em>$1</em>");

  // Links [text](url) — extract into placeholders to prevent auto-link from
  // double-linking URLs that appear inside the display text of markdown links
  const linkSpans: string[] = [];
  p = p.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, text: string, url: string) => {
    if (/^\s*(javascript|data|vbscript):/i.test(url)) {
      return `${text}`;
    }
    const idx = linkSpans.length;
    const external = /^https?:\/\//.test(url);
    linkSpans.push(`<a href="${url}"${external ? ' target="_blank" rel="noopener"' : ''}>${text}</a>`);
    return `\x01LK${idx}\x01`;
  });

  // Auto-link URLs and file paths (safe now — markdown links are placeholders)
  p = applyAutoLinks(p);

  // Restore markdown links
  p = p.replace(/\x01LK(\d+)\x01/g, (_, idx) => linkSpans[Number(idx)]);

  // Headers (# at start of line) — process most specific first
  p = p.replace(/^#### (.+)$/gm, "<h6>$1</h6>");
  p = p.replace(/^### (.+)$/gm, "<h5>$1</h5>");
  p = p.replace(/^## (.+)$/gm, "<h4>$1</h4>");
  p = p.replace(/^# (.+)$/gm, "<h3>$1</h3>");

  // Horizontal rule
  p = p.replace(/^---+$/gm, "<hr>");

  // List items (unordered and ordered)
  p = p.replace(/^- (.+)$/gm, "<li>$1</li>");
  p = p.replace(/^\d+\.\s+(.+)$/gm, "<li>$1</li>");

  // Wrap consecutive <li> runs in <ul>
  p = p.replace(/((?:<li>.*?<\/li>\n?)+)/g, "<ul>$1</ul>");

  // Paragraphs (double newline) and line breaks (single newline)
  p = p.replace(/\n\n+/g, "</p><p>");
  p = p.replace(/\n(?!<\/?\s*(?:ul|li|h[3-6]|hr|p|table|div))/g, "<br>\n");

  // Restore inline code spans
  p = p.replace(/\x01IC(\d+)\x01/g, (_, idx) => codeSpans[Number(idx)]);

  return p;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/** Convert markdown text to HTML. */
export function renderMarkdownInline(text: string): string {
  // Strip control characters used as internal sentinel delimiters (\x00 for
  // fenced code blocks, \x01 for inline code placeholders). User content
  // with these bytes could bypass escaping or corrupt placeholder restoration.
  text = text.replace(/[\x00\x01]/g, "");

  // Fenced code blocks first (``` lang\n code ```)
  // Use multiline mode so ^``` only matches at the start of a line,
  // preventing mid-line backticks (e.g. in template literals) from closing the block.
  text = text.replace(
    /```(\w*)\n(.*?)^```\s*$/gms,
    (_m, lang: string, code: string) => {
      const escapedLang = escape(lang);
      const escapedCode = escape(code.trim());
      const langAttr = escapedLang ? ` class="language-${escapedLang}"` : "";
      return `${PRE_OPEN}<code${langAttr}>${escapedCode}</code>${PRE_CLOSE}`;
    },
  );

  // Split on sentinel-marked code blocks to avoid processing their contents
  const parts = text.split(SENTINEL_SPLIT_RE);

  const processed: string[] = [];

  for (const part of parts) {
    if (part.startsWith(PRE_OPEN)) {
      // Replace sentinels with real <pre> tags
      processed.push(
        part.replace(PRE_OPEN, "<pre>").replace(PRE_CLOSE, "</pre>"),
      );
      continue;
    }

    // Convert markdown tables before escaping
    const afterTables = processTables(part);

    // Split on <table> blocks to avoid escaping table HTML
    const tableSplit = afterTables.split(/(<table>.*?<\/table>)/gs);
    const partPieces: string[] = [];

    for (const piece of tableSplit) {
      if (piece.startsWith("<table>")) {
        // Table cells are already formatted by renderMdTable (escape + applyInlineFormatting).
        // Pass through as-is to avoid cross-cell backtick/formatting contamination.
        partPieces.push(piece);
      } else {
        partPieces.push(applyInlineFormatting(escape(piece)));
      }
    }

    processed.push(partPieces.join(""));
  }

  let result = processed.join("");

  // Sanitize HTML tags that would break page structure if they leak through.
  // Tool results can contain escaped HTML that partially decodes through the
  // markdown pipeline, producing real <title>, <script>, etc. elements.
  result = result.replace(/<(\/?)(title|script|style|iframe|object|embed|base)([\s>])/gi,
    (_, slash, tag, after) => `&lt;${slash}${tag}${after === ">" ? "&gt;" : after}`);

  return result;
}
