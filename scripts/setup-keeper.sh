#!/usr/bin/env bash
# setup-keeper.sh — register the Chaingammon settlement workflow on KeeperHub
#                   and push all required secrets.
#
# Usage (local):
#   cp keeperhub/.env.example keeperhub/.env   # fill in values
#   ./scripts/setup-keeper.sh
#
# Usage (CI — add each variable as a GitHub Secret, then run this script
#   in a workflow step):
#   ./scripts/setup-keeper.sh
#
# Prereqs:
#   kh CLI — install with:  brew install keeperhub/tap/kh
#   All variables below set in keeperhub/.env OR as environment variables.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$REPO_ROOT/keeperhub/.env"

# ── Load .env file if present (allows local usage without exporting vars) ────
if [[ -f "$ENV_FILE" ]]; then
  # shellcheck source=/dev/null
  set -a
  source "$ENV_FILE"
  set +a
fi

# ── Validate required variables ──────────────────────────────────────────────
REQUIRED_VARS=(
  KH_API_KEY
  KEEPER_PRIVKEY
  SERVER_URL
  RELAYER_URL
  GNUBG_REPLAY_URL
  OG_RPC_URL
  OG_STORAGE_INDEXER
  MATCH_REGISTRY_ADDRESS
  MATCH_ESCROW_ADDRESS
)

missing=()
for var in "${REQUIRED_VARS[@]}"; do
  if [[ -z "${!var:-}" ]]; then
    missing+=("$var")
  fi
done

if [[ ${#missing[@]} -gt 0 ]]; then
  echo "ERROR: The following variables are not set:"
  for v in "${missing[@]}"; do
    echo "  $v"
  done
  echo ""
  echo "Copy keeperhub/.env.example to keeperhub/.env and fill in the values,"
  echo "or export them as environment variables before running this script."
  exit 1
fi

# ── Authenticate ─────────────────────────────────────────────────────────────
export KH_API_KEY
echo "✓ Using KH_API_KEY"

# ── Push workflow YAML to KeeperHub ──────────────────────────────────────────
echo "→ Pushing workflow to KeeperHub..."
kh workflow push "$REPO_ROOT/keeperhub/match-settle.yaml"
echo "✓ Workflow registered"

# ── Push secrets ─────────────────────────────────────────────────────────────
echo "→ Setting secrets..."

kh secret set KEEPER_PRIVKEY          "$KEEPER_PRIVKEY"
kh secret set SERVER_URL              "$SERVER_URL"
kh secret set RELAYER_URL             "$RELAYER_URL"
kh secret set GNUBG_REPLAY_URL        "$GNUBG_REPLAY_URL"
kh secret set OG_RPC_URL              "$OG_RPC_URL"
kh secret set OG_STORAGE_INDEXER      "$OG_STORAGE_INDEXER"
kh secret set MATCH_REGISTRY_ADDRESS  "$MATCH_REGISTRY_ADDRESS"
kh secret set MATCH_ESCROW_ADDRESS    "$MATCH_ESCROW_ADDRESS"

echo "✓ All secrets set"

# ── Done ─────────────────────────────────────────────────────────────────────
echo ""
echo "KeeperHub setup complete."
echo "The chaingammon-match-settle workflow will fire automatically when"
echo "both players deposit into MatchEscrow on 0G testnet."
