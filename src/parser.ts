import { readFileSync } from "fs";
import type { Conversation } from "./types.js";
import { IncrementalParser } from "./incremental-parser.js";

export function buildConversation(inputFile: string): Conversation {
  const fileContent = readFileSync(inputFile, "utf-8");
  const lines = fileContent.split("\n");

  const parser = new IncrementalParser();
  parser.feedLines(lines);

  const meta = parser.getMetadata();
  return {
    sessionId: meta.sessionId,
    projectDir: meta.projectDir,
    model: meta.model,
    version: meta.version,
    startTime: meta.startTime,
    turns: parser.getTurns(),
  };
}
