from pydantic import BaseModel
from typing import List, Literal, Optional
from fastapi import APIRouter, HTTPException
import sys
from pathlib import Path

# Need to ensure `agent/` is in sys.path BEFORE importing from it
_agent_dir = Path(__file__).resolve().parents[2] / "agent"
if _agent_dir.exists() and str(_agent_dir) not in sys.path:
    sys.path.insert(0, str(_agent_dir))

from agent_profile import NullProfile, ModelProfile, OverlayProfile, load_profile
from app.chain_client import ChainClient
from app.og_storage_client import get_blob
from gnubg_encoder import encode_position_id
from cube_evaluation import evaluate_cube_action

router = APIRouter()

class CubeDecisionRequest(BaseModel):
    agent_id: int
    position_id: str
    match_id: str
    cube: int
    cube_owner: int
    is_agent_turn: bool

class CubeDecisionResponse(BaseModel):
    action: Literal["offer", "take", "drop", "none"]
    equity: float

@router.post("/agents/{agent_id}/cube-decision", response_model=CubeDecisionResponse)
def get_cube_decision(agent_id: int, req: CubeDecisionRequest):
    """
    Evaluates whether the agent should offer, take, or drop a double
    based on the current position's win equity.
    """
    try:
        chain = ChainClient.from_env()
        hashes = chain.agent_data_hashes(agent_id)
        weights_hash = hashes[1]
    except Exception as e:
        print(f"Cube decision chain fallback due to: {e}")
        weights_hash = "0x" + "00" * 32

    if weights_hash == "0x" + "00" * 32:
        # Fallback to default GNUBG weights for untrained agent
        from sample_trainer import BackgammonNet, DEFAULT_EXTRAS_DIM
        net = BackgammonNet(core_seed=0xBACC, extras_dim=DEFAULT_EXTRAS_DIM, extras_seed=0)
    else:
        profile = load_profile(weights_hash, fetch=get_blob)
        if isinstance(profile, ModelProfile):
            net = profile.net
        else:
            from sample_trainer import BackgammonNet, DEFAULT_EXTRAS_DIM
            net = BackgammonNet(core_seed=0xBACC, extras_dim=DEFAULT_EXTRAS_DIM, extras_seed=0)

    net.eval()

    import torch
    # Agent perspective is 1. If we evaluate equity from agent perspective,
    # we need to pass perspective=1 to encode_position_id.
    features = encode_position_id(req.position_id, perspective=1)

    with torch.no_grad():
        feat_tensor = features.clone().detach().type(torch.float32).unsqueeze(0) if isinstance(features, torch.Tensor) else torch.tensor(features, dtype=torch.float32).unsqueeze(0)
        extras_tensor = torch.zeros((1, 16), dtype=torch.float32)  # Default context
        equity = net(feat_tensor, extras_tensor).item()

    action = evaluate_cube_action(
        equity=equity,
        match_length=0, # Assuming money game for MVP
        p0_score=0,
        p1_score=0,
        current_cube=req.cube,
        cube_owner=req.cube_owner,
        is_agent_turn=req.is_agent_turn
    )

    return {"action": action, "equity": equity}
