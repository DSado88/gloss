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

  // --- Auto-linking URLs ---

  it("auto-links bare URLs", () => {
    const html = renderMarkdownInline("visit https://example.com today");
    expect(html).toContain('<a href="https://example.com">https://example.com</a>');
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
});
