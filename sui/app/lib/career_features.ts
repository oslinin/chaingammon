/**
 * Browser port of agent/career_features.py's 40-d "extras" layout.
 *
 * Builds the style half of the uniform agent input — the second part of the
 * `features = [board(198) ‖ style(40)]` vector that every per-agent ONNX model
 * (MLP or sklearn forest) now consumes. Must stay byte-compatible with
 * career_features.encode_career_context(dim=40); see that file for the layout.
 */

export const STYLE_DIM = 40;

// Mirrors career_features.ALL_CATEGORIES — order is significant and must match.
export const ALL_CATEGORIES: readonly string[] = [
  "opening_slot",
  "opening_split",
  "opening_builder",
  "opening_anchor",
  "build_5_point",
  "build_bar_point",
  "bearoff_efficient",
  "bearoff_safe",
  "risk_hit_exposure",
  "risk_blot_leaving",
  "hits_blot",
  "runs_back_checker",
  "anchors_back",
  "phase_prime_building",
  "phase_race_conversion",
  "phase_back_game",
  "phase_holding_game",
  "phase_blitz",
  "cube_offer_aggressive",
  "cube_take_aggressive",
];

// The 18 non-cube axes used in the 40-d layout (ALL_CATEGORIES[:18]).
export const ACTIVE_AXES: readonly string[] = ALL_CATEGORIES.slice(0, 18);

const STAKE_LOG_DIVISOR = 70.0;

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function project(style: Record<string, number> | null | undefined): number[] {
  if (!style) return new Array(ACTIVE_AXES.length).fill(0);
  return ACTIVE_AXES.map((ax) => clamp(Number(style[ax] ?? 0), -1, 1));
}

export interface StyleContext {
  stakeWei?: number;
  tournamentPosition?: number;
  isTeamMatch?: boolean;
}

/**
 * Encode the 40-d style vector: [self(18) | opponent(18) | stake | tourney |
 * team | bias]. Neutral (all-zero style + bias=1) when called with no args,
 * which is a valid input that lets any board+style model run.
 */
export function encodeStyleVector(
  selfStyle?: Record<string, number> | null,
  opponentStyle?: Record<string, number> | null,
  ctx: StyleContext = {},
): Float32Array {
  const out = new Float32Array(STYLE_DIM);
  const self = project(selfStyle);
  const opp = project(opponentStyle);
  for (let i = 0; i < 18; i++) out[i] = self[i];
  for (let i = 0; i < 18; i++) out[18 + i] = opp[i];
  const stake = Math.max(0, ctx.stakeWei ?? 0);
  out[36] = Math.min(Math.log1p(stake) / STAKE_LOG_DIVISOR, 1.0);
  out[37] = clamp(ctx.tournamentPosition ?? 0, -1, 1);
  out[38] = ctx.isTeamMatch ? 1.0 : 0.0;
  out[39] = 1.0; // bias channel
  return out;
}
