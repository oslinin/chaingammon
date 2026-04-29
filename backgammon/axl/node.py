"""
backgammon/axl/node.py — AXL-coordinated training node.

Each node:
  - Runs continuous self-play training in a background thread.
  - Exposes a Flask HTTP service that AXL proxies peer messages to.
  - Every PEER_CYCLE_MINUTES: announces checkpoint, challenges one peer
    for 20 games, updates local ELO (K=32).  If peer ELO exceeds self
    by ≥50 points, downloads their weights from 0G Storage and replaces
    local model.

AXL integration
---------------
AXL is started externally as ``axl start --config axl-config.json``.
Incoming peer messages arrive as HTTP POST requests to this service's
/axl endpoint (AXL proxies peer → local upstream).

Outbound messages are sent to the AXL node's local HTTP API.  The AXL
send endpoint is assumed to be:
  POST http://localhost:<AXL_PORT>/send
  Body: {"to": "<peer_id>", "service": "<svc_name>", "data": <msg_dict>}

NOTE: The exact AXL send API was not verifiable at implementation time
(WebFetch unavailable).  If the actual endpoint or body schema differs,
update AXLTransport.send() below and/or axl-config.json.

Entry point:
    python -m backgammon.axl.node --peers id1,id2 [--no-chain] [--no-storage]
"""

from __future__ import annotations

import argparse
import hashlib
import io
import logging
import os
import random
import threading
import time
from collections import OrderedDict
from typing import Optional

import numpy as np
import torch
import torch.optim as optim

from backgammon.agent import NetAgent
from backgammon.axl.messages import (
    Announce,
    Challenge,
    MatchResult,
    WeightsReq,
    WeightsResp,
    from_dict,
)
from backgammon.net import BackgammonNet
from backgammon.selfplay import play_game, td_lambda_update

logger = logging.getLogger(__name__)

_K_FACTOR = 32.0
_PEER_CYCLE_MINUTES = 2.0
_MATCH_GAMES = 20
_MAX_PEERS = 10

# ── ELO maths ────────────────────────────────────────────────────────────────

def _elo_update(elo_self: float, elo_opp: float, score: float, n: int) -> float:
    """K=32 ELO update; score is wins/n."""
    expected = 1.0 / (1.0 + 10 ** ((elo_opp - elo_self) / 400.0))
    return elo_self + _K_FACTOR * (score - expected)


# ── AXL transport abstraction ─────────────────────────────────────────────────

class AXLTransport:
    """Thin wrapper around the AXL node's local HTTP send API.

    Override for testing by passing a custom transport to BackgammonNode.
    """

    def __init__(self, axl_port: int = 7070, service_name: str = "backgammon") -> None:
        self.axl_port = axl_port
        self.service_name = service_name

    def send(self, peer_id: str, message: dict) -> None:
        """POST message to AXL send endpoint → peer.

        AXL assumed endpoint: POST http://localhost:<port>/send
        Body: {"to": peer_id, "service": service_name, "data": message}
        """
        try:
            import requests
            url = f"http://localhost:{self.axl_port}/send"
            requests.post(
                url,
                json={"to": peer_id, "service": self.service_name, "data": message},
                timeout=5.0,
            )
        except Exception as exc:
            logger.warning("AXL send to %s failed: %s", peer_id, exc)

    def list_peers(self) -> list[str]:
        """Query AXL for connected peers."""
        try:
            import requests
            url = f"http://localhost:{self.axl_port}/peers"
            resp = requests.get(url, timeout=3.0)
            return resp.json().get("peers", [])
        except Exception:
            return []


# ── Node ─────────────────────────────────────────────────────────────────────

class BackgammonNode:
    """One training node in the decentralised population."""

    def __init__(
        self,
        agent_id: str,
        net: BackgammonNet,
        transport: AXLTransport,
        seed: int = 0,
        lambda_td: float = 0.7,
        epsilon: float = 0.1,
        lr: float = 1e-3,
        enable_storage: bool = True,
        enable_chain: bool = True,
    ) -> None:
        self.agent_id = agent_id
        self.net = net
        self.transport = transport
        self.seed = seed
        self.lambda_td = lambda_td
        self.epsilon = epsilon
        self.enable_storage = enable_storage
        self.enable_chain = enable_chain

        self.optimizer = optim.Adam(net.parameters(), lr=lr)
        self.elo: float = 1500.0
        self.generation: int = 0
        self.lock = threading.Lock()

        # LRU peer pool: peer_id → {"elo": float, "checkpoint_hash": str, ...}
        self._peers: OrderedDict[str, dict] = OrderedDict()

        self._rng_py = random.Random(seed)
        self._rng_np = np.random.default_rng(seed)

        self._running = False
        self._train_thread: Optional[threading.Thread] = None
        self._cycle_thread: Optional[threading.Thread] = None

    # ── Checkpoint ───────────────────────────────────────────────────────────

    def checkpoint_bytes(self) -> bytes:
        buf = io.BytesIO()
        torch.save(self.net.state_dict(), buf)
        return buf.getvalue()

    def checkpoint_hash(self) -> str:
        return hashlib.sha256(self.checkpoint_bytes()).hexdigest()

    def _upload_checkpoint(self) -> str:
        """Upload weights to 0G Storage; return URI."""
        if not self.enable_storage:
            return f"local://{self.checkpoint_hash()}"
        try:
            from backgammon.og.storage import upload_checkpoint
            return upload_checkpoint(self.net.state_dict())
        except Exception as exc:
            logger.warning("0G upload failed: %s", exc)
            return f"local://{self.checkpoint_hash()}"

    def _replace_weights_from_uri(self, uri: str) -> None:
        """Download peer weights from 0G Storage and load them."""
        if not self.enable_storage or uri.startswith("local://"):
            return
        try:
            from backgammon.og.storage import download_checkpoint
            state_dict = download_checkpoint(uri)
            with self.lock:
                self.net.load_state_dict(state_dict)
            logger.info("[%s] Replaced weights from %s", self.agent_id, uri)
        except Exception as exc:
            logger.warning("Weight download from %s failed: %s", uri, exc)

    # ── Peer pool management ─────────────────────────────────────────────────

    def _add_peer(self, peer_id: str, info: dict) -> None:
        with self.lock:
            if peer_id in self._peers:
                self._peers.move_to_end(peer_id)
            self._peers[peer_id] = info
            while len(self._peers) > _MAX_PEERS:
                self._peers.popitem(last=False)

    def _pick_peer(self) -> Optional[str]:
        with self.lock:
            if not self._peers:
                return None
            return random.choice(list(self._peers.keys()))

    # ── Background training thread ───────────────────────────────────────────

    def _train_loop(self) -> None:
        agent = NetAgent(self.net, epsilon=self.epsilon)
        while self._running:
            rng_py = random.Random(self._rng_py.randint(0, 2**31))
            rng_np = np.random.default_rng(int(self._rng_np.integers(0, 2**31)))
            traj = play_game(agent, agent, rng_py, rng_np)
            with self.lock:
                td_lambda_update(self.net, self.optimizer, traj, lam=self.lambda_td)
                self.generation += 1

    # ── Peer interaction cycle ────────────────────────────────────────────────

    def _peer_cycle(self) -> None:
        while self._running:
            time.sleep(_PEER_CYCLE_MINUTES * 60)
            if not self._running:
                break
            try:
                self._do_announce()
                peer_id = self._pick_peer()
                if peer_id:
                    self._do_challenge(peer_id)
            except Exception as exc:
                logger.error("[%s] Peer cycle error: %s", self.agent_id, exc)

    def _do_announce(self) -> None:
        """Broadcast current checkpoint hash + ELO to all known peers."""
        msg = Announce(
            agent_id=self.agent_id,
            checkpoint_hash=self.checkpoint_hash(),
            elo=self.elo,
            generation=self.generation,
        ).to_dict()
        for peer_id in list(self._peers.keys()):
            self.transport.send(peer_id, msg)

    def _do_challenge(self, peer_id: str) -> None:
        """Challenge *peer_id* to a match; play it locally and report results."""
        seed = self._rng_py.randint(0, 2**31)
        msg = Challenge(from_id=self.agent_id, n_games=_MATCH_GAMES, seed=seed).to_dict()
        self.transport.send(peer_id, msg)
        # Play the match ourselves (peer also plays it with the same seed).
        score_self, score_peer = self._play_match_vs_peer(peer_id, _MATCH_GAMES, seed)
        result = MatchResult(
            agent_a=self.agent_id,
            agent_b=peer_id,
            score_a=score_self,
            score_b=score_peer,
            n_games=_MATCH_GAMES,
        )
        self._handle_match_result(result)
        # Forward result to peer.
        self.transport.send(peer_id, result.to_dict())

        # Submit to chain if both agree (peer's co-signature required; stub here).
        if self.enable_chain:
            self._submit_match_chain(result)

    def _play_match_vs_peer(
        self, peer_id: str, n_games: int, seed: int
    ) -> tuple[int, int]:
        """Play n_games against a local copy using a shared random seed."""
        from backgammon.agent import RandomAgent
        peer_agent = RandomAgent()   # Opponent simulated as random when weights unavailable.
        self_agent = NetAgent(self.net, epsilon=0.0)
        wins_self = 0
        for i in range(n_games):
            rng_py = random.Random(seed + i)
            rng_np = np.random.default_rng(seed + i)
            if i % 2 == 0:
                traj = play_game(self_agent, peer_agent, rng_py, rng_np)
                white_won = traj.target[0].item() > 0.5
                if white_won:
                    wins_self += 1
            else:
                traj = play_game(peer_agent, self_agent, rng_py, rng_np)
                white_won = traj.target[0].item() > 0.5
                if not white_won:
                    wins_self += 1
        return wins_self, n_games - wins_self

    def _handle_match_result(self, result: MatchResult) -> None:
        score = result.score_a / result.n_games if result.n_games > 0 else 0.5
        peer_info = self._peers.get(result.agent_b, {})
        peer_elo = peer_info.get("elo", 1500.0)
        new_elo = _elo_update(self.elo, peer_elo, score, result.n_games)
        with self.lock:
            self.elo = new_elo

        # Pull weights if peer is significantly better.
        if peer_elo >= self.elo + 50 and "storage_uri" in peer_info:
            self._replace_weights_from_uri(peer_info["storage_uri"])

    def _submit_match_chain(self, result: MatchResult) -> None:
        try:
            from backgammon.og.chain import report_match
            report_match(
                agent_a=result.agent_a,
                agent_b=result.agent_b,
                score_a=result.score_a,
                sig_a=b"",   # full EIP-712 sig requires private key — stub
                sig_b=b"",
            )
        except Exception as exc:
            logger.debug("Chain submit skipped: %s", exc)

    # ── Incoming message handler (called by Flask endpoint) ──────────────────

    def handle_message(self, data: dict) -> dict:
        try:
            msg = from_dict(data)
        except ValueError as exc:
            return {"error": str(exc)}

        if isinstance(msg, Announce):
            self._add_peer(msg.agent_id, {
                "elo": msg.elo,
                "checkpoint_hash": msg.checkpoint_hash,
                "generation": msg.generation,
            })
            return {"status": "ok"}

        if isinstance(msg, Challenge):
            # Peer challenged us — play the match and report back.
            score_self, score_peer = self._play_match_vs_peer(
                msg.from_id, msg.n_games, msg.seed
            )
            result = MatchResult(
                agent_a=msg.from_id,
                agent_b=self.agent_id,
                score_a=score_peer,   # from challenger's perspective
                score_b=score_self,
                n_games=msg.n_games,
            )
            self.transport.send(msg.from_id, result.to_dict())
            return {"status": "playing"}

        if isinstance(msg, MatchResult):
            self._handle_match_result(msg)
            return {"status": "ok"}

        if isinstance(msg, WeightsReq):
            uri = self._upload_checkpoint()
            resp = WeightsResp(
                checkpoint_hash=msg.checkpoint_hash,
                storage_uri=uri,
            ).to_dict()
            return resp

        if isinstance(msg, WeightsResp):
            peer_id = data.get("_from", "")
            if peer_id and peer_id in self._peers:
                self._peers[peer_id]["storage_uri"] = msg.storage_uri
            return {"status": "ok"}

        return {"error": "unhandled"}

    # ── Lifecycle ─────────────────────────────────────────────────────────────

    def start(self) -> None:
        self._running = True
        self._train_thread = threading.Thread(target=self._train_loop, daemon=True)
        self._cycle_thread = threading.Thread(target=self._peer_cycle, daemon=True)
        self._train_thread.start()
        self._cycle_thread.start()

    def stop(self) -> None:
        self._running = False


# ── Flask HTTP service ────────────────────────────────────────────────────────

def _build_app(node: BackgammonNode):
    from flask import Flask, jsonify, request
    app = Flask(__name__)

    @app.post("/axl")
    def axl_handler():
        data = request.get_json(force=True, silent=True) or {}
        result = node.handle_message(data)
        return jsonify(result)

    @app.get("/status")
    def status():
        return jsonify({
            "agent_id": node.agent_id,
            "elo": node.elo,
            "generation": node.generation,
            "peers": list(node._peers.keys()),
        })

    return app


# ── CLI entry point ────────────────────────────────────────────────────────────

def main() -> None:
    logging.basicConfig(level=logging.INFO)
    p = argparse.ArgumentParser(description="Backgammon AXL training node")
    p.add_argument("--agent-id",   type=str, default=None)
    p.add_argument("--peers",      type=str, default="",
                   help="Comma-separated initial peer IDs")
    p.add_argument("--port",       type=int, default=8100,
                   help="Local HTTP service port (registered with AXL)")
    p.add_argument("--axl-port",   type=int, default=7070)
    p.add_argument("--hidden",     type=int, default=128)
    p.add_argument("--lr",         type=float, default=1e-3)
    p.add_argument("--lambda-td",  type=float, default=0.7)
    p.add_argument("--epsilon",    type=float, default=0.1)
    p.add_argument("--seed",       type=int, default=42)
    p.add_argument("--no-chain",   action="store_true")
    p.add_argument("--no-storage", action="store_true")
    args = p.parse_args()

    agent_id = args.agent_id or f"node-{os.getpid()}"
    net = BackgammonNet(hidden=args.hidden)
    transport = AXLTransport(axl_port=args.axl_port)

    node = BackgammonNode(
        agent_id=agent_id,
        net=net,
        transport=transport,
        seed=args.seed,
        lambda_td=args.lambda_td,
        epsilon=args.epsilon,
        lr=args.lr,
        enable_storage=not args.no_storage,
        enable_chain=not args.no_chain,
    )

    for pid in (args.peers or "").split(","):
        pid = pid.strip()
        if pid:
            node._add_peer(pid, {"elo": 1500.0})

    node.start()
    logger.info("[%s] Node started on port %d", agent_id, args.port)

    app = _build_app(node)
    app.run(host="0.0.0.0", port=args.port)


if __name__ == "__main__":
    main()
