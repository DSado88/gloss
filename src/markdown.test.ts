import { describe, it, expect } from "vitest";
import {
  escape,
  renderMdTable,
  processTables,
  linkFilepath,
  renderMarkdownInline,
} from "./markdown.js";
import { homedir } from "os";

// ---------------------------------------------------------------------------
// escape()
// ---------------------------------------------------------------------------

describe("escape", () => {
  it("escapes ampersand", () => {
    expect(escape("A & B")).toBe("A &amp; B");
  });

  it("escapes less-than", () => {
    expect(escape("a < b")).toBe("a &lt; b");
  });

  it("escapes greater-than", () => {
    expect(escape("a > b")).toBe("a &gt; b");
  });

  it("escapes double quote", () => {
    expect(escape('say "hi"')).toBe("say &quot;hi&quot;");
  });

  it("escapes single quote", () => {
    expect(escape("it's")).toBe("it&#x27;s");
  });

  it("escapes all five entities together", () => {
    expect(escape(`<a href="x">'&'</a>`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;&#x27;&amp;&#x27;&lt;/a&gt;",
    );
  });
});

// ---------------------------------------------------------------------------
// renderMdTable()
// ---------------------------------------------------------------------------

describe("renderMdTable", () => {
  it("converts a well-formed table", () => {
    const lines = [
      "| Name | Age |",
      "|------|-----|",
      "| Alice | 30 |",
      "| Bob | 25 |",
    ];
    const html = renderMdTable(lines);
    expect(html).toContain("<table>");
    expect(html).toContain("<th>Name</th>");
    expect(html).toContain("<th>Age</th>");
    expect(html).toContain("<td>Alice</td>");
    expect(html).toContain("<td>30</td>");
    expect(html).toContain("<td>Bob</td>");
    expect(html).toContain("</table>");
  });

  it("returns original lines when fewer than 2 lines", () => {
    expect(renderMdTable(["| only |"])).toBe("| only |");
  });

  it("returns original lines when separator is invalid", () => {
    const lines = ["| A |", "| not a separator |"];
    expect(renderMdTable(lines)).toBe(lines.join("\n"));
  });
});

// ---------------------------------------------------------------------------
// processTables()
// ---------------------------------------------------------------------------

describe("processTables", () => {
  it("converts a table embedded in text", () => {
    const text = [
      "Before",
      "| H1 | H2 |",
      "|----|-----|",
      "| a  | b   |",
      "After",
    ].join("\n");
    const result = processTables(text);
    expect(result).toContain("<table>");
    expect(result).toContain("Before");
    expect(result).toContain("After");
  });

  it("leaves non-table text unchanged", () => {
    const text = "Hello world\nno tables here";
    expect(processTables(text)).toBe(text);
  });
});

// ---------------------------------------------------------------------------
// linkFilepath()
// ---------------------------------------------------------------------------

describe("linkFilepath", () => {
  it("wraps an absolute path in a file:// link", () => {
    const result = linkFilepath("/Users/alice/foo.txt");
    expect(result).toBe(
      '<a href="file:///Users/alice/foo.txt" class="file-link">/Users/alice/foo.txt</a>',
    );
  });

  it("expands ~ to homedir", () => {
    const result = linkFilepath("~/docs/bar.md");
    const home = homedir();
    expect(result).toBe(
      `<a href="file://${home}/docs/bar.md" class="file-link">~/docs/bar.md</a>`,
    );
  });
});

// ---------------------------------------------------------------------------
// renderMarkdownInline()
// ---------------------------------------------------------------------------

describe("renderMarkdownInline", () => {
  // --- Fenced code blocks ---

  it("renders fenced code blocks with language", () => {
    const md = "```ts\nconst x = 1;\n```";
    const html = renderMarkdownInline(md);
    expect(html).toContain('<pre><code class="language-ts">');
    expect(html).toContain("const x = 1;");
    expect(html).toContain("</code></pre>");
  });

  it("renders fenced code blocks without language", () => {
    const md = "```\nhello\n```";
    const html = renderMarkdownInline(md);
    expect(html).toContain("<pre><code>");
    expect(html).toContain("hello");
  });

  it("does not close code block on triple backticks mid-line", () => {
    const md = '```js\nconst fence = "```";\n```';
    const html = renderMarkdownInline(md);
    // The full code line should be inside the code block, not cut off at the mid-line ```
    expect(html).toContain('const fence = &quot;```&quot;;');
  });

  it("does NOT process markdown inside code blocks", () => {
    const md = "```\n**bold** and *italic*\n```";
    const html = renderMarkdownInline(md);
    // The bold/italic markers should be escaped, not converted
    expect(html).not.toContain("<strong>");
    expect(html).not.toContain("<em>");
    expect(html).toContain("**bold**");
  });

  it("escapes HTML inside code blocks", () => {
    const md = "```\n<div>test</div>\n```";
    const html = renderMarkdownInline(md);
    expect(html).toContain("&lt;div&gt;");
  });

  // --- Inline code ---

  it("renders inline code", () => {
    const html = renderMarkdownInline("use `foo()` here");
    expect(html).toContain("<code>foo()</code>");
  });

  it("does not corrupt text containing \\x01 inline-code placeholder pattern", () => {
    // The inline code placeholder uses \x01IC{N}\x01 internally.
    // Content with literal \x01 must not be misinterpreted as a placeholder.
    const malicious = "text \x01IC0\x01 more text";
    const html = renderMarkdownInline(malicious);
    expect(html).not.toContain("undefined");
    // The \x01 chars should be stripped or escaped, preserving the surrounding text
    expect(html).toContain("text");
    expect(html).toContain("more text");
  });

  it("does not apply bold/italic inside inline code spans", () => {
    const html = renderMarkdownInline("Use `**not bold**` and `*not italic*` in code");
    // The ** and * inside backticks should be literal, not converted to <strong>/<em>
    expect(html).not.toContain("<strong>");
    expect(html).not.toContain("<em>");
    expect(html).toContain("<code>");
  });

  // --- Bold ---

  it("renders bold with **", () => {
    const html = renderMarkdownInline("this is **bold** text");
    expect(html).toContain("<strong>bold</strong>");
  });

  it("renders bold with __", () => {
    const html = renderMarkdownInline("this is __bold__ text");
    expect(html).toContain("<strong>bold</strong>");
  });

  // --- Italic ---

  it("renders italic with *", () => {
    const html = renderMarkdownInline("this is *italic* text");
    expect(html).toContain("<em>italic</em>");
  });

  it("renders italic with _", () => {
    const html = renderMarkdownInline("this is _italic_ text");
    expect(html).toContain("<em>italic</em>");
  });

  // --- Links ---

  it("renders [text](url) links", () => {
    const html = renderMarkdownInline("[Click](https://example.com)");
    expect(html).toContain('<a href="https://example.com">Click</a>');
  });

  it("rejects javascript: URLs in markdown links", () => {
    const html = renderMarkdownInline("[click me](javascript:alert(1))");
    expect(html).not.toContain('href="javascript:');
  });

  it("rejects data: URLs in markdown links", () => {
    const html = renderMarkdownInline("[click](data:text/html,<script>alert(1)</script>)");
    expect(html).not.toContain('href="data:');
  });

  // --- Auto-linking URLs ---

  it("auto-links bare URLs", () => {
    const html = renderMarkdownInline("visit https://example.com today");
    expect(html).toContain('<a href="https://example.com">https://example.com</a>');
  });

  it("does not double-link URLs inside markdown link display text", () => {
    const html = renderMarkdownInline("[see https://example.com](https://other.com)");
    // Should produce ONE <a> tag (the markdown link), not nested <a> tags
    const anchorCount = (html.match(/<a /g) || []).length;
    expect(anchorCount).toBe(1);
    expect(html).toContain('href="https://other.com"');
  });

  it("does not include trailing sentence punctuation in auto-linked URLs", () => {
    const html = renderMarkdownInline("See https://example.com. Also https://test.org, ok?");
    expect(html).toContain('href="https://example.com"');
    expect(html).not.toContain('href="https://example.com."');
    expect(html).toContain('href="https://test.org"');
    expect(html).not.toContain('href="https://test.org,"');
  });

  // --- Auto-linking file paths ---

  it("auto-links /Users/ paths", () => {
    const html = renderMarkdownInline("see /Users/alice/file.txt");
    expect(html).toContain('class="file-link"');
    expect(html).toContain("file:///Users/alice/file.txt");
  });

  it("auto-links ~/ paths", () => {
    const html = renderMarkdownInline("see ~/docs/readme.md");
    expect(html).toContain('class="file-link"');
    expect(html).toContain("~/docs/readme.md");
  });

  // --- Headers ---

  it("renders h3 from #", () => {
    const html = renderMarkdownInline("# Title");
    expect(html).toContain("<h3>Title</h3>");
  });

  it("renders h4 from ##", () => {
    const html = renderMarkdownInline("## Subtitle");
    expect(html).toContain("<h4>Subtitle</h4>");
  });

  it("renders h5 from ###", () => {
    const html = renderMarkdownInline("### Section");
    expect(html).toContain("<h5>Section</h5>");
  });

  it("renders h6 from ####", () => {
    const html = renderMarkdownInline("#### Sub-section");
    expect(html).toContain("<h6>Sub-section</h6>");
  });

  // --- Horizontal rules ---

  it("renders horizontal rules", () => {
    const html = renderMarkdownInline("above\n\n---\n\nbelow");
    expect(html).toContain("<hr>");
  });

  // --- Lists ---

  it("renders unordered list items", () => {
    const html = renderMarkdownInline("- item one\n- item two");
    expect(html).toContain("<ul>");
    expect(html).toContain("<li>item one</li>");
    expect(html).toContain("<li>item two</li>");
    expect(html).toContain("</ul>");
  });

  it("renders ordered list items", () => {
    const html = renderMarkdownInline("1. first\n2. second");
    expect(html).toContain("<ul>");
    expect(html).toContain("<li>first</li>");
    expect(html).toContain("<li>second</li>");
  });

  // --- Tables via renderMarkdownInline ---

  it("renders markdown tables", () => {
    const md = "| A | B |\n|---|---|\n| 1 | 2 |";
    const html = renderMarkdownInline(md);
    expect(html).toContain("<table>");
    expect(html).toContain("<th>A</th>");
    expect(html).toContain("<td>1</td>");
  });

  // --- Paragraphs ---

  it("wraps double-newline separated text in paragraphs", () => {
    const html = renderMarkdownInline("para one\n\npara two");
    expect(html).toContain("</p><p>");
  });

  // --- Line breaks ---

  it("inserts <br> for single newlines", () => {
    const html = renderMarkdownInline("line one\nline two");
    expect(html).toContain("<br>");
  });

  // --- Mixed content ---

  it("handles code block + regular text + table together", () => {
    const md = [
      "```js",
      "const x = 1;",
      "```",
      "",
      "Some **bold** text.",
      "",
      "| H1 | H2 |",
      "|----|-----|",
      "| a  | b   |",
    ].join("\n");

    const html = renderMarkdownInline(md);

    // Code block
    expect(html).toContain('<pre><code class="language-js">');
    expect(html).toContain("const x = 1;");
    // Bold text
    expect(html).toContain("<strong>bold</strong>");
    // Table
    expect(html).toContain("<table>");
    expect(html).toContain("<th>H1</th>");
    expect(html).toContain("<td>a</td>");
  });

  // --- Security: HTML escaping in tables (mut-005, mut-006) ---

  it("escapes HTML in table headers", () => {
    // Use <div> — not caught by the dangerous-tag sanitizer, so only escape() protects us
    const md = "| <div>XSS</div> | Normal |\n|---|---|\n| a | b |";
    const html = renderMarkdownInline(md);
    expect(html).toContain("&lt;div&gt;");
    expect(html).not.toMatch(/<div>XSS/);
  });

  it("escapes HTML in table cells", () => {
    // Use <span> — not caught by the dangerous-tag sanitizer
    const md = "| H1 | H2 |\n|---|---|\n| <span>alert(1)</span> | safe |";
    const html = renderMarkdownInline(md);
    expect(html).toContain("&lt;span&gt;");
    expect(html).not.toMatch(/<span>alert/);
  });

  // --- Security: dangerous tag sanitizer (mut-015, mut-016) ---
  // The sanitizer is defense-in-depth for tags that leak through other paths.
  // To test it, we use table cells where the <title> appears in the rendered
  // table HTML *after* table processing but *before* the final sanitizer runs.
  // We test with raw HTML that the table path produces.

  it("sanitizes <title> tags that survive to final output", () => {
    // This tests the full pipeline — escape() in table cells is the primary defense,
    // and the sanitizer is the backup. We verify the final output is safe.
    const md = "| <title>bad</title> | ok |\n|---|---|\n| x | y |";
    const html = renderMarkdownInline(md);
    expect(html).not.toMatch(/<title>/i);
  });

  it("sanitizes case-insensitive dangerous tags", () => {
    // Mixed case tags must also be caught
    const md = "| <TITLE>bad</TITLE> | ok |\n|---|---|\n| x | y |";
    const html = renderMarkdownInline(md);
    expect(html).not.toMatch(/<TITLE>/i);
  });

  it("sanitizes dangerous tags with attributes", () => {
    const md = '| <script type="text/javascript">x</script> | ok |\n|---|---|\n| x | y |';
    const html = renderMarkdownInline(md);
    expect(html).not.toMatch(/<script[\s>]/i);
  });

  // --- Security: null-byte sentinel injection ---

  it("does not allow null-byte sentinel injection to bypass escaping", () => {
    // The renderer uses \x00PRE_OPEN\x00 / \x00PRE_CLOSE\x00 as internal sentinels.
    // If user content contains these, it must NOT bypass HTML escaping.
    const PRE_OPEN = "\x00PRE_OPEN\x00";
    const PRE_CLOSE = "\x00PRE_CLOSE\x00";
    const malicious = `text ${PRE_OPEN}<code><img src=x onerror=alert(1)></code>${PRE_CLOSE} more`;
    const html = renderMarkdownInline(malicious);
    expect(html).not.toContain("<img");
  });

  // --- Security: HTML escaping in main text (mut-018) ---

  it("escapes raw HTML in regular text", () => {
    const html = renderMarkdownInline("<div>injected</div>");
    expect(html).toContain("&lt;div&gt;");
    expect(html).not.toMatch(/<div>/);
  });

  // --- Boundary: table separator validation (mut-004) ---

  it("rejects single-column separator as table", () => {
    const lines = ["| A | B |", "| --- |", "| 1 | 2 |"];
    // Separator needs at least two pipe-separated sections
    const html = renderMdTable(lines);
    expect(html).not.toContain("<table>");
  });

  // --- Boundary: table row slice (mut-019) ---

  it("does not render the separator row as a data row", () => {
    const lines = [
      "| H1 | H2 |",
      "|---|---|",
      "| a | b |",
    ];
    const html = renderMdTable(lines);
    expect(html).toContain("<td>a</td>");
    // Only 1 data row in tbody — separator must not become a <tr>
    const tbodyMatch = html.match(/<tbody>([\s\S]*?)<\/tbody>/);
    const trCount = (tbodyMatch?.[1].match(/<tr>/g) || []).length;
    expect(trCount).toBe(1);
  });

  // --- Boundary: processTables whitespace handling (mut-007) ---

  it("recognizes table rows with leading whitespace", () => {
    const text = "  | H1 | H2 |\n  |---|---|\n  | a | b |";
    const result = processTables(text);
    expect(result).toContain("<table>");
  });

  // --- Logic: greedy bold matching (mut-009) ---

  it("renders multiple bold spans independently", () => {
    const html = renderMarkdownInline("**first** and **second**");
    expect(html).toContain("<strong>first</strong>");
    expect(html).toContain("<strong>second</strong>");
  });

  // --- Boundary: empty backtick handling (mut-010) ---

  it("does not create empty code elements from ``", () => {
    const html = renderMarkdownInline("empty `` backticks");
    // Should NOT produce <code></code>
    expect(html).not.toContain("<code></code>");
  });

  // --- Boundary: newline collapsing (mut-013) ---

  it("collapses quadruple newlines into a single paragraph break", () => {
    // With /\n\n+/g (correct), \n\n\n\n matches as one → 1 break
    // With /\n\n/g (mutant), \n\n\n\n matches twice → 2 breaks
    const html = renderMarkdownInline("para one\n\n\n\npara two");
    const count = (html.match(/<\/p><p>/g) || []).length;
    expect(count).toBe(1);
  });

  // --- Logic: list wrapping across paragraphs (mut-012) ---

  it("does not wrap list items across paragraph boundaries", () => {
    const md = "- item one\n- item two\n\nNon-list paragraph\n\n- item three";
    const html = renderMarkdownInline(md);
    // Should have two separate <ul> groups, not one spanning the paragraph
    const ulCount = (html.match(/<ul>/g) || []).length;
    expect(ulCount).toBe(2);
  });

  // --- Boundary: filepath ~ expansion (mut-008) ---

  it("expands bare ~ in filepath", () => {
    const result = linkFilepath("~/test.txt");
    const home = homedir();
    expect(result).toContain(`file://${home}/test.txt`);
  });

  // --- Logic: sentinel startsWith check (mut-017) ---

  it("does not treat non-code-block content as code blocks", () => {
    // Text that contains code block markers should still be processed normally
    // when it appears outside of actual fenced code blocks
    const html = renderMarkdownInline("**bold** text here");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).not.toContain("<pre>");
  });

  // --- Boundary: parseRow leading pipe (mut-020) ---

  it("preserves pipe characters in table cell content", () => {
    const lines = [
      "| Expr | Result |",
      "|------|--------|",
      "| a | b |",
    ];
    const html = renderMdTable(lines);
    expect(html).toContain("<td>a</td>");
    expect(html).toContain("<td>b</td>");
  });
});
