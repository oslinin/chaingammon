# ChainGammon — FastAPI server

FastAPI backend serving the match engine, agent registry, training orchestration, and 0G Storage integration.

## Running locally

```bash
uv sync
uv run uvicorn app.main:app --host 0.0.0.0 --port 8000
```

Point the frontend at it by setting `NEXT_PUBLIC_SERVER_URL=http://localhost:8000` in `frontend/.env.local`.

## VPS deployment

The production server runs on `132.145.158.84` under systemd as `chaingammon-server`. Set these once per terminal session:

```bash
export CG_VPS=ubuntu@132.145.158.84          # primary
export CG_VPS_BACKUP=oleg@136.112.73.124     # backup
export CG_KEY=~/Documents/ssh/ssh-key-2026-05-17.key
```

### First-time installation

```bash
# 1. SSH in
ssh -i $CG_KEY $CG_VPS

# 2. Clone the repo
git clone https://github.com/oslinin/chaingammon.git
cd chaingammon

# 3. Create the env file (contains secrets — not in git)
cat > server/.env <<'EOF'
OG_STORAGE_RPC=https://evmrpc-testnet.0g.ai
OG_STORAGE_INDEXER=https://indexer-storage-testnet-turbo.0g.ai
OG_STORAGE_PRIVATE_KEY=<your-key>
OG_EQUITY_URL=http://132.145.158.84
EOF

# 4. Install deps, register and start the service
bash server/scripts/setup.sh
```

### Deploy a change

```bash
ssh -i $CG_KEY $CG_VPS "cd /home/ubuntu/chaingammon && bash server/scripts/deploy.sh"
```

### Logs and manual control

```bash
ssh -i $CG_KEY $CG_VPS   # then on the VPS:

journalctl -u chaingammon-server -f         # tail live logs
journalctl -u chaingammon-server -n 100     # last 100 lines

sudo systemctl stop    chaingammon-server
sudo systemctl start   chaingammon-server
sudo systemctl status  chaingammon-server
```

The server takes ~15 s to start (torch loads at import time). `journalctl -f` shows `Application startup complete` when ready.

## Key modules

| File | Responsibility |
|------|---------------|
| `app/main.py` | All HTTP endpoints — matches, agents, training, ELO, ENS |
| `app/gnubg_client.py` | Subprocess bridge to gnubg for move evaluation |
| `app/og_storage_client.py` | 0G Storage KV get/put for agent weights and profiles |
| `app/training_service.py` | Spawns `challenge_trainer.py` subprocess, streams status |
| `app/keeper_workflow.py` | KeeperHub workflow integration for match settlement |
| `app/chain_client.py` | Web3 calls to `MatchRegistry` and `AgentRegistry` on Sepolia |
| `app/agent_overlay.py` | Parses agent style profiles from 0G KV blobs |
| `app/weights.py` | Loads and caches ONNX / torch agent checkpoints |

## Environment variables

All sourced from `server/.env` (locally) or the systemd `EnvironmentFile` (VPS):

| Variable | Required | Description |
|----------|----------|-------------|
| `OG_STORAGE_RPC` | yes | 0G testnet RPC — `https://evmrpc-testnet.0g.ai` |
| `OG_STORAGE_INDEXER` | yes | 0G storage indexer — `https://indexer-storage-testnet-turbo.0g.ai` |
| `OG_STORAGE_PRIVATE_KEY` | yes | Wallet key for signing 0G Storage uploads |
| `OG_EQUITY_URL` | no | Direct equity provider URL, bypasses on-chain 0G registration |

## Tests

```bash
uv run pytest tests/
```
