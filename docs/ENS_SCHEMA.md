# Chaingammon ENS Schema v1

## Purpose

How third-party protocols read Chaingammon reputation from ENS subnames.

Chaingammon issues subnames under `chaingammon.eth` for every registered player and AI agent. Each subname carries text records that describe the identity's reputation and capabilities. This document specifies the schema so that external protocols — betting markets, tournament organisers, coaching platforms — can read verified reputation without coordinating with Chaingammon directly.

---

## Parent

`chaingammon.eth`

Currently deployed on 0G testnet (chainId 16602, RPC `https://evmrpc-testnet.0g.ai`). The registrar contract is `PlayerSubnameRegistrar` at the address published in [`contracts/deployments/0g-testnet.json`](../contracts/deployments/0g-testnet.json).

---

## Subname Pattern

```
<label>.chaingammon.eth
```

Both human players and AI agents share the same pattern. The `kind` text record discriminates between them.

---

## Text Record Keys

### Reserved (protocol-written only)

These keys can **only be written by the Chaingammon protocol** (i.e. the contract owner, which is the server post-match). A subname owner cannot set them. This is enforced on-chain in `PlayerSubnameRegistrar.setText` via a `bytes32 → bool` reserved-key map keyed by `keccak256(key)`.

| Key | Type | Who can write | Semantics | Example |
|---|---|---|---|---|
| `elo` | decimal string | protocol only | Current ELO rating. Updated by the server after every match settlement. | `"1547"` |
| `match_count` | decimal string | protocol only | Total matches played. | `"42"` |
| `last_match_id` | decimal string | protocol only | On-chain match ID of the most recent settled match. | `"17"` |
| `kind` | `"human"` or `"agent"` | protocol only | Identity discriminator. Set at subname creation and never changes. | `"agent"` |
| `inft_id` | decimal string | protocol only | For agents: the ERC-721 token ID of the corresponding iNFT in `AgentRegistry`. Empty string for humans. | `"3"` |

### User-writable

These keys can be written by either the subname owner **or** the protocol.

| Key | Type | Who can write | Semantics | Example |
|---|---|---|---|---|
| `bio` | string | owner or protocol | Free-text profile description. | `"Aggressive opening player. Loves the anchor game."` |
| `avatar` | URL string | owner or protocol | Profile avatar image URL. | `"https://example.com/avatar.png"` |
| `style_uri` | 0g:// URI | owner or protocol | Link to the player's style profile blob on 0G Storage (aggregate of opening choices, cube tendency, bear-off speed). | `"0g://bafyreib..."` |
| `endpoint` | HTTP URL | owner or protocol | For agents: the HTTP endpoint of the agent's gnubg service. Empty for humans. | `"http://agent.example.com:8001"` |

---

## Authoritative Source Note

The `elo` text record is a **cache**. The on-chain truth is:
- For humans: `MatchRegistry.humanElo(address)`
- For agents: `MatchRegistry.agentElo(uint256 agentId)`

Tools needing real-time freshness should read the contract directly. Tools needing portability — cross-chain reads, ENS-native integrations, indexers — should read the text record.

The protocol guarantees that the `elo` text record is updated by the server in the same match-settlement transaction that calls `MatchRegistry.recordMatch`, so the two values are always in sync within a single block of the settlement.

---

## Migration Note

Currently deployed on 0G testnet as a self-contained registrar (no dependency on the canonical ENS root). v2 migrates to L2 ENS via Durin so mainnet ENS resolvers can read subnames directly. The text record schema above is stable across v1 → v2.

---

## Example Use Cases

### Betting market

A betting market wants to price a match between two players. It reads:
```
text(namehash("alice.chaingammon.eth"), "elo")
text(namehash("gnubg-tier1.chaingammon.eth"), "elo")
```
Both values are protocol-written and therefore verified — not self-asserted. The market can build an implied win probability from the ELO difference without trusting either player.

### Tournament organiser

A tournament bracket app fetches all registered subnames:
```
subnameCount() → N
subnameAt(i) → node   for i in 0..N-1
text(node, "elo")
text(node, "kind")    // filter to "human" or "agent" for separate brackets
```
Sorts by `elo` descending, seeds the bracket, and never needs to contact Chaingammon's server.

### Coaching platform

A coaching tool reads a player's style profile from 0G Storage:
```
text(namehash("alice.chaingammon.eth"), "style_uri")
→ "0g://bafyreib..."
```
Fetches the blob from 0G Storage and parses the JSON style aggregate (opening percentages, cube-take thresholds, bear-off speed). No Chaingammon API key required.

### Cross-protocol agent directory

An agent marketplace lists every AI agent on the network:
```
// filter for kind == "agent"
text(node, "kind")     → "agent"
text(node, "inft_id")  → "3"
text(node, "elo")      → "1612"
text(node, "endpoint") → "http://agent.example.com:8001"
```
Uses `endpoint` to route challenges directly to the agent's gnubg service. Uses `inft_id` to look up the agent's data hashes in `AgentRegistry.dataHashes(3)` for on-chain weight verification.
