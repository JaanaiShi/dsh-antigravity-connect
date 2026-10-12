#!/bin/bash
# Refresh the stable runtime copy the desktop profile loads.
#
# The profile points at a *copy* rather than at this working tree on purpose: a
# linked checkout means the app and the author's tests share one directory, so
# running the suite can change what the running app sees — including briefly
# binding the OAuth callback port. This copy is the boundary.
#
# Usage: scripts/sync-stable-copy.sh [destination]
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
DEST="${1:-$HOME/.dsh/profiles/desktop/node_modules/dsh-antigravity-connect-stable}"

if [ ! -d "$(dirname "$DEST")" ]; then
  echo "sync-stable-copy: $(dirname "$DEST") does not exist; is the desktop profile installed?" >&2
  exit 1
fi

# Only runtime files: never the dev module layer, tests, docs, or scripts.
rm -rf "$DEST"
mkdir -p "$DEST"
for item in index.js client.js cordis.patch.yml package.json LICENSE README.md README.zh.md lib bin; do
  cp -R "$HERE/$item" "$DEST/$item"
done

echo "sync-stable-copy: refreshed $DEST"
find "$DEST" -type f | wc -l | sed 's/^/  files: /'
