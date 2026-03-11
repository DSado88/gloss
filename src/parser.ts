import { readFileSync } from "fs";
import type {
  Block,
  Conversation,
  Turn,
} from "./types.js";
import { cleanUserText, isSystemNoise } from "./text-cleaning.js";

export function buildConversation(inputFile: string): Conversation {
  const fileContent = readFileSync(inputFile, "utf-8");
  const lines = fileContent.split("\n");

  const turns: Turn[] = [];
  let currentTurn: Turn | null = null;
  let sessionId: string | null = null;
  let projectDir: string | null = null;
  let model: string | null = null;
  let startTime: string | null = null;
  let version: string | null = null;

  for (const line of lines) {
    if (!line.trim()) continue;

    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }

    const message = (obj.message as Record<string, unknown>) ?? {};

    // Grab metadata on first occurrence
    if (!sessionId) {
      const msgSid = message.sessionId as string | undefined;
      const rootSid = obj.sessionId as string | undefined;
      if (msgSid) sessionId = msgSid;
      else if (rootSid) sessionId = rootSid;
    }
    if (!projectDir && obj.cwd) {
      projectDir = obj.cwd as string;
    }
    if (!version && obj.version) {
      version = obj.version as string;
    }

    const msgType = obj.type as string | undefined;
    if (msgType !== "user" && msgType !== "assistant") continue;

    const content = (message.content as string | unknown[] | undefined) ?? "";
    const timestamp = (obj.timestamp as string) ?? "";

    if (!startTime && timestamp) {
      startTime = timestamp;
    }
    if (!model && message.model) {
      model = message.model as string;
    }

    let hasUserText = false;
    let hasToolResults = false;
    const parsedBlocks: Block[] = [];

    if (typeof content === "string" && content.trim()) {
      if (msgType === "user") {
        const cmdMatch = content.match(/<command-name>\s*(\/[\w-]+)\s*<\/command-name>/);
        const cmdArgsMatch = content.match(/<command-args>\s*([\s\S]*?)\s*<\/command-args>/);

        if (isSystemNoise(content)) {
          if (cmdMatch) {
            const cmd = cmdMatch[1];
            const args = cmdArgsMatch ? cmdArgsMatch[1].trim() : "";
            const label = args ? `${cmd} ${args}`.trim() : cmd;
            parsedBlocks.push({ type: "slash_command", command: label });
            hasUserText = true;
          } else if (content.trim().startsWith("This session is being continued")) {
            parsedBlocks.push({ type: "session_continuation", text: content.trim() });
            hasUserText = true;
          }
          // Otherwise skip entirely
        } else {
          const cleaned = cleanUserText(content);
          if (cleaned) {
            hasUserText = true;
            parsedBlocks.push({ type: "text", text: cleaned });
          }
        }
      } else {
        hasUserText = true;
        parsedBlocks.push({ type: "text", text: content });
      }
    } else if (Array.isArray(content)) {
      for (const item of content) {
        if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
        const block = item as Record<string, unknown>;
        const blockType = (block.type as string) ?? "";

        if (blockType === "text") {
          const text = (block.text as string) ?? "";
          if (text.trim()) {
            if (msgType === "user") {
              if (isSystemNoise(text)) continue;
              const cleaned = cleanUserText(text);
              if (cleaned) {
                hasUserText = true;
                parsedBlocks.push({ type: "text", text: cleaned });
              }
            } else {
              hasUserText = true;
              parsedBlocks.push({ type: "text", text });
            }
          }
        } else if (blockType === "thinking") {
          const thinking = (block.thinking as string) ?? "";
          if (thinking.trim()) {
            parsedBlocks.push({ type: "thinking", text: thinking });
          }
        } else if (blockType === "tool_use") {
          parsedBlocks.push({
            type: "tool_use",
            name: (block.name as string) ?? "unknown",
            input: (block.input as Record<string, unknown>) ?? {},
            id: (block.id as string) ?? "",
          });
        } else if (blockType === "tool_result") {
          hasToolResults = true;
          const resultContent = (block.content as string | unknown[] | undefined) ?? "";
          const isError = (block.is_error as boolean) ?? false;

          let resultText: string;
          let metaText: string | null = null;

          if (Array.isArray(resultContent)) {
            const textParts: string[] = [];
            const metaParts: string[] = [];
            for (const rc of resultContent) {
              if (typeof rc === "object" && rc !== null && !Array.isArray(rc)) {
                const rcObj = rc as Record<string, unknown>;
                if (rcObj.type === "text") {
                  const t = (rcObj.text as string) ?? "";
                  if (t.trim().startsWith("agentId:") || t.trim().startsWith("<usage>")) {
                    metaParts.push(t);
                  } else {
                    textParts.push(t);
                  }
                }
              } else if (typeof rc === "string") {
                textParts.push(rc);
              }
            }
            resultText = textParts.join("\n");
            metaText = metaParts.length > 0 ? metaParts.join("\n") : null;
          } else {
            resultText = typeof resultContent === "string" ? resultContent : String(resultContent);
          }

          parsedBlocks.push({
            type: "tool_result",
            content: resultText,
            meta: metaText,
            isError,
            toolUseId: (block.tool_use_id as string) ?? "",
          });
        }
      }
    }

    // Tool result folding: user messages with only tool_results merge into preceding assistant turn
    if (msgType === "user" && hasToolResults && !hasUserText) {
      if (currentTurn && currentTurn.role === "assistant") {
        currentTurn.blocks.push(...parsedBlocks);
        continue;
      }
    }

    const role = msgType as "user" | "assistant";

    // Merge consecutive same-role messages into one turn
    if (currentTurn && currentTurn.role === role) {
      currentTurn.blocks.push(...parsedBlocks);
    } else {
      currentTurn = { role, timestamp, blocks: parsedBlocks };
      turns.push(currentTurn);
    }
  }

  return {
    sessionId,
    projectDir,
    model,
    version,
    startTime,
    turns,
  };
}
