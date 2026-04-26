# Development Log

## Phase 1: GNUBG Wrapper Service
Commit: 48d2653684d4ddb3d9430f63111eff216af9dd13 (and subsequent Phase 1 work)
Tests: All Phase 1 tests pass.

- `server/app/gnubg_client.py`: uses python CLI library pexpect to spawn gnubg and interact with it through FastAPI
- `server/app/game_state.py`: contains the Pydantic models for tracking the state of the backgammon match
- `server/app/main.py`: implements the FastAPI server and REST endpoints for creating and playing games against the gnubg agent
- `server/tests/test_phase1_game.py`: includes end-to-end integration tests for playing a full match using the API
