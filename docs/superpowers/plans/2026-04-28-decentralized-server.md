# Decentralized Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the centralized FastAPI server and KeeperHub with Gensyn AXL agent nodes (gnubg + LLM coach), two-signature on-chain settlement, and AXL-based game relay so gameplay continues if any single server goes down.

**Architecture:** gnubg and the LLM coach run as AXL-registered FastAPI services — anyone can run them. The player's browser talks to `localhost:9002` (AXL), which routes to whichever agent node is available. Human vs human game relay also runs over AXL A2A. Settlement is a single `MatchRegistry.recordMatch` transaction with both players' ECDSA signatures.

**Tech Stack:** Python 3.12 + FastAPI + AXL binary, `transformers` (flan-t5-base), Solidity 0.8.24, Next.js 16, wagmi v3, viem v2, 0G Storage JS SDK

---

## Scope note

Six independent subsystems in dependency order:
1. AXL agent services (gnubg + coach)
2. Contract changes (two-signature settlement)
3. Frontend dice module
4. Frontend AXL client
5. Frontend Coach UI
6. Cleanup (remove server, KeeperHub, og-bridge)

---

## File Map

| File | Status | Purpose |
|---|---|---|
| `agent/gnubg_service.py` | Create | FastAPI service: gnubg eval + AI move via AXL |
| `agent/coach_service.py` | Create | FastAPI service: flan-t5-base LLM hint via AXL |
| `agent/axl-config.json` | Create | AXL node configuration |
| `agent/requirements.txt` | Create | Python deps for agent nodes |
| `agent/start.sh` | Create | Starts AXL node + both services |
| `agent/tests/test_gnubg_service.py` | Create | pytest tests for gnubg service |
| `agent/tests/test_coach_service.py` | Create | pytest tests for coach service |
| `scripts/upload_gnubg_docs.py` | Create | One-time: upload gnubg strategy doc to 0G Storage |
| `contracts/src/MatchRegistry.sol` | Modify | Two-signature settlement, setTextBatch call |
| `contracts/src/PlayerSubnameRegistrar.sol` | Modify | setTextBatch callable by MatchRegistry |
| `contracts/test/phase17_settlement.test.js` | Create | Hardhat tests for new settlement flow |
| `frontend/app/dice.ts` | Create | Commit-reveal (H vs H) + block-hash PRNG (H vs AI) |
| `frontend/app/axl_client.ts` | Create | HTTP wrapper for AXL localhost:9002 API |
| `frontend/app/CoachPanel.tsx` | Create | Non-blocking hint popup with toggle |
| `frontend/app/settlement.ts` | Create | buildDigest, signSettlement, submitSettlement |
| `frontend/app/contracts.ts` | Modify | Add new recordMatch ABI with sig1/sig2 |
| `frontend/tests/coach-panel.spec.ts` | Create | Playwright: coach panel renders, dismisses, toggles |
| `server/` | Delete | Entire directory — game logic moves to agent/ |
| `og-bridge/` | Delete | Replaced by 0G JS SDK in browser |

---

## Task 1: AXL gnubg agent service

**Files:**
- Create: `agent/gnubg_service.py`
- Create: `agent/requirements.txt`
- Create: `agent/tests/__init__.py`
- Create: `agent/tests/test_gnubg_service.py`

The gnubg agent is a FastAPI HTTP service that AXL exposes on the mesh. It accepts board positions and returns ranked candidate moves. The logic is adapted from `server/app/gnubg_client.py`.

- [ ] **Step 1: Write the failing tests**

`agent/tests/test_gnubg_service.py`:
```python
"""Tests for gnubg_service.py — run with: cd agent && python -m pytest tests/test_gnubg_service.py -v"""
import pytest
from httpx import AsyncClient, ASGITransport
from gnubg_service import app

OPENING_POSITION_ID = "4HPwATDgc/ABMA"
OPENING_MATCH_ID = "cAkAAAAAAAAA"


@pytest.mark.anyio
async def test_move_returns_candidates():
    """/move must return a list of candidates with move + equity."""
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        resp = await client.post("/move", json={
            "position_id": OPENING_POSITION_ID,
            "match_id": OPENING_MATCH_ID,
            "dice": [3, 1],
            "agent_weights_hash": "",
        })
    assert resp.status_code == 200
    body = resp.json()
    assert "move" in body
    assert "candidates" in body
    assert len(body["candidates"]) >= 1
    assert "equity" in body["candidates"][0]


@pytest.mark.anyio
async def test_move_bad_position_returns_422():
    """/move with missing required field returns 422."""
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        resp = await client.post("/move", json={"dice": [1, 2]})
    assert resp.status_code == 422
```

`agent/requirements.txt`:
```
fastapi>=0.111.0
uvicorn>=0.29.0
httpx>=0.27.0
anyio>=4.3.0
pytest>=8.0.0
pytest-anyio>=0.0.0
transformers>=4.40.0
torch>=2.2.0
```

- [ ] **Step 2: Run tests — expect FAIL**

```bash
cd agent && python -m pytest tests/test_gnubg_service.py -v
```
Expected: `ModuleNotFoundError: No module named 'gnubg_service'`

- [ ] **Step 3: Implement gnubg_service.py**

`agent/gnubg_service.py`:
```python
"""
gnubg_service.py — AXL agent node: gnubg move evaluation.

Exposed via AXL as an A2A service. The AXL binary proxies HTTP traffic
from remote peers to this service on localhost. Run alongside AXL:

  axl start --config axl-config.json &
  uvicorn gnubg_service:app --port 8001

POST /move
  Request:  { position_id, match_id, dice: [int, int], agent_weights_hash }
  Response: { move: str, candidates: [{move, equity}] }

POST /evaluate
  Request:  { position_id, match_id, dice: [int, int] }
  Response: { candidates: [{move, equity}] }  — no move selected (for coach use)
"""

from __future__ import annotations
import re
import subprocess
from typing import Optional

from fastapi import FastAPI
from pydantic import BaseModel

app = FastAPI(title="Chaingammon gnubg Agent")

# ─── gnubg subprocess helpers (from server/app/gnubg_client.py) ──────────────

_GNUBG_BINARY = ["gnubg", "-t", "-q"]
_INIT_COMMANDS = (
    "set automatic roll off\n"
    "set automatic game off\n"
    "set automatic move off\n"
    "set automatic bearoff off\n"
    "set player 0 human\n"
    "set player 1 human\n"
)


def _run_gnubg(commands: str) -> str:
    proc = subprocess.Popen(
        _GNUBG_BINARY,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    stdout, _ = proc.communicate(_INIT_COMMANDS + commands)
    return stdout


def _evaluate(position_id: str, match_id: str) -> list[dict]:
    """Return gnubg's ranked candidate moves with equity scores."""
    cmds = f"set matchid {match_id}\nset board {position_id}\nhint\n"
    stdout = _run_gnubg(cmds)
    rows = re.findall(
        r"(\d+)\.\s+[\w-]+\s+[0-9]+-ply\s+([\d/a-zA-Z*\(\)\s]+?)\s*Eq\.:\s*([+\-]?[0-9.]+)",
        stdout,
    )
    candidates = []
    for _rank, move_str, eq_str in rows:
        try:
            equity = float(eq_str)
        except ValueError:
            continue
        candidates.append({"move": move_str.strip(), "equity": equity})
    return candidates


# ─── API ─────────────────────────────────────────────────────────────────────

class MoveRequest(BaseModel):
    position_id: str
    match_id: str
    dice: list[int]
    agent_weights_hash: str = ""


class EvaluateRequest(BaseModel):
    position_id: str
    match_id: str
    dice: list[int]


@app.post("/move")
def get_move(req: MoveRequest) -> dict:
    """Evaluate position and return best move + all candidates."""
    candidates = _evaluate(req.position_id, req.match_id)
    if not candidates:
        return {"move": None, "candidates": []}
    best = max(candidates, key=lambda c: c["equity"])
    return {"move": best["move"], "candidates": candidates[:3]}


@app.post("/evaluate")
def evaluate_only(req: EvaluateRequest) -> dict:
    """Return candidates without selecting a move (used by coach service)."""
    candidates = _evaluate(req.position_id, req.match_id)
    return {"candidates": candidates[:3]}
```

- [ ] **Step 4: Run tests — expect PASS**

```bash
cd agent && python -m pytest tests/test_gnubg_service.py -v
```
Expected: 2 passed (`test_move_bad_position_returns_422` always passes; `test_move_returns_candidates` requires `gnubg` binary — skip with `@pytest.mark.skipif(shutil.which("gnubg") is None, reason="gnubg not installed")` if needed in CI)

- [ ] **Step 5: Commit**

```bash
git add agent/gnubg_service.py agent/requirements.txt agent/tests/
git commit -m "agent: gnubg_service FastAPI — AXL node for gnubg move evaluation"
```

---

## Task 2: AXL coach agent service

**Files:**
- Create: `agent/coach_service.py`
- Create: `agent/tests/test_coach_service.py`

- [ ] **Step 1: Write the failing tests**

`agent/tests/test_coach_service.py`:
```python
"""Tests for coach_service.py"""
import pytest
from unittest.mock import patch
from httpx import AsyncClient, ASGITransport
from coach_service import app


@pytest.mark.anyio
async def test_hint_returns_string():
    """/hint must return a non-empty hint string."""
    with patch("coach_service._load_model"), \
         patch("coach_service._generate") as mock_gen:
        mock_gen.return_value = "Build your prime on the 5-point."
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.post("/hint", json={
                "position_id": "4HPwATDgc/ABMA",
                "match_id": "cAkAAAAAAAAA",
                "dice": [3, 1],
                "candidates": [{"move": "13/10 24/23", "equity": -0.050}],
                "docs_hash": "",
            })
    assert resp.status_code == 200
    assert "hint" in resp.json()
    assert len(resp.json()["hint"]) > 5


@pytest.mark.anyio
async def test_hint_missing_candidates_returns_422():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        resp = await client.post("/hint", json={"dice": [1, 2]})
    assert resp.status_code == 422
```

- [ ] **Step 2: Run tests — expect FAIL**

```bash
cd agent && python -m pytest tests/test_coach_service.py -v
```
Expected: `ModuleNotFoundError: No module named 'coach_service'`

- [ ] **Step 3: Implement coach_service.py**

`agent/coach_service.py`:
```python
"""
coach_service.py — AXL agent node: LLM coaching hints.

Exposed via AXL as an A2A service on a separate port from gnubg_service.
Run alongside AXL:

  uvicorn coach_service:app --port 8002

POST /hint
  Request:  { position_id, match_id, dice, candidates: [{move, equity}], docs_hash }
  Response: { hint: str }
"""

from __future__ import annotations
from typing import Optional

from fastapi import FastAPI
from pydantic import BaseModel

app = FastAPI(title="Chaingammon Coach Agent")

_model = None
_tokenizer = None


def _load_model():
    """Lazy-load flan-t5-base. Called once per process."""
    global _model, _tokenizer
    if _model is None:
        from transformers import T5ForConditionalGeneration, T5Tokenizer
        _tokenizer = T5Tokenizer.from_pretrained("google/flan-t5-base")
        _model = T5ForConditionalGeneration.from_pretrained("google/flan-t5-base")


def _fetch_docs(docs_hash: str) -> str:
    """Fetch gnubg strategy doc from 0G Storage. Returns fallback if unavailable."""
    if not docs_hash:
        return "Backgammon: build primes, anchor on the 5-point, avoid blots."
    try:
        # 0G Python SDK — verify import path against current SDK docs
        from zg_storage import download
        return download(docs_hash).decode("utf-8", errors="replace")
    except Exception:
        return "Backgammon: build primes, anchor on the 5-point, avoid blots."


def _generate(dice: list[int], candidates: list[dict], docs_context: str) -> str:
    """Run flan-t5-base inference to produce a coaching hint."""
    _load_model()
    top3 = candidates[:3]
    moves_text = "; ".join(
        f"{c['move']} (equity {c['equity']:+.3f})" for c in top3
    )
    prompt = (
        f"You are a backgammon coach. Context: {docs_context} "
        f"The player rolled {dice[0]} and {dice[1]}. "
        f"gnubg ranked these moves: {moves_text}. "
        f"In 1-2 sentences, explain why the best move is good."
    )
    inputs = _tokenizer(prompt, return_tensors="pt", max_length=512, truncation=True)
    outputs = _model.generate(**inputs, max_new_tokens=80)
    return _tokenizer.decode(outputs[0], skip_special_tokens=True)


# ─── API ─────────────────────────────────────────────────────────────────────

class HintRequest(BaseModel):
    position_id: str
    match_id: str
    dice: list[int]
    candidates: list[dict]
    docs_hash: str = ""


@app.post("/hint")
def get_hint(req: HintRequest) -> dict:
    """Generate a coaching hint from gnubg equity output."""
    docs_context = _fetch_docs(req.docs_hash)
    hint = _generate(req.dice, req.candidates, docs_context)
    return {"hint": hint}
```

- [ ] **Step 4: Run tests — expect PASS**

```bash
cd agent && python -m pytest tests/test_coach_service.py -v
```
Expected: 2 passed

- [ ] **Step 5: Create AXL config and start script**

`agent/axl-config.json`:
```json
{
  "name": "chaingammon-agent",
  "peers": [],
  "services": [
    {
      "name": "gnubg",
      "upstream": "http://localhost:8001"
    },
    {
      "name": "coach",
      "upstream": "http://localhost:8002"
    }
  ]
}
```

`agent/start.sh`:
```bash
#!/usr/bin/env bash
# Start AXL node + gnubg service + coach service.
# Usage: ./start.sh
# Requires: axl binary in PATH, gnubg installed, Python deps installed.
set -e
uvicorn gnubg_service:app --port 8001 &
uvicorn coach_service:app --port 8002 &
axl start --config axl-config.json
```

```bash
chmod +x agent/start.sh
```

- [ ] **Step 6: Commit**

```bash
git add agent/coach_service.py agent/tests/test_coach_service.py agent/axl-config.json agent/start.sh
git commit -m "agent: coach_service FastAPI + AXL config — LLM coach hint node via flan-t5-base"
```

---

## Task 3: Upload gnubg strategy docs to 0G Storage

**Files:**
- Create: `scripts/upload_gnubg_docs.py`

One-time setup: upload a gnubg strategy reference to 0G Storage so the coach agent can fetch it as RAG context.

- [ ] **Step 1: Write upload script**

`scripts/upload_gnubg_docs.py`:
```python
"""
One-time script: upload gnubg backgammon strategy doc to 0G Storage.

Usage:
  cd server && uv run python ../scripts/upload_gnubg_docs.py

Prints the root hash to stdout. Store this hash as GNUBG_DOCS_HASH
in agent/.env and in frontend/.env as NEXT_PUBLIC_GNUBG_DOCS_HASH.

Requires: OG_STORAGE_RPC, OG_STORAGE_INDEXER, OG_STORAGE_PRIVATE_KEY in env.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "server"))
from app.og_storage_client import put_blob

DOCS = """\
GNU Backgammon Strategy Reference

Opening principles:
- Anchor on the 5-point (your opponent's 5-point) early — it is the strongest anchor.
- Build a prime (consecutive blocked points) to trap opponent checkers.
- Avoid leaving blots (single checkers) on high-traffic points when behind.
- The golden point is your own 5-point; control it to dominate the middle game.

Equity:
- Equity is the expected outcome of a position, ranging roughly from -3.0 (losing badly)
  to +3.0 (winning a gammon). 0.0 is an even game.
- A move that costs more than 0.05 equity compared to the best move is a significant error.
- A difference of 0.10+ is a blunder.

Bear-off:
- Leave as few gaps as possible on your home board.
- Stack deeply on the 6-point only if forced; spread checkers to fill gaps.

Doubling cube:
- Double when your winning chances exceed ~70% and your opponent can still take.
- Take a double if your losing chances are below ~75% (the 25% rule).
"""

if __name__ == "__main__":
    result = put_blob(DOCS.encode("utf-8"))
    print(f"GNUBG_DOCS_HASH={result.root_hash}")
    print(f"tx: {result.tx_hash}")
```

- [ ] **Step 2: Run it (requires 0G Storage env vars)**

```bash
cd server && uv run python ../scripts/upload_gnubg_docs.py
```
Expected:
```
GNUBG_DOCS_HASH=0x<hash>
tx: 0x<tx>
```
Store `GNUBG_DOCS_HASH` in `frontend/.env` as `NEXT_PUBLIC_GNUBG_DOCS_HASH=0x<hash>`.

- [ ] **Step 3: Commit**

```bash
git add scripts/upload_gnubg_docs.py
git commit -m "scripts: upload_gnubg_docs — one-time 0G Storage upload of gnubg strategy reference for coach RAG"
```

---

## Task 4: Contract — two-signature settlement

**Files:**
- Modify: `contracts/src/MatchRegistry.sol`
- Modify: `contracts/src/PlayerSubnameRegistrar.sol`
- Create: `contracts/test/phase17_settlement.test.js`

### 4a: PlayerSubnameRegistrar — setTextBatch

- [ ] **Step 1: Write failing test**

`contracts/test/phase17_settlement.test.js`:
```javascript
const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("Phase 17: Two-signature settlement", function () {
  let registry, registrar, owner, player1, player2;
  const PARENT_NODE = ethers.keccak256(ethers.toUtf8Bytes("chaingammon.eth"));

  beforeEach(async function () {
    [owner, player1, player2] = await ethers.getSigners();

    const Registrar = await ethers.getContractFactory("PlayerSubnameRegistrar");
    registrar = await Registrar.deploy(PARENT_NODE);
    await registrar.waitForDeployment();

    const Registry = await ethers.getContractFactory("MatchRegistry");
    registry = await Registry.deploy(await registrar.getAddress());
    await registry.waitForDeployment();

    await registrar.setMatchRegistry(await registry.getAddress());

    await registrar.mintSubname("alice", player1.address);
    await registrar.mintSubname("bob", player2.address);
  });

  it("setTextBatch reverts when called by non-MatchRegistry", async function () {
    const node = await registrar.subnameNode("alice");
    await expect(
      registrar.connect(player1).setTextBatch(node, 1550, "0x" + "aa".repeat(32), "0g://archive")
    ).to.be.revertedWithCustomError(registrar, "NotAuthorized");
  });

  it("recordMatch with two valid signatures updates ELOs and ENS text records", async function () {
    const gameRecordHash = "0x" + "bb".repeat(32);

    const digest = ethers.solidityPackedKeccak256(
      ["address", "address", "address", "bytes32"],
      [player1.address, player2.address, player1.address, gameRecordHash]
    );

    const sig1 = await player1.signMessage(ethers.getBytes(digest));
    const sig2 = await player2.signMessage(ethers.getBytes(digest));

    await registry.connect(player1).recordMatch(
      0, player1.address,
      0, player2.address,
      1,
      gameRecordHash,
      sig1,
      sig2
    );

    expect(await registry.humanElo(player1.address)).to.be.gt(1500);
    expect(await registry.humanElo(player2.address)).to.be.lt(1500);

    const node1 = await registrar.subnameNode("alice");
    const elo1 = await registrar.text(node1, "elo");
    expect(Number(elo1)).to.be.gt(1500);
  });

  it("recordMatch reverts on invalid winner signature", async function () {
    const gameRecordHash = "0x" + "cc".repeat(32);
    const digest = ethers.solidityPackedKeccak256(
      ["address", "address", "address", "bytes32"],
      [player1.address, player2.address, player1.address, gameRecordHash]
    );
    const sig1 = await player2.signMessage(ethers.getBytes(digest)); // wrong signer
    const sig2 = await player2.signMessage(ethers.getBytes(digest));
    await expect(
      registry.connect(player1).recordMatch(0, player1.address, 0, player2.address, 1, gameRecordHash, sig1, sig2)
    ).to.be.revertedWithCustomError(registry, "InvalidSignature");
  });

  it("recordMatch reverts on double settlement", async function () {
    const gameRecordHash = "0x" + "dd".repeat(32);
    const digest = ethers.solidityPackedKeccak256(
      ["address", "address", "address", "bytes32"],
      [player1.address, player2.address, player1.address, gameRecordHash]
    );
    const sig1 = await player1.signMessage(ethers.getBytes(digest));
    const sig2 = await player2.signMessage(ethers.getBytes(digest));
    await registry.connect(player1).recordMatch(0, player1.address, 0, player2.address, 1, gameRecordHash, sig1, sig2);
    await expect(
      registry.connect(player1).recordMatch(0, player1.address, 0, player2.address, 1, gameRecordHash, sig1, sig2)
    ).to.be.revertedWithCustomError(registry, "AlreadySettled");
  });
});
```

- [ ] **Step 2: Run tests — expect FAIL**

```bash
cd contracts && pnpm exec hardhat test test/phase17_settlement.test.js
```
Expected: compilation error — `setMatchRegistry` and `setTextBatch` not defined

- [ ] **Step 3: Add setTextBatch and setMatchRegistry to PlayerSubnameRegistrar**

In `contracts/src/PlayerSubnameRegistrar.sol`, add after the existing `setText` function:

```solidity
    /// @notice Address of the MatchRegistry contract authorised to call setTextBatch.
    address public matchRegistry;

    /// @notice Set the authorised MatchRegistry address. Owner only, called once after deploy.
    function setMatchRegistry(address _matchRegistry) external onlyOwner {
        matchRegistry = _matchRegistry;
    }

    /// @notice Batch-update ELO, last_match_id, and archive_uri for a player node.
    ///         Called by MatchRegistry after settlement. Node must exist.
    function setTextBatch(
        bytes32 node,
        uint256 elo,
        bytes32 matchId,
        string calldata archiveUri
    ) external {
        if (msg.sender != matchRegistry) revert NotAuthorized();
        if (!_subnames[node].exists) revert SubnameDoesNotExist();
        _textRecords[node]["elo"] = _uint256ToString(elo);
        _textRecords[node]["last_match_id"] = _bytes32ToHex(matchId);
        _textRecords[node]["archive_uri"] = archiveUri;
        emit TextRecordSet(node, "elo", _textRecords[node]["elo"]);
        emit TextRecordSet(node, "last_match_id", _textRecords[node]["last_match_id"]);
        emit TextRecordSet(node, "archive_uri", archiveUri);
    }

    function _uint256ToString(uint256 v) internal pure returns (string memory) {
        if (v == 0) return "0";
        uint256 tmp = v;
        uint256 len;
        while (tmp != 0) { len++; tmp /= 10; }
        bytes memory buf = new bytes(len);
        while (v != 0) { buf[--len] = bytes1(uint8(48 + v % 10)); v /= 10; }
        return string(buf);
    }

    function _bytes32ToHex(bytes32 b) internal pure returns (string memory) {
        bytes memory hex_ = "0123456789abcdef";
        bytes memory s = new bytes(66);
        s[0] = "0"; s[1] = "x";
        for (uint i = 0; i < 32; i++) {
            s[2 + i * 2] = hex_[uint8(b[i] >> 4)];
            s[3 + i * 2] = hex_[uint8(b[i] & 0x0f)];
        }
        return string(s);
    }
```

- [ ] **Step 4: Replace MatchRegistry.sol with two-signature version**

Replace `contracts/src/MatchRegistry.sol` entirely:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import "./EloMath.sol";
import "./PlayerSubnameRegistrar.sol";

/// @title MatchRegistry — records backgammon matches and updates ELO.
///
/// @notice Phase 17: permissionless settlement. Any caller may record a match
///         provided both players have signed the result. The two ECDSA
///         signatures replace the previous onlyOwner server trust model.
///         MatchRegistry calls PlayerSubnameRegistrar.setTextBatch for each
///         human player atomically in the same transaction.
contract MatchRegistry {
    using ECDSA for bytes32;
    using MessageHashUtils for bytes32;

    PlayerSubnameRegistrar public immutable registrar;

    struct MatchInfo {
        uint64 timestamp;
        uint256 winnerAgentId;
        address winnerHuman;
        uint256 loserAgentId;
        address loserHuman;
        uint16 matchLength;
        bytes32 gameRecordHash;
    }

    uint256 public matchCount;
    mapping(uint256 => MatchInfo) public matches;
    mapping(uint256 => uint256) private _agentElo;
    mapping(address => uint256) private _humanElo;
    mapping(uint256 => bool) private _agentSeen;
    mapping(address => bool) private _humanSeen;
    mapping(bytes32 => bool) private _settled;

    error InvalidSignature(string which);
    error AlreadySettled(bytes32 gameRecordHash);

    event MatchRecorded(
        uint256 indexed matchId,
        uint256 winnerAgentId,
        address winnerHuman,
        uint256 loserAgentId,
        address loserHuman,
        uint256 newWinnerElo,
        uint256 newLoserElo
    );
    event EloUpdated(uint256 indexed agentId, address indexed human, uint256 oldElo, uint256 newElo);
    event GameRecordStored(uint256 indexed matchId, bytes32 gameRecordHash);

    constructor(address _registrar) {
        registrar = PlayerSubnameRegistrar(_registrar);
    }

    function agentElo(uint256 agentId) public view returns (uint256) {
        return _agentSeen[agentId] ? _agentElo[agentId] : EloMath.INITIAL;
    }

    function humanElo(address human) public view returns (uint256) {
        return _humanSeen[human] ? _humanElo[human] : EloMath.INITIAL;
    }

    function getMatch(uint256 matchId) external view returns (MatchInfo memory) {
        return matches[matchId];
    }

    /// @notice Record a match result verified by both players' ECDSA signatures.
    ///
    /// @param winnerAgentId  0 if winner is human.
    /// @param winnerHuman    zero address if winner is an agent.
    /// @param loserAgentId   0 if loser is human.
    /// @param loserHuman     zero address if loser is an agent.
    /// @param matchLength    Points played.
    /// @param gameRecordHash Merkle root of the 0G Storage game record.
    /// @param sig1           EIP-191 signature from the winner.
    /// @param sig2           EIP-191 signature from the loser.
    function recordMatch(
        uint256 winnerAgentId,
        address winnerHuman,
        uint256 loserAgentId,
        address loserHuman,
        uint16 matchLength,
        bytes32 gameRecordHash,
        bytes calldata sig1,
        bytes calldata sig2
    ) external returns (uint256 matchId) {
        require(
            (winnerAgentId == 0) != (winnerHuman == address(0)),
            "winner must be exactly one of agent or human"
        );
        require(
            (loserAgentId == 0) != (loserHuman == address(0)),
            "loser must be exactly one of agent or human"
        );
        if (_settled[gameRecordHash]) revert AlreadySettled(gameRecordHash);

        // Digest: keccak256(winner, loser, winner, gameRecordHash)
        // Both players sign this; the winner field appears twice so
        // either party can verify who won without extra calldata.
        bytes32 digest = keccak256(abi.encodePacked(
            winnerHuman, loserHuman, winnerHuman, gameRecordHash
        ));
        bytes32 ethDigest = digest.toEthSignedMessageHash();

        if (winnerHuman != address(0)) {
            if (ethDigest.recover(sig1) != winnerHuman) revert InvalidSignature("sig1");
        }
        if (loserHuman != address(0)) {
            if (ethDigest.recover(sig2) != loserHuman) revert InvalidSignature("sig2");
        }

        _settled[gameRecordHash] = true;

        uint256 winnerOld = winnerAgentId != 0 ? agentElo(winnerAgentId) : humanElo(winnerHuman);
        uint256 loserOld  = loserAgentId  != 0 ? agentElo(loserAgentId)  : humanElo(loserHuman);
        uint256 winnerExp = EloMath.expectedScorePct(int256(winnerOld), int256(loserOld));
        uint256 loserExp  = EloMath.expectedScorePct(int256(loserOld),  int256(winnerOld));
        uint256 winnerNew = EloMath.newRating(winnerOld, winnerExp, true);
        uint256 loserNew  = EloMath.newRating(loserOld,  loserExp,  false);

        if (winnerAgentId != 0) {
            _agentElo[winnerAgentId] = winnerNew; _agentSeen[winnerAgentId] = true;
            emit EloUpdated(winnerAgentId, address(0), winnerOld, winnerNew);
        } else {
            _humanElo[winnerHuman] = winnerNew; _humanSeen[winnerHuman] = true;
            emit EloUpdated(0, winnerHuman, winnerOld, winnerNew);
        }
        if (loserAgentId != 0) {
            _agentElo[loserAgentId] = loserNew; _agentSeen[loserAgentId] = true;
            emit EloUpdated(loserAgentId, address(0), loserOld, loserNew);
        } else {
            _humanElo[loserHuman] = loserNew; _humanSeen[loserHuman] = true;
            emit EloUpdated(0, loserHuman, loserOld, loserNew);
        }

        matchId = matchCount;
        matches[matchId] = MatchInfo({
            timestamp:      uint64(block.timestamp),
            winnerAgentId:  winnerAgentId,
            winnerHuman:    winnerHuman,
            loserAgentId:   loserAgentId,
            loserHuman:     loserHuman,
            matchLength:    matchLength,
            gameRecordHash: gameRecordHash
        });
        matchCount = matchId + 1;
        _settled[gameRecordHash] = true;

        emit MatchRecorded(matchId, winnerAgentId, winnerHuman, loserAgentId, loserHuman, winnerNew, loserNew);
        emit GameRecordStored(matchId, gameRecordHash);

        // Update ENS text records atomically for human players
        bytes32 onChainMatchId = keccak256(abi.encodePacked(winnerHuman, loserHuman, block.timestamp));
        string memory archiveUri = string(abi.encodePacked("0g://", _toHex(gameRecordHash)));
        if (winnerHuman != address(0)) _trySetTextBatch(winnerHuman, winnerNew, onChainMatchId, archiveUri);
        if (loserHuman  != address(0)) _trySetTextBatch(loserHuman,  loserNew,  onChainMatchId, archiveUri);
    }

    function _trySetTextBatch(address player, uint256 elo, bytes32 matchId, string memory archiveUri) internal {
        // Address label: lowercase hex without 0x prefix (matches mintSubname convention)
        string memory label = _toAddressLabel(player);
        bytes32 node = registrar.subnameNode(label);
        try registrar.ownerOf(node) returns (address owner_) {
            if (owner_ != address(0)) {
                registrar.setTextBatch(node, elo, matchId, archiveUri);
            }
        } catch {}
    }

    function _toHex(bytes32 b) internal pure returns (string memory) {
        bytes memory h = "0123456789abcdef";
        bytes memory s = new bytes(64);
        for (uint i = 0; i < 32; i++) {
            s[i*2]   = h[uint8(b[i] >> 4)];
            s[i*2+1] = h[uint8(b[i] & 0x0f)];
        }
        return string(s);
    }

    function _toAddressLabel(address addr) internal pure returns (string memory) {
        bytes memory h = "0123456789abcdef";
        bytes memory s = new bytes(40);
        for (uint i = 0; i < 20; i++) {
            s[i*2]   = h[uint8(uint160(addr) >> (4*(39-i*2))) & 0xf];
            s[i*2+1] = h[uint8(uint160(addr) >> (4*(38-i*2))) & 0xf];
        }
        return string(s);
    }
}
```

- [ ] **Step 5: Run contract tests — expect PASS**

```bash
cd contracts && pnpm exec hardhat test test/phase17_settlement.test.js
```
Expected: 4 passed

- [ ] **Step 6: Confirm all prior contract tests still pass**

```bash
cd contracts && pnpm exec hardhat test
```
Expected: all prior tests pass

- [ ] **Step 7: Commit**

```bash
git add contracts/src/MatchRegistry.sol contracts/src/PlayerSubnameRegistrar.sol contracts/test/phase17_settlement.test.js
git commit -m "contracts: Phase 17 — permissionless two-signature settlement, setTextBatch on PlayerSubnameRegistrar"
```

---

## Task 5: Frontend dice module

**Files:**
- Create: `frontend/app/dice.ts`
- Create: `frontend/app/test-dice-module/page.tsx`
- Create: `frontend/tests/dice-module.spec.ts`

- [ ] **Step 1: Write failing Playwright test**

`frontend/tests/dice-module.spec.ts`:
```typescript
import { test, expect } from "@playwright/test";

test("block-hash PRNG produces two dice values 1-6", async ({ page }) => {
  await page.goto("/test-dice-module");
  const result = await page.locator('[data-testid="dice-result"]').textContent();
  const [d1, d2] = JSON.parse(result!);
  expect(d1).toBeGreaterThanOrEqual(1);
  expect(d1).toBeLessThanOrEqual(6);
  expect(d2).toBeGreaterThanOrEqual(1);
  expect(d2).toBeLessThanOrEqual(6);
});

test("commit produces a 32-byte hex commitment", async ({ page }) => {
  await page.goto("/test-dice-module");
  const commit = await page.locator('[data-testid="commit-a"]').textContent();
  expect(commit).toMatch(/^0x[0-9a-f]{64}$/);
});
```

- [ ] **Step 2: Run — expect FAIL**

```bash
cd frontend && pnpm test:e2e tests/dice-module.spec.ts
```
Expected: FAIL — route `/test-dice-module` not found

- [ ] **Step 3: Create dice.ts**

`frontend/app/dice.ts`:
```typescript
/**
 * dice.ts — two dice protocols.
 *
 * blockHashPRNG: derives [d1, d2] from a recent block hash + nonce.
 *   Used for human-vs-AI. Player cannot choose the block hash mid-game.
 *
 * commit / verify / combine: commit-reveal for human-vs-human.
 *   1. Both peers call commit() → get { commitment, secret }.
 *   2. Exchange commitments over AXL A2A.
 *   3. Exchange secrets over AXL A2A.
 *   4. Call combine(secretA, secretB) → shared dice roll.
 */

import { keccak256, encodePacked, toHex } from "viem";

export function blockHashPRNG(blockHash: `0x${string}`, nonce: number): [number, number] {
  const seed = keccak256(encodePacked(["bytes32", "uint256"], [blockHash, BigInt(nonce)]));
  const n = BigInt(seed);
  const d1 = Number((n % 6n) + 1n);
  const d2 = Number(((n >> 8n) % 6n) + 1n);
  return [d1, d2];
}

export interface DiceCommitment {
  commitment: `0x${string}`;
  secret: `0x${string}`;
}

export function commit(): DiceCommitment {
  const secret = toHex(crypto.getRandomValues(new Uint8Array(32))) as `0x${string}`;
  const commitment = keccak256(encodePacked(["bytes32"], [secret]));
  return { commitment, secret };
}

export function verify(commitment: `0x${string}`, secret: `0x${string}`): boolean {
  return keccak256(encodePacked(["bytes32"], [secret])) === commitment;
}

export function combine(secretA: `0x${string}`, secretB: `0x${string}`): [number, number] {
  const xored = BigInt(secretA) ^ BigInt(secretB);
  const d1 = Number((xored % 6n) + 1n);
  const d2 = Number(((xored >> 8n) % 6n) + 1n);
  return [d1, d2];
}
```

- [ ] **Step 4: Create fixture page**

`frontend/app/test-dice-module/page.tsx`:
```tsx
"use client";
import { blockHashPRNG, commit } from "../dice";

export default function TestDiceModulePage() {
  const FAKE_BLOCK_HASH =
    "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890" as `0x${string}`;
  const dice = blockHashPRNG(FAKE_BLOCK_HASH, 0);
  const { commitment: commitA } = commit();
  return (
    <div>
      <div data-testid="dice-result">{JSON.stringify(dice)}</div>
      <div data-testid="commit-a">{commitA}</div>
    </div>
  );
}
```

- [ ] **Step 5: Run tests — expect PASS**

```bash
cd frontend && pnpm test:e2e tests/dice-module.spec.ts
```
Expected: 2 passed

- [ ] **Step 6: Commit**

```bash
git add frontend/app/dice.ts frontend/app/test-dice-module/ frontend/tests/dice-module.spec.ts
git commit -m "frontend: dice module — blockHashPRNG for H-vs-AI, commit-reveal for H-vs-H"
```

---

## Task 6: Frontend AXL client

**Files:**
- Create: `frontend/app/axl_client.ts`

The AXL client talks to the local AXL node at `localhost:9002`. It routes requests to named agent services on the mesh via the `/a2a/` endpoint.

> **AXL API note:** The exact path structure for `/a2a/<pubkey>/<service>/<endpoint>` should be verified against current AXL docs at https://docs.gensyn.ai/tech/agent-exchange-layer. The pattern below follows the documented localhost HTTP interface.

- [ ] **Step 1: Create axl_client.ts**

`frontend/app/axl_client.ts`:
```typescript
/**
 * axl_client.ts — HTTP wrapper for the local AXL node (localhost:9002).
 *
 * AXL is Gensyn's Agent eXchange Layer: a P2P mesh where agent nodes
 * communicate via end-to-end encrypted routes. The browser talks to
 * its local AXL node; AXL routes requests to remote agent nodes.
 *
 * Usage:
 *   const client = new AXLClient();
 *   const { move } = await client.move(gnubgPubkey, { position_id, match_id, dice });
 *   const { hint } = await client.hint(coachPubkey, { position_id, match_id, dice, candidates });
 *   await client.send(opponentPubkey, "game", message);
 *
 * Agent public keys are read from ENS text records on chaingammon.eth:
 *   gnubg_axl_pubkey  — canonical gnubg agent
 *   coach_axl_pubkey  — canonical coach agent
 */

export interface MoveRequest {
  position_id: string;
  match_id: string;
  dice: [number, number];
  agent_weights_hash?: string;
}

export interface MoveResponse {
  move: string;
  candidates: Array<{ move: string; equity: number }>;
}

export interface HintRequest {
  position_id: string;
  match_id: string;
  dice: [number, number];
  candidates: Array<{ move: string; equity: number }>;
  docs_hash?: string;
}

export interface HintResponse {
  hint: string;
}

export type GameMessage =
  | { type: "move"; move: string }
  | { type: "dice_commit"; commitment: string }
  | { type: "dice_reveal"; secret: string }
  | { type: "game_end"; result: "player1" | "player2" };

const AXL_BASE = "http://localhost:9002";

export class AXLClient {
  /** Request an AI move from the gnubg agent node. */
  async move(agentPubkey: string, req: MoveRequest): Promise<MoveResponse> {
    return this._post(agentPubkey, "gnubg", "move", req);
  }

  /** Request a coaching hint from the coach agent node. */
  async hint(coachPubkey: string, req: HintRequest): Promise<HintResponse> {
    return this._post(coachPubkey, "coach", "hint", req);
  }

  /** Send a game message to the opponent's AXL node. */
  async send(opponentPubkey: string, msg: GameMessage): Promise<void> {
    await this._post(opponentPubkey, "game", "message", msg);
  }

  /** Poll for incoming game messages from the opponent. */
  async recv(opponentPubkey: string): Promise<GameMessage | null> {
    const resp = await fetch(`${AXL_BASE}/recv?peer=${encodeURIComponent(opponentPubkey)}`, {
      method: "GET",
    });
    if (resp.status === 204) return null;
    if (!resp.ok) throw new Error(`AXL recv failed: ${resp.status}`);
    return resp.json() as Promise<GameMessage>;
  }

  private async _post(pubkey: string, service: string, endpoint: string, body: unknown): Promise<any> {
    const url = `${AXL_BASE}/a2a/${encodeURIComponent(pubkey)}/${service}/${endpoint}`;
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => resp.statusText);
      throw new Error(`AXL request failed (${resp.status}): ${text}`);
    }
    return resp.json();
  }
}

export const axlClient = new AXLClient();
```

- [ ] **Step 2: Build check**

```bash
cd frontend && pnpm build 2>&1 | grep "error TS" | head -10
```
Expected: no TypeScript errors in `axl_client.ts`

- [ ] **Step 3: Commit**

```bash
git add frontend/app/axl_client.ts
git commit -m "frontend: axl_client.ts — HTTP wrapper for AXL localhost:9002; routes move/hint/game messages via AXL mesh"
```

---

## Task 7: Coach Panel UI

**Files:**
- Create: `frontend/app/CoachPanel.tsx`
- Create: `frontend/app/test-coach-panel/page.tsx`
- Create: `frontend/tests/coach-panel.spec.ts`

- [ ] **Step 1: Write failing Playwright test**

`frontend/tests/coach-panel.spec.ts`:
```typescript
import { test, expect } from "@playwright/test";

test("coach panel renders hint text", async ({ page }) => {
  await page.goto("/test-coach-panel");
  await expect(page.locator('[data-testid="coach-hint"]')).toContainText("prime");
});

test("coach panel can be dismissed", async ({ page }) => {
  await page.goto("/test-coach-panel");
  await page.locator('[data-testid="coach-dismiss"]').click();
  await expect(page.locator('[data-testid="coach-hint"]')).not.toBeVisible();
});

test("coach panel toggle off hides hint", async ({ page }) => {
  await page.goto("/test-coach-panel");
  await page.locator('[data-testid="coach-toggle"]').click();
  await expect(page.locator('[data-testid="coach-hint"]')).not.toBeVisible();
});
```

- [ ] **Step 2: Run — expect FAIL**

```bash
cd frontend && pnpm test:e2e tests/coach-panel.spec.ts
```
Expected: FAIL — route not found

- [ ] **Step 3: Create CoachPanel.tsx**

`frontend/app/CoachPanel.tsx`:
```tsx
"use client";
/**
 * CoachPanel — non-blocking hint popup shown after each dice roll.
 * Hint comes from the AXL coach agent node via axl_client.ts.
 * On by default; toggleable for experienced players to reduce latency.
 */
import { useState, useEffect } from "react";

interface CoachPanelProps {
  hint: string | null;  // null while waiting for AXL response
  enabled: boolean;
  onToggle: () => void;
}

export function CoachPanel({ hint, enabled, onToggle }: CoachPanelProps) {
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (hint) setDismissed(false);
  }, [hint]);

  if (!enabled || dismissed) return null;

  return (
    <div className="rounded-lg border border-indigo-200 bg-indigo-50 p-3 dark:border-indigo-800 dark:bg-indigo-950">
      <div className="flex items-start justify-between gap-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-indigo-500">
          Coach
        </span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            data-testid="coach-toggle"
            onClick={onToggle}
            className="text-xs text-indigo-400 hover:text-indigo-600"
            title="Turn off coach"
          >
            Off
          </button>
          <button
            type="button"
            data-testid="coach-dismiss"
            onClick={() => setDismissed(true)}
            className="text-xs text-indigo-400 hover:text-indigo-600"
            aria-label="Dismiss hint"
          >
            ✕
          </button>
        </div>
      </div>
      {hint ? (
        <p data-testid="coach-hint" className="mt-1 text-sm text-indigo-900 dark:text-indigo-100">
          {hint}
        </p>
      ) : (
        <p data-testid="coach-hint" className="mt-1 text-sm text-indigo-400 dark:text-indigo-500">
          Thinking…
        </p>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Create fixture page**

`frontend/app/test-coach-panel/page.tsx`:
```tsx
"use client";
import { useState } from "react";
import { CoachPanel } from "../CoachPanel";

export default function TestCoachPanelPage() {
  const [enabled, setEnabled] = useState(true);
  return (
    <div className="p-8">
      <CoachPanel
        hint="Build your prime on the 5-point early."
        enabled={enabled}
        onToggle={() => setEnabled(false)}
      />
    </div>
  );
}
```

- [ ] **Step 5: Run tests — expect PASS**

```bash
cd frontend && pnpm test:e2e tests/coach-panel.spec.ts
```
Expected: 3 passed

- [ ] **Step 6: Commit**

```bash
git add frontend/app/CoachPanel.tsx frontend/app/test-coach-panel/ frontend/tests/coach-panel.spec.ts
git commit -m "frontend: CoachPanel — hint popup with dismiss/toggle; Playwright tests pass"
```

---

## Task 8: Frontend settlement flow

**Files:**
- Create: `frontend/app/settlement.ts`
- Modify: `frontend/app/contracts.ts`

- [ ] **Step 1: Create settlement.ts**

`frontend/app/settlement.ts`:
```typescript
/**
 * settlement.ts — two-signature on-chain settlement.
 *
 * Flow:
 *   1. Upload game record to 0G Storage → rootHash.
 *   2. Winner signs digest.
 *   3. Loser signs digest (exchanged over AXL A2A during game-end sequence).
 *   4. Either player calls MatchRegistry.recordMatch with both signatures.
 *
 * Digest: keccak256(abi.encodePacked(winner, loser, winner, gameRecordHash))
 */

import { keccak256, encodePacked, type WalletClient } from "viem";
import { writeContract } from "@wagmi/core";
import { MatchRegistryABI } from "./contracts";
import { config } from "./wagmi";

export function buildDigest(
  winner: `0x${string}`,
  loser: `0x${string}`,
  gameRecordHash: `0x${string}`
): `0x${string}` {
  return keccak256(
    encodePacked(
      ["address", "address", "address", "bytes32"],
      [winner, loser, winner, gameRecordHash]
    )
  );
}

export async function signSettlement(
  walletClient: WalletClient,
  digest: `0x${string}`
): Promise<`0x${string}`> {
  return walletClient.signMessage({ message: { raw: digest } });
}

export async function submitSettlement(params: {
  winner: `0x${string}`;
  loser: `0x${string}`;
  gameRecordHash: `0x${string}`;
  matchLength: number;
  matchRegistryAddress: `0x${string}`;
  chainId: number;
  sig1: `0x${string}`;
  sig2: `0x${string}`;
}): Promise<`0x${string}`> {
  return writeContract(config, {
    address: params.matchRegistryAddress,
    abi: MatchRegistryABI,
    functionName: "recordMatch",
    args: [
      BigInt(0), params.winner,
      BigInt(0), params.loser,
      params.matchLength,
      params.gameRecordHash,
      params.sig1,
      params.sig2,
    ],
    chainId: params.chainId,
  });
}
```

- [ ] **Step 2: Add new recordMatch signature to MatchRegistryABI in contracts.ts**

In `frontend/app/contracts.ts`, replace the existing `recordMatch` entry in `MatchRegistryABI` with:

```typescript
{
  name: "recordMatch",
  type: "function",
  stateMutability: "nonpayable",
  inputs: [
    { name: "winnerAgentId",  type: "uint256" },
    { name: "winnerHuman",    type: "address" },
    { name: "loserAgentId",   type: "uint256" },
    { name: "loserHuman",     type: "address" },
    { name: "matchLength",    type: "uint16"  },
    { name: "gameRecordHash", type: "bytes32" },
    { name: "sig1",           type: "bytes"   },
    { name: "sig2",           type: "bytes"   },
  ],
  outputs: [{ name: "matchId", type: "uint256" }],
},
```

- [ ] **Step 3: Build check**

```bash
cd frontend && pnpm build 2>&1 | grep "error TS" | head -10
```
Expected: no TypeScript errors

- [ ] **Step 4: Commit**

```bash
git add frontend/app/settlement.ts frontend/app/contracts.ts
git commit -m "frontend: settlement.ts — buildDigest, signSettlement, submitSettlement for two-sig on-chain settlement"
```

---

## Task 9: Cleanup — remove server, KeeperHub, og-bridge

**Files:**
- Delete: `server/` (entire directory)
- Delete: `og-bridge/` (entire directory)
- Modify: root `package.json` — remove server/og-bridge scripts
- Modify: `CONTEXT.md` — update architecture, sponsor notes, key files
- Modify: `README.md` — remove server commands, add AXL agent setup

- [ ] **Step 1: Delete server and og-bridge**

```bash
git rm -r server/ og-bridge/
```

- [ ] **Step 2: Remove stale scripts from root package.json**

Remove these entries from the `scripts` block in the root `package.json`:
- `"server:test"` and any reference to `server/` or `og-bridge/`

Keep all `contracts:*` and `frontend:*` scripts.

- [ ] **Step 3: Update CONTEXT.md**

Replace the architecture diagram with:

```
                       ┌──────────────────────────┐
                       │    Frontend (Next.js)    │
                       │    - matchmaking         │
                       │    - profile (ENS)       │
                       │    - match replay        │
                       │    - live game           │
                       │    - LLM coach panel     │
                       └────────────┬─────────────┘
                                    │ localhost:9002
                                    ▼
                       ┌──────────────────────────┐
                       │   AXL node (local)       │
                       │  Gensyn Agent eXchange   │
                       │  Layer — P2P encrypted   │
                       │  mesh on Yggdrasil       │
                       └────────┬─────────────────┘
                                │ AXL mesh
              ┌─────────────────┼─────────────────┐
              ▼                 ▼                  ▼
   ┌─────────────────┐  ┌──────────────┐  ┌──────────────┐
   │  gnubg agent    │  │ coach agent  │  │  opponent    │
   │  (agent/)       │  │  (agent/)    │  │  AXL node    │
   │  FastAPI+gnubg  │  │  flan-t5-    │  │  (H vs H)    │
   │  POST /move     │  │  base LLM    │  │              │
   └────────┬────────┘  └──────────────┘  └──────────────┘
            │ on game-end (browser → contract)
            ▼
   ┌──────────────────────────────────────────────┐
   │  MatchRegistry.recordMatch(sig1, sig2)       │
   │  + PlayerSubnameRegistrar.setTextBatch x2    │
   └────┬──────────────────┬──────────────────────┘
        ▼                  ▼
 ┌──────────────┐  ┌──────────────────────────────┐
 │   0G Chain   │  │       0G Storage             │
 │ AgentRegistry│  │  Log: game records           │
 │ MatchRegistry│  │  Blob: gnubg weights         │
 │ EloMath      │  │  Blob: gnubg strategy docs   │
 │ PlayerSubname│  │        (coach RAG)           │
 │   Registrar  │  └──────────────────────────────┘
 └──────────────┘
```

Update the sponsor notes section to replace KeeperHub with Gensyn AXL.
Update the key files table: remove server entries, add agent/ entries.
Remove the "KeeperHub CLI" commands section.
Add an AXL section describing `axl start --config agent/axl-config.json`.

- [ ] **Step 4: Update README.md — AXL agent setup**

Remove server commands block. Add:

```markdown
## AXL agent nodes (Gensyn)

The `agent/` directory contains two FastAPI services exposed via Gensyn AXL:
- `gnubg_service.py` — gnubg move evaluation
- `coach_service.py` — flan-t5-base LLM coaching hints

```bash
# Install Python deps
pip install -r agent/requirements.txt

# Install gnubg (Ubuntu/Debian)
sudo apt install gnubg

# Start AXL node + both services
cd agent && ./start.sh

# Run tests
cd agent && python -m pytest tests/ -v
```

The AXL node generates a public key on first run. Publish it to the
`gnubg_axl_pubkey` text record on `chaingammon.eth` so clients can
discover it.
```

- [ ] **Step 5: Run all remaining tests**

```bash
pnpm contracts:test && pnpm frontend:test
```
Expected: all contracts pass, frontend build succeeds

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "cleanup: remove server/ and og-bridge/; update CONTEXT.md and README for AXL agent architecture"
```

---

## Task 10: Pivot commit — spec + plan in git history

- [ ] **Step 1: Stage docs**

```bash
git add docs/superpowers/specs/2026-04-28-decentralized-server-design.md
git add docs/superpowers/plans/2026-04-28-decentralized-server.md
```

- [ ] **Step 2: Commit**

```bash
git commit -m "pivot: drop FastAPI server + KeeperHub; adopt Gensyn AXL (P2P mesh) + two-sig settlement + LLM coach

This commit records the architectural pivot in docs/superpowers/specs/.

Motivation: the centralized FastAPI server was a single point of failure.
ELO and identity were already decentralized (ENS + 0G) but gameplay was not.

What changes:
- FastAPI server removed; gnubg runs as an AXL-registered FastAPI agent node
  (agent/gnubg_service.py) that anyone can operate
- LLM coach (flan-t5-base) runs as a second AXL agent node
  (agent/coach_service.py); generates per-move hints from gnubg equity output
  and gnubg strategy docs fetched from 0G Storage
- KeeperHub removed; settlement becomes permissionless via two ECDSA signatures
  from both players — MatchRegistry.recordMatch verifies both sigs on-chain
- WebRTC + 0G KV signaling removed; AXL (Gensyn Agent eXchange Layer) handles
  all P2P communication: AI move requests, coach hints, H-vs-H game relay
- og-bridge Node CLI removed; 0G Storage uploads move to browser JS SDK

AXL (Agent eXchange Layer): Gensyn's P2P network node built on Yggdrasil.
Applications talk to localhost:9002; AXL handles encryption, routing, and
peer discovery across the mesh. Agent public keys published as ENS text
records on chaingammon.eth for discovery without a server.

Sponsor coverage after pivot:
- ENS: portable identity + ELO text records + agent AXL key discovery
- 0G Chain: MatchRegistry, AgentRegistry, PlayerSubnameRegistrar (updated)
- 0G Storage: game records, gnubg weights, gnubg docs for coach RAG
- Gensyn AXL: P2P mesh for AI moves, coach hints, H-vs-H relay (new)"
```

---

## Self-Review — Spec Coverage

| Spec requirement | Task |
|---|---|
| gnubg runs as AXL agent node (FastAPI) | Task 1 |
| LLM coach via flan-t5-base as AXL node | Task 2 |
| gnubg docs on 0G Storage for RAG | Task 3 |
| MatchRegistry two-signature settlement | Task 4 |
| PlayerSubnameRegistrar setTextBatch | Task 4 |
| Dice commit-reveal (H vs H) | Task 5 |
| Dice block-hash PRNG (H vs AI) | Task 5 |
| Frontend AXL client (localhost:9002) | Task 6 |
| CoachPanel UI + toggle | Task 7 |
| settlement.ts (buildDigest, sign, submit) | Task 8 |
| Remove server/, og-bridge/, KeeperHub | Task 9 |
| Pivot commit with AXL context in history | Task 10 |
| Agent discovery via ENS text records | Task 6 (axl_client.ts doc) + Task 9 (README) |
| Coach toggle skips hint but not gnubg eval | Task 2 (coach_service) + Task 7 (CoachPanel) |
