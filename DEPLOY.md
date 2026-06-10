# Deploying Gloss to a remote server

This runbook sets up Gloss as an always-on memory server on a dedicated
machine (examples assume macOS + [Tailscale](https://tailscale.com), but any
private network works). Client machines keep doing real work and sync raw
JSONL logs over; phones and other devices read history through the same
private network.

Throughout, `<server-ip>` is the server's address on your private network
(e.g. its Tailscale IP) and `<user>` is the account that runs Gloss there.

Architecture:

- **The server owns** `~/.convo/db.sqlite` (one writer, ever). Never sync the DB.
- **Clients sync** `~/.claude/projects/` → server, one-way, every 5 min.
- **Auth**: `GLOSS_REMOTE=1` requires a token on every route and the
  WebSocket. Treat your private network as semi-trusted — other people's
  devices may share it. Network-only ≠ private.
- **OS endpoints** (`/api/resume`, `/api/spawn-quick`, `/api/pick-folder`,
  `/api/backup`) are disabled by default in remote mode
  (`GLOSS_DISABLE_OS_ENDPOINTS` defaults to `1`; don't override it to `0`
  on a shared network).

## 1. One-time seeding (run from your main machine)

```sh
# Repo — install OUTSIDE ~/Documents (see TCC note below)
rsync -a ./ <user>@<server-ip>:/Users/<user>/gloss/ --exclude node_modules
ssh <user>@<server-ip> 'cd ~/gloss && ~/.bun/bin/bun install'

# Conversation logs (first run can take a while)
GLOSS_SYNC_DEST='<user>@<server-ip>:/Users/<user>/.claude/projects-laptop/' \
  scripts/sync-to-server.sh

# Gloss DB — snapshot the live DB safely (never raw-copy db.sqlite)
bun -e 'import {openDb} from "./src/db.js"; const db = openDb(); db.backupTo("/tmp/gloss-seed.sqlite"); db.close()'
ssh <user>@<server-ip> 'mkdir -p ~/.convo'
scp /tmp/gloss-seed.sqlite <user>@<server-ip>:/Users/<user>/.convo/db.sqlite
rm /tmp/gloss-seed.sqlite

# Annotation safety net (cheap, do it)
bun src/cli.ts annotations export -o /tmp/annotations-backup.json
scp /tmp/annotations-backup.json <user>@<server-ip>:/Users/<user>/.convo/

# Embedding model cache (skips a ~400MB re-download on the server)
rsync -a ~/.cache/huggingface/ <user>@<server-ip>:/Users/<user>/.cache/huggingface/ 2>/dev/null || true
```

If the client and server use the same username, the seeded DB's `jsonl_path`s
resolve as-is. Different usernames: let the server's first scan rebuild paths
(the JSONLs are the source of truth).

## 2. Server (LaunchDaemon)

Install as a **LaunchDaemon**, not a LaunchAgent: agents live in the GUI
login session and die the moment that user logs out (we learned this the
hard way — the server silently vanished when the account got logged out).
Daemons run from boot, no login required.

Fill in the placeholders in `deploy/macos/gloss.plist.template` (instructions
are in the template header) and bootstrap it:

```sh
# On the server
sed -e "s|__USERNAME__|$(whoami)|g" \
    -e "s|__BIND_IP__|<server-ip>|g" \
    -e "s|__INSTALL_DIR__|$HOME/gloss|g" \
    -e "s|__GLOSS_AUTH_TOKEN__|$(openssl rand -hex 32)|g" \
    deploy/macos/gloss.plist.template \
    > /tmp/com.gloss.server.plist
grep GLOSS_AUTH_TOKEN -A1 /tmp/com.gloss.server.plist  # save the token in a password manager
sudo mv /tmp/com.gloss.server.plist /Library/LaunchDaemons/com.gloss.server.plist
sudo chown root:wheel /Library/LaunchDaemons/com.gloss.server.plist
sudo chmod 600 /Library/LaunchDaemons/com.gloss.server.plist   # the plist contains the token
sudo launchctl bootstrap system /Library/LaunchDaemons/com.gloss.server.plist
```

Multi-machine corpora: uncomment `GLOSS_PROJECTS_ROOTS` in the plist so the
server's own logs and each synced client tree get distinct source labels
(they show up as filter chips in the index Settings menu). Roots must be
disjoint directories — the server refuses nested roots.

Logs: `~/Library/Logs/gloss.log` / `gloss.err.log`.
Restart after pulling new code: `sudo launchctl kickstart -k system/com.gloss.server`.

## 3. Client sync (LaunchAgent, every 5 min)

```sh
# On each client — script must live OUTSIDE ~/Documents (see TCC note below)
mkdir -p ~/.local/bin
cp scripts/sync-to-server.sh ~/.local/bin/gloss-sync.sh
chmod +x ~/.local/bin/gloss-sync.sh
sed -e "s|__USERNAME__|$(whoami)|g" \
    -e "s|__SYNC_DEST__|<user>@<server-ip>:/Users/<user>/.claude/projects-laptop/|g" \
    deploy/macos/gloss-sync.plist.template \
    > ~/Library/LaunchAgents/com.gloss.sync.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.gloss.sync.plist
```

Sync each client into its **own root** on the server (e.g.
`~/.claude/projects-laptop/`), never into the server's own
`~/.claude/projects/` — that's what keeps source attribution structural.

**macOS TCC gotcha (bit us twice):** launchd agents do not inherit the Full
Disk Access that SSH/Terminal sessions have, so anything they execute or read
under `~/Documents` fails — bun dies with `error: An unknown error occurred
(Unexpected)`. That's why the server repo lives at `~/gloss` and the client
sync script at `~/.local/bin`. Also: bun's runtime transpiler cache
(`~/Library/Caches/bun`) can wedge and hang every module load under launchd;
the server plist sets `BUN_RUNTIME_TRANSPILER_CACHE_PATH=0`.

The script takes a lock, so a slow first sync and the 5-min interval can't
race. The server rescans on its own (60s–5min adaptive backoff), so new files
show up without any push notification.

## 4. Validation

On the server (bound to `<server-ip>` — localhost is intentionally refused):

```sh
curl -si http://127.0.0.1:3456/                                            # connection refused — expected
curl -si http://<server-ip>:3456/ | head -1                                # HTTP/1.1 401
curl -si -H "Authorization: Bearer $TOKEN" http://<server-ip>:3456/ | head -1            # HTTP/1.1 200
curl -si -X POST -H "Authorization: Bearer $TOKEN" http://<server-ip>:3456/api/resume | head -1  # HTTP/1.1 403
cd ~/gloss && bun src/cli.ts doctor --strict                               # exit 0
```

From a client: same 401/200/403 trio against `<server-ip>:3456`.

End-to-end freshness: start a Claude session on a client, wait ≤5 min for
sync + ≤5 min for rescan, confirm it appears on the server's index. (Or skip
the wait: `POST /api/scan` below.)

## 5. Phone

Open once in the phone browser (on the private network):

```
http://<server-ip>:3456/?token=<TOKEN>
```

The `?token=` visit sets a year-long `gloss_token` cookie and redirects to
strip the token from the URL — every page, search, and live WebSocket works
normally after that. Bookmark the bare URL.

## 6. Client MCP bridge → server

To make client Claude Code sessions query the server's index, set in the MCP
server config for `gloss`:

```json
"env": {
  "GLOSS_URL": "http://<server-ip>:3456",
  "GLOSS_AUTH_TOKEN": "<TOKEN>",
  "GLOSS_SYNC_CMD": "/Users/<user>/.local/bin/gloss-sync.sh"
}
```

(While a machine still runs its own local Gloss, leave this unset.)

`GLOSS_SYNC_CMD` makes every MCP tool call push this machine's freshest logs
first (debounced 60s) and then `POST /api/scan`, which forces an immediate
rescan instead of waiting for the 1–5 min timer. Any sync client can use
`/api/scan` the same way:

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" http://<server-ip>:3456/api/scan
# → {"ok":true,"changedCount":N,"total":M}
```

## Environment variable reference

| Var | Meaning |
|-----|---------|
| `GLOSS_REMOTE=1` | Require auth everywhere, disable OS endpoints, don't auto-open a browser |
| `GLOSS_AUTH_TOKEN` | Shared secret (Bearer header, `gloss_token` cookie, or one-time `?token=`) |
| `GLOSS_BIND_HOST` | Interface to bind. Non-loopback values require `GLOSS_REMOTE=1` (fails closed at startup) |
| `GLOSS_DISABLE_OS_ENDPOINTS` | Defaults to `1` in remote mode; `0` re-enables (don't, on a shared network) |
| `GLOSS_PROJECTS_DIR` | Override the scan root (default `~/.claude/projects`) |
| `GLOSS_PROJECTS_ROOTS` | Multi-root scan with source attribution: `name=path,name=path`. Takes precedence over `GLOSS_PROJECTS_DIR`. Each root's sessions get that name as `source_machine`; the Sources toggle in index Settings appears when >1 source. Roots must be disjoint |
| `GLOSS_MACHINE_NAME` | Source label for single-root scans (default `local`) |
| `GLOSS_SYNC_CMD` | MCP bridge only: command that pushes this machine's logs before tool calls |
| `GLOSS_SYNC_DEST` / `GLOSS_SYNC_SRC` | `sync-to-server.sh` destination (required) and source (default `~/.claude/projects/`) |
| `CONVO_DB_PATH` | Override the DB path (default `~/.convo/db.sqlite`) |

## Recovery

- Raw JSONLs are the source of truth; FTS and embeddings are disposable caches.
- Annotations are journaled to `~/.convo/backups/annotations-YYYY-MM-DD.jsonl`
  on every committed write, and `bun src/cli.ts annotations export/import`
  round-trips everything (idempotent).
- DB snapshot while live: `db.backupTo()` / `VACUUM INTO` only. Never `cp db.sqlite`.
- `bun src/cli.ts doctor --strict` before trusting a rebuilt index.

## Non-goals (deliberate)

- No public internet exposure (no Tailscale Funnel or port forwarding).
- No `--delete` in sync — a confused client must never erase server history.
- No bidirectional DB sync — the server is the single writer.
- Two routes are intentionally still available in remote mode and shell out
  to the local `claude` CLI on the server: `/api/ask*` (AI search) and
  session summaries. They require auth and pass no request data as command
  arguments. If you don't want any remote-triggered subprocess, don't install
  the `claude` CLI on the server.
- Tightening further: a network ACL restricting 3456/tcp to your own devices
  protects the 401 surface itself (in Tailscale: the admin console).
