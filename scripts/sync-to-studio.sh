#!/bin/zsh
# Sync Claude Code JSONL logs from this laptop to the Mac Studio.
#
# Safety properties (do not "optimize" these away):
#   -a               preserves mtimes — canonical ranking tiebreaks depend on them
#   --delay-updates  every changed file lands via atomic rename at the END of the
#                    transfer, so Studio Gloss never sees a half-copied file
#   --partial-dir    interrupted transfers resume without corrupting targets
#   NO --inplace / --append   would write into live files non-atomically
#   NO --delete               a bad local state must never erase Studio history
#
# Usage: sync-to-studio.sh [--dry-run]

set -euo pipefail

# Tailscale IP — plain hostname doesn't resolve from the laptop
STUDIO_HOST="${GLOSS_STUDIO_HOST:-100.109.110.36}"
SRC="$HOME/.claude/projects/"
DEST="david@${STUDIO_HOST}:/Users/david/.claude/projects/"
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
