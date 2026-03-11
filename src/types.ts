/** Block types that can appear in a turn */

export interface TextBlock {
  type: "text";
  text: string;
}

export interface SlashCommandBlock {
  type: "slash_command";
  command: string;
}

export interface SessionContinuationBlock {
  type: "session_continuation";
  text?: string;
}

export interface ThinkingBlock {
  type: "thinking";
  text: string;
}

export interface ToolUseBlock {
  type: "tool_use";
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultBlock {
  type: "tool_result";
  content: string;
  meta?: string;
  is_error?: boolean;
}

export type Block =
  | TextBlock
  | SlashCommandBlock
  | SessionContinuationBlock
  | ThinkingBlock
  | ToolUseBlock
  | ToolResultBlock;

export interface Turn {
  role: "user" | "assistant";
  timestamp?: string;
  blocks: Block[];
}

export interface TocEntry {
  id: string;
  role: string;
  label: string;
  timestamp: string;
  preview: string;
}

export interface Conversation {
  turns: Turn[];
  title?: string;
  model?: string;
}

export interface ConvertOptions {
  includeThinking: boolean;
  includeTools: boolean;
  title?: string;
}

export interface ConvoDataEntry {
  path: string;
  conversation: Conversation;
}
