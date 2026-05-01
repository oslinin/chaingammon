# Coach dialogue — turn-by-turn human↔agent collaboration

The coach today is one-shot: per turn, the frontend POSTs `/hint` to
`coach_service`, gets back a single sentence, and renders it. That
gets you a narrator. The coach we *want* — the one that makes
Chaingammon a real Open Agents project — is a stateful, two-way
dialogue with the player: the agent considers the human's history
and tendencies, the human can push back on the suggestion or ask
follow-up questions, and the agent updates its take in light of the
exchange.

This is the **human-in-the-loop** thesis. Pure-AI play converges on
gnubg-equivalent equity-maxing; pure-human play tops out at the
human's ELO. The collaboration is what unlocks the next plateau —
the same way Claude Code is a stronger software engineer with a
human reviewing and redirecting it than either is alone.

## Design goals

1. **Per-turn dialogue, not per-game.** The unit of conversation is
   one turn: the human rolls the dice, sees the agent's
   recommendation, can challenge / question / accept, and the agent
   responds in kind before the human commits a move.
2. **The agent reads the human, not just the position.** Style
   profile (from 0G Storage KV) + recent move history + the
   currently-in-flight dialogue all feed the prompt. No more
   generic "consider making the 5-point" — the agent says "you've
   been playing aggressive openings all session, and against this
   opponent that's been costing you on bear-off; this is one of
   the spots where the safer play actually pays better."
3. **The human can talk back.** Free-text questions ("why not
   13/8?"), challenges ("but I'd be leaving a blot"), or
   acceptance ("ok, doing it"). The agent's next message is
   conditioned on the exchange so far.
4. **Feedback adjusts the coach, not just the conversation.** A
   human's correction ("I prefer running games, stop suggesting
   primes") becomes a per-session preference signal that biases
   the agent's next hint *and* — eventually — feeds the agent's
   training as a labelled data point about this human's style.
5. **Bounded latency.** Total round-trip (browser → coach →
   browser) under 1.5 seconds for the dialogue to feel
   conversational rather than chat-shaped. Streaming responses
   when the LLM backend supports it.

## Conversational shape

```
Human turn opens
  ├─ frontend rolls dice (drand-derived in production)
  ├─ frontend hits coach: opening hint with full context
  │     POST /chat {kind: "open_turn", state, dice, candidates,
  │                 history, opponent_profile, dialogue: []}
  └─ agent returns initial take (1-2 sentences)
        "5-3 here. Two reasonable plays — 13/8 13/10 (safer,
         keeps a builder in reserve) or 13/8 8/3 (slots the 3-point,
         pressures the back checkers). You've been slotting all
         session and it's worked twice; I'd lean the second."

Optional human reply
  ├─ human types: "but doesn't 8/3 leave a blot?"
  └─ frontend hits coach: dialogue reply
        POST /chat {kind: "human_reply", state, dialogue: [...exchange]}
        agent returns: "It does — the blot's on the 3-point with
                        24 indirect shots. You hold the 22-point
                        anchor so even if you get hit, you're safe.
                        Net equity is still in your favour by ~0.05."

Human commits a move
  ├─ frontend hits coach: feedback signal (kind: "move_committed")
  └─ agent records: "human took 13/8 13/10 (the safer line) despite
                     my recommendation. Down-weight aggressive
                     suggestions for the rest of this session."
```

Three message kinds — `open_turn`, `human_reply`, `move_committed`
— share a single endpoint (`POST /chat`) and a single response
shape (`{message, dialogue_id, latency_ms}`). The frontend keeps
the dialogue list per match in `localStorage` so it survives
reload.

## Data shapes

### `DialogueMessage`

```python
@dataclass(frozen=True)
class DialogueMessage:
    role: Literal["human", "agent"]
    text: str
    turn_index: int                # which turn this message belongs to
    move_id: Optional[str]         # opaque id for the move under discussion
    timestamp: str                 # ISO-8601
```

### `DialogueState` (per match)

```python
@dataclass(frozen=True)
class DialogueState:
    match_id: str
    opponent: PlayerRef            # the human's adversary (the agent or another human)
    history: list[DialogueMessage] # full per-match dialogue, append-only
    preferences: dict[str, float]  # session-derived signal: {"prefers_running": +0.4, …}
```

### `ChatRequest` / `ChatResponse`

```python
class ChatRequest(BaseModel):
    kind: Literal["open_turn", "human_reply", "move_committed"]
    state: MatchState              # current board / dice / turn — shared with /hint
    candidates: list[Candidate]    # ranked moves from gnubg_service.evaluate
    dialogue: list[DialogueMessage]
    opponent_profile_uri: str      # 0G Storage URI for opponent's style profile
    agent_weights_hash: str        # 0G Storage hash of the agent's brain
    move_committed: Optional[str]  # only for kind="move_committed"

class ChatResponse(BaseModel):
    message: DialogueMessage       # the agent's reply
    backend: Literal["compute", "local"]
    preferences_delta: dict[str, float]  # signal extracted from this exchange
    latency_ms: int
```

## Where the pieces live

| Concern | Module | Notes |
| --- | --- | --- |
| Dialogue data shapes | `agent/coach_dialogue.py` (new) | `DialogueMessage`, `DialogueState`, ingestion helpers |
| HTTP endpoint | `agent/coach_service.py` (extend) | `POST /chat` alongside the existing `/hint` |
| Prompt assembly | `agent/coach_dialogue.py` (`build_chat_prompt`) | Combines state + dialogue + opponent profile + agent profile + RAG docs |
| Inference backend | unchanged — Qwen 2.5 7B on 0G Compute, flan-t5-base local fallback | `agent/coach_compute_client.py` |
| Frontend session | `frontend/app/match/page.tsx` (extend) | Persist dialogue in `localStorage`; render bubbles inline with the move panel |
| Per-session prefs | `agent/coach_dialogue.py` (`update_preferences`) | Derive `{prefers_running: +0.4}`-style signal from accept/reject patterns |
| Future training feed | `server/app/...` (out of scope for v1) | Periodically aggregate per-session prefs into the human's style profile blob on 0G Storage KV |

## Implementation phases

The plan is to ship in three small, reviewable steps so we keep the
existing `/hint` flow working while we layer the dialogue on top.

### Phase A — data shapes + endpoint stub *(this is the next commit)*

- New `agent/coach_dialogue.py`: `DialogueMessage`, `DialogueState`,
  `build_chat_prompt`, `update_preferences`. Pure data + helpers,
  no HTTP yet.
- New `POST /chat` endpoint in `agent/coach_service.py` that
  consumes `ChatRequest`, returns a stub `ChatResponse` so the
  frontend can integrate against it before the LLM path is wired.
- Unit tests for the data shapes, prompt assembly, and preference
  updates.

### Phase B — wire the LLM backend

- `_generate_chat` analogue of the existing `_generate` for
  the dialogue prompt; reuse `_generate_compute` and
  `_generate_local`.
- Add `streaming=True` for the `compute` path when the SDK supports
  it (the dialogue is conversational; streaming is the difference
  between "feels live" and "feels like chat-with-a-bot").

### Phase C — frontend integration

- `frontend/app/match/page.tsx` adds a dialogue panel below the
  move panel: scrollable bubbles, inline reply textarea, "send"
  button (Enter in textarea), per-turn separator. Persist the full
  history to `localStorage` keyed by `matchId`.
- Wire `kind="open_turn"` on dice roll, `kind="human_reply"` on
  send, `kind="move_committed"` on move commit.
- Playwright spec: open a match, send one human reply, verify the
  agent reply appears within 2 seconds.

### Phase D — preference loop

- Persist `preferences` per session (browser-side) and feed back
  into `ChatRequest.preferences` so the agent sees the running
  signal across turns.
- Periodically (post-match) write the session preferences into the
  human's `style_uri` blob on 0G Storage. The next match's coach
  starts already-calibrated.

### Phase E — training feedback (post-hackathon)

- Aggregate per-session preference updates as labelled
  human-in-the-loop signal for the agent's next training round.
  This closes the human-agent collaboration loop in the way
  DeepMind's Gato / RT-2 work argues for: the human's corrections
  aren't just for that turn, they shape the agent's future play.

## Cost / latency budget

| Component | Budget | Notes |
| --- | --- | --- |
| Prompt assembly | <10 ms | Pure Python; trivial |
| 0G Compute round-trip | <1200 ms | Qwen 2.5 7B; streaming target |
| Local fallback (flan-t5) | <500 ms | Smaller model, faster but less coherent |
| Frontend render | <50 ms | Append one bubble to a virtualized list |
| **Total p95** | **<1.5 s** | Guides the streaming-vs-blocking decision |

## What this is NOT

- A general-purpose chat. The dialogue is bounded to the current
  turn; off-topic questions get a short "let's stay focused on
  this move."
- A replacement for `/hint`. `/hint` stays as the one-shot
  per-turn narration for users who don't want a dialogue. `/chat`
  is opt-in.
- A persistent personality. The agent's voice comes from its
  trained checkpoint + the opponent profile; the dialogue history
  is per-match, and the per-session preferences are bounded
  signals (clipped to `[-1, 1]`) — not free-form long-term memory.

## References

- README's "How agents are trained" section — the trained checkpoint
  is what gives the agent its baseline play.
- `agent/agent_profile.py` — the existing per-agent overlay loader
  (we'll extend it to include opponent profile context for the
  chat prompt).
- `docs/keeperhub-workflow.md` — the per-turn workflow that the
  dialogue layer composes on top of (drand → dice → /chat → human
  reply → /chat → move commit → KeeperHub validate → next round).
