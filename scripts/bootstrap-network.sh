#!/usr/bin/env bash
# bootstrap-network.sh — fresh-network setup for Chaingammon.
#
# One command does the full bootstrap so a clean repo + funded wallet leaves
# you with a working deployment that anyone in the world can verify:
#
#   1. Compile + run hardhat tests (ensures we don't deploy broken contracts)
#   2. Deploy MatchRegistry + AgentRegistry to Sepolia, mint seed agent #1
#      (writes contracts/deployments/sepolia.json)
#   3. Encrypt /usr/lib/gnubg/gnubg.wd, upload to 0G Storage, and pin the
#      resulting Merkle rootHash on AgentRegistry via setBaseWeightsHash
#   4. Verify the deployed contracts on Etherscan / Sepolia (source code visible)
#
# Run from the repo root:
#
#   ./scripts/bootstrap-network.sh
#
# Prereqs (server/.env — gitignored):
#
#   - DEPLOYER_PRIVATE_KEY        mirrored from contracts/.env
#   - OG_STORAGE_PRIVATE_KEY      same wallet is fine for testnet
#   - BASE_WEIGHTS_ENCRYPTION_KEY 32 bytes hex; generate once with
#       cd server && uv run python scripts/upload_base_weights.py --print-fresh-key
#
# When NOT to use this script:
#   - You only want to redeploy contracts and reuse the existing weights blob:
#     run `pnpm contracts:deploy` alone.
#   - You only want to re-upload a new weights blob without redeploying:
#     run `cd server && uv run python scripts/upload_base_weights.py` alone.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

# Pull in server/.env so we can fail fast if the encryption key is missing.
if [[ -f server/.env ]]; then
    set -a
    # shellcheck disable=SC1091
    source server/.env
    set +a
fi
: "${BASE_WEIGHTS_ENCRYPTION_KEY:?missing BASE_WEIGHTS_ENCRYPTION_KEY in server/.env — run 'cd server && uv run python scripts/upload_base_weights.py --print-fresh-key' first}"

# gnubg's weights file (and the gnubg binary itself, used by the inference
# runtime) ships only inside the gnubg package — there's no separate
# CDN-hosted weights file. Bail early with a readable error if missing.
GNUBG_WEIGHTS="/usr/lib/gnubg/gnubg.wd"
if [[ ! -f "$GNUBG_WEIGHTS" ]]; then
    cat >&2 <<EOF
error: gnubg weights file not found at $GNUBG_WEIGHTS

The bootstrap reads gnubg's neural-network weights file, encrypts it, and
uploads it to 0G Storage. That file ships inside the gnubg package; you
need to install gnubg first.

  Ubuntu / Debian:  sudo apt install gnubg
  macOS:            brew install gnubg

EOF
    exit 1
fi

echo "==> 1/4  Compile + run hardhat tests"
pnpm contracts:test

echo
echo "==> 2/4  Deploy MatchRegistry + AgentRegistry to Sepolia"
pnpm contracts:deploy

DEPLOYMENTS_JSON="contracts/deployments/sepolia.json"
if [[ ! -f "$DEPLOYMENTS_JSON" ]]; then
    echo "error: $DEPLOYMENTS_JSON not found after deploy" >&2
    exit 1
fi
NEW_AGENT_REGISTRY_ADDRESS="$(python3 -c "import json; print(json.load(open('$DEPLOYMENTS_JSON'))['contracts']['AgentRegistry'])")"
NEW_MATCH_REGISTRY_ADDRESS="$(python3 -c "import json; print(json.load(open('$DEPLOYMENTS_JSON'))['contracts']['MatchRegistry'])")"

echo
echo "==> 3/4  Encrypt /usr/lib/gnubg/gnubg.wd and pin its 0G Storage hash on $NEW_AGENT_REGISTRY_ADDRESS"
(
    cd server
    AGENT_REGISTRY_ADDRESS="$NEW_AGENT_REGISTRY_ADDRESS" \
    MATCH_REGISTRY_ADDRESS="$NEW_MATCH_REGISTRY_ADDRESS" \
    uv run python scripts/upload_base_weights.py
)

echo
echo "==> 4/4  Verify deployed contracts on Etherscan (Sepolia)"
pnpm contracts:verify

cat <<EOF

✓ Bootstrap complete.

Next steps:
  1. Update server/.env with:
        AGENT_REGISTRY_ADDRESS=$NEW_AGENT_REGISTRY_ADDRESS
        MATCH_REGISTRY_ADDRESS=$NEW_MATCH_REGISTRY_ADDRESS

  2. Update frontend/.env.local with:
        NEXT_PUBLIC_AGENT_REGISTRY_ADDRESS=$NEW_AGENT_REGISTRY_ADDRESS
        NEXT_PUBLIC_MATCH_REGISTRY_ADDRESS=$NEW_MATCH_REGISTRY_ADDRESS

  3. (Optional) Update DEFAULT_BASE_WEIGHTS_HASH in contracts/script/deploy.js
     so future redeploys inherit the pinned hash without a follow-up tx.
     Read the new hash with:
        cd server && uv run python -c "from app.chain_client import ChainClient; print(ChainClient.from_env().base_weights_hash())"

EOF
