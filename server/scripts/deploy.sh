#!/usr/bin/env bash
# Deploy latest code to the VPS. Run from inside the repo on the VPS.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SERVER_DIR="$REPO_ROOT/server"

echo "==> Pulling latest code"
cd "$REPO_ROOT"
git pull

echo "==> Syncing deps"
cd "$SERVER_DIR"
uv sync

echo "==> Restarting service"
sudo systemctl restart chaingammon-server
sudo systemctl status chaingammon-server --no-pager
