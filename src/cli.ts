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
  .action((inputs: string[], options) => {
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
