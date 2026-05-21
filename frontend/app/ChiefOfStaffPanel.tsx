// AgentTeammatePanel — Phase 76: DeepMind-inspired Agent Teammate UI.
//
// Dynamic chat panel beneath the game board where the LLM acts as an
// Agent Teammate that negotiates move trade-offs with the human in
// real-time. The human dictates macro-strategy; the AI selects the specific
// tagged move that best fits it.
//
// Move evaluation runs fully client-side via the ONNX BackgammonNet
// (onnx_eval.ts) + heuristic move tagger (move_tagger.ts). No gnubg
// subprocess or network call to port 8001 required.
//
// Props:
//   positionId, matchId, dice  — current board state (feed from match state)
//   board, bar, off            — full board state for ONNX evaluation
//   turn                       — who is on roll (0 = human, 1 = agent)
//   opponentId                 — used to surface opponent features
//   onMoveSelect               — called with the LLM-recommended move string
//   disabled                   — true when it's the agent's turn or game over

"use client";

import { useEffect, useRef, useState } from "react";
import { evaluateMoves } from "../lib/onnx_eval";
import { generateLegalMoves } from "../lib/rules_engine";
import { tagCandidates } from "../lib/move_tagger";

// ── Types ──────────────────────────────────────────────────────────────────

export interface TaggedCandidate {
  move: string;
  equity: number;
  tag: "Safe" | "Aggressive" | "Priming" | "Anchor" | "Blitz";
  tag_reason: string;
}

interface TeammateMessage {
  role: "human" | "agent";
  text: string;
}

interface TeammateResponse {
  reply: string;
  recommended_move: string | null;
  recommended_tag: string | null;
  deep_dive: string | null;
  backend: string;
  latency_ms: number;
}

interface Props {
  positionId: string;
  matchId: string;
  dice: [number, number] | null;
  board?: number[];
  bar?: [number, number];
  off?: [number, number];
  turn?: 0 | 1;
  opponentId?: number;
  onMoveSelect?: (move: string) => void;
  onMoveHover?: (move: string | null) => void;
  disabled?: boolean;
  /** When true, skip the LLM entirely — show ONNX-ranked moves only. */
  noLLM?: boolean;
}

// ── Tag colour palette — mapped to CG semantic tokens ─────────────────────
// One accent color per tag; all use CG-approved values from the design system.

const TAG_COLORS: Record<string, { bg: string; text: string; border: string }> = {
  Safe:       { bg: "rgba(125,155,74,0.12)",  text: "#7D9B4A", border: "rgba(125,155,74,0.35)" },
  Aggressive: { bg: "rgba(208,138,60,0.12)",  text: "#D08A3C", border: "rgba(208,138,60,0.35)" },
  Priming:    { bg: "rgba(232,192,126,0.12)",  text: "#F4D49A", border: "rgba(232,192,126,0.35)" },
  Anchor:     { bg: "rgba(107,138,166,0.12)", text: "#6B8AA6", border: "rgba(107,138,166,0.35)" },
  Blitz:      { bg: "rgba(192,74,59,0.12)",   text: "#C04A3B", border: "rgba(192,74,59,0.35)" },
};

function TagBadge({ tag }: { tag: string }) {
  const c = TAG_COLORS[tag] ?? TAG_COLORS.Safe;
  return (
    <span
      style={{
        display: "inline-block",
        borderRadius: "var(--cg-radius-sm)",
        padding: "1px 6px",
        fontSize: 9,
        fontWeight: 600,
        letterSpacing: "0.1em",
        textTransform: "uppercase",
        background: c.bg,
        color: c.text,
        border: `1px solid ${c.border}`,
      }}
    >
      {tag}
    </span>
  );
}

// ── Main component ─────────────────────────────────────────────────────────

export function AgentTeammatePanel({
  positionId,
  matchId,
  dice,
  board,
  bar,
  off,
  turn = 0,
  opponentId,
  onMoveSelect,
  onMoveHover,
  disabled = false,
  noLLM = false,
}: Props) {
  const [taggedCandidates, setTaggedCandidates] = useState<TaggedCandidate[]>([]);
  const [loadingCandidates, setLoadingCandidates] = useState(false);
  const [candidatesRanked, setCandidatesRanked] = useState(false);

  const [dialogue, setDialogue] = useState<TeammateMessage[]>([]);
  const [strategyInput, setStrategyInput] = useState("");
  const [sending, setSending] = useState(false);

  const [lastResponse, setLastResponse] = useState<TeammateResponse | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  // ── Step 1: Evaluate candidates with ONNX BackgammonNet ──────────────

  useEffect(() => {
    if (disabled || !dice || !board) return;
    setTaggedCandidates([]);
    setCandidatesRanked(false);
    setLastResponse(null);
    setDialogue([]);
    setLoadingCandidates(true);

    const gameBoard = {
      points: board,
      bar: bar ?? ([0, 0] as [number, number]),
      off: off ?? ([0, 0] as [number, number]),
    };

    let cancelled = false;
    void (async () => {
      try {
        const candidates = await evaluateMoves(gameBoard, turn, dice);
        if (cancelled) return;
        const tagged = tagCandidates(candidates, board, 10) as TaggedCandidate[];
        setTaggedCandidates(tagged);
        setCandidatesRanked(true);
      } catch {
        if (cancelled) return;
        try {
          const moves = generateLegalMoves(gameBoard, turn, dice);
          const unranked = moves.map((m, i) => ({ move: m, equity: -i * 0.0001 }));
          const tagged = tagCandidates(unranked, board, 10) as TaggedCandidate[];
          setTaggedCandidates(tagged);
          setCandidatesRanked(false);
        } catch {
          // rules engine also unavailable — panel stays empty
        }
      } finally {
        if (!cancelled) setLoadingCandidates(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [disabled, positionId, matchId, dice?.[0], dice?.[1]]);

  const autoSentRef = useRef<string>("");
  useEffect(() => {
    if (noLLM || disabled || !dice || taggedCandidates.length === 0) return;
    const key = `${positionId}-${dice[0]}-${dice[1]}`;
    if (autoSentRef.current === key) return;
    autoSentRef.current = key;
    void sendStrategy("What's the best move here?");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noLLM, disabled, positionId, dice?.[0], dice?.[1], taggedCandidates.length]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [dialogue, lastResponse]);

  // ── Step 2: Send strategy to Agent Teammate ──────────────────────────

  const sendStrategy = async (text: string) => {
    if (!text.trim() || sending) return;

    const userMsg: TeammateMessage = { role: "human", text: text.trim() };
    const newDialogue = [...dialogue, userMsg];
    setDialogue(newDialogue);
    setStrategyInput("");
    setSending(true);
    setLastResponse(null);

    try {
      const opponentFeatures =
        opponentId != null ? `Agent #${opponentId} in play` : undefined;

      const res = await fetch("/api/agent-teammate/chat/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tagged_candidates: taggedCandidates,
          human_strategy: text.trim(),
          dialogue: newDialogue.map((m) => ({ role: m.role, text: m.text })),
          opponent_features: opponentFeatures ?? null,
          agent_id: opponentId ?? null,
          turn_index: 0,
          backend: "compute",
        }),
      });
      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        throw new Error(errorData.error || `${res.status}`);
      }
      const data = (await res.json()) as TeammateResponse;

      setLastResponse(data);
      setDialogue([...newDialogue, { role: "agent", text: data.reply }]);

      if (data.recommended_move && onMoveSelect) {
        onMoveSelect(data.recommended_move);
      }
    } catch (e: any) {
      setDialogue([
        ...newDialogue,
        {
          role: "agent",
          text: `Agent teammate encountered an error: ${e.message}. Ensure your wallet has OG balance and your 0G connection is stable.`,
        },
      ]);
    } finally {
      setSending(false);
    }
  };

  const handleSend = () => void sendStrategy(strategyInput);

  const QUICK_ACTIONS = [
    "Play safe",
    "Be aggressive",
    "Validate my intuition",
    "Build a prime",
  ];

  // ── Render ─────────────────────────────────────────────────────────────

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        background: "var(--cg-bg-2)",
      }}
    >
      {/* Header */}
      <div
        style={{
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          borderBottom: "1px solid var(--cg-line-1)",
          padding: "8px 16px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span
            style={{
              fontSize: 10,
              fontWeight: 600,
              letterSpacing: "0.12em",
              textTransform: "uppercase",
              color: "var(--cg-brass)",
              fontFamily: "var(--cg-font-sans)",
            }}
          >
            {noLLM ? "Move advisor" : "Agent teammate"}
          </span>
          <span style={{ fontSize: 10, color: "var(--cg-fg-4)" }}>
            {noLLM ? "· ONNX-ranked moves" : "· AI micro-tactics"}
          </span>
        </div>
      </div>

      {/* Pinned candidates row */}
      {(loadingCandidates || taggedCandidates.length > 0) && (
        <div
          style={{
            flexShrink: 0,
            borderBottom: "1px solid var(--cg-line-1)",
            padding: "10px 16px",
          }}
        >
          {loadingCandidates && (
            <p
              style={{
                fontSize: 12,
                color: "var(--cg-fg-3)",
                fontFamily: "var(--cg-font-sans)",
              }}
              className="animate-pulse"
            >
              Evaluating moves…
            </p>
          )}
          {taggedCandidates.length > 0 && (
            <>
              <p
                style={{
                  marginBottom: 8,
                  fontSize: 10,
                  fontWeight: 600,
                  letterSpacing: "0.12em",
                  textTransform: "uppercase",
                  color: "var(--cg-fg-4)",
                }}
              >
                {candidatesRanked ? "Top moves this turn" : "Legal moves this turn"}
              </p>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {taggedCandidates.map((c, i) => {
                  const isRecommended = lastResponse?.recommended_move === c.move;
                  const col = TAG_COLORS[c.tag] ?? TAG_COLORS.Safe;
                  return (
                    <button
                      key={i}
                      type="button"
                      disabled={disabled}
                      onClick={() => onMoveSelect?.(c.move)}
                      onMouseEnter={() => onMoveHover?.(c.move)}
                      onMouseLeave={() => onMoveHover?.(null)}
                      title={c.tag_reason}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                        borderRadius: "var(--cg-radius)",
                        border: isRecommended
                          ? "1px solid var(--cg-brass)"
                          : `1px solid var(--cg-line-2)`,
                        background: isRecommended ? "rgba(201,155,92,0.10)" : "var(--cg-bg-3)",
                        padding: "5px 10px",
                        fontFamily: "var(--cg-font-mono)",
                        fontSize: 12,
                        color: "var(--cg-fg-1)",
                        cursor: disabled ? "not-allowed" : "pointer",
                        opacity: disabled ? 0.5 : 1,
                        boxShadow: isRecommended ? "var(--cg-glow-brass)" : "none",
                        transition: "border-color 120ms, background 120ms",
                      }}
                    >
                      <TagBadge tag={c.tag} />
                      <span>{c.move}</span>
                      {candidatesRanked && (
                        <span style={{ fontSize: 10, color: "var(--cg-fg-3)" }}>
                          {c.equity >= 0 ? "+" : ""}
                          {c.equity.toFixed(3)}
                        </span>
                      )}
                      {isRecommended && (
                        <span style={{ fontSize: 10, fontWeight: 600, color: "var(--cg-brass-hi)" }}>
                          ✓
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </>
          )}
        </div>
      )}

      {/* Scrollable conversation — hidden in noLLM mode */}
      <div
        style={{
          flex: 1,
          display: noLLM ? "none" : "flex",
          flexDirection: "column",
          gap: 12,
          overflowY: "auto",
          padding: 16,
          minHeight: 0,
        }}
      >
        {/* Deep-dive panel */}
        {lastResponse?.deep_dive && (
          <div
            style={{
              borderRadius: "var(--cg-radius)",
              border: "1px solid rgba(208,138,60,0.30)",
              background: "rgba(208,138,60,0.08)",
              padding: "8px 12px",
              fontSize: 12,
              color: "var(--cg-warn)",
            }}
          >
            <span style={{ fontWeight: 600, marginRight: 6 }}>Historical analysis</span>
            {lastResponse.deep_dive}
          </div>
        )}

        {/* Conversation history */}
        {dialogue.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8, paddingRight: 4 }}>
            {dialogue.map((msg, i) => (
              <div
                key={i}
                style={{
                  display: "flex",
                  justifyContent: msg.role === "human" ? "flex-end" : "flex-start",
                }}
              >
                <div
                  style={{
                    maxWidth: "80%",
                    borderRadius: "var(--cg-radius)",
                    padding: "6px 12px",
                    fontSize: 12,
                    lineHeight: 1.5,
                    background: msg.role === "human" ? "var(--cg-brass)" : "var(--cg-bg-3)",
                    color: msg.role === "human" ? "var(--cg-brass-ink)" : "var(--cg-fg-2)",
                    border: msg.role === "human" ? "none" : "1px solid var(--cg-line-2)",
                    boxShadow: "var(--cg-shadow-1)",
                  }}
                >
                  {msg.text}
                </div>
              </div>
            ))}
            <div ref={bottomRef} />
          </div>
        )}

        {/* Quick-action chips */}
        {!disabled && dialogue.length === 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {QUICK_ACTIONS.map((action) => (
              <button
                key={action}
                type="button"
                onClick={() => void sendStrategy(action)}
                style={{
                  borderRadius: "var(--cg-radius-pill)",
                  border: "1px solid var(--cg-line-2)",
                  background: "var(--cg-bg-3)",
                  padding: "3px 10px",
                  fontSize: 11,
                  color: "var(--cg-fg-2)",
                  cursor: "pointer",
                  transition: "border-color 120ms, background 120ms",
                }}
              >
                {action}
              </button>
            ))}
          </div>
        )}

        {sending && (
          <p
            style={{ fontSize: 12, color: "var(--cg-fg-3)", fontFamily: "var(--cg-font-sans)" }}
            className="animate-pulse"
          >
            Agent teammate is thinking…
          </p>
        )}
      </div>

      {/* Strategy input — hidden in noLLM mode */}
      <div
        style={{
          flexShrink: 0,
          display: noLLM ? "none" : "flex",
          gap: 8,
          borderTop: "1px solid var(--cg-line-1)",
          padding: "10px 16px",
        }}
      >
        <input
          ref={inputRef}
          value={strategyInput}
          onChange={(e) => setStrategyInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleSend()}
          placeholder={
            disabled
              ? "Waiting for your turn…"
              : "Tell me your strategy…"
          }
          disabled={disabled || sending}
          style={{
            flex: 1,
            borderRadius: "var(--cg-radius-sm)",
            border: "1px solid var(--cg-line-2)",
            background: "var(--cg-bg-1)",
            color: "var(--cg-fg-1)",
            fontFamily: "var(--cg-font-sans)",
            fontSize: 12,
            padding: "6px 12px",
            outline: "none",
          }}
        />
        <button
          type="button"
          onClick={handleSend}
          disabled={disabled || !strategyInput.trim() || sending}
          style={{
            borderRadius: "var(--cg-radius-sm)",
            background: "var(--cg-brass)",
            color: "var(--cg-brass-ink)",
            padding: "6px 12px",
            fontSize: 12,
            fontWeight: 600,
            cursor: "pointer",
            transition: "background 120ms",
          }}
          className="disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {sending ? "…" : "Ask"}
        </button>
      </div>
    </div>
  );
}
