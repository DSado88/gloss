import type { Conversation } from "./types.js";

export function buildConversation(inputFile: string): Conversation {
  return {
    sessionId: null,
    projectDir: null,
    model: null,
    version: null,
    startTime: null,
    turns: [],
  };
}
