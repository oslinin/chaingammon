"""
One-time script: upload gnubg backgammon strategy doc to 0G Storage.

0G Storage is 0G's decentralised storage layer. Clients upload bytes and
get back a Merkle `rootHash` that any other client can use to fetch those
bytes. The coach agent (agent/coach_service.py) fetches this doc at
inference time to use as RAG context for its LLM hints.

Usage:
  cd server && uv run python ../scripts/upload_gnubg_docs.py

Prints two lines on success:
  GNUBG_DOCS_HASH=0x<hash>   — store this in agent/.env and frontend/.env
  tx: 0x<txHash>             — the 0G flow contract transaction that pins the blob

Requires: OG_STORAGE_RPC, OG_STORAGE_INDEXER, OG_STORAGE_PRIVATE_KEY in env
(see server/.env.example). These are the same keys used by the server for
game-record uploads — the same wallet can pay both.
"""
import sys
from pathlib import Path

from dotenv import load_dotenv

# Load server/.env so OG_STORAGE_{RPC,INDEXER,PRIVATE_KEY} are visible to
# og_storage_client without the user having to `set -a; source` them.
_REPO_ROOT = Path(__file__).resolve().parents[1]
load_dotenv(_REPO_ROOT / "server" / ".env")

# Run this from the server/ directory so og_storage_client can be imported
# via the server venv (uv run python ../scripts/upload_gnubg_docs.py).
sys.path.insert(0, str(_REPO_ROOT / "server"))
from app.og_storage_client import put_blob  # type: ignore[import]

# Strategy reference covering opening principles, equity, bear-off, and
# cube decisions. This is public gnubg knowledge, not copyrighted material.
# Keep this under ~2 KB so the coach prompt fits within flan-t5-base's
# 512-token input window after the dice + candidates are prepended.
DOCS = """\
GNU Backgammon Strategy Reference

Opening principles:
- Anchor on the 5-point (your opponent's 5-point) early — it is the strongest anchor.
- Build a prime (consecutive blocked points) to trap opponent checkers.
- Avoid leaving blots (single checkers) on high-traffic points when behind.
- The golden point is your own 5-point; control it to dominate the middle game.

Equity:
- Equity is the expected outcome of a position, ranging roughly from -3.0 (losing badly)
  to +3.0 (winning a gammon). 0.0 is an even game.
- A move that costs more than 0.05 equity compared to the best move is a significant error.
- A difference of 0.10+ is a blunder.

Bear-off:
- Leave as few gaps as possible on your home board.
- Stack deeply on the 6-point only if forced; spread checkers to fill gaps.

Doubling cube:
- Double when your winning chances exceed ~70% and your opponent can still take.
- Take a double if your losing chances are below ~75% (the 25% rule).
"""

if __name__ == "__main__":
    result = put_blob(DOCS.encode("utf-8"))
    print(f"GNUBG_DOCS_HASH={result.root_hash}")
    print(f"tx: {result.tx_hash}")
