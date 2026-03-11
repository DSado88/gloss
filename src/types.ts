/** A single text block within a turn (rendered markdown, code, etc.) */
export interface TextBlock {
  type: "text";
  text: string;
}

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

export interface ThinkingBlock {
  type: "thinking";
  thinking: string;
}

/** Union of all content block types in a conversation turn */
export type Block = TextBlock | ToolUseBlock | ToolResultBlock | ThinkingBlock;

/** A single turn (message) in a conversation */
export interface Turn {
  role: "user" | "assistant";
  content: Block[];
  timestamp?: string;
}

/** A full parsed conversation */
export interface Conversation {
  turns: Turn[];
  session_id: string;
  project?: string;
  model?: string;
}

/** Entry for the table-of-contents sidebar */
export interface TocEntry {
  role: "user" | "assistant";
  preview: string;
  timestamp?: string;
  turnIndex: number;
}

/** Options controlling HTML conversion */
export interface ConvertOptions {
  includeTools?: boolean;
  includeThinking?: boolean;
  inputFile: string;
  outputFile?: string;
}

/** Entry in the index page listing all conversations */
export interface ConvoDataEntry {
  role: string;
  timestamp: string;
  text: string[];
}
