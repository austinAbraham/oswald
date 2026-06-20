#!/usr/bin/env bash
# Publish a clean, code-only mirror of the local development checkout to the
# public GitHub remote. Excludes GSD/agent-internal artifacts (.planning/ and the
# root CLAUDE.md) while preserving public commit history (incremental commits).
#
# Run from your local development checkout:
#   scripts/publish.sh [remote-url] [commit-message]
set -euo pipefail

REMOTE="${1:-git@github.com:austinAbraham/oswald.git}"
MSG="${2:-Publish code-only snapshot}"

SRC="$(git rev-parse --show-toplevel)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

git clone -q "$REMOTE" "$WORK"
# Replace the public working tree (keep its .git), then re-populate from local HEAD.
find "$WORK" -mindepth 1 -maxdepth 1 ! -name '.git' -exec rm -rf {} +
git -C "$SRC" archive HEAD | tar -x -C "$WORK"
# Strip internal-only artifacts.
rm -rf "$WORK/.planning" "$WORK/CLAUDE.md"

git -C "$WORK" add -A
if git -C "$WORK" diff --cached --quiet; then
  echo "No changes to publish."
  exit 0
fi
git -C "$WORK" commit -q -m "$MSG"
git -C "$WORK" push -q origin HEAD:main
echo "Published code-only mirror to $REMOTE"
