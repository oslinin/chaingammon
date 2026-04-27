# Chaingammon — Architecture

An open protocol for portable backgammon reputation. Players and AI agents carry an ENS subname whose text records hold their ELO rating and a link to their full match archive on 0G Storage.

---

## 1. Components

```mermaid
graph LR
    FE[Frontend\nNext.js]
    API[Game Server\nFastAPI]
    GN[gnubg]
    BR[og-bridge\nNode.js]

    FE -->|REST| API
    API --> GN
    API --> BR
```

```mermaid
graph LR
    BR[og-bridge]
    OGS[0G Storage]
    MR[MatchRegistry]
    AR[AgentRegistry]
    EM[EloMath]
    ENS[ENS]
    KH[KeeperHub]

    BR <--> OGS
    MR --> EM
    AR -->|reads ELO| MR
    KH -->|recordMatch| MR
    KH --> ENS
    KH --> OGS
```

---

## 2. Starting a game

```mermaid
sequenceDiagram
    participant FE as Frontend
    participant API as Server
    participant GN as gnubg

    FE->>API: POST /games {agent_id, match_length}
    API->>GN: new_match()
    GN-->>API: position_id + match_id
    API-->>FE: GameState
```

---

## 3. One turn

```mermaid
sequenceDiagram
    participant FE as Frontend
    participant API as Server
    participant GN as gnubg

    FE->>API: POST /games/{id}/roll
    API->>GN: roll_dice()
    GN-->>API: new state
    API-->>FE: GameState (dice)

    alt Human move
        FE->>API: POST /games/{id}/move
        API->>GN: submit_move()
    else Agent move
        FE->>API: POST /games/{id}/agent-move
        API->>GN: get_agent_move()
    end

    GN-->>API: new state
    API-->>FE: GameState
```

---

## 4. Finalizing a match

```mermaid
sequenceDiagram
    participant FE as Frontend
    participant API as Server
    participant OG as 0G Storage
    participant CH as 0G Chain

    FE->>API: POST /games/{id}/finalize
    API->>API: build GameRecord JSON
    API->>OG: put_blob(record)
    OG-->>API: rootHash + txHash
    API->>CH: MatchRegistry.recordMatch(…, rootHash)
    CH-->>API: matchId
    API-->>FE: match_id + root_hash
```

---

## 5. Smart contracts

```mermaid
graph TD
    AR[AgentRegistry\nERC-721 iNFT]
    MR[MatchRegistry\nELO + match log]
    EM[EloMath\nfixed-point ELO]
    PSR[PlayerSubnameRegistrar\nENS subnames]

    AR -->|IMatchRegistry.agentElo| MR
    MR --> EM
```

**EloMath** — pure library, fixed-point K=32 formula. No storage.

**MatchRegistry** — `recordMatch(winner, loser, matchLength, gameRecordHash)` updates ELO and stores `MatchInfo`. Default ELO = 1500.

**AgentRegistry** — ERC-721 where each token carries `dataHashes[2]`: `[baseWeightsHash, overlayHash]`. ERC-7857-compatible shape.

**PlayerSubnameRegistrar** — issues `<name>.chaingammon.eth` subnames and controls their text records (`elo`, `match_count`, `style_uri`, `archive_uri`).

---

## 6. Data on 0G Storage

| What | Encrypted? | Who writes |
|------|-----------|------------|
| Game record JSON (moves + final state) | No | Server on `/finalize` |
| KeeperHub audit trail | No | KeeperHub workflow |
| Player style profile (KV) | No | KeeperHub workflow |
| gnubg base weights (Blob) | Yes — AES-256-GCM | `upload_base_weights.py` once |
| Agent experience overlay (Blob) | Yes | Server after each match |

The `gameRecordHash` in `MatchRegistry.MatchInfo` is the 0G Merkle root of the game record. Anyone can fetch and replay the match from the chain reference alone.

---

## 7. Game record schema

```mermaid
classDiagram
    class GameRecord {
        int match_length
        list final_score
        str final_position_id
        str final_match_id
        list moves
        str started_at
        str ended_at
    }
    class PlayerRef {
        str kind
        str address
        int agent_id
    }
    class MoveEntry {
        int turn
        list dice
        str move
    }

    GameRecord --> PlayerRef : winner + loser
    GameRecord --> MoveEntry : moves
```

---

## 8. Trust model (v1)

```mermaid
graph LR
    SRV[Server\nholds deployer key]
    MR[MatchRegistry\non-chain ELO]
    OG[0G Storage\narchive]
    CH[gameRecordHash\non-chain]

    SRV -->|signs recordMatch| MR
    SRV -->|uploads record| OG
    SRV -->|passes rootHash| CH
    CH -.->|verifiable link| OG
```

The server is the trusted dice roller and settlement submitter in v1. Commit-reveal VRF is a v2 roadmap item.

---

## 9. Phases

```mermaid
gantt
    dateFormat YYYY-MM-DD
    section Done
    1 Game server + gnubg    :done, 2026-04-01, 3d
    2 EloMath                :done, 2026-04-04, 2d
    3 MatchRegistry          :done, 2026-04-06, 2d
    4 Deploy to 0G testnet   :done, 2026-04-08, 1d
    5 AgentRegistry iNFT     :done, 2026-04-09, 2d
    6 0G Storage round-trip  :done, 2026-04-11, 2d
    7 GameRecord + finalize  :done, 2026-04-13, 3d
    section Next
    8 Encrypted weights      :2026-04-16, 3d
    9 Experience overlay     :2026-04-19, 3d
    10 KeeperHub settlement  :2026-04-22, 3d
    11 ENS subnames          :2026-04-25, 3d
    12 Frontend profile      :2026-04-28, 3d
```
