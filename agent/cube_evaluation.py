def evaluate_cube_action(
    equity: float,
    match_length: int,
    p0_score: int,
    p1_score: int,
    current_cube: int,
    cube_owner: int,
    is_agent_turn: bool
) -> str:
    """
    Given the win equity (from the agent's perspective), determine the mathematically correct
    doubling cube action.
    """
    # For a money game MVP (match_length=0), the theoretical drop point is ~25% equity (i.e. -0.5 on a -1 to 1 scale)
    # The double point is when equity is roughly > 75% (+0.5 on scale)
    # If the score is an equity from 0 to 1, then:
    # Drop Point = 0.25
    # Double Point = 0.75

    # Assuming equity is [0, 1] probability of winning:
    if is_agent_turn:
        # Agent has the dice. Can they double?
        if cube_owner in [-1, 1]:
            if equity > 0.75:
                return "offer"
    else:
        # It's the opponent's turn. Did they offer a double?
        if equity < 0.25:
            return "drop"
        else:
            return "take"

    return "none"
