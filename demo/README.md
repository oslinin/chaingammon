# Local Swarm Demo

This demo spins up five backgammon RL training nodes that discover each other over AXL, play matches, and report results to the Tournament ELO contract on 0G Chain.

## What the demo shows

Five nodes start with random weights and identical 1500 ELO.  Each node trains continuously via TD(λ) self-play while simultaneously challenging peers.  Within the first few minutes you will see:

- **Peer discovery** — nodes exchange `ANNOUNCE` messages, populating each other's peer pool.
- **First match exchange** — one node challenges another; both compute the match result with a shared random seed and report the co-signed result to the chain.
- **First chain submission** — the `MatchReported` event appears in the 0G explorer (chainscan-galileo.0g.ai).
- **ELO divergence** — nodes that hit lucky match draws pull ahead; nodes 50+ ELO points behind a peer download that peer's checkpoint and fast-track their training.

## Prerequisites

```bash
# Python deps
pip install -r requirements.txt

# 0G Chain: deploy Tournament contract
npx hardhat run contracts/script/deploy_tournament.js --network 0g-testnet
# Sets OG_RPC_URL and DEPLOYER_PRIVATE_KEY in .env first (see .env.example)

# AXL binary (from https://github.com/gensyn-ai/axl)
axl start --config agent/axl-config.json &
```

## Running the demo

```bash
# Full demo (requires AXL running and 0G env vars set)
bash demo/run_local_swarm.sh

# Standalone self-play only (no AXL or 0G required)
bash demo/run_local_swarm.sh --no-network
```

## Watching the logs

```bash
tail -f demo/logs/node_0.log   # training progress + peer events
```

## Live leaderboard

```bash
python demo/leaderboard.py --top 5 --interval 30
```

## What to look for

| Log pattern | Meaning |
|---|---|
| `Node started on port 8101` | Node 0 accepting AXL messages |
| `Peer cycle` + `ANNOUNCE` | Broadcast to known peers |
| `playing` response in log | Node accepted a challenge |
| `MatchReported` tx hash | On-chain ELO update confirmed |
| `Replaced weights from 0g://` | Weight pull from stronger peer |
