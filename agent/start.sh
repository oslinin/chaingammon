#!/usr/bin/env bash
# start.sh — start the two local agent processes (gnubg + coach FastAPI services).
#
# Requirements:
#   - gnubg installed: sudo apt install gnubg
#   - Python deps: `uv sync` (reads agent/pyproject.toml)
#
# The browser hits these services directly on localhost (8001 + 8002).
# No relay or P2P layer in front of them.
#
# HOST defaults to 0.0.0.0 so a browser on a different machine on the
# same LAN (e.g. http://192.168.x.y:8001) can reach the services. Set
# AGENT_HOST=127.0.0.1 to lock to loopback only.
set -e

HOST="${AGENT_HOST:-0.0.0.0}"

uv run uvicorn gnubg_service:app --host "$HOST" --port 8001 &
uv run uvicorn coach_service:app --host "$HOST" --port 8002 &

# Keep the script alive so its child uvicorn processes stay running and
# Ctrl+C terminates the whole group. Without `wait`, `set -e` lets the
# script fall through and exit, which would orphan (or, in some terminal
# modes, kill) the backgrounded services and silently break the coach panel.
echo "Services running: gnubg :8001, coach :8002. Press Ctrl+C to stop."
wait
