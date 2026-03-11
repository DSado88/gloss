// Block types
export interface TextBlock {
  type: "text";
  text: string;
}

export interface ThinkingBlock {
  type: "thinking";
  text: string;
}

export interface ToolUseBlock {
  type: "tool_use";
  name: string;
  input: Record<string, unknown>;
  id?: string;
}

export interface ToolResultBlock {
  type: "tool_result";
  content: string;
  meta?: string | null;
  isError?: boolean;
  toolUseId?: string;
}

export interface SlashCommandBlock {
  type: "slash_command";
  command: string;
}

export interface SessionContinuationBlock {
  type: "session_continuation";
  text: string;
}

export type Block =
  | TextBlock
  | ThinkingBlock
  | ToolUseBlock
  | ToolResultBlock
  | SlashCommandBlock
  | SessionContinuationBlock;

export interface Turn {
  role: "user" | "assistant";
  timestamp?: string;
  blocks: Block[];
}

export interface Conversation {
  sessionId: string | null;
  projectDir: string | null;
  model: string | null;
  version: string | null;
  startTime: string | null;
  turns: Turn[];
}

export interface TocEntry {
  id: string;
  role: string;
  label: string;
  timestamp: string;
  preview: string;
}

export interface ConvertOptions {
  includeThinking?: boolean;
  includeTools?: boolean;
}

// Lightweight conversation data for client-side JS
export interface ConvoDataEntry {
  role: string;
  timestamp: string;
  text: string[];
}

/** Metadata embedded in rendered HTML files for index generation. */
export interface ConvoMeta {
  session_id: string;
  short_id: string;
  project_dir: string;
  model: string;
  start_time: string;
  turn_count: number;
  user_turns: number;
}
