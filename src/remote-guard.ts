import * as crypto from "node:crypto";

// ---------------------------------------------------------------------------
// Remote-safe mode: auth + OS-endpoint blocking for tailnet-exposed servers.
//
// Local mode (GLOSS_REMOTE unset) is a no-op — guardRequest always allows.
// Remote mode (GLOSS_REMOTE=1) requires GLOSS_AUTH_TOKEN and authenticates
// every HTTP route and WebSocket upgrade via Bearer header, gloss_token
// cookie, or ?token= query param. Endpoints that execute local OS behavior
// are blocked outright.
// ---------------------------------------------------------------------------

export interface RemoteConfig {
  remote: boolean;
  authToken: string;
  bindHost?: string;
  disableOsEndpoints: boolean;
}

/** Routes that spawn subprocesses / drive the local OS. Never remotely callable by default. */
export const OS_ENDPOINTS: readonly string[] = [
  "/api/resume",
  "/api/spawn-quick",
  "/api/pick-folder",
  "/api/backup",
];

export function resolveRemoteConfig(
  env: Record<string, string | undefined> = process.env,
): RemoteConfig {
  const remote = env.GLOSS_REMOTE === "1";
  const authToken = env.GLOSS_AUTH_TOKEN ?? "";
  if (remote && !authToken) {
    throw new Error("GLOSS_REMOTE=1 requires GLOSS_AUTH_TOKEN to be set");
  }
  const disableOsEndpoints =
    env.GLOSS_DISABLE_OS_ENDPOINTS != null
      ? env.GLOSS_DISABLE_OS_ENDPOINTS === "1"
      : remote;
  return {
    remote,
    authToken,
    bindHost: env.GLOSS_BIND_HOST || undefined,
    disableOsEndpoints,
  };
}

/** Constant-time token comparison. */
function tokenMatches(provided: string | null | undefined, expected: string): boolean {
  if (!provided || !expected) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function tokenFromCookie(req: Request): string | null {
  const cookie = req.headers.get("cookie");
  if (!cookie) return null;
  for (const part of cookie.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === "gloss_token") {
      return part.slice(eq + 1).trim();
    }
  }
  return null;
}

function tokenFromQuery(req: Request): string | null {
  try {
    return new URL(req.url).searchParams.get("token");
  } catch {
    return null;
  }
}

export function isAuthorized(req: Request, cfg: RemoteConfig): boolean {
  if (!cfg.remote) return true;
  const auth = req.headers.get("authorization");
  if (auth?.startsWith("Bearer ") && tokenMatches(auth.slice(7), cfg.authToken)) return true;
  if (tokenMatches(tokenFromCookie(req), cfg.authToken)) return true;
  if (tokenMatches(tokenFromQuery(req), cfg.authToken)) return true;
  return false;
}

/** True when the request authenticated via ?token= (so the server should set the cookie). */
export function authedViaQuery(req: Request, cfg: RemoteConfig): boolean {
  return cfg.remote && tokenMatches(tokenFromQuery(req), cfg.authToken);
}

/** Cookie that lets browsers (phone) authenticate after a one-time ?token= visit. */
export function buildAuthCookie(cfg: RemoteConfig): string {
  // No Secure flag: served over plain HTTP inside the tailnet.
  return `gloss_token=${cfg.authToken}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`;
}

/**
 * Gate a request. Returns null when allowed, or a 401/403 Response when not.
 * Must run before any route handling, including WebSocket upgrades.
 */
export function guardRequest(req: Request, pathname: string, cfg: RemoteConfig): Response | null {
  if (!cfg.remote) return null;
  const jsonHeaders = { "Content-Type": "application/json; charset=utf-8" };
  if (!isAuthorized(req, cfg)) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: jsonHeaders,
    });
  }
  if (cfg.disableOsEndpoints && OS_ENDPOINTS.includes(pathname)) {
    return new Response(JSON.stringify({ error: "Endpoint disabled in remote mode" }), {
      status: 403,
      headers: jsonHeaders,
    });
  }
  return null;
}
