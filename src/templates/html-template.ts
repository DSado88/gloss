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
}

export function safeForScript(s: string): string {
  return s.replace(/<\//g, "<\\/");
}

export function buildHtmlPage(params: HtmlPageParams): string {
  return "<!DOCTYPE html><html><body></body></html>";
}
