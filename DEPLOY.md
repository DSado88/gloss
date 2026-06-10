# Deploying Gloss to the Mac Studio

Goal: the Studio (`Davids-Mac-Studio`, tailnet `100.109.110.36`) runs Gloss
continuously as the canonical memory server. The laptop keeps doing real work
and syncs raw JSONL logs over; the phone reads history over Tailscale even
when the laptop is closed.

Architecture:

- **Studio owns** `~/.convo/db.sqlite` (one writer, ever). Never sync the DB.
- **Laptop syncs** `~/.claude/projects/` → Studio, one-way, every 5 min.
- **Auth**: `GLOSS_REMOTE=1` requires a token on every route and the
  WebSocket. The tailnet includes Matt's devices — tailnet-only ≠ private.
- **OS endpoints** (`/api/resume`, `/api/spawn-quick`, `/api/pick-folder`,
  `/api/backup`) are hard-disabled in remote mode.

## 1. One-time seeding (run from the laptop)

```sh
# Repo
ssh david@100.109.110.36 'mkdir -p ~/Documents/Programs'
rsync -a ~/Documents/Programs/convo-viewer/ \
  david@100.109.110.36:/Users/david/Documents/Programs/convo-viewer/ \
  --exclude node_modules
ssh david@100.109.110.36 'cd ~/gloss && ~/.bun/bin/bun install'

# Conversation logs (~28G — first run takes a while)
~/Documents/Programs/convo-viewer/scripts/sync-to-studio.sh

# Gloss DB — snapshot the live DB safely (never raw-copy db.sqlite)
cd ~/Documents/Programs/convo-viewer
bun -e 'import {openDb} from "./src/db.js"; const db = openDb(); db.backupTo("/tmp/gloss-seed.sqlite"); db.close()'
ssh david@100.109.110.36 'mkdir -p ~/.convo'
scp /tmp/gloss-seed.sqlite david@100.109.110.36:/Users/david/.convo/db.sqlite
rm /tmp/gloss-seed.sqlite

# Annotation safety net (cheap, do it)
bun src/cli.ts annotations export -o /tmp/annotations-backup.json
scp /tmp/annotations-backup.json david@100.109.110.36:/Users/david/.convo/

# Embedding model cache (skips a ~400MB re-download on the Studio)
rsync -a ~/.cache/huggingface/ david@100.109.110.36:/Users/david/.cache/huggingface/ 2>/dev/null || true
```

Note: the seeded DB's `jsonl_paths` are all `/Users/david/.claude/projects/...`
— identical layout on both machines, so they resolve as-is on the Studio.

## 2. Studio server (LaunchAgent, run as david)

```sh
# On the Studio
TOKEN=$(openssl rand -hex 32); echo "GLOSS_AUTH_TOKEN=$TOKEN"   # save this in a password manager
sed "s/__GLOSS_AUTH_TOKEN__/$TOKEN/" \
  ~/gloss/deploy/com.david.gloss.plist \
  > ~/Library/LaunchAgents/com.david.gloss.plist
chmod 600 ~/Library/LaunchAgents/com.david.gloss.plist
launchctl bootstrap gui/501 ~/Library/LaunchAgents/com.david.gloss.plist
```

Logs: `~/Library/Logs/gloss.log` / `gloss.err.log`.
Restart after pulling new code: `launchctl kickstart -k gui/501/com.david.gloss`.

## 3. Laptop sync (LaunchAgent, every 5 min)

```sh
# On the laptop — script must live OUTSIDE ~/Documents (see TCC note below)
mkdir -p ~/.local/bin
cp ~/Documents/Programs/convo-viewer/scripts/sync-to-studio.sh ~/.local/bin/gloss-sync-to-studio.sh
chmod +x ~/.local/bin/gloss-sync-to-studio.sh
cp ~/Documents/Programs/convo-viewer/deploy/com.david.gloss-sync.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.david.gloss-sync.plist
```

**macOS TCC gotcha (bit us twice):** launchd agents do not inherit the Full
Disk Access that SSH/Terminal sessions have, so anything they execute or read
under `~/Documents` fails — bun dies with `error: An unknown error occurred
(Unexpected)`. That's why the Studio repo lives at `~/gloss` and the laptop
sync script at `~/.local/bin`. Also: bun's runtime transpiler cache
(`~/Library/Caches/bun`) was wedged on the Studio and hung every module load;
the server plist sets `BUN_RUNTIME_TRANSPILER_CACHE_PATH=0`.

The script takes a lock, so a slow first sync and the 5-min interval can't
race. The server rescans on its own (60s–5min adaptive backoff), so new files
show up without any push notification.

## 4. Validation

On the Studio (bound to the tailnet IP — localhost is intentionally refused):

```sh
curl -si http://127.0.0.1:3456/            # connection refused — expected
curl -si http://100.109.110.36:3456/        | head -1   # HTTP/1.1 401
curl -si -H "Authorization: Bearer $TOKEN" http://100.109.110.36:3456/ | head -1  # HTTP/1.1 200
curl -si -X POST -H "Authorization: Bearer $TOKEN" http://100.109.110.36:3456/api/resume | head -1  # HTTP/1.1 403
cd ~/Documents/Programs/convo-viewer && bun src/cli.ts doctor --strict   # exit 0
```

From the laptop: same 401/200/403 trio against `100.109.110.36:3456`.

End-to-end freshness: start a Claude session on the laptop, wait ≤5 min for
sync + ≤5 min for rescan, confirm it appears on the Studio index.

## 5. Phone

Open once in the phone browser (Tailscale on):

```
http://100.109.110.36:3456/?token=<TOKEN>
```

The `?token=` visit sets a year-long `gloss_token` cookie — every page,
search, and live WebSocket works normally after that. Bookmark the bare URL.

## 6. Laptop MCP bridge → Studio

To make laptop Claude Code sessions query the Studio's index, set in the MCP
server config for `gloss`:

```json
"env": {
  "GLOSS_URL": "http://100.109.110.36:3456",
  "GLOSS_AUTH_TOKEN": "<TOKEN>"
}
```

(While the laptop still runs its own local Gloss, leave this unset.)

## Environment variable reference

| Var | Meaning |
|-----|---------|
| `GLOSS_REMOTE=1` | Require auth everywhere, disable OS endpoints, don't auto-open a browser |
| `GLOSS_AUTH_TOKEN` | Shared secret (Bearer header, `gloss_token` cookie, or one-time `?token=`) |
| `GLOSS_BIND_HOST` | Interface to bind (Studio: the Tailscale IP) |
| `GLOSS_DISABLE_OS_ENDPOINTS` | Defaults to `1` in remote mode; `0` re-enables (don't) |
| `GLOSS_PROJECTS_DIR` | Override the scan root (default `~/.claude/projects`) |
| `GLOSS_PROJECTS_ROOTS` | Multi-root scan with source attribution: `name=path,name=path` (Studio: `studio=~/.claude/projects,mbp=~/.claude/projects-mbp`). Takes precedence over `GLOSS_PROJECTS_DIR`. Each root's sessions get that name as `source_machine`; the Sources toggle in index Settings appears when >1 source |
| `GLOSS_MACHINE_NAME` | Source label for single-root scans (default `local`) |
| `CONVO_DB_PATH` | Override the DB path (default `~/.convo/db.sqlite`) |

## Recovery

- Raw JSONLs are the source of truth; FTS and embeddings are disposable caches.
- Annotations are journaled to `~/.convo/backups/annotations-YYYY-MM-DD.jsonl`
  on every write, and `bun src/cli.ts annotations export/import` round-trips
  everything (idempotent).
- DB snapshot while live: `db.backupTo()` / `VACUUM INTO` only. Never `cp db.sqlite`.
- `bun src/cli.ts doctor --strict` before trusting a rebuilt index.

## Non-goals (deliberate)

- No public internet exposure, no Tailscale Funnel.
- No `--delete` in sync — a confused laptop must never erase Studio history.
- No bidirectional DB sync — the Studio is the single writer.
- Tightening further: a Tailscale ACL restricting 3456/tcp to your MBP +
  iPhone would protect the 401 surface itself; do it in the admin console.
