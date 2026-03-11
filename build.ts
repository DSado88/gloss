import * as esbuild from "esbuild";

esbuild
  .build({
    entryPoints: ["src/cli.ts"],
    bundle: true,
    outfile: "dist/cli.js",
    platform: "node",
    target: "es2022",
    format: "esm",
    banner: { js: "#!/usr/bin/env node" },
  })
  .catch(() => process.exit(1));
