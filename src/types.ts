export interface Block {
  type: string;
  text?: string;
  command?: string;
  [key: string]: unknown;
}

export interface Turn {
  role: string;
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
