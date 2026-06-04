import sys; import os; sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
from app.gnubg_client import GnubgClient

def test_gnubg_startup():
    client = GnubgClient()
    res = client.new_match(1)
    assert "position_id" in res
    assert "match_id" in res
    assert len(res["points"]) == 24
