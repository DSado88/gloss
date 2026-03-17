/**
 * Embedding subprocess — runs ONNX inference in a separate process so the
 * HTTP server event loop is never blocked.
 *
 * Spawned by EmbeddingEngine via Bun.spawn(). Communicates over stdin/stdout
 * using newline-delimited JSON:
 *
 *   stdin  (parent → child): { id: number, texts: string[] }
 *   stdout (child → parent): { id: number, embeddings: number[][] }
 *                          | { id: number, error: string }
 *                          | { type: "ready" }
 *                          | { type: "status", message: string }
 */

const MODEL_NAME = "Snowflake/snowflake-arctic-embed-m-v2.0";
const EMBEDDING_DIMS = 256;

let extractor: any = null;

function truncateAndNormalize(vec: number[]): number[] {
  const out = new Array(EMBEDDING_DIMS);
  let norm = 0;
  for (let i = 0; i < EMBEDDING_DIMS; i++) {
    const v = i < vec.length ? vec[i] : 0;
    out[i] = v;
    norm += v * v;
  }
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < EMBEDDING_DIMS; i++) {
      out[i] /= norm;
    }
  }
  return out;
}

function send(obj: unknown) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

async function init() {
  try {
    send({ type: "status", message: "Loading model..." });
    const { pipeline, env } = await import("@huggingface/transformers");
    try {
      extractor = await pipeline("feature-extraction", MODEL_NAME, { dtype: "q8" });
    } catch {
      if (env.backends?.onnx?.wasm) {
        env.backends.onnx.wasm.numThreads = 1;
      }
      extractor = await pipeline("feature-extraction", MODEL_NAME, {
        dtype: "q8",
        device: "wasm",
      });
    }
    send({ type: "ready" });
  } catch (err) {
    send({ type: "status", message: `Failed to load model: ${err}` });
    process.exit(1);
  }
}

async function handleRequest(line: string) {
  let parsed: { id: number; texts: string[] };
  try {
    parsed = JSON.parse(line);
  } catch {
    return; // ignore malformed input
  }

  const { id, texts } = parsed;
  if (!extractor) {
    send({ id, error: "Model not loaded" });
    return;
  }

  try {
    const truncated = texts.map((t: string) => (t.length > 2000 ? t.slice(0, 2000) : t));
    const output = await extractor(truncated, { pooling: "cls", normalize: true });
    const fullVectors = output.tolist();
    const embeddings = fullVectors.map((vec: number[]) => truncateAndNormalize(vec));
    send({ id, embeddings });
  } catch (err) {
    send({ id, error: String(err) });
  }
}

// Read newline-delimited JSON from stdin
let buffer = "";
process.stdin.setEncoding("utf-8");
process.stdin.on("data", (chunk: string) => {
  buffer += chunk;
  const lines = buffer.split("\n");
  buffer = lines.pop() || ""; // keep incomplete line in buffer
  for (const line of lines) {
    if (line.trim()) {
      handleRequest(line);
    }
  }
});

process.stdin.on("end", () => {
  process.exit(0);
});

init();
