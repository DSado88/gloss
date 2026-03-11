#!/usr/bin/env node
import { program } from "commander";
import { convertJsonlToHtml } from "./convert.js";

program
  .name("convo-viewer")
  .description("Convert Claude JSONL conversation logs to formatted HTML")
  .argument("<input...>", "Input JSONL file(s)")
  .option("-o, --output <file>", "Output file (single input only)")
  .option("--no-thinking", "Exclude thinking blocks")
  .option("--no-tools", "Exclude tool calls and results")
  .option("--live", "Start a live server that watches the JSONL file")
  .option("--port <number>", "Port for the live server (default: 3456)", parseInt)
  .action(async (inputs: string[], options) => {
    if (options.live) {
      if (inputs.length > 1) {
        console.error("Error: --live can only be used with a single input file");
        process.exit(1);
      }
      const { startLiveServer } = await import("./live.js");
      await startLiveServer(inputs[0], {
        port: options.port,
        includeThinking: options.thinking,
        includeTools: options.tools,
      });
      return;
    }

    if (options.output && inputs.length > 1) {
      console.error("Error: --output cannot be used with multiple input files");
      process.exit(1);
    }
    for (const input of inputs) {
      convertJsonlToHtml(input, options.output, {
        includeThinking: options.thinking,
        includeTools: options.tools,
      });
    }
  });

program.parse();
