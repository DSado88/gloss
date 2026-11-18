import { createHash } from "node:crypto";

/**
 * Which file a search result or a read came from, and which version of it:
 * the path Gloss indexed it under and the SHA-256 of the exact bytes it read.
 * A client that keeps several projects apart checks these against its own
 * record of what it published, so a stale row can't release another file's
 * text under this session's id.
 */
export interface SourceIdentity {
  path: string;
  sha256: string;
  size: number;
}

export function identityOfBytes(path: string, bytes: Buffer): SourceIdentity {
  return { path, sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length };
}
