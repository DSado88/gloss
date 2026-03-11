import { describe, it, expect } from "vitest";
import { buildHtmlPage, type HtmlPageParams } from "./templates/html-template.js";

function makeParams(overrides: Partial<HtmlPageParams> = {}): HtmlPageParams {
  return {
    title: "Test Conversation",
    metaHtml: "<span>meta</span>",
    conversationHtml: "<div>hello</div>",
    tocHtml: "<div>toc</div>",
    sessionId: "test-session-id",
    jsonlPath: "/tmp/test.jsonl",
    metaComment: "<!-- meta -->",
    conversationDataJson: "[]",
    bakedAnnotationsJson: "{}",
    ...overrides,
  };
}

describe("buildHtmlPage dual mode", () => {
  // -----------------------------------------------------------------------
  // Inline mode (export / static HTML)
  // -----------------------------------------------------------------------

  describe("inline mode (default)", () => {
    it("inlines CSS in a <style> tag", () => {
      const html = buildHtmlPage(makeParams());
      expect(html).toContain("<style>");
      expect(html).not.toContain('href="/assets/style.css"');
    });

    it("inlines JS in a <script> tag (no src)", () => {
      const html = buildHtmlPage(makeParams());
      // Should have inline script content, not an external reference
      expect(html).not.toContain('src="/assets/client.js"');
    });

    it("does not include page-config", () => {
      const html = buildHtmlPage(makeParams());
      expect(html).not.toContain('id="page-config"');
    });

    it("does not set data-mode=server", () => {
      const html = buildHtmlPage(makeParams());
      expect(html).not.toContain('data-mode="server"');
    });

    it("is self-contained (no external asset references)", () => {
      const html = buildHtmlPage(makeParams());
      // Should not reference /assets/ at all
      expect(html).not.toContain('"/assets/');
    });
  });

  // -----------------------------------------------------------------------
  // Server mode
  // -----------------------------------------------------------------------

  describe("server mode", () => {
    const serverParams = () =>
      makeParams({
        mode: "server",
        wsUrl: "ws://localhost:3456/ws/test-session-id",
      });

    it("uses external CSS link instead of inline <style>", () => {
      const html = buildHtmlPage(serverParams());
      expect(html).toContain('href="/assets/style.css"');
      expect(html).not.toMatch(/<style>[\s\S]*<\/style>/);
    });

    it("uses external JS script instead of inline", () => {
      const html = buildHtmlPage(serverParams());
      expect(html).toContain('src="/assets/client.js"');
    });

    it("includes page-config JSON with session info", () => {
      const html = buildHtmlPage(serverParams());
      expect(html).toContain('id="page-config"');
      const match = html.match(/id="page-config">(.*?)<\/script/s);
      expect(match).not.toBeNull();
      const config = JSON.parse(match![1]);
      expect(config.sessionId).toBe("test-session-id");
      expect(config.wsUrl).toBe("ws://localhost:3456/ws/test-session-id");
      expect(config.mode).toBe("server");
    });

    it("sets data-mode=server on body", () => {
      const html = buildHtmlPage(serverParams());
      expect(html).toContain('data-mode="server"');
    });

    it("is much smaller than inline mode (no inlined CSS/JS)", () => {
      const inlineHtml = buildHtmlPage(makeParams());
      const serverHtml = buildHtmlPage(serverParams());
      // Server mode should be significantly smaller since CSS+JS aren't inlined
      expect(serverHtml.length).toBeLessThan(inlineHtml.length);
    });

    it("still includes conversation content inline", () => {
      const html = buildHtmlPage(serverParams());
      // Conversation data and baked annotations are still inline for fast first paint
      expect(html).toContain("<div>hello</div>");
    });
  });

  // -----------------------------------------------------------------------
  // Mode switching doesn't leak
  // -----------------------------------------------------------------------

  it("inline and server modes produce different output for same content", () => {
    const base = makeParams();
    const inlineHtml = buildHtmlPage(base);
    const serverHtml = buildHtmlPage({
      ...base,
      mode: "server",
      wsUrl: "ws://localhost:3456/ws/test",
    });
    expect(inlineHtml).not.toEqual(serverHtml);
  });
});
