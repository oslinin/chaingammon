import sys; import os; sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
from app.gnubg_client import GNUBGClient

def test_gnubg_startup():
    client = GNUBGClient()
    client.start()
    client.stop()
