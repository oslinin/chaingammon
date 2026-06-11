# Chaingammon

> **An open protocol for portable backgammon reputation.** Your wallet (or your AI agent) is your player profile. Your ENS subname is your portable identity. Your full match archive lives on 0G Storage, owned by you forever.

A decentralised, verifiable ELO ledger for backgammon — humans and agents share one identity layer.

- **Open identity.** ENS subnames written only by the protocol. Reserved text records (`elo`, `match_count`, `kind`, `inft_id`, `style_uri`, `archive_uri`) cannot be self-claimed; any third-party tool reads them without coordinating with us.
- **Verifiable.** Every match settles to `MatchRegistry` on Sepolia. The on-chain record carries the 32-byte 0G Storage hash of the full archive (every move, every dice roll) — anyone can audit any rating change end-to-end.
- **Living agents.** Each AI agent is an ERC-7857 iNFT (with ERC-721 fallback). It pins two `dataHashes`: a starter NN initialised from gnubg's published weights, and a per-agent checkpoint that grows match by match. Transfer the token, transfer the brain.
- **Trustless dice.** Each turn's dice are `keccak256(drand_round_digest, turn_index) mod 36`. The server passes drand's BLS12-381 signature through to the client so an auditor can independently verify the round against drand's group public key.
- **Optional stakes.** A match can be free (ELO-only) or staked (per-side ETH deposit, winner takes the pot). Agent funds live in `AgentVault` — only the NFT owner can withdraw; the server operator key can stake but not steal. Settlement is browser-direct via `settleWithSessionKeys`, with KeeperHub as fallback.
- **No central server.** Move evaluation runs in the browser (ONNX Runtime Web). The coach LLM runs on 0G Compute (Qwen 2.5 7B) with a local fallback. KeeperHub orchestrates settlement.
- **Serverless human-vs-human (in progress).** Press Play to be matched — by nearest ELO — with another human who is also searching, with no matchmaking server and nothing volatile on-chain: presence and the WebRTC handshake ride public Nostr relays, moves flow peer-to-peer over a WebRTC data channel, dice stay drand-verifiable, and settlement fires automatically from session keys both players sign before the game.

For detailed architecture, component design, and infrastructure docs see [ARCHITECTURE.md](ARCHITECTURE.md).

---

## How it works

1. Connect a wallet → frontend resolves (or auto-mints) `<name>.chaingammon.eth` on Sepolia.
2. Pick an opponent — another player's subname or an AI agent (e.g. `gnubg-classic.chaingammon.eth`).
3. Per-turn loop:
   - KeeperHub pulls drand round R → dice are deterministic from the round digest.
   - The active side's agent runs a value-network forward pass (browser or 0G Compute) and selects the highest-equity legal move.
   - The move is appended to the in-progress `GameRecord`; KeeperHub validates legality via the WASM rules engine.
4. Game ends → browser uploads `GameRecord` to 0G Storage → `MatchRegistry.settleWithSessionKeys` called directly from the browser → `post-settle-audit` KeeperHub workflow fires → ENS text records updated → audit trail anchored.
5. Any other tool reads your ENS subname and reconstructs your full backgammon DNA — ELO, games played, playing style.

---

## Running locally

### Prerequisites

- Python 3.12+, [uv](https://github.com/astral-sh/uv)
- Node 20+, [pnpm](https://pnpm.io)
- `gnubg` (for local debugging only) — `sudo apt install gnubg` (Ubuntu/Debian) or `brew install gnubg` (macOS)

### One-time setup

```bash
git clone <repo> && cd chaingammon
pnpm install                    # frontend + contracts (workspace)
cd agent && uv sync && cd ..    # agent Python deps
cp contracts/.env.example contracts/.env       # add DEPLOYER_PRIVATE_KEY + Sepolia RPC_URL
cp frontend/.env.example frontend/.env.local
```

Fund the deployer wallet with Sepolia ETH from any public faucet.

### Bootstrap and run

```bash
# 1. deploy + verify settlement contracts on Sepolia (one shot)
./scripts/bootstrap-network.sh

# 2. start the frontend (from repo root)
pnpm frontend:dev                # Next.js on :3000
```

The FastAPI backend (`server/`) runs on a persistent VPS at `http://132.145.158.84` and is already live — the frontend's `NEXT_PUBLIC_SERVER_URL` points there by default. To run a local backend instead:

```bash
# terminal A — backend
cd server && uv run uvicorn app.main:app --host 0.0.0.0 --port 8000

# frontend/.env.local — point frontend at local server
NEXT_PUBLIC_SERVER_URL=http://localhost:8000
```

Or use the VS Code Tasks workflow (`.vscode/tasks.json`) — `Tasks: Run Task` → `Localhost: launch all` fires hardhat node → deploy contracts → FastAPI server → Next.js frontend in sequence.

### Local dev with Hardhat

```bash
cd contracts && pnpm exec hardhat node            # local chain (chainId 31337)
cd contracts && pnpm exec hardhat run script/deploy.js --network localhost
```

Switch chains in MetaMask; the frontend re-targets the new chain's contracts automatically (see `frontend/app/chains.ts`).

### Test commands

```bash
pnpm test                  # all tests: agent (pytest) + contracts (hardhat) + frontend (build)
pnpm contracts:test
pnpm agent:test
pnpm frontend:test
```

---

## VPS ops

```bash
export CG_VPS=ubuntu@132.145.158.84
export CG_KEY=~/Documents/ssh/ssh-key-2026-05-17.key
```

**Deploy a change:**
```bash
ssh -i $CG_KEY $CG_VPS "cd /home/ubuntu/chaingammon && bash server/scripts/deploy.sh"
```

**Restart everything** (after a reboot or crash):
```bash
ssh -i $CG_KEY $CG_VPS
# FastAPI backend
sudo systemctl restart chaingammon-server

# WebRTC TURN relay
pkill turnserver; turnserver -c /tmp/turnserver.conf --daemon
sudo sslh -p 0.0.0.0:443 --tls=127.0.0.1:8443 --anyprot=127.0.0.1:3479 -P /tmp/sslh.pid

# Frontend (static, port 3001; nginx proxies 443 → 3001)
pkill -f "serve.*out"; npm exec serve@latest /home/ubuntu/chaingammon/frontend/out -- -p 3001 -s &
```

**Logs:**
```bash
journalctl -u chaingammon-server -f
```

Full VPS architecture (coturn, sslh, nginx layout): [ARCHITECTURE.md](ARCHITECTURE.md).

---

## Deployed contracts

**Sepolia:**

- [MatchRegistry](https://sepolia.etherscan.io/address/0x507d78149AE2092a5438825B1BA3F12737FAeC0C)
- [MatchEscrow](https://sepolia.etherscan.io/address/0x1206A93a9B76652382BC1F5164a8383a9F2A2e16)
- [AgentRegistry](https://sepolia.etherscan.io/address/0xE23B83cE16B292e420cd8820ac9d303A45333D17)
- [PlayerSubnameRegistrar](https://sepolia.etherscan.io/address/0x48285B8C9B04C6a3D61bBA067a4DE4399A5a4aEb)

Full deployment records: `contracts/deployments/*.json`.

---

## Roadmap

- **Current:** human-vs-agent gameplay; on-chain ELO; ENS subnames; agent iNFTs with hash-committed weights; 0G Storage match archive; drand dice; KeeperHub-orchestrated settlement on Sepolia.
- **In progress — serverless human-vs-human:** one-press, ELO-biased matchmaking and live play with no central server. Presence + WebRTC signaling ride public Nostr relays, moves flow peer-to-peer, settlement is automatic from pre-authorized session keys.
- **Next:** all-agent autonomous tournaments; 0G Compute for TEE-attested fine-tuning; team / chouette mode with the career head; per-agent cube doubling.
- **Later:** ZK proofs of agent inference (zkML); betting markets and ELO derivative tokens; mainnet on Base/Optimism.

See [ROADMAP.md](ROADMAP.md) for the full version. Architecture details: [ARCHITECTURE.md](ARCHITECTURE.md).
