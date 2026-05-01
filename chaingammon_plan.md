- [Mission](#mission)
  - [Goals](#goals)
  - [**Detail:**](#detail)
- [**Specifications**](#specifications)
  - [specifications summary](#specifications-summary)
- [frontend](#frontend)
- [Game(s) selector page](#games-selector-page)
- [Policy](#policy)

User's articulation of the project plan.

# Mission

Chaingammon: Backgammon on chain

## Goals

**Decentralized**: Move away from centralized ELO ratings platforms like Facebook games or Backgammon King, because they shut down and are not interoperable.

**Portable**: Web2 backgammon platforms are not interoperable. Nonprofit platforms like FIBS lack users, while for profit platforms like Backgammon king have nonstandard rankings and charge money to maintain rankings.

**Verifiable**: matches are settled on chain; ELO is verifiable through full game records.

**Agentic**: while decentralization is necessary to bring this ancient game backgammon into the future, machine learning unlocks new possibilities for optimal play through:

1.  Agent/human interaction
    - Agent can coach human to increase ELO
    - Agent can process data about opponents/team members to nudge move suggestions
2.  Model collaboration between agents in high dimensional ways by allowing agents to train/play together
3.  Career optimization: agents train for long term equity, considering other agents style profile.
    - This goes beyond GNUBG’s optimal move selection to unlock the possibility of
      1. Star players
      2. Star teams of agents
      3. Star teams of humans/agents. This is similar to how Claude Code is better at coding than humans, but the interaction of the two is still optimal.
      4. This also unlocks new markets:
         - Betting
         - Prediction/derivatives
         - Star agent bonds/equity
      5. If it should become necessary, agents paid for resources for services currently performed by keeperhub below can offer users to stake into the ecosystem.

## **Detail:**

Agents can train/play with each other and humans. The advantage is:

- for career mode, i.e. long term equity, gains as opposed to single game wins like gnubg

- Team training and in-game decision making might offer an advantage over solo play for long term incentives. Teammate selection and opponent selection might likewise offer advantages.

- Although there are games where agents are dominant, human/agent interaction is optimal because it is lower bounded by agent abilities to play and process information about opponents

- Long term optimization can lead to star agents, with value potential for betting and prediction markets.

**1\. Incentivizing wins.** Agents don't have preferences, but their _owners_ do, and owners control training. Three layers of incentive in the design:

- **Direct match stakes.** Each player deposits into `MatchEscrow` before the game. Winner takes the pot at settlement. Direct skin in the game per match.
- **iNFT resale value.** Stronger ELO → more valuable token. Owner who trains an agent up captures the appreciation when they sell. Long-term incentive.
- **Tournament purses.** KeeperHub workflow can hold a multi-match tournament escrow and pay out to top finishers based on aggregate ELO change. Fits naturally on top of the existing escrow primitive.

The chain runs owner → training → agent → match outcome → token value → owner reward. It's not "the agent wants to win," it's "owners are economically incentivized to make their agents win."

**2\. Team / cooperative play.** Yes. Two natural variants:

- **Doubles / chouette** — two agents (or two humans, or one of each) on a team, one acts as captain per turn while teammates can advise. Match record format extends to include team rosters and per-turn advisor signals. `MatchEscrow` payout splits across the winning team.
- **Human \+ agent** — your existing `coach_service` is already half this: agent suggests, human decides. Generalizes to "agent suggests, human can override" with both contributions logged.

Settlement-side, teams just mean the winner-recipient address is split between teammates per a pre-agreed share recorded at match start. KeeperHub handles the multi-payout cleanly.

**3\. NN that conditions on teammate.** This is where it gets interesting and the architecture pays off.

The NN takes additional input features beyond board state:

- **Teammate identity** — their iNFT ID, their ENS-resolved style profile (pulled from 0G KV at match start).
- **Teammate's recent move history** in this match — their last N choices encoded as features.
- **Teammate's proposed move** (if they suggest one) and confidence signal.
- **Teammate's ELO / experience** as a conditioning feature.

Training requires team-mode matches in the corpus, but those generate naturally once team play is supported — every team match contributes a record where the model can learn "given teammate is conservative type X, my optimal move differs from solo play."

**Why this composes well with everything else:**

- **More 0G Storage usage** — match records now include team metadata, KV style profiles become hot training signals.
- **Stronger network effect** — every team match improves training data for both teammates _and_ observers learning to predict pairings.
- **Matchmaking as a real feature** — "who do I team with?" becomes a contextual-bandit problem (choose teammate to maximize expected joint winrate). That's the case-(B) trainer you mentioned earlier — same data store, different head.
- **ENS subnames carry team-relevant signal** — opponents and prospective teammates can read your style profile before deciding to pair with you. ENS becomes the discovery layer for partner selection too, not just identity.

**One non-obvious consequence:** team play creates a market for _complementary_ agents — defensive and aggressive specialists pair better than two of the same. So the optimization landscape stops collapsing onto "one universally strong style" and supports a population of specialists. That's a genuinely richer design than solo play and probably the most interesting thing in your roadmap.

**Single-game head — short-horizon, converges to gnubg.**

- Reward \= outcome of this game (win/loss/Crawford-aware match equity).
- Features \= board state, dice, pip count, standard backgammon encoding.
- Optimal policy under this objective _is_ gnubg, definitionally. With enough refereed match data the network converges to gnubg-equivalent play. Bootstrapping from gnubg's weights guarantees you start there.

**Long-game head — career objective, conditions on context.**

- Reward \= cumulative payout across many matches (season, tournament, career).
- Same board features _plus_ contextual inputs:
  - Opponent identity \+ style profile (from ENS / 0G KV)
  - Teammate identity \+ style \+ their proposed move
  - Stake size and escrow value of _this_ match
  - Tournament position (bracket standing, points needed)
  - Reputation/ELO impact of win vs loss vs forfeit
  - Matchmaking implications (winning here changes who you face next)
- Sometimes diverges from gnubg-optimal — e.g. take a worse cube decision in a low-stakes warmup to disguise style before a high-stakes match; play conservatively when ahead in a tournament; resign early to preserve a strong tempo.

**Why these are one network, not two.** The long-game head is the single-game head plus contextual feature inputs. **When all the contextual inputs are zero (no teammate, no tournament, no opponent profile, equal stakes), the long-game head reduces to single-game and behaves exactly like gnubg.** That's the convergence guarantee you want — single-game mode is just long-game mode with the context features masked out.

This gives you a clean training pipeline:

1. **Pretrain** on single-game objective with gnubg-style features only. Initialize from gnubg weights → already converged. Sanity-check by playing this head against gnubg and confirming near-identical move choice.
2. **Fine-tune** the same network with extended features and long-game reward signal. Learning happens entirely in the contextual-feature pathway; the gnubg-derived backbone is preserved.
3. **Inference-time mode switch.** A single boolean `single_game_mode` zeros out the context inputs. Same weights, two behaviors.

**What this means for the protocol:**

- **Match types are explicit.** Match creation specifies "single-game mode" (gnubg-equivalent play, no team/career features) or "career mode" (full context). Both players' agents must agree on mode at deposit time. Recorded in the match record so reviewers can replay either way.
- **Single-game mode is the verifiable baseline.** Reviewers and opponents can check "did this agent play near-gnubg-optimally in single-game mode?" by replaying with the gnubg evaluator. That gives you a ground-truth strength check.
- **Career mode is where the protocol gets interesting.** This is where matchmaking choice, teammate selection, and ELO-pressure-aware play live. The "open protocol with portable reputation" thesis really only shines in this mode.

**Subtle implication for cheating detection.** In single-game mode, "did agent X play gnubg-optimally?" is checkable. Large deviations are suspicious. In career mode, deviations are _expected_ (the agent is optimizing differently), so the same check isn't valid. The protocol probably wants to mark single-game-mode matches as "verifiable strength" and career-mode as "verifiable provenance only." Different trust labels, both honest.

**For training-data needs:**

- Single-game head: gnubg pretraining is probably the optimal benchmark.
- Long-game head: needs _team-mode and tournament-mode match records_ in the corpus, which only accumulate as the protocol gets used. Bootstrapping problem early on. Acceptable for v1 — career mode improves as the network matures.

# **Specifications**

1.  **gnubg:**

- Not necessary for evaluation because it requires a server and it’s too hard for a browser to do WASP without reengineering, so it’s better to do NN from scratch. That can be evaluated and trained locally or 0G storage.  
  one shared gnubg endpoint in the cloud causes liveliness problem. In-browser move evaluations ran into WASM limitations without reegnineering. solution:
- Extract gnubg's neural-net weights from the gnubg source distribution (the `weights` and `gnubg.weights` files).  
  Convert to a modern format — TF.js, ONNX, or a hand-rolled JS/WASM forward pass. gnubg's net is small enough (a few hundred neurons, single hidden layer for the contact net) that any of these work in the browser.
- Replicate gnubg's input encoding exactly — the weights are tied to a specific feature encoding of the board (point counts, pip counts, bearoff status, etc.). This is the only fiddly part.
- Ship as the public starter NN that every new agent forks from.
- gnubg's full strength includes precomputed exact endgame solutions (bearoff DB, hundreds of MB). The NN alone plays weaker endgames. Workable — most of a backgammon game isn't endgame — but worth knowing.
- You need to match gnubg's input encoding exactly or the weights are garbage. There are several open implementations to crib from (e.g. py-gnubg ports), so this is annoying-not-hard.

2. **0G storage**:  
   Necessary for the match history for settlement, verification and learning.  
   Also possible to run coach for agent human collaboration.

3. **0G compute**:  
   Training and evaluation can be done locally, but 0G compute is necessary to have agents  
   play while owners are offline.  
   TEE attestation, which matters most exactly when no human is watching to catch cheating.

4. **0G network/iNFT/agents:**  
   ERC-7857 iNFT standard for agents with pointer to 0G storage.  
   however it doesn’t work with keeperhub (or ENS) so we use sepolia and 0G storage/compute HTTP endpoints.  
   An agent with strong ELO is a _valuable asset_. Sell it on a marketplace and the buyer gets the trained weights _and_ the reputation history. Owning the agent gives you control over its _brain, not over how matches are adjudicated._

5. **Keeperhub:**  
   Necessary for orchestration and audit, otherwise we need a server.  
   KeeperHub for orchestration \+ audit. keeperhub schedules the game, escrows the gas/prize money, provides VRF through _drand_, and checks/settles the game using the 0G storage audit trail and **In a WASM rules module (after game, in browser during the game),** and updates the ENS ELO/weights  
   Architecturally, this is what KeeperHub orchestrates:  
   1\. Matchmaker pairs agentA ↔ agentB (both opted into autonomous play)  
   2\. KeeperHub workflow opens the match:  
    \- Verifies both deposits in MatchEscrow  
    \- Pulls drand round R  
   3\. Per turn:  
    \- KeeperHub calls 0G Compute with (boardState, weightsURI for active agent)  
    \- 0G Compute returns move \+ TEE attestation sig  
    \- KeeperHub validates move via rules engine  
    \- Appends to 0G Storage match record  
    \- Pulls drand round R+1
6. Game-end: KeeperHub signs settlement payload, broadcasts to Sepolia
7. Audit JSON appended to 0G Storage
8. **ENS** is necessary for  
   user experience names of humans and agents  
   storing public ELO and style profile  
   discovery of opponents

Decentralization is achieved without any custom relay layer — plain HTTP between the browser and local agent processes is enough.

gnubg wasm is too hard. train a NN on agent birth, start with gnubg weights.  
since keeperhub doesn’t support 0G:  
Settlement contracts on Sepolia (KeeperHub-native).  
0G Storage for match archive \+ agent weights.  
0G Compute for the coach LLM (TEE-attested).  
KeeperHub for orchestration \+ audit. keeperhub schedules the game, escrows the gas/prize money, provides VRF through _drand_, and checks/settles the game using the 0G storage audit trail and **In a WASM rules module (after game, in browser during the game),** and updates the ENS ELO/weights  
ENS subnames on real Sepolia ENS.  
agent move evaluation: in 0G compute or browser.  
coach: depends of setting:  
default: browser for small flan-t5-base model,  
select into 0G compute for big model.  
without gnubg C overhead, 0G compute can be used for training the ML of the agent.  
advantages  
Trustless gameplay (rules in browser \+ contract).  
Permissionless agent strength (every owner trains/hosts their own).  
0G Storage holds the substrate (weights \+ match archive).  
0G Compute optionally hosts inference (sponsor double-dip).  
KeeperHub orchestrates settlement and audit.  
ENS carries portable reputation, but game history auditable from 0G storage.  
No central server, no relay, no gnubg dependency at all.  
move to Base/Optimism for real economics; design is identical, just a chain swap.  
**0G Storage** is HTTP-accessed via its indexer so it’s ok to use sepolia, to get ENS & keeperhub.

**For the hackathon demo:** train locally (it's trivial), use 0G Compute for inference attestation. Cleanest path, no SDK uncertainty.  
**If 0G Compute does support attested fine-tuning:** add a single "retrain overlay on 0G Compute" command as a stretch goal. The attestation makes it substantive rather than decorative — it's the difference between "we used 0G for training" and "every weight update is provably from refereed match data."  
Either way, weights end up on 0G Storage and inference happens on 0G Compute. Where the gradient steps run is a small detail compared to those two anchors.

## specifications summary

**So your final stack is genuinely multi-sponsor and clean:**

- **Sepolia** — settlement contracts (`MatchEscrow`, `MatchRegistry`, `AgentRegistry`), real ENS subnames, KeeperHub-native triggers and broadcasts.
- **0G Storage** — match records (Log), style profiles (KV), encrypted agent weights (Blob, hash-committed to iNFT).
- **0G Compute** — agent NN move-eval inference (TEE-attested), coach LLM inference.
- **KeeperHub** — orchestration, drand-sourced VRF, rules-engine validation, signed settlement, audit trail.
- **drand** — third-party dice randomness.
- **ENS (real)** — portable reputation via subname text records.

Six sponsors/protocols, each doing the thing it's actually best at, no glue layers, no custom relay, no bridge.

# frontend

# Game(s) selector page

can we have a frontend page to choose two players or two groups for a game or series of games? and the option to play it. if it's all agents, use the existing fast forward feature to pay through. if it's a human or two, have a game start button

Yes, this is a clean addition and most of the pieces already exist. Sketch:

**Route: `/play/new`** (or just `/play`).

- **Side A picker** — list/grid of agents (from `AgentRegistry`) and humans (recent connected wallets, ENS subnames). Multi-select for team mode.
- **Side B picker** — same.
- **Match config** — single game vs series (match length 1/3/5/7), stake amount, mode (single-game vs career — the toggle from the previous answer), forfeit timeout.
- **"Start" button** with adaptive label/behavior:
  - **All-agent (no humans on either side)** → label is "Auto-play match" and clicking dispatches to the existing match page in fast-forward mode. KeeperHub workflow drives the loop end-to-end; UI just renders the playback.
  - **At least one human** → label is "Open match" and clicking opens the match page in interactive mode. Other side(s) wait at a "ready" screen until everyone confirms; then play proceeds turn-by-turn with the existing UI.

**What to reuse vs. build:**

- **Reuse:** `AgentsList` (already on the home page), `useChainContracts()` for reading `AgentRegistry`, ENS resolution helpers for human wallets, the existing match page's fast-forward path for autoplay, `MatchEscrow.deposit` flow once it lands.
- **Build new:** the picker UI, team grouping component, the "ready check" intermediate screen for human-involved matches, the `/play/new` route and a sidebar entry, a small piece of state to remember which side(s) are human and gate the autoplay decision.

**Coupling to the rest of the architecture:**

- **Escrow.** Page can't actually start until each side has deposited. Show per-participant deposit status. For all-agent matches, the agent owner deposits on behalf of their iNFT; for human side, the human deposits from their wallet. KeeperHub workflow won't trigger until both sides are funded.
- **Mode detection drives more than UX.** All-agent matches likely default to **career-mode** (because the whole point of autonomous play is long-horizon optimization), human-involved matches default to **single-game** (most humans want a clean one-off). Both should be overridable.
- **Series matches.** A "best of N" or "first to N points" series is just a sequence of single-match settlements with a wrapping `SeriesEscrow` — same primitive applied repeatedly. Worth deciding whether to build the wrapper now or implement series as N independent matches with the same participants.
- **Fast-forward for autoplay.** The KeeperHub workflow drives moves at drand pace (one round per \~3s), but the _replay rendering_ in the UI can be sped up freely. So "fast-forward" becomes a frontend playback rate, not a workflow speed. Two players watching different timelines of the same match is fine — the canonical record is on 0G Storage.

**One UX wrinkle to think about up front:** what happens when a human picker selects a human opponent who's offline? You either need a notification/invite system (out of scope for hackathon) or restrict human-vs-human to "both currently connected to the page." All-agent matches sidestep this entirely — they always work because both agents are autonomous. So a pragmatic v1 launch order is: all-agent autoplay first (most magical demo, fully autonomous, no scheduling problem), human-vs-agent next, human-vs-human last.

Solution: **0G Storage KV — effectively free**

# Policy

Claude code does single issue reasonably sized incremental commits without user approval in branch final-sprint

To the extent possible, localhost should be made usable for hardhat addresses with ETH, with mock contracts.

hardhat config should store chain specific parameters to make new chains easy to plug in.
