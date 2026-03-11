#!/usr/bin/env python3
"""Convert Claude JSONL conversation logs to formatted HTML."""

import argparse
import html
import json
import re
from datetime import datetime, timezone
from pathlib import Path


def escape(text: str) -> str:
    """HTML-escape text."""
    return html.escape(text)


# Patterns for system-injected noise in user messages
_SYSTEM_NOISE_PATTERNS = [
    # Task notifications (background task completions)
    re.compile(r"<task-notification>.*?</task-notification>", re.DOTALL),
    # System reminders (injected by Claude Code infra)
    re.compile(r"<system-reminder>.*?</system-reminder>", re.DOTALL),
    # Slash command metadata
    re.compile(r"<command-message>.*?</command-message>"),
    re.compile(r"<command-name>.*?</command-name>"),
    re.compile(r"<command-args>.*?</command-args>"),
    # Local command infrastructure
    re.compile(r"<local-command-caveat>.*?</local-command-caveat>", re.DOTALL),
    re.compile(r"<local-command-stdout>.*?</local-command-stdout>", re.DOTALL),
    # Tool output file references
    re.compile(r"Read the output file to retrieve the result:.*"),
]

# User messages that are entirely system content (no real user text)
_SYSTEM_ONLY_PREFIXES = [
    "Base directory for this skill:",
    "This session is being continued from a previous conversation",
]


def clean_user_text(text: str) -> str:
    """Strip system-injected noise from user message text.

    Returns the cleaned text (may be empty if it was all noise).
    """
    cleaned = text
    for pattern in _SYSTEM_NOISE_PATTERNS:
        cleaned = pattern.sub("", cleaned)
    # Collapse leftover whitespace
    cleaned = re.sub(r"\n{3,}", "\n\n", cleaned).strip()
    return cleaned


def is_system_noise(text: str) -> bool:
    """Check if a user text block is entirely system noise."""
    cleaned = clean_user_text(text)
    if not cleaned:
        return True
    # Check for known system-only prefixes
    for prefix in _SYSTEM_ONLY_PREFIXES:
        if cleaned.startswith(prefix):
            return True
    return False


def _render_md_table(lines: list[str]) -> str:
    """Convert markdown table lines into an HTML table.

    Expects lines like:
      | Header1 | Header2 |
      |---------|---------|
      | Cell1   | Cell2   |
    """
    def parse_row(line):
        # Strip leading/trailing pipes and split
        cells = [c.strip() for c in line.strip().strip("|").split("|")]
        return cells

    if len(lines) < 2:
        return "\n".join(lines)

    headers = parse_row(lines[0])

    # Check line[1] is the separator (|---|---|)
    if not re.match(r"^\s*\|?[\s:_-]+(\|[\s:_-]+)+\|?\s*$", lines[1]):
        return "\n".join(lines)

    html_parts = ['<table>']
    # Header
    html_parts.append("<thead><tr>")
    for h in headers:
        html_parts.append(f"<th>{h}</th>")
    html_parts.append("</tr></thead>")
    # Body
    html_parts.append("<tbody>")
    for row_line in lines[2:]:
        cells = parse_row(row_line)
        html_parts.append("<tr>")
        for cell in cells:
            html_parts.append(f"<td>{cell}</td>")
        html_parts.append("</tr>")
    html_parts.append("</tbody></table>")
    return "".join(html_parts)


def _process_tables(text: str) -> str:
    """Find and convert markdown tables in text, leaving the rest untouched."""
    lines = text.split("\n")
    result = []
    table_buf = []
    in_table = False

    for line in lines:
        is_table_line = re.match(r"^\s*\|.*\|\s*$", line)
        if is_table_line:
            table_buf.append(line)
            in_table = True
        else:
            if in_table:
                # Flush accumulated table
                result.append(_render_md_table(table_buf))
                table_buf = []
                in_table = False
            result.append(line)

    if table_buf:
        result.append(_render_md_table(table_buf))

    return "\n".join(result)


def _link_filepath(m):
    """Convert a file path match to a clickable file:// link."""
    path = m.group(0)
    href_path = path
    if href_path.startswith("~"):
        import os
        href_path = os.path.expanduser("~") + href_path[1:]
    return f'<a href="file://{href_path}" class="file-link">{path}</a>'


def render_markdown_inline(text: str) -> str:
    """Lightweight markdown-to-HTML for inline formatting.

    Handles: bold, italic, inline code, links, code blocks, tables.
    Not a full parser — just enough for readable conversations.
    """
    # Fenced code blocks first (``` ... ```)
    # Use sentinel markers to avoid false matches when source text contains literal <pre>
    _PRE_OPEN = "\x00PRE_OPEN\x00"
    _PRE_CLOSE = "\x00PRE_CLOSE\x00"

    def replace_code_block(m):
        lang = escape(m.group(1) or "")
        code = escape(m.group(2).strip())
        lang_attr = f' class="language-{lang}"' if lang else ""
        return f'{_PRE_OPEN}<code{lang_attr}>{code}</code>{_PRE_CLOSE}'

    text = re.sub(r"```(\w*)\n(.*?)```", replace_code_block, text, flags=re.DOTALL)

    # Split on sentinel-marked code blocks to avoid processing their contents
    parts = re.split(f"({re.escape(_PRE_OPEN)}.*?{re.escape(_PRE_CLOSE)})", text, flags=re.DOTALL)
    processed = []
    for part in parts:
        if part.startswith(_PRE_OPEN):
            # Replace sentinels with real <pre> tags
            processed.append(part.replace(_PRE_OPEN, "<pre>").replace(_PRE_CLOSE, "</pre>"))
            continue

        # Convert markdown tables before escaping (tables use | which is safe)
        p = _process_tables(part)

        # Split on <table> blocks to avoid escaping table HTML
        table_split = re.split(r"(<table>.*?</table>)", p, flags=re.DOTALL)
        part_pieces = []
        for piece in table_split:
            if piece.startswith("<table>"):
                # Apply inline formatting inside table cells
                piece = re.sub(r"`([^`]+)`", lambda m: f"<code>{escape(m.group(1))}</code>", piece)
                piece = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", piece)
                piece = re.sub(r"(?<!\w)\*([^*]+?)\*(?!\w)", r"<em>\1</em>", piece)
                # Auto-link URLs and file paths in table cells
                piece = re.sub(
                    r'(?<!href=")(?<!">)(https?://[^\s<>\)]+)',
                    r'<a href="\1">\1</a>', piece
                )
                piece = re.sub(
                    r'(?<!["\w])(/(?:Users|private|tmp|var|opt|etc|home)[/\w._-]+(?:\.\w+)?|~/[/\w._-]+(?:\.\w+)?)',
                    _link_filepath, piece
                )
                part_pieces.append(piece)
                continue

            p = escape(piece)

            # Inline code (backticks)
            p = re.sub(r"`([^`]+)`", r"<code>\1</code>", p)

            # Bold **text** or __text__
            p = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", p)
            p = re.sub(r"__(.+?)__", r"<strong>\1</strong>", p)

            # Italic *text* or _text_  (but not inside words with underscores)
            p = re.sub(r"(?<!\w)\*([^*]+?)\*(?!\w)", r"<em>\1</em>", p)
            p = re.sub(r"(?<!\w)_([^_]+?)_(?!\w)", r"<em>\1</em>", p)

            # Links [text](url)
            p = re.sub(r"\[([^\]]+)\]\(([^)]+)\)", r'<a href="\2">\1</a>', p)

            # Auto-link bare URLs (not already inside an <a> tag)
            p = re.sub(
                r'(?<!href=")(?<!">)(https?://[^\s<>\)]+)',
                r'<a href="\1">\1</a>', p
            )

            p = re.sub(
                r'(?<!["\w])(/(?:Users|private|tmp|var|opt|etc|home)[/\w._-]+(?:\.\w+)?|~/[/\w._-]+(?:\.\w+)?)',
                _link_filepath, p
            )

            # Headers (# ... at start of line)
            p = re.sub(r"^#### (.+)$", r"<h6>\1</h6>", p, flags=re.MULTILINE)
            p = re.sub(r"^### (.+)$", r"<h5>\1</h5>", p, flags=re.MULTILINE)
            p = re.sub(r"^## (.+)$", r"<h4>\1</h4>", p, flags=re.MULTILINE)
            p = re.sub(r"^# (.+)$", r"<h3>\1</h3>", p, flags=re.MULTILINE)

            # Horizontal rule
            p = re.sub(r"^---+$", "<hr>", p, flags=re.MULTILINE)

            # Unordered list items (- item) and ordered list items (1. item)
            p = re.sub(r"^- (.+)$", r"<li>\1</li>", p, flags=re.MULTILINE)
            p = re.sub(r"^\d+\.\s+(.+)$", r"<li>\1</li>", p, flags=re.MULTILINE)

            # Wrap consecutive <li> runs in <ul> (or <ol> — using ul for both is fine visually)
            p = re.sub(r"((?:<li>.*?</li>\n?)+)", r"<ul>\1</ul>", p)

            # Line breaks → <br> for consecutive non-blank lines, paragraphs for blank lines
            # But don't add <br> around block elements
            p = re.sub(r"\n\n+", "</p><p>", p)
            p = re.sub(r"\n(?!</?(?:ul|li|h[3-6]|hr|p|table|div))", "<br>\n", p)
            # Clean up stray newlines around block elements
            p = re.sub(r"\n(?=</?(?:ul|li|h[3-6]|hr|table))", "\n", p)

            part_pieces.append(p)

        processed.append("".join(part_pieces))

    return "".join(processed)


def format_timestamp(ts_str: str) -> str:
    """Format ISO timestamp to readable local time."""
    try:
        dt = datetime.fromisoformat(ts_str.replace("Z", "+00:00"))
        local = dt.astimezone()
        return local.strftime("%I:%M %p").lstrip("0")
    except Exception:
        return ""


def build_conversation(input_file: str) -> dict:
    """Parse JSONL into a structured conversation with merged turns.

    Returns dict with metadata and a list of turns, where each turn is:
      { role, timestamp, blocks: [{ type, content, ... }] }
    """
    turns = []
    current_turn = None
    session_id = None
    project_dir = None
    model = None
    start_time = None
    version = None

    with open(input_file, "r", encoding="utf-8") as f:
        for line in f:
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue

            msg_type = obj.get("type")

            # Grab metadata
            if not session_id and obj.get("sessionId"):
                session_id = obj["sessionId"]
            if not project_dir and obj.get("cwd"):
                project_dir = obj["cwd"]
            if not version and obj.get("version"):
                version = obj["version"]

            if msg_type not in ("user", "assistant"):
                continue

            message = obj.get("message", {})
            content = message.get("content", "")
            timestamp = obj.get("timestamp", "")

            if not start_time and timestamp:
                start_time = timestamp

            if not model and message.get("model"):
                model = message["model"]

            # Classify what this message contains
            has_user_text = False
            has_tool_results = False
            parsed_blocks = []

            if isinstance(content, str) and content.strip():
                if msg_type == "user":
                    # Check for slash commands — extract the command for display
                    cmd_match = re.search(r"<command-name>\s*(/[\w-]+)\s*</command-name>", content)
                    cmd_args_match = re.search(r"<command-args>\s*(.*?)\s*</command-args>", content, re.DOTALL)

                    if is_system_noise(content):
                        # Pure system noise — check for slash command to show as label
                        if cmd_match:
                            cmd = cmd_match.group(1)
                            args = cmd_args_match.group(1).strip() if cmd_args_match else ""
                            label = f"{cmd} {args}".strip() if args else cmd
                            parsed_blocks.append({"type": "slash_command", "command": label})
                            has_user_text = True
                        # Session continuation — show as collapsible divider with full summary
                        elif content.strip().startswith("This session is being continued"):
                            parsed_blocks.append({"type": "session_continuation", "text": content.strip()})
                            has_user_text = True
                        # Otherwise skip entirely
                    else:
                        cleaned = clean_user_text(content)
                        if cleaned:
                            has_user_text = True
                            parsed_blocks.append({"type": "text", "text": cleaned})
                else:
                    has_user_text = True
                    parsed_blocks.append({"type": "text", "text": content})
            elif isinstance(content, list):
                for item in content:
                    if not isinstance(item, dict):
                        continue
                    block_type = item.get("type", "")

                    if block_type == "text":
                        text = item.get("text", "")
                        if text.strip():
                            if msg_type == "user":
                                if is_system_noise(text):
                                    continue  # Skip skill prompts, system noise
                                cleaned = clean_user_text(text)
                                if cleaned:
                                    has_user_text = True
                                    parsed_blocks.append({"type": "text", "text": cleaned})
                            else:
                                has_user_text = True
                                parsed_blocks.append({"type": "text", "text": text})

                    elif block_type == "thinking":
                        thinking = item.get("thinking", "")
                        if thinking.strip():
                            parsed_blocks.append(
                                {"type": "thinking", "text": thinking}
                            )

                    elif block_type == "tool_use":
                        parsed_blocks.append(
                            {
                                "type": "tool_use",
                                "name": item.get("name", "unknown"),
                                "input": item.get("input", {}),
                                "id": item.get("id", ""),
                            }
                        )

                    elif block_type == "tool_result":
                        has_tool_results = True
                        result_content = item.get("content", "")
                        is_error = item.get("is_error", False)
                        # Extract text from content block arrays
                        if isinstance(result_content, list):
                            text_parts = []
                            meta_parts = []
                            for rc in result_content:
                                if isinstance(rc, dict) and rc.get("type") == "text":
                                    t = rc.get("text", "")
                                    if t.strip().startswith("agentId:") or t.strip().startswith("<usage>"):
                                        meta_parts.append(t)
                                    else:
                                        text_parts.append(t)
                                elif isinstance(rc, str):
                                    text_parts.append(rc)
                            result_text = "\n".join(text_parts)
                            meta_text = "\n".join(meta_parts) if meta_parts else None
                        else:
                            result_text = result_content if isinstance(result_content, str) else str(result_content)
                            meta_text = None
                        parsed_blocks.append(
                            {
                                "type": "tool_result",
                                "content": result_text,
                                "meta": meta_text,
                                "is_error": is_error,
                                "tool_use_id": item.get("tool_use_id", ""),
                            }
                        )

            # Decide which turn to attach these blocks to.
            # User messages that are ONLY tool_results (no human text) get folded
            # into the preceding assistant turn — they're responses to tool_use calls.
            if msg_type == "user" and has_tool_results and not has_user_text:
                # Attach to the last assistant turn if one exists
                if current_turn and current_turn["role"] == "assistant":
                    current_turn["blocks"].extend(parsed_blocks)
                    continue
                # Otherwise fall through and create a new turn

            role = msg_type

            # Merge consecutive messages from the same role into one turn
            if current_turn and current_turn["role"] == role:
                current_turn["blocks"].extend(parsed_blocks)
            else:
                current_turn = {
                    "role": role,
                    "timestamp": timestamp,
                    "blocks": parsed_blocks,
                }
                turns.append(current_turn)

    return {
        "session_id": session_id,
        "project_dir": project_dir,
        "model": model,
        "version": version,
        "start_time": start_time,
        "turns": turns,
    }


def render_tool_use(block: dict) -> str:
    """Render a tool_use block to HTML."""
    name = escape(block["name"])
    inp = block.get("input", {})

    # Build a concise summary line
    summary = ""
    if name in ("Read", "Glob", "Grep"):
        target = inp.get("file_path") or inp.get("pattern") or inp.get("path") or ""
        summary = escape(str(target))
    elif name == "Bash":
        cmd = str(inp.get("command", ""))
        desc = inp.get("description", "")
        summary = escape(desc if desc else cmd[:200])
    elif name in ("Edit", "Write"):
        summary = escape(str(inp.get("file_path", "")))
    elif name == "Agent":
        summary = escape(str(inp.get("description", "")))
    else:
        # For MCP tools and others, show first meaningful field
        for key in ("query", "prompt", "url", "pattern", "message"):
            if key in inp:
                summary = escape(str(inp[key])[:150])
                break

    # Full input as collapsed detail
    full_input = escape(json.dumps(inp, indent=2, ensure_ascii=False))

    return f"""<div class="tool-use">
  <div class="tool-header" onclick="this.parentElement.classList.toggle('expanded')">
    <span class="tool-icon">&#9881;</span>
    <span class="tool-name">{name}</span>
    {f'<span class="tool-summary">{summary}</span>' if summary else ''}
    <span class="tool-expand">&#9660;</span>
  </div>
  <pre class="tool-detail">{full_input}</pre>
</div>"""


def render_tool_result(block: dict) -> str:
    """Render a tool_result block to HTML."""
    content = block.get("content", "")
    meta = block.get("meta")
    is_error = block.get("is_error", False)
    error_class = " tool-error" if is_error else ""

    # Agent results with real content get rendered as markdown text
    # (these are subagent reports that are meant to be read)
    if len(content) > 500 and not content.lstrip().startswith(("{", "[")):
        rendered = render_markdown_inline(content)
        meta_html = ""
        if meta:
            meta_escaped = escape(meta)
            meta_html = f'<div class="tool-result-meta">{meta_escaped}</div>'
        return f"""<div class="tool-result agent-result{error_class}">
  <div class="tool-result-header" onclick="this.parentElement.classList.toggle('expanded')">
    <span class="tool-icon">&#9654;</span>
    <span>{'Error' if is_error else 'Result'} ({len(content):,} chars)</span>
    <span class="tool-expand">&#9660;</span>
  </div>
  <div class="tool-result-rendered"><p>{rendered}</p></div>
  {meta_html}
</div>"""

    # Short or structured results: show as preformatted text
    display = escape(content)
    meta_html = ""
    if meta:
        meta_escaped = escape(meta)
        meta_html = f'<div class="tool-result-meta">{meta_escaped}</div>'

    if len(content) > 2000:
        preview = escape(content[:2000])
        return f"""<div class="tool-result{error_class}">
  <div class="tool-result-header" onclick="this.parentElement.classList.toggle('expanded')">
    <span class="tool-icon">&#9654;</span>
    <span>{'Error' if is_error else 'Result'} ({len(content):,} chars)</span>
    <span class="tool-expand">&#9660;</span>
  </div>
  <pre class="tool-result-preview">{preview}…</pre>
  <pre class="tool-result-full">{display}</pre>
  {meta_html}
</div>"""
    else:
        return f"""<div class="tool-result{error_class}">
  <div class="tool-result-header" onclick="this.parentElement.classList.toggle('expanded')">
    <span class="tool-icon">&#9654;</span>
    <span>{'Error' if is_error else 'Result'}</span>
    <span class="tool-expand">&#9660;</span>
  </div>
  <pre class="tool-result-preview">{display}</pre>
  {meta_html}
</div>"""


def render_turn(turn: dict, turn_index: int, include_thinking: bool, include_tools: bool) -> tuple:
    """Render a full turn to HTML.

    Returns (html_string, toc_entry_or_None).
    toc_entry is a dict with {id, role, timestamp, preview} for user turns.
    """
    role = turn["role"]
    timestamp = format_timestamp(turn.get("timestamp", ""))
    blocks_html = []
    first_text = ""

    text_block_idx = 0
    for block in turn["blocks"]:
        btype = block["type"]

        if btype == "text":
            rendered = render_markdown_inline(block["text"])
            blocks_html.append(f'<div class="message-text" data-block-index="{text_block_idx}"><p>{rendered}</p></div>')
            text_block_idx += 1
            if not first_text:
                first_text = block["text"]

        elif btype == "slash_command":
            cmd = escape(block["command"])
            blocks_html.append(f'<div class="slash-command"><span class="slash-cmd">{cmd}</span></div>')
            if not first_text:
                first_text = block["command"]

        elif btype == "session_continuation":
            summary = render_markdown_inline(block.get("text", ""))
            blocks_html.append(
                f'<details class="session-divider">'
                f'<summary><span>Session continued</span></summary>'
                f'<div class="session-summary"><p>{summary}</p></div>'
                f'</details>'
            )
            if not first_text:
                first_text = "--- Session continued ---"

        elif btype == "thinking" and include_thinking:
            text = escape(block["text"])
            blocks_html.append(
                f'<details class="thinking"><summary>Thinking</summary>'
                f"<pre>{text}</pre></details>"
            )

        elif btype == "tool_use" and include_tools:
            blocks_html.append(render_tool_use(block))

        elif btype == "tool_result" and include_tools:
            blocks_html.append(render_tool_result(block))

    # Skip turns with no visible content
    if not blocks_html:
        return "", None

    turn_id = f"turn-{turn_index}"
    content = "\n".join(blocks_html)
    label = "You" if role == "user" else "Claude"
    ts_html = f'<span class="timestamp">{timestamp}</span>' if timestamp else ""

    html = f"""<div class="turn {role}" id="{turn_id}">
  <div class="turn-header">
    <span class="role-label">{label}</span>
    {ts_html}
  </div>
  <div class="turn-body">
    {content}
  </div>
</div>"""

    # Build TOC entry for user turns
    toc_entry = {
        "id": turn_id,
        "role": role,
        "label": label,
        "timestamp": timestamp,
        "preview": first_text.replace("\n", " ").strip()[:120] if first_text else "",
    }

    return html, toc_entry


HTML_TEMPLATE = """\
<!DOCTYPE html>
<html lang="en">
{meta_comment}
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>{title}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  :root {{
    --bg: #0d1117;
    --surface: #161b22;
    --surface2: #21262d;
    --border: #30363d;
    --border-subtle: #21262d;
    --text: #e6edf3;
    --text-muted: #9eaab8;
    --text-tertiary: #7a8595;
    --user-bg: rgba(45, 212, 191, 0.08);
    --user-border: #2dd4bf;
    --user-label: #5eead4;
    --assistant-bg: rgba(218, 119, 86, 0.08);
    --assistant-border: #da7756;
    --assistant-label: #e8956e;
    --code-bg: #0d1117;
    --tool-bg: rgba(63, 185, 80, 0.05);
    --tool-border: #30363d;
    --result-bg: rgba(56, 139, 253, 0.05);
    --result-border: #30363d;
    --error-border: #f85149;
    --error-bg: rgba(248, 81, 73, 0.08);
    --accent: #6e79d6;
    --accent-hover: #8b93db;
    --accent-subtle: rgba(110, 121, 214, 0.12);
    --thinking-bg: #161b22;
    --tab-bg: rgba(255, 255, 255, 0.06);
    --tab-hover: rgba(255, 255, 255, 0.10);
  }}

  @media (prefers-color-scheme: light) {{
    html:not([data-theme="dark"]) {{
      --bg: #f7f7f8;
      --surface: #ffffff;
      --surface2: #ececef;
      --border: #e0e0e4;
      --border-subtle: #ececef;
      --text: #111111;
      --text-muted: #555555;
      --text-tertiary: #888888;
      --user-bg: rgba(13, 148, 136, 0.06);
      --user-border: #0d9488;
      --user-label: #0f766e;
      --assistant-bg: rgba(218, 119, 86, 0.06);
      --assistant-border: #da7756;
      --assistant-label: #c4633e;
      --code-bg: #f0f0f3;
      --tool-bg: rgba(22, 163, 74, 0.05);
      --tool-border: #e0e0e4;
      --result-bg: rgba(37, 99, 235, 0.04);
      --result-border: #e0e0e4;
      --error-border: #dc2626;
      --error-bg: rgba(220, 38, 38, 0.06);
      --accent: #4f46e5;
      --accent-hover: #4338ca;
      --accent-subtle: rgba(79, 70, 229, 0.08);
      --thinking-bg: #f5f5f7;
      --tab-bg: rgba(0, 0, 0, 0.04);
      --tab-hover: rgba(0, 0, 0, 0.07);
    }}
  }}

  /* Manual light mode override */
  html[data-theme="light"] {{
    --bg: #f7f7f8;
    --surface: #ffffff;
    --surface2: #ececef;
    --border: #e0e0e4;
    --border-subtle: #ececef;
    --text: #111111;
    --text-muted: #555555;
    --text-tertiary: #888888;
    --user-bg: rgba(13, 148, 136, 0.06);
    --user-border: #0d9488;
    --user-label: #0f766e;
    --assistant-bg: rgba(218, 119, 86, 0.06);
    --assistant-border: #da7756;
    --assistant-label: #c4633e;
    --code-bg: #f0f0f3;
    --tool-bg: rgba(22, 163, 74, 0.05);
    --tool-border: #e0e0e4;
    --result-bg: rgba(37, 99, 235, 0.04);
    --result-border: #e0e0e4;
    --error-border: #dc2626;
    --error-bg: rgba(220, 38, 38, 0.06);
    --accent: #4f46e5;
    --accent-hover: #4338ca;
    --accent-subtle: rgba(79, 70, 229, 0.08);
    --thinking-bg: #f5f5f7;
    --tab-bg: rgba(0, 0, 0, 0.04);
    --tab-hover: rgba(0, 0, 0, 0.07);
  }}

  * {{ margin: 0; padding: 0; box-sizing: border-box; }}

  body {{
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
    background: var(--bg);
    color: var(--text);
    line-height: 1.55;
    padding: 0;
    font-size: 14px;
    -webkit-font-smoothing: antialiased;
  }}

  .header {{
    background: var(--surface);
    border-bottom: 1px solid var(--border);
    padding: 20px 24px;
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
  }}

  .header-left {{ flex: 1; min-width: 0; }}

  .header h1 {{
    font-size: 18px;
    font-weight: 600;
    margin-bottom: 6px;
    letter-spacing: -0.03em;
  }}

  .header .meta {{
    font-size: 12px;
    color: var(--text-muted);
    display: flex;
    gap: 20px;
    flex-wrap: wrap;
  }}

  .controls {{
    background: var(--surface);
    border-bottom: 1px solid var(--border);
    padding: 8px 24px;
    display: flex;
    justify-content: space-between;
    font-size: 13px;
    position: sticky;
    top: 0;
    z-index: 99;
    align-items: center;
  }}

  .controls-left {{ display: flex; align-items: center; gap: 12px; }}
  .controls-right {{ display: flex; align-items: center; gap: 10px; }}

  .controls label {{
    cursor: pointer;
    color: var(--text-muted);
    user-select: none;
    font-size: 13px;
    font-weight: 500;
  }}

  .controls input[type="checkbox"] {{
    margin-right: 4px;
  }}

  .toc-toggle {{
    background: var(--tab-bg);
    border: none;
    color: var(--text-muted);
    padding: 5px 12px;
    border-radius: 6px;
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    white-space: nowrap;
    font-family: inherit;
    transition: all 0.1s ease;
  }}
  .toc-toggle:hover {{ background: var(--tab-hover); color: var(--text); }}

  #theme-toggle {{
    background: var(--tab-bg);
    border: none;
    color: var(--text-muted);
    padding: 6px 10px;
    border-radius: 6px;
    font-size: 16px;
    cursor: pointer;
    transition: all 0.1s ease;
    line-height: 1;
    flex-shrink: 0;
    margin-top: 2px;
  }}
  #theme-toggle:hover {{ background: var(--tab-hover); color: var(--text); }}

  /* Settings dropdown */
  .settings-menu {{ position: relative; }}
  .settings-toggle {{
    background: var(--tab-bg);
    border: none;
    color: var(--text-muted);
    padding: 5px 10px;
    border-radius: 6px;
    font-size: 15px;
    cursor: pointer;
    transition: all 0.1s ease;
    line-height: 1;
  }}
  .settings-toggle:hover {{ background: var(--tab-hover); color: var(--text); }}
  .settings-dropdown {{
    display: none;
    position: absolute;
    right: 0;
    top: calc(100% + 6px);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 8px 12px;
    box-shadow: 0 4px 12px rgba(0,0,0,0.15);
    z-index: 200;
    white-space: nowrap;
  }}
  .settings-menu.open .settings-dropdown {{ display: flex; flex-direction: column; gap: 6px; }}
  .settings-dropdown label {{
    cursor: pointer;
    color: var(--text-muted);
    user-select: none;
    font-size: 13px;
    font-weight: 500;
    padding: 2px 0;
  }}

  .conversation {{
    max-width: 100%;
    margin: 0 auto;
    padding: 12px 24px 60px;
  }}

  .turn {{
    margin: 8px 0;
    border-radius: 8px;
    overflow: hidden;
    border: 1px solid var(--border);
    background: var(--surface);
  }}

  .turn.user {{
    background: var(--user-bg);
    border-left: 3px solid var(--user-border);
  }}

  .turn.assistant {{
    background: var(--assistant-bg);
    border-left: 3px solid var(--assistant-border);
  }}

  .turn-header {{
    padding: 8px 16px;
    display: flex;
    justify-content: space-between;
    align-items: center;
  }}

  .role-label {{
    font-weight: 600;
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }}

  .user .role-label {{ color: var(--user-label); }}
  .assistant .role-label {{ color: var(--assistant-label); }}

  .timestamp {{
    font-size: 11px;
    color: var(--text-tertiary);
  }}

  .turn-body {{
    padding: 4px 16px 14px;
  }}

  .message-text {{
    font-size: 14px;
    line-height: 1.65;
  }}

  .message-text p {{ margin-bottom: 8px; }}
  .message-text h3, .message-text h4, .message-text h5, .message-text h6 {{
    margin: 12px 0 4px;
    letter-spacing: -0.01em;
  }}
  .message-text li, .tool-result-rendered li {{ margin-left: 20px; line-height: 1.55; }}
  .message-text ul, .tool-result-rendered ul {{ margin: 4px 0; padding: 0; }}
  .message-text hr {{ border: none; border-top: 1px solid var(--border); margin: 12px 0; }}

  .message-text table, .tool-result-rendered table {{
    width: 100%;
    border-collapse: collapse;
    margin: 8px 0;
    font-size: 13px;
  }}
  .message-text th, .tool-result-rendered th {{
    text-align: left;
    padding: 8px 12px;
    background: var(--surface2);
    border: 1px solid var(--border);
    font-weight: 600;
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    color: var(--text-muted);
  }}
  .message-text td, .tool-result-rendered td {{
    padding: 6px 12px;
    border: 1px solid var(--border);
    vertical-align: top;
  }}
  .message-text tr:hover, .tool-result-rendered tr:hover {{
    background: var(--surface2);
  }}

  .message-text code {{
    background: var(--code-bg);
    padding: 2px 5px;
    border-radius: 3px;
    font-size: 12px;
    font-family: 'SF Mono', 'Fira Code', monospace;
    border: 1px solid var(--border);
  }}

  .message-text pre {{
    background: var(--code-bg);
    padding: 14px;
    border-radius: 6px;
    overflow-x: auto;
    margin: 8px 0;
    font-size: 13px;
    line-height: 1.5;
    border: 1px solid var(--border);
  }}

  .message-text pre code {{
    background: none;
    padding: 0;
    font-size: inherit;
    border: none;
  }}

  .message-text a {{
    color: var(--accent);
    text-decoration: none;
  }}
  .message-text a:hover, .tool-result-rendered a:hover {{ text-decoration: underline; }}

  a.file-link {{
    color: var(--accent);
    text-decoration: none;
    border-bottom: 1px dashed var(--accent);
    font-family: 'SF Mono', 'Fira Code', monospace;
    font-size: 12px;
  }}
  a.file-link:hover {{
    border-bottom-style: solid;
  }}

  /* Tool use */
  .tool-use {{
    background: var(--tool-bg);
    border: 1px solid var(--border);
    border-radius: 6px;
    margin: 6px 0;
    font-size: 13px;
  }}

  .tool-header {{
    padding: 6px 12px;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 8px;
    user-select: none;
    transition: background 0.1s;
  }}

  .tool-header:hover {{ background: var(--tab-hover); }}

  .tool-icon {{ font-size: 13px; }}
  .tool-name {{ font-weight: 600; font-family: 'SF Mono', 'Fira Code', monospace; font-size: 12px; }}
  .tool-summary {{
    color: var(--text-tertiary);
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 12px;
  }}
  .tool-expand {{
    font-size: 9px;
    transition: transform 0.2s;
    color: var(--text-muted);
  }}
  .tool-use.expanded .tool-expand {{ transform: rotate(180deg); }}

  .tool-detail {{
    display: none;
    padding: 12px;
    background: var(--code-bg);
    border-top: 1px solid var(--border);
    font-size: 12px;
    max-height: 400px;
    overflow: auto;
    white-space: pre-wrap;
    word-break: break-word;
    font-family: 'SF Mono', 'Fira Code', monospace;
  }}
  .tool-use.expanded .tool-detail {{ display: block; }}

  /* Tool result */
  .tool-result {{
    background: var(--result-bg);
    border: 1px solid var(--border);
    border-radius: 6px;
    margin: 4px 0;
    font-size: 13px;
  }}

  .tool-result.tool-error {{
    border-color: var(--error-border);
    background: var(--error-bg);
  }}

  .tool-result-header {{
    padding: 4px 12px;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 6px;
    user-select: none;
    color: var(--text-tertiary);
    font-size: 12px;
    transition: background 0.1s;
  }}
  .tool-result-header:hover {{ background: var(--tab-hover); }}

  .tool-result-preview {{
    display: block;
    padding: 8px 12px;
    border-top: 1px solid var(--border);
    font-size: 12px;
    max-height: 150px;
    overflow: hidden;
    white-space: pre-wrap;
    word-break: break-word;
    color: var(--text-muted);
    font-family: 'SF Mono', 'Fira Code', monospace;
  }}

  .tool-result-full {{
    display: none;
    padding: 8px 12px;
    border-top: 1px solid var(--border);
    font-size: 12px;
    max-height: 500px;
    overflow: auto;
    white-space: pre-wrap;
    word-break: break-word;
    font-family: 'SF Mono', 'Fira Code', monospace;
  }}

  .tool-result.expanded .tool-result-preview {{ display: none; }}
  .tool-result.expanded .tool-result-full {{ display: block; }}

  /* Thinking */
  .thinking {{
    margin: 6px 0;
    border: 1px solid var(--border);
    border-radius: 6px;
    font-size: 13px;
  }}

  .thinking summary {{
    padding: 6px 12px;
    cursor: pointer;
    font-weight: 500;
    color: var(--text-tertiary);
    font-size: 12px;
    user-select: none;
    transition: color 0.1s;
  }}
  .thinking summary:hover {{ color: var(--text-muted); }}

  .thinking pre {{
    padding: 12px;
    background: var(--thinking-bg);
    max-height: 400px;
    overflow: auto;
    white-space: pre-wrap;
    word-break: break-word;
    font-size: 12px;
    line-height: 1.55;
  }}

  /* Agent result rendered as readable text — collapsed by default */
  .agent-result .tool-result-rendered {{
    display: none;
    padding: 12px;
    font-size: 14px;
    line-height: 1.65;
    max-height: 600px;
    overflow: auto;
  }}
  .agent-result.expanded .tool-result-rendered {{ display: block; max-height: none; }}

  .agent-result .tool-result-rendered pre {{
    background: var(--code-bg);
    padding: 12px;
    border-radius: 6px;
    overflow-x: auto;
    margin: 8px 0;
    font-size: 12px;
    border: 1px solid var(--border);
  }}

  .agent-result .tool-result-rendered code {{
    background: var(--code-bg);
    padding: 2px 5px;
    border-radius: 3px;
    font-size: 12px;
    font-family: 'SF Mono', 'Fira Code', monospace;
  }}

  .agent-result .tool-result-rendered pre code {{
    background: none;
    padding: 0;
    border: none;
  }}

  .tool-result-meta {{
    display: none;
    padding: 4px 12px;
    font-size: 11px;
    color: var(--text-tertiary);
    border-top: 1px solid var(--border);
    font-family: 'SF Mono', 'Fira Code', monospace;
    white-space: pre-wrap;
  }}
  .tool-result.expanded .tool-result-meta {{ display: block; }}

  /* Slash commands */
  .slash-command {{
    padding: 4px 0;
  }}
  .slash-cmd {{
    font-family: 'SF Mono', 'Fira Code', monospace;
    background: var(--accent-subtle);
    padding: 3px 8px;
    border-radius: 4px;
    font-size: 13px;
    color: var(--accent);
    font-weight: 500;
  }}

  /* Session continuation divider */
  .session-divider {{
    text-align: center;
    padding: 16px 0;
    color: var(--text-muted);
    font-size: 12px;
  }}
  .session-divider summary {{
    cursor: pointer;
    list-style: none;
    user-select: none;
  }}
  .session-divider summary::-webkit-details-marker {{ display: none; }}
  .session-divider summary span {{
    background: var(--surface);
    padding: 4px 14px;
    border-radius: 20px;
    border: 1px solid var(--border);
    font-weight: 500;
    transition: all 0.1s ease;
  }}
  .session-divider summary:hover span {{
    border-color: var(--text-muted);
    background: var(--surface2);
  }}
  .session-summary {{
    text-align: left;
    font-size: 13px;
    line-height: 1.55;
    padding: 14px;
    margin-top: 10px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    max-height: 500px;
    overflow: auto;
  }}

  /* Toggle visibility */
  body.hide-tools .tool-use,
  body.hide-tools .tool-result {{ display: none; }}
  body.hide-thinking .thinking {{ display: none; }}
  body.hide-tagging .kind-chips,
  body.hide-tagging .tags-row,
  body.hide-tagging .hl-kind-badge,
  body.hide-tagging .hl-item-tags {{ display: none; }}

  /* ── TOC Sidebar ── */
  .toc-panel {{
    position: fixed;
    top: 0; left: 0; bottom: 0;
    width: 340px;
    background: var(--surface);
    border-right: 1px solid var(--border);
    z-index: 300;
    display: none;
    flex-direction: column;
    box-shadow: 4px 0 24px rgba(0,0,0,0.15);
  }}
  .toc-panel.visible {{ display: flex; }}

  /* Slide page content right when TOC is open */
  .header, .controls, .conversation {{
    transition: margin-left 0.2s ease;
  }}
  body.toc-open .header,
  body.toc-open .controls,
  body.toc-open .conversation {{
    margin-left: 340px;
  }}
  .toc-panel-header {{
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 14px 16px;
    border-bottom: 1px solid var(--border);
  }}
  .toc-panel-header h3 {{ font-size: 14px; font-weight: 600; margin: 0; letter-spacing: -0.01em; }}
  .toc-panel-header button {{
    background: none; border: none; color: var(--text-tertiary); cursor: pointer; font-size: 16px;
    transition: color 0.1s;
  }}
  .toc-panel-header button:hover {{ color: var(--text); }}
  .toc-filter {{
    padding: 8px 12px;
    border-bottom: 1px solid var(--border);
    display: flex;
    gap: 6px;
  }}
  .toc-filter button {{
    padding: 4px 10px;
    border-radius: 6px;
    border: none;
    background: var(--tab-bg);
    color: var(--text-muted);
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
    font-family: inherit;
    transition: all 0.1s ease;
  }}
  .toc-filter button:hover:not(.active) {{ background: var(--tab-hover); color: var(--text); }}
  .toc-filter button.active {{ background: var(--text); color: var(--bg); }}
  .toc-body {{
    flex: 1;
    overflow-y: auto;
    padding: 8px;
  }}
  .toc-item {{
    padding: 6px 10px;
    border-radius: 6px;
    cursor: pointer;
    margin-bottom: 2px;
    transition: background 0.1s;
  }}
  .toc-item:hover {{ background: var(--tab-hover); }}
  .toc-item-header {{
    display: flex;
    justify-content: space-between;
    align-items: center;
  }}
  .toc-role {{
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }}
  .toc-user .toc-role {{ color: var(--user-label); }}
  .toc-assistant .toc-role {{ color: var(--assistant-label); }}
  .toc-time {{
    font-size: 10px;
    color: var(--text-tertiary);
  }}
  .toc-item-preview {{
    font-size: 12px;
    color: var(--text-muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    line-height: 1.4;
  }}
  .toc-user .toc-item-preview {{ color: var(--text); }}

  /* ── Annotations ── */
  mark[data-annotation-id] {{
    background: var(--accent-subtle);
    border-bottom: 2px solid var(--accent);
    cursor: pointer;
    border-radius: 2px;
    padding: 0 1px;
    transition: background 0.15s;
  }}
  /* Hide marks wrapping whitespace between list items */
  ul > mark[data-annotation-id],
  ol > mark[data-annotation-id] {{
    border-bottom: none;
    background: none;
    padding: 0;
  }}
  mark[data-annotation-id]:hover,
  mark[data-annotation-id].active {{
    background: rgba(94, 106, 210, 0.25);
  }}

  .controls-right > button {{
    background: var(--tab-bg);
    border: none;
    color: var(--text-muted);
    padding: 5px 12px;
    border-radius: 6px;
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    white-space: nowrap;
    font-family: inherit;
    transition: all 0.1s ease;
  }}
  .controls-right > button:hover {{ background: var(--tab-hover); color: var(--text); }}
  .controls-right > button:disabled {{ opacity: 0.3; cursor: default; }}
  .controls-right > .count {{
    font-size: 12px;
    color: var(--text-tertiary);
  }}

  /* Comment popover */
  .comment-popover {{
    position: absolute;
    z-index: 200;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 10px;
    width: 320px;
    box-shadow: 0 8px 30px rgba(0,0,0,0.2);
    display: none;
  }}
  .comment-popover.visible {{ display: block; }}
  .comment-popover textarea {{
    width: 100%;
    min-height: 60px;
    background: var(--bg);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 8px;
    font-size: 13px;
    font-family: inherit;
    resize: vertical;
  }}
  .comment-popover .comment-actions {{
    display: flex;
    justify-content: space-between;
    margin-top: 6px;
    gap: 6px;
  }}
  .comment-popover .comment-actions button {{
    padding: 4px 10px;
    border-radius: 6px;
    border: none;
    background: var(--tab-bg);
    color: var(--text);
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
    font-family: inherit;
  }}
  .comment-popover .comment-actions button.save {{ background: var(--accent); color: #fff; }}
  .comment-popover .comment-actions button:hover {{ opacity: 0.85; }}
  .comment-popover .comment-preview {{
    font-size: 12px;
    color: var(--text-tertiary);
    margin-bottom: 6px;
    font-style: italic;
    max-height: 40px;
    overflow: hidden;
    text-overflow: ellipsis;
  }}

  /* Kind chips */
  .kind-chips {{
    display: flex;
    gap: 5px;
    flex-wrap: wrap;
    margin-bottom: 6px;
  }}
  .kind-chip {{
    font-size: 11px;
    padding: 2px 8px;
    border-radius: 10px;
    border: 1px solid var(--border);
    background: transparent;
    color: var(--text2);
    cursor: pointer;
    font-family: inherit;
    transition: all 0.15s;
  }}
  .kind-chip:hover {{ background: var(--surface2); }}
  .kind-chip.active {{
    background: var(--accent);
    color: #fff;
    border-color: var(--accent);
  }}
  .tags-row input {{
    width: 100%;
    font-size: 12px;
    padding: 5px 8px;
    border-radius: 5px;
    border: 1px solid var(--border);
    background: var(--surface2);
    color: var(--text);
    font-family: inherit;
    margin-bottom: 6px;
    outline: none;
  }}
  .tags-row input:focus {{ border-color: var(--accent); }}

  /* Kind badge in highlights panel */
  .hl-kind-badge {{
    font-size: 10px;
    padding: 1px 6px;
    border-radius: 8px;
    background: var(--surface2);
    color: var(--text2);
    margin-left: 6px;
  }}

  /* Export panel */
  .export-panel {{
    display: none;
    position: fixed;
    top: 0; right: 0; bottom: 0;
    width: 380px;
    background: var(--surface);
    border-left: 1px solid var(--border);
    z-index: 300;
    flex-direction: column;
    box-shadow: -4px 0 24px rgba(0,0,0,0.15);
  }}
  .export-panel.visible {{ display: flex; }}

  body.highlights-open .header,
  body.highlights-open .controls,
  body.highlights-open .conversation {{
    margin-right: 380px;
  }}
  .export-panel-header {{
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 14px 16px;
    border-bottom: 1px solid var(--border);
  }}
  .export-panel-header h3 {{ font-size: 14px; font-weight: 600; letter-spacing: -0.01em; }}
  .export-panel-header button {{
    background: none; border: none; color: var(--text-tertiary); cursor: pointer; font-size: 16px;
    transition: color 0.1s;
  }}
  .export-panel-header button:hover {{ color: var(--text); }}
  .export-panel-body {{
    flex: 1;
    overflow: auto;
    padding: 8px;
  }}
  .hl-item {{
    padding: 8px 12px;
    border-radius: 6px;
    cursor: pointer;
    margin-bottom: 4px;
    border-left: 3px solid var(--accent);
    background: var(--bg);
    transition: background 0.1s;
  }}
  .hl-item:hover {{ background: var(--tab-hover); }}
  .hl-delete {{
    background: none; border: none; color: var(--text-tertiary); cursor: pointer;
    font-size: 16px; line-height: 1; padding: 0 2px; opacity: 0;
    transition: opacity 0.1s, color 0.1s;
  }}
  .hl-item:hover .hl-delete {{ opacity: 1; }}
  .hl-delete:hover {{ color: var(--error-border); }}
  .hl-item-header {{
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 2px;
  }}
  .hl-item-role {{
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    color: var(--text-tertiary);
    letter-spacing: 0.04em;
  }}
  .hl-item-time {{
    font-size: 10px;
    color: var(--text-tertiary);
  }}
  .hl-item-text {{
    font-size: 13px;
    color: var(--text);
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    line-height: 1.45;
  }}
  .hl-item-comment {{
    font-size: 12px;
    color: var(--accent);
    margin-top: 4px;
    font-style: italic;
  }}
  .hl-item-tags {{
    display: flex;
    gap: 4px;
    flex-wrap: wrap;
    margin-top: 4px;
  }}
  .hl-tag {{
    font-size: 10px;
    padding: 1px 6px;
    border-radius: 6px;
    background: var(--surface2);
    color: var(--text2);
  }}
  .hl-empty {{
    text-align: center;
    color: var(--text-tertiary);
    font-size: 13px;
    padding: 30px 16px;
  }}
  .export-panel-footer {{
    padding: 10px 16px;
    border-top: 1px solid var(--border);
    display: flex;
    gap: 8px;
    justify-content: flex-end;
  }}
  .export-panel-footer button {{
    padding: 6px 14px;
    border-radius: 6px;
    border: none;
    background: var(--tab-bg);
    color: var(--text);
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    font-family: inherit;
    transition: all 0.1s;
  }}
  .export-panel-footer button:hover {{ background: var(--tab-hover); }}
  .export-panel-footer button.primary {{ background: var(--accent); color: #fff; }}
  .export-panel-footer button.primary:hover {{ opacity: 0.85; }}
  .export-panel-footer button.primary {{ background: var(--accent); color: #fff; }}
  .export-panel-footer button.primary:hover {{ background: var(--accent-hover); }}
</style>
</head>
<body class="hide-tools hide-thinking hide-tagging">
<div class="header">
  <div class="header-left">
    <h1>{title}</h1>
    <div class="meta">
      {meta_html}
    </div>
  </div>
  <button id="theme-toggle" onclick="cycleTheme()" title="Toggle dark/light mode">&#9790;</button>
</div>
<div class="controls">
  <div class="controls-left">
    <button class="toc-toggle" onclick="toggleToc()" title="Table of Contents">&#9776; TOC</button>
  </div>
  <div class="controls-right">
    <button id="btn-highlight" onclick="annotate()" disabled title="Select text then press h, or click this button">Highlight</button>
    <button id="btn-export" onclick="toggleExport()">Highlights</button>
    <span class="count" id="annotation-count"></span>
    <span style="border-left: 1px solid var(--border); height: 16px;"></span>
    <div class="settings-menu">
      <button class="settings-toggle" onclick="this.parentElement.classList.toggle('open')" title="Display settings">&#9881;</button>
      <div class="settings-dropdown">
        <label><input type="checkbox" id="toggle-tools" onchange="document.body.classList.toggle('hide-tools', !this.checked)"> Show tools</label>
        <label><input type="checkbox" id="toggle-thinking" onchange="document.body.classList.toggle('hide-thinking', !this.checked)"> Show thinking</label>
        <label><input type="checkbox" id="toggle-tagging" onchange="document.body.classList.toggle('hide-tagging', !this.checked)"> Tags &amp; kinds</label>
      </div>
    </div>
  </div>
</div>

<div class="toc-panel" id="toc-panel">
  <div class="toc-panel-header">
    <h3>Table of Contents</h3>
    <button onclick="toggleToc()">&#10005;</button>
  </div>
  <div class="toc-filter">
    <button class="active" onclick="filterToc('all', this)">All</button>
    <button onclick="filterToc('user', this)">You</button>
    <button onclick="filterToc('assistant', this)">Claude</button>
  </div>
  <div class="toc-body" id="toc-body">
    {toc_html}
  </div>
</div>
<div class="conversation">
{conversation_html}
</div>

<div class="comment-popover" id="comment-popover">
  <div class="comment-preview" id="comment-preview"></div>
  <div class="kind-chips" id="kind-chips"></div>
  <div class="tags-row">
    <input type="text" id="tags-input" placeholder="Tags (comma-separated)">
  </div>
  <textarea id="comment-input" placeholder="Add a comment..." rows="3"></textarea>
  <div class="comment-actions">
    <button onclick="removeAnnotation()">Remove</button>
    <div>
      <button onclick="closePopover()">Cancel</button>
      <button class="save" onclick="saveComment()">Save</button>
    </div>
  </div>
</div>

<div class="export-panel" id="export-panel">
  <div class="export-panel-header">
    <h3>Highlights</h3>
    <button onclick="toggleExport()">&#10005;</button>
  </div>
  <div class="export-panel-body">
    <div id="highlights-list"></div>
  </div>
  <div class="export-panel-footer">
    <button onclick="copyJsonlSlice(this)" title="Copy exchange-window JSONL to clipboard">Slice</button>
    <button onclick="copyMarkdownExport(this)">Markdown</button>
    <button onclick="copyXmlExport(this)" class="primary" title="Structured XML optimized for Claude context injection">For Claude</button>
    <button onclick="downloadAnnotations()" title="Download annotations JSON for backup/bake-in">&#8615;</button>
  </div>
</div>

<script type="application/json" id="conversation-data">\x00CONVO_DATA\x00</script>
<script type="application/json" id="baked-annotations">\x00BAKED_ANNOTATIONS\x00</script>

<script>
// ── Theme toggle ──
function cycleTheme() {{
  const html = document.documentElement;
  const current = html.getAttribute('data-theme') || 'auto';
  const next = current === 'auto' ? 'light' : current === 'light' ? 'dark' : 'auto';
  const btn = document.getElementById('theme-toggle');
  if (next === 'auto') {{
    html.removeAttribute('data-theme');
    btn.textContent = '\u263E';
    btn.title = 'Theme: auto (system)';
  }} else if (next === 'light') {{
    html.setAttribute('data-theme', 'light');
    btn.textContent = '\u2600';
    btn.title = 'Theme: light';
  }} else {{
    html.setAttribute('data-theme', 'dark');
    btn.textContent = '\u263E';
    btn.title = 'Theme: dark';
  }}
  localStorage.setItem('convo-viewer-theme', next);
}}
// Restore saved theme
(function() {{
  const saved = localStorage.getItem('convo-viewer-theme');
  if (saved && saved !== 'auto') {{
    document.documentElement.setAttribute('data-theme', saved);
    const btn = document.getElementById('theme-toggle');
    if (btn) {{
      btn.textContent = saved === 'light' ? '\u2600' : '\u263E';
      btn.title = 'Theme: ' + saved;
    }}
  }}
}})();

// ── Close settings dropdown on outside click ──
document.addEventListener('click', function(e) {{
  var menu = document.querySelector('.settings-menu');
  if (menu && menu.classList.contains('open') && !menu.contains(e.target)) {{
    menu.classList.remove('open');
  }}
}});

// ── TOC ──
function toggleToc() {{
  document.getElementById('toc-panel').classList.toggle('visible');
  document.body.classList.toggle('toc-open');
}}
function closeToc() {{
  // Keep TOC open — user can close manually
}}
function filterToc(filter, btn) {{
  // Update active button
  document.querySelectorAll('.toc-filter button').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  // Show/hide items
  document.querySelectorAll('.toc-item').forEach(item => {{
    if (filter === 'all') {{
      item.style.display = '';
    }} else if (filter === 'user') {{
      item.style.display = item.classList.contains('toc-user') ? '' : 'none';
    }} else if (filter === 'assistant') {{
      item.style.display = item.classList.contains('toc-assistant') ? '' : 'none';
    }}
  }});
}}

// ── Conversation data (for trigger capture and JSONL slice export) ──
const convoData = JSON.parse(document.getElementById('conversation-data')?.textContent || '[]');

// ── Annotation state ──
const bakedAnnotations = JSON.parse(document.getElementById('baked-annotations')?.textContent || '{{}}');
const storedAnnotations = JSON.parse(localStorage.getItem('annotations_{session_id}') || '{{}}');
const annotations = Object.assign({{}}, bakedAnnotations, storedAnnotations);
let activeAnnotationId = null;
let savedRange = null;

// Restore saved annotations on load
document.addEventListener('DOMContentLoaded', () => {{
  restoreAnnotations();
  updateCount();
  document.addEventListener('selectionchange', onSelectionChange);
}});

// Keyboard shortcut: 'h' when text is selected, or Cmd/Ctrl+Shift+H
document.addEventListener('keydown', (e) => {{
  if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'h') {{
    e.preventDefault();
    annotate();
    return;
  }}
  if (e.key.toLowerCase() === 'h' && !e.metaKey && !e.ctrlKey && !e.altKey) {{
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed && sel.toString().trim()) {{
      e.preventDefault();
      annotate();
    }}
  }}
}});

function genId() {{
  return 'a' + Math.random().toString(36).slice(2, 10);
}}

function onSelectionChange() {{
  const sel = window.getSelection();
  const hasSelection = sel && !sel.isCollapsed && sel.toString().trim();
  const btn = document.getElementById('btn-highlight');
  btn.disabled = !hasSelection;
  if (hasSelection) {{
    savedRange = sel.getRangeAt(0).cloneRange();
  }}
}}

// ── Walk text nodes in a range and wrap each in <mark> ──
function getTextNodesInRange(range) {{
  const nodes = [];
  // Clamp range to ensure we have proper boundaries
  const ancestor = range.commonAncestorContainer.nodeType === 1
    ? range.commonAncestorContainer
    : range.commonAncestorContainer.parentElement;
  const walker = document.createTreeWalker(ancestor, NodeFilter.SHOW_TEXT, null);
  let node;
  while ((node = walker.nextNode())) {{
    // Check if this text node is within the range
    if (range.comparePoint(node, 0) > 0) break; // node is after range end
    if (range.comparePoint(node, node.textContent.length) < 0) continue; // node is before range start
    if (node.textContent.trim()) nodes.push(node);
  }}
  return nodes;
}}

function wrapTextNodes(range, id) {{
  const textNodes = getTextNodesInRange(range);
  if (!textNodes.length) return;
  const first = textNodes[0];
  const last = textNodes[textNodes.length - 1];

  textNodes.forEach((textNode) => {{
    let startOffset = 0;
    let endOffset = textNode.textContent.length;

    // First node: start from selection start (only if startContainer is this text node)
    if (textNode === first && range.startContainer === textNode) startOffset = range.startOffset;
    // Last node: end at selection end (only if endContainer is this text node)
    if (textNode === last && range.endContainer === textNode) endOffset = range.endOffset;

    // Split if partial
    if (startOffset > 0) {{
      textNode = textNode.splitText(startOffset);
      endOffset -= startOffset;
    }}
    if (endOffset < textNode.textContent.length) {{
      textNode.splitText(endOffset);
    }}

    const mark = document.createElement('mark');
    mark.setAttribute('data-annotation-id', id);
    mark.onclick = () => openPopover(id);
    textNode.parentNode.insertBefore(mark, textNode);
    mark.appendChild(textNode);
  }});
}}

// ── Compute trigger context ──
function computeTrigger(ann) {{
  if (ann.trigger) return ann.trigger;
  const ti = ann.turnIndex ?? -1;
  if (ti < 0 || !convoData.length) return '';
  if (ann.role === 'Claude' && ti > 0) {{
    for (let i = ti - 1; i >= 0; i--) {{
      if (convoData[i].role === 'user' && convoData[i].text.length) {{
        return 'User: "' + convoData[i].text[0].replace(/\\n/g, ' ').slice(0, 150) + '"';
      }}
    }}
  }} else if (ann.role === 'You' && ti < convoData.length - 1) {{
    for (let i = ti + 1; i < convoData.length; i++) {{
      if (convoData[i].role === 'assistant' && convoData[i].text.length) {{
        return 'Claude: "' + convoData[i].text[0].replace(/\\n/g, ' ').slice(0, 150) + '"';
      }}
    }}
  }}
  return '';
}}

// ── Highlight selected text ──
function annotate() {{
  // Use saved range (survives button click clearing the selection)
  const sel = window.getSelection();
  let range;
  if (sel && !sel.isCollapsed && sel.toString().trim()) {{
    range = sel.getRangeAt(0);
  }} else if (savedRange) {{
    range = savedRange;
  }} else {{
    return;
  }}

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
  if (msgText) {{
    const tw = document.createTreeWalker(msgText, NodeFilter.SHOW_TEXT, null);
    let offset = 0, n;
    while ((n = tw.nextNode())) {{
      if (n === range.startContainer) {{ charStart = offset + range.startOffset; }}
      if (n === range.endContainer) {{ charEnd = offset + range.endOffset; break; }}
      offset += n.textContent.length;
    }}
  }}

  // Compute prefix/suffix from convoData
  let prefix = '', suffix = '';
  if (turnIndex >= 0 && convoData[turnIndex] && convoData[turnIndex].text[blockIndex]) {{
    const blockText = convoData[turnIndex].text[blockIndex];
    // Use indexOf on rendered text as fallback for offset mapping
    const idx = blockText.indexOf(text.slice(0, 60));
    if (idx >= 0) {{
      prefix = blockText.slice(Math.max(0, idx - 50), idx);
      suffix = blockText.slice(idx + text.length, idx + text.length + 50);
    }}
  }}

  // Compute trigger (preceding user msg for Claude, next assistant for user)
  let trigger = '';
  if (turnIndex >= 0 && convoData.length) {{
    if (role === 'Claude' && turnIndex > 0) {{
      for (let i = turnIndex - 1; i >= 0; i--) {{
        if (convoData[i].role === 'user' && convoData[i].text.length) {{
          trigger = 'User: "' + convoData[i].text[0].replace(/\\n/g, ' ').slice(0, 150) + '"';
          break;
        }}
      }}
    }} else if (role === 'You' && turnIndex < convoData.length - 1) {{
      for (let i = turnIndex + 1; i < convoData.length; i++) {{
        if (convoData[i].role === 'assistant' && convoData[i].text.length) {{
          trigger = 'Claude: "' + convoData[i].text[0].replace(/\\n/g, ' ').slice(0, 150) + '"';
          break;
        }}
      }}
    }}
  }}

  // Wrap all text nodes in the range
  wrapTextNodes(range, id);

  savedRange = null;
  if (sel) sel.removeAllRanges();

  // Store annotation
  annotations[id] = {{
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
  }};
  save();
  updateCount();

  // Refresh highlights panel if open
  const panel = document.getElementById('export-panel');
  if (panel.classList.contains('visible')) buildExport();

  // Open popover to add comment
  openPopover(id);
}}

// ── Kind chips ──
const ANNOTATION_KINDS = [
  {{ key: 'highlight', label: 'Highlight' }},
  {{ key: 'decision', label: 'Decision' }},
  {{ key: 'bug', label: 'Bug' }},
  {{ key: 'constraint', label: 'Constraint' }},
  {{ key: 'todo', label: 'TODO' }},
  {{ key: 'question', label: 'Question' }},
  {{ key: 'insight', label: 'Insight' }},
];

function renderKindChips(selectedKind) {{
  return ANNOTATION_KINDS.map(k =>
    `<button class="kind-chip ${{k.key === selectedKind ? 'active' : ''}}" onclick="setKind('${{k.key}}')">${{k.label}}</button>`
  ).join('');
}}

function setKind(kind) {{
  if (!activeAnnotationId) return;
  annotations[activeAnnotationId].kind = kind;
  document.getElementById('kind-chips').innerHTML = renderKindChips(kind);
  save();
  const panel = document.getElementById('export-panel');
  if (panel.classList.contains('visible')) buildExport();
}}

// ── Comment popover ──
function openPopover(id) {{
  const mark = document.querySelector(`mark[data-annotation-id="${{id}}"]`);
  if (!mark) return;

  // Deactivate previous, activate all marks for this annotation
  document.querySelectorAll('mark.active').forEach(m => m.classList.remove('active'));
  document.querySelectorAll(`mark[data-annotation-id="${{id}}"]`).forEach(m => m.classList.add('active'));
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
}}

function closePopover() {{
  document.getElementById('comment-popover').classList.remove('visible');
  document.querySelectorAll('mark.active').forEach(m => m.classList.remove('active'));
  activeAnnotationId = null;
}}

function saveComment() {{
  if (!activeAnnotationId) return;
  const input = document.getElementById('comment-input');
  annotations[activeAnnotationId].comment = input.value;
  const tagsStr = document.getElementById('tags-input').value;
  annotations[activeAnnotationId].tags = tagsStr.split(',').map(t => t.trim()).filter(Boolean);
  save();
  closePopover();
  const panel = document.getElementById('export-panel');
  if (panel.classList.contains('visible')) buildExport();
}}

function removeAnnotation(targetId) {{
  const id = targetId || activeAnnotationId;
  if (!id) return;
  // Remove all marks with this ID (cross-element highlights produce multiple)
  document.querySelectorAll(`mark[data-annotation-id="${{id}}"]`).forEach(mark => {{
    const parent = mark.parentNode;
    while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
    parent.removeChild(mark);
  }});
  delete annotations[id];
  save();
  updateCount();
  closePopover();
  // Refresh highlights panel if open
  const panel = document.getElementById('export-panel');
  if (panel.classList.contains('visible')) buildExport();
}}

// ── Persistence ──
function save() {{
  localStorage.setItem('annotations_{session_id}', JSON.stringify(annotations));
}}

function restoreAnnotations() {{
  // Migrate v1 → v2 schema (add defaults for missing fields)
  let migrated = false;
  for (const [id, ann] of Object.entries(annotations)) {{
    if (ann.turnIndex === undefined) {{
      ann.turnIndex = ann.turnId ? parseInt(ann.turnId.replace('turn-', ''), 10) : -1;
      migrated = true;
    }}
    if (ann.blockIndex === undefined) {{ ann.blockIndex = 0; migrated = true; }}
    if (ann.charStart === undefined) {{ ann.charStart = -1; migrated = true; }}
    if (ann.charEnd === undefined) {{ ann.charEnd = -1; migrated = true; }}
    if (ann.prefix === undefined) {{ ann.prefix = ''; migrated = true; }}
    if (ann.suffix === undefined) {{ ann.suffix = ''; migrated = true; }}
    if (ann.trigger === undefined) {{ ann.trigger = ''; migrated = true; }}
    if (ann.kind === undefined) {{ ann.kind = 'highlight'; migrated = true; }}
    if (ann.tags === undefined) {{ ann.tags = []; migrated = true; }}
  }}
  if (migrated) save();

  // Re-create <mark> elements from stored annotations
  for (const [id, ann] of Object.entries(annotations)) {{
    if (document.querySelector(`mark[data-annotation-id="${{id}}"]`)) continue;
    if (!ann.text) continue;

    // Tier 1: Precise match using block index + char offsets
    if (ann.charStart >= 0 && ann.turnId) {{
      const turnEl = document.getElementById(ann.turnId);
      if (turnEl) {{
        const msgText = turnEl.querySelector(`.message-text[data-block-index="${{ann.blockIndex}}"]`);
        if (msgText && wrapByOffset(msgText, ann.charStart, ann.charEnd, id)) continue;
      }}
    }}

    // Tier 2/3: Text search in turn container (handles legacy + fuzzy)
    const container = ann.turnId
      ? document.getElementById(ann.turnId)
      : document.querySelector('.conversation');
    if (!container) continue;

    const textNodes = [];
    let totalLen = 0;
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null);
    let node;
    while ((node = walker.nextNode())) {{
      textNodes.push({{ node, offset: totalLen, len: node.textContent.length }});
      totalLen += node.textContent.length;
    }}

    const fullText = textNodes.map(t => t.node.textContent).join('');
    const idx = fullText.indexOf(ann.text);
    if (idx === -1) continue;

    const endIdx = idx + ann.text.length;
    const nodesToWrap = [];
    for (const t of textNodes) {{
      const nodeStart = t.offset;
      const nodeEnd = t.offset + t.len;
      if (nodeEnd <= idx || nodeStart >= endIdx) continue;
      const wrapStart = Math.max(idx, nodeStart) - nodeStart;
      const wrapEnd = Math.min(endIdx, nodeEnd) - nodeStart;
      nodesToWrap.push({{ node: t.node, start: wrapStart, end: wrapEnd }});
    }}

    for (let i = nodesToWrap.length - 1; i >= 0; i--) {{
      const {{ node: tn, start: s, end: e }} = nodesToWrap[i];
      let target = tn;
      if (s > 0) target = tn.splitText(s);
      if (e - s < target.textContent.length) target.splitText(e - s);
      const mark = document.createElement('mark');
      mark.setAttribute('data-annotation-id', id);
      mark.onclick = () => openPopover(id);
      target.parentNode.insertBefore(mark, target);
      mark.appendChild(target);
    }}
  }}
}}

function wrapByOffset(container, charStart, charEnd, id) {{
  // Wrap text at precise character offsets within a container element
  const textNodes = [];
  let totalLen = 0;
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null);
  let node;
  while ((node = walker.nextNode())) {{
    textNodes.push({{ node, offset: totalLen, len: node.textContent.length }});
    totalLen += node.textContent.length;
  }}
  if (charStart >= totalLen || charEnd > totalLen) return false;

  const nodesToWrap = [];
  for (const t of textNodes) {{
    const nodeStart = t.offset;
    const nodeEnd = t.offset + t.len;
    if (nodeEnd <= charStart || nodeStart >= charEnd) continue;
    const wrapStart = Math.max(charStart, nodeStart) - nodeStart;
    const wrapEnd = Math.min(charEnd, nodeEnd) - nodeStart;
    nodesToWrap.push({{ node: t.node, start: wrapStart, end: wrapEnd }});
  }}
  if (!nodesToWrap.length) return false;

  for (let i = nodesToWrap.length - 1; i >= 0; i--) {{
    const {{ node: tn, start: s, end: e }} = nodesToWrap[i];
    let target = tn;
    if (s > 0) target = tn.splitText(s);
    if (e - s < target.textContent.length) target.splitText(e - s);
    const mark = document.createElement('mark');
    mark.setAttribute('data-annotation-id', id);
    mark.onclick = () => openPopover(id);
    target.parentNode.insertBefore(mark, target);
    mark.appendChild(target);
  }}
  return true;
}}

function updateCount() {{
  const n = Object.keys(annotations).length;
  document.getElementById('annotation-count').textContent = n ? n + ' annotation' + (n > 1 ? 's' : '') : '';
}}

// Close popover on outside click
document.addEventListener('mousedown', (e) => {{
  const popover = document.getElementById('comment-popover');
  if (popover.classList.contains('visible') && !popover.contains(e.target) && !e.target.closest('mark[data-annotation-id]')) {{
    closePopover();
  }}
}});

// ── Export ──
function toggleExport() {{
  const panel = document.getElementById('export-panel');
  const isVisible = panel.classList.toggle('visible');
  document.body.classList.toggle('highlights-open', isVisible);
  if (isVisible) buildExport();
}}

function sortedAnnotationIds() {{
  const ids = Object.keys(annotations);
  ids.sort((a, b) => {{
    const ma = document.querySelector(`mark[data-annotation-id="${{a}}"]`);
    const mb = document.querySelector(`mark[data-annotation-id="${{b}}"]`);
    if (!ma || !mb) return 0;
    return (ma.getBoundingClientRect().top + window.scrollY) - (mb.getBoundingClientRect().top + window.scrollY);
  }});
  return ids;
}}

function buildExport() {{
  const list = document.getElementById('highlights-list');
  const ids = sortedAnnotationIds();

  if (!ids.length) {{
    list.innerHTML = '<div class="hl-empty">Select text and click Highlight to annotate</div>';
    return;
  }}

  list.innerHTML = ids.map(id => {{
    const ann = annotations[id];
    const quote = (ann.text || '').replace(/\\n/g, ' ').slice(0, 200);
    const comment = ann.comment ? `<div class="hl-item-comment">${{ann.comment}}</div>` : '';
    const time = ann.time ? `<span class="hl-item-time">${{ann.time}}</span>` : '';
    const kindBadge = (ann.kind && ann.kind !== 'highlight') ? `<span class="hl-kind-badge">${{ann.kind}}</span>` : '';
    const tagsHtml = (ann.tags && ann.tags.length) ? `<div class="hl-item-tags">${{ann.tags.map(t => `<span class="hl-tag">${{t}}</span>`).join('')}}</div>` : '';
    return `<div class="hl-item" onclick="scrollToHighlight('${{id}}')" onmouseenter="hoverHighlight('${{id}}',true)" onmouseleave="hoverHighlight('${{id}}',false)">
      <div class="hl-item-header"><span class="hl-item-role">${{ann.role || '?'}}${{kindBadge}}</span><span style="display:flex;align-items:center;gap:6px">${{time}}<button class="hl-delete" onclick="event.stopPropagation();removeAnnotation('${{id}}')" title="Delete highlight">&times;</button></span></div>
      <div class="hl-item-text">${{quote}}</div>
      ${{comment}}
      ${{tagsHtml}}
    </div>`;
  }}).join('');
}}

function scrollToHighlight(id) {{
  const mark = document.querySelector(`mark[data-annotation-id="${{id}}"]`);
  if (mark) {{
    mark.scrollIntoView({{ behavior: 'smooth', block: 'center' }});
    // Flash it
    document.querySelectorAll('mark.active').forEach(m => m.classList.remove('active'));
    document.querySelectorAll(`mark[data-annotation-id="${{id}}"]`).forEach(m => m.classList.add('active'));
    setTimeout(() => {{
      document.querySelectorAll(`mark[data-annotation-id="${{id}}"]`).forEach(m => m.classList.remove('active'));
    }}, 2000);
  }} else {{
    // Mark not in DOM (page reload) — scroll to the turn instead
    const ann = annotations[id];
    if (ann?.turnId) {{
      const turn = document.getElementById(ann.turnId);
      if (turn) {{
        turn.scrollIntoView({{ behavior: 'smooth', block: 'start' }});
        turn.style.outline = '2px solid rgba(255, 179, 0, 0.6)';
        turn.style.outlineOffset = '4px';
        setTimeout(() => {{ turn.style.outline = ''; turn.style.outlineOffset = ''; }}, 2000);
      }}
    }}
  }}
}}

function hoverHighlight(id, on) {{
  document.querySelectorAll(`mark[data-annotation-id="${{id}}"]`).forEach(m => {{
    m.classList.toggle('active', on);
  }});
}}

const JSONL_SOURCE = '{jsonl_path}';

// ── Clipboard helper ──
function copyToClipboard(text, btn) {{
  navigator.clipboard.writeText(text);
  if (btn) {{
    const orig = btn.textContent;
    btn.textContent = 'Copied!';
    setTimeout(() => btn.textContent = orig, 1500);
  }}
}}

function escXml(s) {{
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}}

// Reconstruct full quote from convoData using char offsets, falling back to stored text
function fullQuote(ann) {{
  const ti = ann.turnIndex ?? -1;
  const bi = ann.blockIndex ?? 0;
  if (ti >= 0 && ti < convoData.length && ann.charStart >= 0 && ann.charEnd > ann.charStart) {{
    const blockText = (convoData[ti].text || [])[bi];
    if (blockText) {{
      const reconstructed = blockText.slice(ann.charStart, ann.charEnd);
      if (reconstructed.length > 0) return reconstructed;
    }}
  }}
  return ann.text || '';
}}

// ── Copy for Claude (XML context bundle) ──
function copyXmlExport(btn) {{
  const ids = sortedAnnotationIds();
  if (!ids.length) return;

  const source = JSONL_SOURCE.split('/').pop();
  const date = new Date().toISOString().slice(0, 10);
  const kindOrder = ['decision', 'constraint', 'bug', 'todo', 'question', 'insight', 'highlight'];

  // Group by kind
  const grouped = {{}};
  ids.forEach(id => {{
    const ann = annotations[id];
    const k = ann.kind || 'highlight';
    (grouped[k] = grouped[k] || []).push({{ id, ann }});
  }});

  let xml = `<context_bundle source="${{escXml(source)}}" date="${{date}}">\\n`;

  kindOrder.forEach(kind => {{
    if (!grouped[kind]) return;
    grouped[kind].forEach(({{ id, ann }}) => {{
      const turnIdx = ann.turnIndex ?? -1;
      const speaker = ann.role || '?';
      const quote = fullQuote(ann).replace(/\\n/g, ' ');

      xml += `  <highlight turn="${{turnIdx}}" speaker="${{speaker}}" kind="${{kind}}"`;
      if (ann.tags && ann.tags.length) xml += ` tags="${{ann.tags.join(',')}}"`;
      xml += `>\\n`;

      const trigger = computeTrigger(ann);
      if (trigger) xml += `    <trigger>${{escXml(trigger)}}</trigger>\\n`;
      xml += `    <quote>${{escXml(quote)}}</quote>\\n`;
      if (ann.comment) xml += `    <note>${{escXml(ann.comment)}}</note>\\n`;
      xml += `  </highlight>\\n`;
    }});
  }});

  xml += `</context_bundle>`;
  copyToClipboard(xml, btn);
}}

// ── Copy Markdown ──
function copyMarkdownExport(btn) {{
  const ids = sortedAnnotationIds();
  if (!ids.length) return;

  const title = document.querySelector('.header h1')?.textContent || 'Conversation';
  let out = `## Highlights from ${{title}}\\n`;
  out += 'Source: `' + JSONL_SOURCE + '`\\n\\n';

  ids.forEach((id, i) => {{
    const ann = annotations[id];
    const speaker = ann.role || '?';
    const time = ann.time ? `, ${{ann.time}}` : '';
    const turnRef = ann.turnIndex ?? (ann.turnId ? ann.turnId.replace('turn-', '') : '?');
    const kindLabel = (ann.kind && ann.kind !== 'highlight') ? ` [${{ann.kind}}]` : '';
    const quote = fullQuote(ann).replace(/\\n/g, ' ');

    out += `${{i + 1}}. [${{speaker}}${{time}}, turn #${{turnRef}}]${{kindLabel}} "${{quote}}"\\n`;

    const trigger = computeTrigger(ann);
    if (trigger) out += `   Context: ${{trigger}}\\n`;
    if (ann.comment) out += `   > ${{ann.comment}}\\n`;
    if (ann.tags?.length) out += `   Tags: ${{ann.tags.join(', ')}}\\n`;
    out += `\\n`;
  }});

  copyToClipboard(out, btn);
}}

// ── Copy JSONL Slice (exchange windows) ──
function copyJsonlSlice(btn) {{
  const ids = sortedAnnotationIds();
  if (!ids.length) return;

  const turnIndices = new Set();
  ids.forEach(id => {{
    const ann = annotations[id];
    const ti = ann.turnIndex ?? -1;
    if (ti >= 0) {{
      turnIndices.add(ti);
      // Include exchange partner
      if (ann.role === 'Claude' && ti > 0) turnIndices.add(ti - 1);
      if (ann.role === 'You' && ti < convoData.length - 1) turnIndices.add(ti + 1);
    }}
  }});

  // Collect annotations per turn
  const turnNotes = {{}};
  ids.forEach(id => {{
    const ann = annotations[id];
    const ti = ann.turnIndex ?? -1;
    if (ti < 0) return;
    if (!turnNotes[ti]) turnNotes[ti] = [];
    const note = {{ quote: fullQuote(ann).replace(/\\n/g, ' ') }};
    if (ann.comment) note.comment = ann.comment;
    if (ann.kind && ann.kind !== 'highlight') note.kind = ann.kind;
    if (ann.tags?.length) note.tags = ann.tags;
    turnNotes[ti].push(note);
  }});

  const sorted = Array.from(turnIndices).sort((a, b) => a - b);
  const lines = sorted.map(ti => {{
    if (ti < convoData.length) {{
      const turn = convoData[ti];
      const entry = {{
        role: turn.role,
        timestamp: turn.timestamp,
        text: turn.text.join('\\n\\n')
      }};
      if (turnNotes[ti]) entry.annotations = turnNotes[ti];
      return JSON.stringify(entry);
    }}
    return null;
  }}).filter(Boolean);

  copyToClipboard(lines.join('\\n'), btn);
}}

// ── Download annotations JSON (for bake-in) ──
function downloadAnnotations() {{
  const data = JSON.stringify(annotations, null, 2);
  const blob = new Blob([data], {{ type: 'application/json' }});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = '{session_id}.annotations.json';
  a.click();
  URL.revokeObjectURL(url);
}}
</script>
</body>
</html>
"""


def convert_jsonl_to_html(
    input_file: str,
    output_file: str = None,
    include_thinking: bool = True,
    include_tools: bool = True,
):
    """Convert a JSONL conversation to formatted HTML."""
    input_path = Path(input_file)

    if not input_path.exists():
        print(f"Error: File not found: {input_file}")
        return None

    # Parse first so we have session_id for default output path
    convo = build_conversation(input_file)

    # Determine output path
    if output_file:
        output_path = Path(output_file)
    elif convo["session_id"]:
        viewer_dir = Path.home() / ".claude" / "viewer"
        viewer_dir.mkdir(parents=True, exist_ok=True)
        short_id = convo["session_id"][:8]
        output_path = viewer_dir / f"{short_id}.html"
    else:
        output_path = input_path.with_suffix(".html")

    # Render turns
    turns_html = []
    toc_entries = []
    for i, turn in enumerate(convo["turns"]):
        rendered, toc_entry = render_turn(turn, i, include_thinking, include_tools)
        if rendered:
            turns_html.append(rendered)
        if toc_entry:
            toc_entries.append(toc_entry)

    # Build metadata
    meta_parts = []
    if convo["start_time"]:
        try:
            dt = datetime.fromisoformat(
                convo["start_time"].replace("Z", "+00:00")
            ).astimezone()
            meta_parts.append(f"<span>{dt.strftime('%B %d, %Y at %I:%M %p')}</span>")
        except Exception:
            pass
    if convo["model"]:
        meta_parts.append(f"<span>Model: {escape(convo['model'])}</span>")
    if convo["project_dir"]:
        meta_parts.append(f"<span>{escape(convo['project_dir'])}</span>")
    if convo["version"]:
        meta_parts.append(f"<span>Claude Code v{escape(convo['version'])}</span>")

    turn_count = len(convo["turns"])
    user_turns = sum(1 for t in convo["turns"] if t["role"] == "user")
    meta_parts.append(f"<span>{turn_count} turns ({user_turns} user)</span>")

    # Title
    session_id_display = convo["session_id"] or input_path.stem
    title = f"Claude Conversation — {session_id_display}"

    # Build TOC
    toc_items = []
    for entry in toc_entries:
        role_class = entry["role"]
        preview = escape(entry["preview"]) if entry["preview"] else "(no text)"
        ts = f'<span class="toc-time">{escape(entry["timestamp"])}</span>' if entry["timestamp"] else ""
        label = escape(entry["label"])
        toc_items.append(
            f'<div class="toc-item toc-{role_class}" onclick="document.getElementById(\'{entry["id"]}\').scrollIntoView({{behavior:\'smooth\',block:\'start\'}});closeToc();">'
            f'<div class="toc-item-header"><span class="toc-role">{label}</span>{ts}</div>'
            f'<div class="toc-item-preview">{preview}</div>'
            f'</div>'
        )
    toc_html = "\n".join(toc_items)

    session_id = convo["session_id"] or input_path.stem

    # Build metadata comment for index page parsing
    meta_json = json.dumps({
        "session_id": session_id,
        "short_id": session_id[:8],
        "project_dir": convo["project_dir"] or "",
        "model": convo["model"] or "",
        "start_time": convo["start_time"] or "",
        "turn_count": turn_count,
        "user_turns": user_turns,
    })
    meta_comment = f"<!-- CONVO_META:{meta_json} -->"

    # Build lightweight conversation data for JS (text blocks only)
    convo_data = []
    for turn in convo["turns"]:
        text_blocks = [b["text"] for b in turn["blocks"] if b["type"] == "text"]
        convo_data.append({
            "role": turn["role"],
            "timestamp": turn.get("timestamp", ""),
            "text": text_blocks,
        })
    conversation_data_json = json.dumps(convo_data, ensure_ascii=False)

    # Load baked annotations from sidecar file if it exists
    viewer_dir = Path.home() / ".claude" / "viewer"
    sidecar_path = viewer_dir / f"{session_id}.annotations.json"
    baked_annotations_json = "{}"
    if sidecar_path.exists():
        try:
            baked_data = json.loads(sidecar_path.read_text(encoding="utf-8"))
            baked_annotations_json = json.dumps(baked_data, ensure_ascii=False)
        except (json.JSONDecodeError, OSError):
            pass

    html_out = HTML_TEMPLATE.format(
        title=escape(title),
        meta_html="\n    ".join(meta_parts),
        conversation_html="\n".join(turns_html),
        toc_html=toc_html,
        session_id=session_id,
        jsonl_path=str(input_path.resolve()),
        meta_comment=meta_comment,
    )

    # Inject JSON data via replace (avoids f-string brace escaping issues)
    # Escape </script> and </Script> etc. to prevent premature script block closure
    # (conversation text may discuss HTML script tags)
    def safe_for_script(s: str) -> str:
        return s.replace("</", "<\\/")

    html_out = html_out.replace("\x00CONVO_DATA\x00", safe_for_script(conversation_data_json))
    html_out = html_out.replace("\x00BAKED_ANNOTATIONS\x00", safe_for_script(baked_annotations_json))

    output_path.write_text(html_out, encoding="utf-8")
    size_kb = output_path.stat().st_size / 1024
    print(
        f"{input_path.name} -> {output_path} "
        f"({turn_count} turns, {size_kb:.0f} KB)"
    )

    # Update index if outputting to viewer directory
    viewer_dir = Path.home() / ".claude" / "viewer"
    if output_path.parent.resolve() == viewer_dir.resolve():
        update_index(viewer_dir)

    return output_path


# ── Index page ──

INDEX_TEMPLATE = """\
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Claude Conversations</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  :root {{
    --bg: #0d1117;
    --surface: #161b22;
    --surface2: #21262d;
    --text: #e6edf3;
    --text2: #7d8590;
    --border: #30363d;
    --accent: #da7756;
  }}
  @media (prefers-color-scheme: light) {{
    :root {{
      --bg: #f6f8fa;
      --surface: #ffffff;
      --surface2: #f0f2f5;
      --text: #1f2328;
      --text2: #656d76;
      --border: #d0d7de;
      --accent: #c2613a;
    }}
  }}
  * {{ margin: 0; padding: 0; box-sizing: border-box; }}
  body {{
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
    background: var(--bg);
    color: var(--text);
    -webkit-font-smoothing: antialiased;
    padding: 40px 24px;
    max-width: 960px;
    margin: 0 auto;
  }}
  h1 {{
    font-size: 1.5rem;
    font-weight: 600;
    margin-bottom: 4px;
  }}
  .meta {{
    color: var(--text2);
    font-size: 0.82rem;
    margin-bottom: 24px;
  }}
  .index-list {{
    display: flex;
    flex-direction: column;
    gap: 1px;
    background: var(--border);
    border-radius: 8px;
    overflow: hidden;
  }}
  .index-entry {{
    display: grid;
    grid-template-columns: 80px 1fr 140px 160px 90px;
    gap: 12px;
    align-items: center;
    padding: 12px 16px;
    background: var(--surface);
    text-decoration: none;
    color: inherit;
    transition: background 0.15s;
  }}
  .index-entry:hover {{
    background: var(--surface2);
  }}
  .entry-id {{
    font-family: 'SF Mono', 'Fira Code', monospace;
    font-size: 0.82rem;
    color: var(--accent);
    font-weight: 500;
  }}
  .entry-project {{
    font-size: 0.85rem;
    color: var(--text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }}
  .entry-model {{
    font-size: 0.8rem;
    color: var(--text2);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }}
  .entry-time {{
    font-size: 0.8rem;
    color: var(--text2);
    white-space: nowrap;
  }}
  .entry-turns {{
    font-size: 0.8rem;
    color: var(--text2);
    text-align: right;
    white-space: nowrap;
  }}
  .empty {{
    text-align: center;
    padding: 40px;
    color: var(--text2);
    background: var(--surface);
    border-radius: 8px;
  }}
  @media (max-width: 700px) {{
    .index-entry {{
      grid-template-columns: 70px 1fr 80px;
    }}
    .entry-model, .entry-time {{
      display: none;
    }}
  }}
</style>
</head>
<body>
  <h1>Claude Conversations</h1>
  <div class="meta">{count} sessions</div>
  {entries_html}
</body>
</html>
"""


def _shorten_model(model: str) -> str:
    """Shorten model name for display."""
    if not model:
        return ""
    # claude-3-5-sonnet-20241022 -> sonnet-3.5
    # claude-opus-4-20250514 -> opus-4
    parts = model.lower()
    for prefix in ("claude-", "anthropic/"):
        if parts.startswith(prefix):
            parts = parts[len(prefix):]
    # Strip date suffix
    parts = re.sub(r"-\d{8}$", "", parts)
    return parts


def _format_index_time(start_time: str) -> str:
    """Format ISO timestamp for index display."""
    if not start_time:
        return ""
    try:
        dt = datetime.fromisoformat(start_time.replace("Z", "+00:00")).astimezone()
        return dt.strftime("%b %d, %Y %I:%M %p")
    except Exception:
        return start_time[:16]


def update_index(viewer_dir: Path):
    """Regenerate the index.html catalog of all rendered sessions."""
    meta_pattern = re.compile(r"<!-- CONVO_META:(\{.*?\}) -->")
    entries = []

    for html_file in sorted(viewer_dir.glob("*.html")):
        if html_file.name == "index.html":
            continue
        try:
            head = html_file.read_text(encoding="utf-8")[:1000]
            match = meta_pattern.search(head)
            if match:
                meta = json.loads(match.group(1))
                meta["_filename"] = html_file.name
                entries.append(meta)
        except Exception:
            continue

    # Sort by start_time descending (most recent first)
    entries.sort(key=lambda e: e.get("start_time", ""), reverse=True)

    if entries:
        rows = []
        for meta in entries:
            short_id = escape(meta.get("short_id", meta.get("_filename", "?")))
            project = meta.get("project_dir", "")
            if project:
                parts = project.rstrip("/").split("/")
                project_display = "/".join(parts[-2:]) if len(parts) >= 2 else project
            else:
                project_display = ""
            model_display = _shorten_model(meta.get("model", ""))
            time_display = _format_index_time(meta.get("start_time", ""))
            turn_count = meta.get("turn_count", 0)
            user_turns = meta.get("user_turns", 0)
            filename = meta["_filename"]

            rows.append(
                f'<a class="index-entry" href="{filename}">'
                f'<span class="entry-id">{short_id}</span>'
                f'<span class="entry-project" title="{escape(project)}">{escape(project_display)}</span>'
                f'<span class="entry-model">{escape(model_display)}</span>'
                f'<span class="entry-time">{time_display}</span>'
                f'<span class="entry-turns">{turn_count} turns ({user_turns} user)</span>'
                f"</a>"
            )
        entries_html = '<div class="index-list">\n' + "\n".join(rows) + "\n</div>"
    else:
        entries_html = '<div class="empty">No conversations rendered yet.</div>'

    index_html = INDEX_TEMPLATE.format(
        count=len(entries),
        entries_html=entries_html,
    )
    (viewer_dir / "index.html").write_text(index_html, encoding="utf-8")


def main():
    parser = argparse.ArgumentParser(
        description="Convert Claude JSONL conversation logs to formatted HTML",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""\
Examples:
  %(prog)s conversation.jsonl                      Convert to conversation.html
  %(prog)s conversation.jsonl -o output.html        Specify output file
  %(prog)s *.jsonl                                  Convert multiple files
  %(prog)s conversation.jsonl --no-thinking         Hide thinking blocks
  %(prog)s conversation.jsonl --no-tools            Hide tool calls & results
""",
    )
    parser.add_argument("input", nargs="+", help="Input JSONL file(s)")
    parser.add_argument("-o", "--output", help="Output file (only for single input)")
    parser.add_argument(
        "--no-thinking",
        action="store_true",
        help="Exclude thinking blocks from output",
    )
    parser.add_argument(
        "--no-tools",
        action="store_true",
        help="Exclude tool calls and results from output",
    )

    args = parser.parse_args()

    if args.output and len(args.input) > 1:
        parser.error("Cannot specify --output with multiple input files")

    for input_file in args.input:
        convert_jsonl_to_html(
            input_file,
            args.output,
            include_thinking=not args.no_thinking,
            include_tools=not args.no_tools,
        )


if __name__ == "__main__":
    main()
