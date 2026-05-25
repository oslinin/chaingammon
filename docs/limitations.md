# Chaingammon — Known Limitations

This document tracks limitations of the current system. Each entry includes the status and whether the architecture can address it or whether it requires a genuine design change.

---

## Player Flywheel

These were originally documented as limitations of the early 6-axis overlay. They are reproduced here with current status.

### 1. Static overlay is a lossy summary of state-dependent human behaviour

**Status: Not a limitation.**

The overlay (18-float exposure-EMA) is static, but agents consume `(board_features, style_overlay)` jointly. The network learns to weight style signals differently depending on board context — e.g. "this blitz-preferring human is dangerous from mid-game positions but overextended here." State-dependence lives in the network weights, not in the overlay itself.

### 2. Style preference, not error/skill structure

**Status: Not a limitation.**

The 18 axes describe what moves a player makes (opening_slot, split, blitz, race, etc.), not where they lose equity. However, an agent trained on `(board, opponent_style)` pairs implicitly learns which style choices are costly in which positions. A custom agent (Python or sklearn) can make this explicit — e.g. a model that explicitly evaluates equity loss correlated with specific style axes.

### 3. No human policy clone learned from real games

**Status: Not a limitation of the architecture; not yet implemented as a default agent.**

A faithful replica of a specific human's decision-making — trained by behavioural cloning on their move history — is not shipped as a default agent. However, the architecture supports it: the style overlay provides the conditioning signal, and a custom agent model (via the `evaluate()` or sklearn interface) could train a move predictor from that signal. Nothing prevents minting an agent whose model is a policy clone of a specific human profile.

---

## Training

### 4. Round-robin training uses 1-ply search by default

**Status: Configurable, not fixed.**

The default training loop uses greedy 1-ply move selection. `search_depth=2` enables 2-ply expectiminimax (all 21 opponent dice combos), which produces stronger TD bootstrap targets at ~21× compute cost per agent turn. Set per-agent via the `search_depths` field on the training start request.

### 5. sklearn agents are static during a training epoch

**Status: By design.**

sklearn models are re-fitted once per epoch on accumulated game data. They cannot do online gradient updates (not differentiable). They play as frozen opponents during each game; improvement is epoch-grained, not step-grained.

---

## Overlay

### 6. Human overlay populated only after on-chain settlement

**Status: By design.**

Human style overlays are updated at finalize/settle time, not in real time during a game. Mid-game style inference is not available.

### 7. Overlay does not track long-run style drift

**Status: Known gap.**

The EMA damping factor (`damping_n = 20`) weights recent matches heavily for cold-start agents but gives diminishing weight to early history as match count grows. A player whose style changes significantly over time will have an overlay that lags. No mechanism currently detects or compensates for style drift.
