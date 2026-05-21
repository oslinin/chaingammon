#!/usr/bin/env bash
# Run once on a fresh VPS after git clone.
# Assumes: repo cloned to ~/chaingammon, .env already exists at server/.env
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SERVER_DIR="$REPO_ROOT/server"
SERVICE_SRC="$SERVER_DIR/chaingammon-server.service"
SERVICE_DST="/etc/systemd/system/chaingammon-server.service"

echo "==> Installing Node.js (if missing)"
if ! command -v node &>/dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi

echo "==> Installing og-bridge and og-compute-bridge deps"
npm install --prefix "$REPO_ROOT/og-bridge" --legacy-peer-deps
npm install --prefix "$REPO_ROOT/og-compute-bridge" --legacy-peer-deps

echo "==> Installing Python deps"
cd "$SERVER_DIR"
uv sync

echo "==> Installing systemd unit"
sudo cp "$SERVICE_SRC" "$SERVICE_DST"
sudo systemctl daemon-reload
sudo systemctl enable chaingammon-server

echo "==> Starting service"
sudo systemctl start chaingammon-server
sudo systemctl status chaingammon-server --no-pager
