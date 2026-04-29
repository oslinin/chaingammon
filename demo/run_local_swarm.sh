#!/usr/bin/env bash
# run_local_swarm.sh — Spin up 5 backgammon AXL training nodes locally.
#
# Prerequisites:
#   1. Python deps installed: pip install -r requirements.txt
#   2. AXL binary in PATH (or --no-storage/--no-chain flags active)
#   3. Tournament contract deployed (optional, use --no-chain to skip):
#      npx hardhat run contracts/script/deploy_tournament.js --network 0g-testnet
#
# Each node gets a distinct seed, varied hyperparameters, and is passed the
# AXL IDs of all other nodes.  Logs go to demo/logs/node_N.log.
#
# Usage:
#   bash demo/run_local_swarm.sh              # full (requires AXL + 0G)
#   bash demo/run_local_swarm.sh --no-network # standalone self-play only

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
LOG_DIR="${SCRIPT_DIR}/logs"

mkdir -p "${LOG_DIR}"

# ── Hyperparameter grid (varied across nodes) ─────────────────────────────────
LAMBDAS=(0.5  0.7  0.9  0.7  0.5)
LRS=(5e-4     1e-3 2e-3 5e-4 1e-3)
HIDDENS=(64   128  192  128  64)
SEEDS=(1      2    3    4    5)
PORTS=(8101   8102 8103 8104 8105)

# ── AXL agent IDs (used as peer-discovery keys) ───────────────────────────────
# In a real deployment these come from `axl status`; here we use predictable IDs.
IDS=("node-0001" "node-0002" "node-0003" "node-0004" "node-0005")

EXTRA_FLAGS=""
if [[ "${1:-}" == "--no-network" ]]; then
  EXTRA_FLAGS="--no-chain --no-storage"
  echo "[swarm] Running in standalone mode (--no-network)"
else
  echo "[swarm] Running with AXL + 0G (use --no-network for standalone)"
fi

PIDS=()

for i in {0..4}; do
  # Build comma-separated peer list (all IDs except self).
  PEERS=""
  for j in {0..4}; do
    if [[ $j -ne $i ]]; then
      PEERS+="${IDS[$j]},"
    fi
  done
  PEERS="${PEERS%,}"   # strip trailing comma

  LOG="${LOG_DIR}/node_${i}.log"
  echo "[swarm] Starting node ${IDS[$i]} on port ${PORTS[$i]} → ${LOG}"

  python3 -m backgammon.axl.node \
    --agent-id "${IDS[$i]}" \
    --peers    "${PEERS}" \
    --port     "${PORTS[$i]}" \
    --seed     "${SEEDS[$i]}" \
    --hidden   "${HIDDENS[$i]}" \
    --lr       "${LRS[$i]}" \
    --lambda-td "${LAMBDAS[$i]}" \
    ${EXTRA_FLAGS} \
    > "${LOG}" 2>&1 &

  PIDS+=($!)
done

echo "[swarm] All 5 nodes started.  PIDs: ${PIDS[*]}"
echo "[swarm] Logs: ${LOG_DIR}/"
echo "[swarm] Press Ctrl+C to stop all nodes."

# Wait for any node to exit (error) or user interrupt.
trap 'echo "[swarm] Stopping..."; kill "${PIDS[@]}" 2>/dev/null' INT TERM

wait "${PIDS[@]}"
