# Decentralized Game Server Design

**Date:** 2026-04-28
**Status:** Approved

## Problem

The Chaingammon game server (FastAPI + gnubg) is a single point of failure. If it goes down, players cannot play — even though their ELO and identity are already safely on-chain (ENS + 0G). The goal is to make live gameplay as decentralized as the reputation layer.

## Decision

Remove the FastAPI server and KeeperHub entirely. Replace them with Gensyn AXL: a peer-to-peer encrypted communication mesh where gnubg and the LLM coach run as AXL agent nodes that anyone can operate. The player's browser talks to a local AXL node (`localhost:9002`) which routes requests to whichever gnubg/coach agent node is available on the mesh. Human vs human game relay also runs over AXL — no WebRTC, no 0G KV signaling, no central relay. Settlement moves to a two-signature on-chain call. No server, no broker, no single point of failure.

## What is AXL

AXL (Agent eXchange Layer) is Gensyn's P2P network node. It is a single binary that provides an encrypted, decentralised communication layer built on the Yggdrasil mesh. Applications talk to `localhost:9002`; AXL handles encryption, routing, and peer discovery. No servers, no cloud accounts. Any language that can make HTTP requests can use it. Built-in `/a2a/` (Agent-to-Agent) and `/mcp/` (Model Context Protocol) endpoints support structured agent communication with end-to-end encryption.

## Sponsor Coverage

| Sponsor | Role |
|---|---|
| ENS | Portable player identity, ELO text records; agent AXL public keys stored as text records |
| 0G Chain | MatchRegistry, AgentRegistry, PlayerSubnameRegistrar |
| 0G Storage | Game records, gnubg weights, gnubg docs (RAG for coach) |
| Gensyn AXL | P2P mesh: game state relay (H vs H), AI move requests (H vs AI), LLM coach hints |

KeeperHub is removed. Gensyn AXL replaces it as the fourth sponsor.

## Architecture

```
Browser
├── AXL client (HTTP → localhost:9002)
│   ├── /a2a/<gnubg-pubkey>/move   — AI move request
│   ├── /a2a/<coach-pubkey>/hint   — LLM coaching hint
│   └── /a2a/<opponent-pubkey>/game — H vs H game relay
├── commit-reveal dice  — trustless rolls for human vs human
├── block-hash PRNG     — dice for human vs AI (v1); on-chain VRF is v2
└── wagmi / viem        — wallet, on-chain settlement call

AXL mesh (Yggdrasil, end-to-end encrypted)
├── gnubg agent node    — Python service: gnubg subprocess eval + AI move
├── coach agent node    — Python service: flan-t5-base LLM hint generation
└── player nodes        — one per human player (browser ↔ localhost:9002)

0G Storage Log/Blob     — game records, gnubg weights, gnubg docs
0G Chain                — MatchRegistry, AgentRegistry, PlayerSubnameRegistrar
ENS                     — subnames + ELO text records + agent AXL public keys
```

No Cloudflare. No AWS. No WebRTC. No KV signaling. No external infrastructure outside the sponsor stack.

## Components

### AXL Agent Nodes — gnubg and LLM Coach

Two Python services run as AXL-registered agents. Anyone can run them — they are open source and require only `gnubg` installed and an AXL node binary.

**gnubg agent (`agent/gnubg_service.py`):**
A FastAPI service exposed via AXL. Accepts `POST /move` with `{ position_id, match_id, dice, agent_weights_hash }`. Fetches agent weights from 0G Storage, runs gnubg as a subprocess (reusing `gnubg_client.py` logic), returns `{ move, candidates }`.

**coach agent (`agent/coach_service.py`):**
A FastAPI service exposed via AXL. Accepts `POST /hint` with `{ position_id, match_id, dice, candidates, docs_hash }`. Fetches gnubg strategy docs from 0G Storage, runs flan-t5-base inference, returns `{ hint }`.

Both services are registered on the AXL mesh with a stable public key. The public key of the canonical gnubg agent is stored as an ENS text record on `chaingammon.eth` (key: `gnubg_axl_pubkey`) so any client can discover it without a server.

**AXL node config (`agent/axl-config.json`):** Standard AXL node configuration. The binary is started alongside each service.

**Coach toggle:** when off, the browser skips the `/hint` call. The gnubg `/move` call always runs.

**Files:**
- `agent/gnubg_service.py` — FastAPI: gnubg eval + move selection
- `agent/coach_service.py` — FastAPI: flan-t5-base LLM hint
- `agent/axl-config.json` — AXL node config
- `agent/requirements.txt` — Python deps
- `agent/start.sh` — starts AXL node + both services

### AXL Client (frontend)

`frontend/app/axl_client.ts` — thin TypeScript wrapper that makes HTTP requests to `localhost:9002/a2a/<pubkey>/<endpoint>`. Used by the game page for AI moves, coach hints, and H vs H relay messages.

**Agent discovery:** the gnubg agent's AXL public key is read from `chaingammon.eth` ENS text record at page load. No hardcoded addresses.

### Human vs Human Game Relay

Both players run an AXL node locally (alongside their browser). They exchange AXL public keys when a match is created — stored in the on-chain match setup event or shared out-of-band for the hackathon demo. Game messages (moves, dice commits, reveals) flow over AXL A2A:

```
Player A browser → localhost:9002/a2a/<PlayerB-pubkey>/game → AXL mesh → Player B node → Player B browser
```

All traffic is end-to-end encrypted by AXL.

**Files:**
- `frontend/app/axl_client.ts` — new: HTTP wrapper for AXL localhost API

### Dice

**Human vs human — commit-reveal over AXL:**
1. Both players generate a random secret
2. Both send `H(secret)` to the other via AXL A2A (commit phase)
3. Both reveal their secret via AXL A2A
4. Roll = `f(secretA XOR secretB)`

**Human vs AI — block-hash PRNG (v1):**
Dice derived from the most recent block hash at move time. On-chain VRF is v2.

**Files:**
- `frontend/app/dice.ts` — commit-reveal protocol + block-hash PRNG

### Settlement — Two Signatures, One Transaction

After game end, both players sign the result. Either submits to `MatchRegistry.recordMatch` with both signatures. The contract verifies both, updates ELO, and calls `PlayerSubnameRegistrar.setTextBatch` for each player atomically.

**Flow:**
1. Game ends; both players have the full move sequence
2. Either player uploads game record to 0G Storage → `rootHash`
3. Both sign `keccak256(matchId, player1, player2, result, rootHash)` via their wallets
4. Either submits both signatures to `MatchRegistry.recordMatch`
5. Contract verifies sigs, updates ELO via `EloMath`, calls `setTextBatch` twice (once per player)
6. One transaction. No orchestrator.

**Match ID:** derived deterministically: `keccak256(abi.encodePacked(player1, player2, block.timestamp))`.

**Contract changes:**
- `MatchRegistry.recordMatch`: accepts `sig1` and `sig2`; verifies via `ecrecover`; calls `PlayerSubnameRegistrar.setTextBatch` twice after ELO update. Constructor takes registrar address.
- `PlayerSubnameRegistrar`: new `setTextBatch(bytes32 node, uint256 elo, bytes32 matchId, string archiveUri)` callable only by `MatchRegistry`.

## What Is Removed

| Item | Reason |
|---|---|
| `server/` FastAPI app | Game logic moves to AXL agent nodes |
| `server/app/keeperhub_client.py` | KeeperHub removed |
| `og-bridge/` Node CLI | 0G uploads handled by 0G JS SDK in browser |
| KeeperHub workflow | Replaced by two-signature on-chain call |
| WebRTC + 0G KV signaling | Replaced by AXL mesh |

`server/app/gnubg_client.py` is not deleted — it is moved to `agent/gnubg_service.py`.

## What Is Preserved

The ELO contracts, ENS subname registrar, AgentRegistry, and all 0G Storage usage are unchanged. The frontend ENS resolution, match replay, and profile pages are unchanged. The agent iNFT model (ERC-7857, encrypted weights, experience overlays) is unchanged.

## Dice Trust Model — Human vs AI Limitation

In v1, the human player derives dice from the block hash. A determined player could wait for a favorable block, though this requires multiple transactions and is expensive relative to the ELO gain. Acceptable for casual play. On-chain VRF (v2) closes this gap.

## Out of Scope

- On-chain VRF for human vs AI dice (v2)
- Dispute resolution for H vs H games where one player goes offline before signing
- Mainnet deployment
- AXL peer key exchange automation (v1 uses known published key for gnubg agent; H vs H key exchange is manual for demo)
