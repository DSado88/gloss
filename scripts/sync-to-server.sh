#!/bin/zsh
# Sync Claude Code JSONL logs from this machine to a remote Gloss server.
#
# Safety properties (do not "optimize" these away):
#   -a               preserves mtimes — canonical ranking tiebreaks depend on them
#   --delay-updates  every changed file lands via atomic rename at the END of the
#                    transfer, so the server's Gloss never sees a half-copied file
#   --partial-dir    interrupted transfers resume without corrupting targets
#   NO --inplace / --append   would write into live files non-atomically
#   NO --delete               a bad local state must never erase server history
#
# Configuration (env):
#   GLOSS_SYNC_DEST   required — rsync destination, e.g.
#                     user@100.x.y.z:/Users/user/.claude/projects-laptop/
#                     Point it at a DEDICATED root on the server (not the
#                     server's own ~/.claude/projects) so source attribution
#                     stays correct; the server lists it in GLOSS_PROJECTS_ROOTS.
#   GLOSS_SYNC_SRC    optional — defaults to ~/.claude/projects/
#
# Usage: sync-to-server.sh [--dry-run]

set -euo pipefail

if [[ -z "${GLOSS_SYNC_DEST:-}" ]]; then
  echo "GLOSS_SYNC_DEST is not set (e.g. user@server:/path/to/projects-laptop/)" >&2
  exit 1
fi
SRC="${GLOSS_SYNC_SRC:-$HOME/.claude/projects/}"
DEST="$GLOSS_SYNC_DEST"
LOG_TAG="gloss-sync"

DRY_RUN=()
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=(--dry-run --verbose)
fi
# ${arr:+...} guard: empty-array expansion errors under `set -u` in bash <4.4

# One sync at a time — overlapping runs (slow first sync + launchd interval)
# would race each other on the same partial dirs.
LOCKDIR="${TMPDIR:-/tmp}/gloss-sync.lock"
if ! mkdir "$LOCKDIR" 2>/dev/null; then
  echo "[$LOG_TAG] another sync is running, skipping" >&2
  exit 0
fi
trap 'rmdir "$LOCKDIR"' EXIT

rsync -a \
  --delay-updates \
  --partial-dir=.rsync-partial \
  --exclude='subagents/' \
  --exclude='.rsync-partial/' \
  --exclude='.DS_Store' \
  ${DRY_RUN:+"${DRY_RUN[@]}"} \
  "$SRC" "$DEST"

echo "[$LOG_TAG] $(date '+%Y-%m-%d %H:%M:%S') sync complete"
