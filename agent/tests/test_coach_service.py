"""Tests for coach_service.py — run with: cd agent && python -m pytest tests/test_coach_service.py -v"""
import pytest
from unittest.mock import patch
from httpx import AsyncClient, ASGITransport


@pytest.fixture
def app():
    """Import coach_service.app inside the fixture so collection works before the module exists."""
    from coach_service import app as _app
    return _app


@pytest.mark.anyio
async def test_hint_returns_string(app):
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
async def test_hint_missing_candidates_returns_422(app):
    """/hint with missing required field returns 422."""
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        resp = await client.post("/hint", json={"dice": [1, 2]})
    assert resp.status_code == 422
