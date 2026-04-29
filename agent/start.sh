#!/usr/bin/env bash
# start.sh — start gnubg service + coach service, plus AXL relay if installed.
#
# Requirements:
#   - gnubg installed: sudo apt install gnubg
#   - Python deps: `uv sync` (reads agent/pyproject.toml)
#   - axl binary on PATH — OPTIONAL. Only needed when a remote browser
#     must reach this node over the Yggdrasil mesh (testnet / live demo).
#     Local dev (browser on the same machine hitting localhost:8001/8002)
#     does not route through AXL.
#
# When AXL is present this script generates a public key on first run.
# Copy it to the gnubg_axl_pubkey text record on chaingammon.eth so
# remote clients can discover this node without a central server.
set -e

uv run uvicorn gnubg_service:app --port 8001 &
uv run uvicorn coach_service:app --port 8002 &

if command -v axl >/dev/null 2>&1; then
  axl start --config axl-config.json
else
  # Local-dev path: AXL not installed. Keep the script alive so its child
  # uvicorn processes stay running and Ctrl+C terminates the whole group.
  # Without `wait`, `set -e` lets the script fall through and exit, which
  # would orphan (or, in some terminal modes, kill) the backgrounded
  # services and silently break the coach panel.
  echo "axl binary not found on PATH — skipping AXL relay (local-dev mode)."
  echo "Services running: gnubg :8001, coach :8002. Press Ctrl+C to stop."
  wait
fi
