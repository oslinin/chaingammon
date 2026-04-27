"""
One-time script: encrypt gnubg's base weights file and pin its 0G Storage
hash on the deployed AgentRegistry.

Steps:
  1. Read the gnubg weights file from disk (default /usr/lib/gnubg/gnubg.wd).
  2. Encrypt with AES-256-GCM using BASE_WEIGHTS_ENCRYPTION_KEY (or generate
     a fresh key if --print-fresh-key is passed).
  3. put_blob to 0G Storage → rootHash.
  4. setBaseWeightsHash(rootHash) on AgentRegistry.

After this lands on-chain, every existing agent's `dataHashes[0]` resolves
to the encrypted weights blob; future mints inherit the same hash via the
deploy script.

Usage:
    # First, generate a key and add it to server/.env
    uv run python scripts/upload_base_weights.py --print-fresh-key

    # Then run the actual upload (reads BASE_WEIGHTS_ENCRYPTION_KEY from env)
    uv run python scripts/upload_base_weights.py
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

# Allow `from app...` when run from the server/ dir.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from dotenv import load_dotenv

_SERVER_ENV = Path(__file__).resolve().parents[1] / ".env"
if _SERVER_ENV.exists():
    load_dotenv(_SERVER_ENV)

from app.chain_client import ChainClient  # noqa: E402
from app.og_storage_client import put_blob  # noqa: E402
from app.weights import (  # noqa: E402
    encrypt_weights,
    generate_key,
    load_key_from_env,
)

DEFAULT_WEIGHTS_PATH = "/usr/lib/gnubg/gnubg.wd"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--weights-path",
        default=DEFAULT_WEIGHTS_PATH,
        help="Path to gnubg's weights file (default: %(default)s)",
    )
    parser.add_argument(
        "--print-fresh-key",
        action="store_true",
        help="Print a freshly-generated AES-256 key (hex) and exit. Save the value as BASE_WEIGHTS_ENCRYPTION_KEY in server/.env.",
    )
    args = parser.parse_args()

    if args.print_fresh_key:
        key = generate_key()
        print(key.hex())
        print(
            "\nAdd to server/.env (gitignored):",
            f"\nBASE_WEIGHTS_ENCRYPTION_KEY={key.hex()}",
            file=sys.stderr,
        )
        return 0

    weights_path = Path(args.weights_path)
    if not weights_path.is_file():
        print(f"error: gnubg weights file not found at {weights_path}", file=sys.stderr)
        print(
            "       Install gnubg first — 'sudo apt install gnubg' on Ubuntu/Debian "
            "or 'brew install gnubg' on macOS.",
            file=sys.stderr,
        )
        return 1
    plaintext = weights_path.read_bytes()
    print(f"Read {len(plaintext)} bytes from {weights_path}", file=sys.stderr)

    key = load_key_from_env()
    envelope = encrypt_weights(plaintext, key)
    blob = envelope.to_bytes()
    print(
        f"Encrypted: {len(plaintext)} → {len(blob)} bytes "
        f"(version=0x{envelope.version:02x}, nonce={envelope.nonce.hex()})",
        file=sys.stderr,
    )

    print("Uploading to 0G Storage ...", file=sys.stderr)
    upload = put_blob(blob, timeout=600.0)
    print(
        f"  rootHash: {upload.root_hash}\n"
        f"  txHash:   {upload.tx_hash}",
        file=sys.stderr,
    )

    print("Calling setBaseWeightsHash on AgentRegistry ...", file=sys.stderr)
    chain = ChainClient.from_env()
    if chain.agent_registry is None:
        print("error: AGENT_REGISTRY_ADDRESS not set in server/.env", file=sys.stderr)
        return 1
    set_tx = chain.set_base_weights_hash(upload.root_hash)
    print(f"  setBaseWeightsHash tx: {set_tx}", file=sys.stderr)

    on_chain = chain.base_weights_hash()
    if on_chain.lower() != upload.root_hash.lower():
        print(
            f"error: on-chain baseWeightsHash {on_chain} doesn't match upload {upload.root_hash}",
            file=sys.stderr,
        )
        return 1

    print("\nDone. Final state:", file=sys.stderr)
    print(f"  AgentRegistry.baseWeightsHash() = {on_chain}", file=sys.stderr)
    print(f"  https://chainscan-galileo.0g.ai/tx/{set_tx}", file=sys.stderr)

    # Stdout is the canonical machine-readable result.
    print(upload.root_hash)
    return 0


if __name__ == "__main__":
    sys.exit(main())
