export function escape(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

export function renderMarkdownInline(text: string): string {
  // For the renderer to compile, this needs to exist
  // The full implementation is in Unit 2
  // Implement a basic version: escape + code blocks + bold + italic + line breaks
  let result = text;

  // Fenced code blocks
  result = result.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    const langAttr = lang ? ` class="language-${escape(lang)}"` : "";
    return `<pre><code${langAttr}>${escape(code.trim())}</code></pre>`;
  });

  // Split on <pre> blocks to avoid processing code contents
  const PRE_RE = /(<pre>[\s\S]*?<\/pre>)/;
  const parts = result.split(PRE_RE);

  return parts
    .map((part) => {
      if (part.startsWith("<pre>")) return part;
      let p = escape(part);
      p = p.replace(/`([^`]+)`/g, "<code>$1</code>");
      p = p.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
      p = p.replace(/(?<!\w)\*([^*]+?)\*(?!\w)/g, "<em>$1</em>");
      p = p.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
      p = p.replace(/\n/g, "<br>\n");
      return p;
    })
    .join("");
}
