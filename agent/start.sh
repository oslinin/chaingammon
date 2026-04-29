#!/usr/bin/env bash
# start.sh — start AXL node + gnubg service + coach service.
#
# Requirements:
#   - axl binary in PATH (Gensyn Agent eXchange Layer)
#   - gnubg installed: sudo apt install gnubg
#   - Python deps: `uv sync` (reads agent/pyproject.toml)
#
# The AXL node generates a public key on first run. Copy it to the
# gnubg_axl_pubkey text record on chaingammon.eth so clients can
# discover this node without a server.
set -e

uv run uvicorn gnubg_service:app --port 8001 &
uv run uvicorn coach_service:app --port 8002 &
axl start --config axl-config.json
