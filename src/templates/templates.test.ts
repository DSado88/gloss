import { describe, it, expect } from "vitest";
import { safeForScript, buildHtmlPage } from "./html-template.js";
import { getClientJs } from "./client-js.js";
import { CSS_STYLES } from "./css.js";
import { buildIndexPage } from "./index-template.js";

describe("safeForScript", () => {
  it("escapes </script> to <\\/script>", () => {
    expect(safeForScript("</script>")).toBe("<\\/script>");
  });

  it("escapes multiple occurrences", () => {
    expect(safeForScript("a</script>b</style>c")).toBe("a<\\/script>b<\\/style>c");
  });

  it("leaves strings without </ unchanged", () => {
    expect(safeForScript("no closing tags here")).toBe("no closing tags here");
  });
});

describe("CSS_STYLES", () => {
  it("is non-empty", () => {
    expect(CSS_STYLES.length).toBeGreaterThan(0);
  });

  it("contains key selectors", () => {
    expect(CSS_STYLES).toContain(".turn");
    expect(CSS_STYLES).toContain(".message-text");
    expect(CSS_STYLES).toContain(".tool-use");
    expect(CSS_STYLES).toContain(".tool-result");
    expect(CSS_STYLES).toContain(".thinking");
    expect(CSS_STYLES).toContain(".toc-panel");
    expect(CSS_STYLES).toContain(".conversation");
    expect(CSS_STYLES).toContain(".controls");
  });

  it("does not contain Python double-brace escaping", () => {
    expect(CSS_STYLES).not.toContain("{{");
    expect(CSS_STYLES).not.toContain("}}");
  });
});

describe("getClientJs", () => {
  it("interpolates sessionId", () => {
    const js = getClientJs("test-session-123", "/path/to/file.jsonl");
    expect(js).toContain("annotations_test-session-123");
    expect(js).toContain("test-session-123.annotations.json");
  });

  it("interpolates jsonlPath", () => {
    const js = getClientJs("sess", "/my/path.jsonl");
    expect(js).toContain("'/my/path.jsonl'");
  });

  it("contains core function definitions", () => {
    const js = getClientJs("s", "p");
    expect(js).toContain("function toggleToc()");
    expect(js).toContain("function annotate()");
    expect(js).toContain("function save()");
    expect(js).toContain("function restoreAnnotations()");
  });

  it("does not contain Python double-brace escaping", () => {
    const js = getClientJs("s", "p");
    expect(js).not.toContain("{{");
    expect(js).not.toContain("}}");
  });
});

describe("buildHtmlPage", () => {
  const params = {
    title: "Test Conversation",
    metaHtml: '<span>Model: claude</span>',
    conversationHtml: '<div class="turn user">Hello</div>',
    tocHtml: '<div class="toc-item">entry</div>',
    sessionId: "abc-123",
    jsonlPath: "/tmp/test.jsonl",
    metaComment: "<!-- CONVO_META:test-meta -->",
    conversationDataJson: '[{"role":"user","text":["hello"]}]',
    bakedAnnotationsJson: "{}",
  };

  it("produces valid HTML structure", () => {
    const html = buildHtmlPage(params);
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("<html lang=\"en\">");
    expect(html).toContain("</html>");
    expect(html).toContain("<head>");
    expect(html).toContain("</head>");
    expect(html).toContain("<body");
    expect(html).toContain("</body>");
  });

  it("includes the title", () => {
    const html = buildHtmlPage(params);
    expect(html).toContain("<title>Test Conversation</title>");
    expect(html).toContain("<h1>Test Conversation</h1>");
  });

  it("includes the meta comment", () => {
    const html = buildHtmlPage(params);
    expect(html).toContain("<!-- CONVO_META:test-meta -->");
  });

  it("includes the meta HTML", () => {
    const html = buildHtmlPage(params);
    expect(html).toContain('<span>Model: claude</span>');
  });

  it("includes the conversation HTML", () => {
    const html = buildHtmlPage(params);
    expect(html).toContain('<div class="turn user">Hello</div>');
  });

  it("includes the TOC HTML", () => {
    const html = buildHtmlPage(params);
    expect(html).toContain('<div class="toc-item">entry</div>');
  });

  it("embeds CSS", () => {
    const html = buildHtmlPage(params);
    expect(html).toContain("<style>");
    expect(html).toContain(".turn");
    expect(html).toContain(".message-text");
  });

  it("embeds JS", () => {
    const html = buildHtmlPage(params);
    expect(html).toContain("<script>");
    expect(html).toContain("function toggleToc()");
    expect(html).toContain("function annotate()");
  });

  it("embeds conversation data JSON", () => {
    const html = buildHtmlPage(params);
    expect(html).toContain('id="conversation-data"');
    expect(html).toContain('[{"role":"user","text":["hello"]}]');
  });

  it("embeds baked annotations JSON", () => {
    const html = buildHtmlPage(params);
    expect(html).toContain('id="baked-annotations"');
  });

  it("applies safeForScript to embedded JSON", () => {
    const paramsWithScript = {
      ...params,
      conversationDataJson: '{"text":"</script>"}',
    };
    const html = buildHtmlPage(paramsWithScript);
    expect(html).not.toContain('"</script>"');
    expect(html).toContain('"<\\/script>"');
  });

  it("sets data-session-id attribute", () => {
    const html = buildHtmlPage(params);
    expect(html).toContain('data-session-id="abc-123"');
  });

  it("includes all expected structural elements", () => {
    const html = buildHtmlPage(params);
    expect(html).toContain('class="header"');
    expect(html).toContain('class="controls"');
    expect(html).toContain('class="toc-panel"');
    expect(html).toContain('class="conversation"');
    expect(html).toContain('class="comment-popover"');
    expect(html).toContain('class="export-panel"');
    expect(html).toContain('id="toggle-tools"');
    expect(html).toContain('id="toggle-thinking"');
    expect(html).toContain('id="btn-highlight"');
  });
});

describe("buildIndexPage", () => {
  it("produces valid HTML structure", () => {
    const html = buildIndexPage("<div>entries</div>", 5);
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("<html lang=\"en\">");
    expect(html).toContain("</html>");
    expect(html).toContain("<head>");
    expect(html).toContain("</head>");
    expect(html).toContain("<body>");
    expect(html).toContain("</body>");
  });

  it("includes the page title", () => {
    const html = buildIndexPage("", 0);
    expect(html).toContain("<title>Claude Conversations</title>");
    expect(html).toContain("<h1>Claude Conversations</h1>");
  });

  it("includes the session count", () => {
    const html = buildIndexPage("", 42);
    expect(html).toContain("42 sessions");
  });

  it("includes the entries HTML", () => {
    const entries = '<a class="index-entry" href="test.html"><span class="entry-id">abc</span></a>';
    const html = buildIndexPage(entries, 1);
    expect(html).toContain(entries);
  });

  it("includes index page CSS", () => {
    const html = buildIndexPage("", 0);
    expect(html).toContain(".index-list");
    expect(html).toContain(".index-entry");
    expect(html).toContain(".entry-id");
  });
});
