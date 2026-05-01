#!/usr/bin/env python3
"""Fetch a public drand round and print its digest in hex.

drand is the League-of-Entropy public randomness beacon. KeeperHub
pulls a round per turn during a match; the per-turn dice are
deterministically derived from the round digest (see
`agent/drand_dice.py` for the hash → dice mapping).

This script is the upstream side of that flow — it fetches the round
from a public drand HTTP endpoint and emits the digest, so the trainer's
`--drand-digest` flag has an obvious source for ad-hoc testing without
running KeeperHub locally.

Usage:
    python scripts/fetch_drand_round.py            # fetch latest round
    python scripts/fetch_drand_round.py --round 12345

Output:
    round=<n>
    digest=0x<64-hex-bytes>

Pipe into the trainer:

    DIGEST=$(python scripts/fetch_drand_round.py | grep digest | cut -d'=' -f2)
    cd agent && uv run python sample_trainer.py --drand-digest "${DIGEST#0x}"
"""
from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.request


# Public drand HTTP endpoint and the chain hash for the
# "League of Entropy" mainnet beacon. drand groups its rounds under
# named "chains"; this hash identifies the canonical 30-second-period
# chain that everyone refers to as "drand mainnet".
DRAND_BASE = "https://api.drand.sh"
LOE_CHAIN_HASH = (
    "8990e7a9aaed2ffed73dbd7092123d6f289930540d7651336225dc172e51b2ce"
)


def fetch_round(round_number: int | None = None, *,
                base: str = DRAND_BASE,
                chain_hash: str = LOE_CHAIN_HASH,
                timeout: float = 10.0) -> dict:
    """Fetch a drand round. Returns the parsed JSON body
    `{round, randomness, signature, previous_signature}`.

    `round_number=None` fetches the latest published round."""
    suffix = "latest" if round_number is None else str(round_number)
    url = f"{base}/{chain_hash}/public/{suffix}"
    req = urllib.request.Request(
        url, headers={"User-Agent": "chaingammon-fetch-drand/1.0"}
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        body = resp.read()
    parsed = json.loads(body)
    if "randomness" not in parsed or "round" not in parsed:
        raise RuntimeError(f"unexpected drand response shape: {parsed}")
    return parsed


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--round", type=int, default=None,
                        help="Round number to fetch. Default: latest.")
    parser.add_argument("--base", type=str, default=DRAND_BASE,
                        help=f"drand HTTP base URL. Default: {DRAND_BASE}")
    parser.add_argument("--chain-hash", type=str, default=LOE_CHAIN_HASH,
                        help="drand chain hash to query (the LoE mainnet "
                             "by default).")
    parser.add_argument("--timeout", type=float, default=10.0,
                        help="HTTP timeout in seconds.")
    parser.add_argument("--json", action="store_true",
                        help="Emit the raw JSON response instead of "
                             "the round= / digest= line format.")
    args = parser.parse_args()

    try:
        result = fetch_round(args.round, base=args.base,
                             chain_hash=args.chain_hash, timeout=args.timeout)
    except (urllib.error.URLError, RuntimeError, json.JSONDecodeError) as e:
        print(f"error fetching drand round: {e}", file=sys.stderr)
        return 1

    if args.json:
        print(json.dumps(result, indent=2))
        return 0

    # The "randomness" field is the 32-byte digest of the round's
    # threshold signature — exactly what `drand_dice.derive_dice`
    # consumes as `round_digest`.
    print(f"round={result['round']}")
    print(f"digest=0x{result['randomness']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
