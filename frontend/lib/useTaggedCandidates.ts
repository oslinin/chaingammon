// Page-owned hook that runs the gnubg ONNX evaluator once per (position, dice)
// and tags the results. Replaces the eval effect that used to live inside
// AgentTeammatePanel so the panel and the landscape MoveCycler can share one
// ranked list without doubling ONNX work.
//
// The ONNX model is warmed up at app startup (providers.tsx → warmupOnnx)
// and is the only evaluator — no legal-moves fallback. If evaluateMoves
// rejects, we log and leave candidates empty.

import { useEffect, useState } from "react";
import { evaluateMoves } from "./onnx_eval";
import { tagCandidates } from "./move_tagger";
import type { MoveTag } from "./move_tags";

export interface TaggedCandidate {
  move: string;
  equity: number;
  tag: MoveTag;
  tag_reason: string;
}

interface UseTaggedCandidatesArgs {
  board?: number[];
  bar?: [number, number];
  off?: [number, number];
  turn?: 0 | 1;
  dice: [number, number] | null;
  /** Stable key that changes on every ply (e.g. game.position_id). */
  positionId: string;
  /** True when it isn't the human's turn or the game is over. */
  disabled: boolean;
}

interface UseTaggedCandidatesResult {
  candidates: TaggedCandidate[];
  loading: boolean;
}

interface FetchedState {
  positionId: string;
  d0: number;
  d1: number;
  candidates: TaggedCandidate[];
}

export function useTaggedCandidates({
  board,
  bar,
  off,
  turn,
  dice,
  positionId,
  disabled,
}: UseTaggedCandidatesArgs): UseTaggedCandidatesResult {
  const [fetched, setFetched] = useState<FetchedState | null>(null);

  useEffect(() => {
    if (disabled || !dice || !board) return;
    const gameBoard = {
      points: board,
      bar: (bar ?? [0, 0]) as [number, number],
      off: (off ?? [0, 0]) as [number, number],
    };
    const myPos = positionId;
    const myD0 = dice[0];
    const myD1 = dice[1];
    let cancelled = false;
    void (async () => {
      try {
        const raw = await evaluateMoves(gameBoard, turn ?? 0, dice);
        if (cancelled) return;
        const tagged = tagCandidates(raw, board, 10) as TaggedCandidate[];
        setFetched({ positionId: myPos, d0: myD0, d1: myD1, candidates: tagged });
      } catch (err) {
        if (cancelled) return;
        // ONNX is expected to be available; surface failures in console
        // rather than silently fabricating a list.
        console.error("useTaggedCandidates: evaluateMoves failed", err);
        setFetched({ positionId: myPos, d0: myD0, d1: myD1, candidates: [] });
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [disabled, positionId, dice?.[0], dice?.[1]]);

  // Derive exposed state from the fetched snapshot — only expose candidates
  // that match the *current* position/dice, so the previous ply's list never
  // leaks into the next ply's first render (the effect re-fires but the
  // async fetch takes a beat to land).
  const fresh =
    !disabled &&
    fetched !== null &&
    fetched.positionId === positionId &&
    !!dice &&
    fetched.d0 === dice[0] &&
    fetched.d1 === dice[1];
  return {
    candidates: fresh ? fetched!.candidates : [],
    loading: !disabled && !!dice && !fresh,
  };
}
