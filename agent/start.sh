#!/usr/bin/env bash
# start.sh — start the local gnubg FastAPI service.
#
# Requirements:
#   - gnubg installed: sudo apt install gnubg
#   - Python deps: `uv sync` (reads agent/pyproject.toml)
#
# The browser hits this service directly on localhost:8001.
# No relay or P2P layer in front of it. The coach LLM runs on
# 0G Compute via the Next.js Route Handler at
# `frontend/app/api/coach/hint/route.ts`, so no local coach
# process is needed.
#
# HOST defaults to 0.0.0.0 so a browser on a different machine on the
# same LAN (e.g. http://192.168.x.y:8001) can reach the service. Set
# AGENT_HOST=127.0.0.1 to lock to loopback only.
set -e

HOST="${AGENT_HOST:-0.0.0.0}"

uv run uvicorn gnubg_service:app --host "$HOST" --port 8001 &

# Keep the script alive so its child uvicorn process stays running and
# Ctrl+C terminates the whole group. Without `wait`, `set -e` lets the
# script fall through and exit, which would orphan (or, in some terminal
# modes, kill) the backgrounded service.
echo "Service running: gnubg :8001. Press Ctrl+C to stop."
wait
