# Team mode — the actual human-in-the-loop story

`chaingammon_plan.md` calls out two related play formats that the
solo single-player flow doesn't cover:

> *Doubles / chouette — two agents (or two humans, or one of each)
> on a team, one acts as captain per turn while teammates can advise.
> Match record format extends to include team rosters and per-turn
> advisor signals.*
>
> *Human + agent — your existing `coach_service` is already half this:
> agent suggests, human decides. Generalizes to "agent suggests, human
> can override" with both contributions logged.*

This is where humans enter the agent training loop. Refereed
team-vs-team match records (signed match outcomes on Sepolia,
archived on 0G Storage) are training data for the next round of
agents — humans contribute to that signal as advisors and captains
within team mode, **not** as preference-labelers in the solo coach
dialogue (`docs/coach-dialogue.md`).

## Modes

| Mode | Composition | Captain selection | Advisors |
| --- | --- | --- | --- |
| Solo | 1v1 | the player IS the captain | none |
| Doubles / chouette | 2v2; any mix of humans and agents | rotates per turn | both teammates of the captain advise |
| Human + agent | 2v1 special case: 1 human + 1 agent vs 1 opponent | always the human | the agent |

The third mode is a special case of the second; in code there is
one team-mode flow.

## The advisor pattern

Per turn, after dice are rolled:

1. The captain's seat is determined by the team's `captain_rotation`
   policy (default: `alternating`).
2. Each non-captain teammate produces an `AdvisorSignal` —
   `{teammate_id, proposed_move, confidence, optional_message}`.
   Agents produce these from their value-net evaluation; humans
   produce them by tapping a candidate move and optionally typing a
   one-line rationale.
3. The captain sees all advisor signals and commits the chosen
   move. They can tag which advisor's proposal they took (or "none"
   if they chose independently).
4. The match record stores the captain's commit AND every advisor
   signal received that turn. Audit replayers can score "did the
   captain follow the strongest advisor?" without re-running the
   value net.

## Data shapes

The team-mode shape extends the existing `server/app/game_record.py`
envelope. All four new fields are `Optional` so existing solo records
hash to the same Merkle root after the schema change — `serialize_
record` already uses `exclude_none=True`.

### `AdvisorSignal`

```python
class AdvisorSignal(BaseModel):
    teammate_id: str        # PlayerRef-shaped id (address or "agent:N") of the advisor
    proposed_move: str      # gnubg-format move string; non-empty
    confidence: float = Field(ge=0.0, le=1.0)
    message: Optional[str] = None  # free-text rationale; omitted when none
```

### `Team`

```python
class Team(BaseModel):
    members: list[PlayerRef] = Field(min_length=1)
    captain_rotation: Literal["alternating", "per_turn_vote", "fixed_first"] = "alternating"
```

### Extensions to existing types

```python
class MoveEntry(BaseModel):
    # ... existing fields ...
    advisor_signals: Optional[list[AdvisorSignal]] = None  # NEW

class GameRecord(BaseModel):
    # ... existing fields ...
    team_a: Optional[Team] = None  # NEW
    team_b: Optional[Team] = None  # NEW
```

`winner` / `loser` stay scalar `PlayerRef` for backwards-compat — by
convention they're the captain at game-end. Audit replayers detect
team-vs-solo by `team_a is not None`.

## Settlement

Settlement uses **`MatchEscrow.payoutSplit(matchId, winners[],
shares[])`** — a per-match split function called by `MatchRegistry`
at game-end with the winning team's addresses and the agreed shares.

There is **no team treasury** and **no off-chain multisig**. Team
terms can change at every match, so the split is decided
off-chain by the team and committed by the settler when the
match settles — the contract verifies that `sum(shares) == pot`
and that no winner is the zero address. Recipients are NOT
restricted to the two depositors: in team mode only one address
per side stakes (no team treasury) but the team's internal split
may include teammates who never put money on the table.

Effects-then-interactions: the `settled` flag flips before any
of the N transfers, so a reentrant winner cannot double-spend.
If any single transfer reverts, the whole transaction reverts and
the pot stays in escrow — the settler retries with a corrected
list. Zero-share entries are allowed (the settler may want to
record team membership without paying) and silently skipped at
transfer time so they don't trigger spurious `PaidOut` events.

## Coach in team mode

`POST /chat` extends with three new `kind` values for team-mode
dialogue:

| Kind | Semantics |
| --- | --- |
| `teammate_propose` | A teammate suggests a move (produces an `AdvisorSignal`). |
| `teammate_advise` | A teammate explains their suggestion in 1-2 sentences. |
| `captain_decide` | The captain commits with optional `chosen_advisor_id`. |

The existing `open_turn` / `human_reply` / `move_committed` stay for
solo matches. The frontend selects between solo and team flows based
on whether `GameRecord.team_a` is populated.

## Phasing

| Phase | Scope | Status |
| --- | --- | --- |
| **Team-1** | GameRecord schema (`AdvisorSignal`, `Team`, optional fields on `MoveEntry`/`GameRecord`) + tests | landed |
| **Team-2** | `/chat` `kind` extensions (`teammate_propose`, `teammate_advise`, `captain_decide`) + `ChatRequest.chosen_advisor_id` + tests | landed |
| **Team-3** | `MatchEscrow.payoutSplit(matchId, winners[], shares[])` Solidity variant + Hardhat tests | landed |
| **Team-3.5** | `MatchRegistry.recordMatchAndSplit` + `setMatchEscrow` wiring; `deploy.js` wires the two contracts end-to-end | landed |
| **Team-4** | `/play/new` frontend route + match-page UI for advisor display | follow-up |
| **Team-5** | `settleWithSessionKeysAndSplit` (trustless settlement with split bound to resultHash) | follow-up |

Team-1 through Team-3.5 close the on-chain story for owner-trusted
settlement. The trustless session-key variant (Team-5) needs a new
signed-message format that binds the split to the result hash — that
landed as its own phase rather than being squeezed into Team-3.5.
Team-4 is the frontend match-page display for advisor signals + a
`/play/new` route that lets users pick solo vs team mode at match
creation.

## What this is NOT

- A general n-player free-for-all. Two teams of one or more, full
  stop. Chouette's "boxer-vs-team" variant is a future extension.
- A persistent team identity. Teams are per-match — the same humans
  and agents can pair differently next match. (This is the reason
  there is no team treasury — terms change every match.)
- A way for humans to directly edit agent weights. Humans contribute
  through gameplay; the training signal is the refereed match record,
  not a side-channel.

## References

- `chaingammon_plan.md` — original framing of doubles/chouette and
  human+agent.
- `server/app/game_record.py` — `PlayerRef`, `MoveEntry`,
  `GameRecord` (the types this design extends).
- `contracts/src/MatchEscrow.sol` — current `payoutWinner` contract;
  the `payoutSplit` variant lands in Team-3.
- `docs/coach-dialogue.md` — solo single-player coach (the
  *non*-team-mode flow). Per-session preferences there are
  session-local UX adaptation, not training data.
