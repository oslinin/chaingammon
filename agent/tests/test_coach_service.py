"""Tests for coach_service.py — run with: cd agent && python -m pytest tests/test_coach_service.py -v"""
import pytest
from unittest.mock import patch
from httpx import AsyncClient, ASGITransport


@pytest.fixture
def app():
    """Import coach_service.app inside the fixture so collection works before
    the module's runtime deps (transformers etc.) are necessarily importable."""
    from coach_service import app as _app
    return _app


@pytest.mark.anyio
async def test_hint_returns_string(app):
    """/hint must return a non-empty hint string and surface the backend used."""
    with patch("coach_service._generate") as mock_gen:
        mock_gen.return_value = ("Build your prime on the 5-point.", "compute")
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.post("/hint", json={
                "position_id": "4HPwATDgc/ABMA",
                "match_id": "cAkAAAAAAAAA",
                "dice": [3, 1],
                "candidates": [{"move": "13/10 24/23", "equity": -0.050}],
                "docs_hash": "",
                "agent_weights_hash": "",
            })
    assert resp.status_code == 200
    body = resp.json()
    assert body["hint"].startswith("Build")
    assert body["backend"] == "compute"


@pytest.mark.anyio
async def test_hint_propagates_when_compute_fails(app):
    """The local flan-t5 fallback was removed — coach is 0G-Compute-only.
    When compute raises, /hint must propagate the exception (no silent
    fallback), so the operator sees the failure and the frontend can
    surface the error to the user."""
    from coach_service import _BACKEND
    assert _BACKEND == "compute"

    def boom(*_a, **_kw):
        raise RuntimeError("0G testnet unreachable")

    with patch("coach_service._generate_compute", side_effect=boom):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            with pytest.raises(RuntimeError, match="0G testnet unreachable"):
                await client.post("/hint", json={
                    "position_id": "4HPwATDgc/ABMA",
                    "match_id": "cAkAAAAAAAAA",
                    "dice": [3, 1],
                    "candidates": [{"move": "13/10 24/23", "equity": -0.05}],
                    "docs_hash": "",
                    "agent_weights_hash": "",
                })


@pytest.mark.anyio
async def test_hint_missing_candidates_returns_422(app):
    """/hint with missing required field returns 422."""
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        resp = await client.post("/hint", json={"dice": [1, 2]})
    assert resp.status_code == 422
