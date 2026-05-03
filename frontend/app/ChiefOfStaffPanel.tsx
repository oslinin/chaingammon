// ChiefOfStaffPanel.tsx — Phase 76: DeepMind-inspired Chief of Staff UI.
//
// Dynamic chat panel beneath the game board where the LLM acts as a
// "Chief of Staff" that negotiates move trade-offs with the human in
// real-time. The human dictates macro-strategy; the AI selects the specific
// tagged move that best fits it.
//
// Layout:
//   1. Tagged candidates row (top-5 with colour-coded strategy tags)
//   2. LLM recommendation bubble (highlights the selected move)
//   3. Deep-dive badge (shown when the LLM ran a mocked historical search)
//   4. Human strategy input + Send button
//   5. Conversation history (last 8 messages)
//
// Props:
//   positionId, matchId, dice  — current board state (feed from match state)
//   board                      — board array for more accurate hit detection
//   agentId                    — used to surface opponent features
//   onMoveSelect               — called with the LLM-recommended move string
//                                so the match page can pre-fill the move input
//   disabled                   — true when it's the agent's turn or game over

"use client";

import { useEffect, useRef, useState } from "react";

const GNUBG = process.env.NEXT_PUBLIC_GNUBG_URL ?? "http://localhost:8001";

// ── Types ──────────────────────────────────────────────────────────────────

export interface TaggedCandidate {
  move: string;
  equity: number;
  tag: "Safe" | "Aggressive" | "Priming" | "Anchor" | "Blitz";
  tag_reason: string;
}

interface ChiefOfStaffMessage {
  role: "human" | "agent";
  text: string;
}

interface ChiefOfStaffResponse {
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
  opponentId?: number;
  onMoveSelect?: (move: string) => void;
  disabled?: boolean;
}

// ── Tag colour palette ─────────────────────────────────────────────────────

const TAG_STYLES: Record<string, { bg: string; text: string; border: string }> = {
  Safe: {
    bg: "bg-emerald-50 dark:bg-emerald-900/20",
    text: "text-emerald-800 dark:text-emerald-300",
    border: "border-emerald-300 dark:border-emerald-700/60",
  },
  Aggressive: {
    bg: "bg-orange-50 dark:bg-orange-900/20",
    text: "text-orange-800 dark:text-orange-300",
    border: "border-orange-300 dark:border-orange-700/60",
  },
  Priming: {
    bg: "bg-violet-50 dark:bg-violet-900/20",
    text: "text-violet-800 dark:text-violet-300",
    border: "border-violet-300 dark:border-violet-700/60",
  },
  Anchor: {
    bg: "bg-blue-50 dark:bg-blue-900/20",
    text: "text-blue-800 dark:text-blue-300",
    border: "border-blue-300 dark:border-blue-700/60",
  },
  Blitz: {
    bg: "bg-red-50 dark:bg-red-900/20",
    text: "text-red-800 dark:text-red-300",
    border: "border-red-300 dark:border-red-700/60",
  },
};

function TagBadge({ tag }: { tag: string }) {
  const s = TAG_STYLES[tag] ?? TAG_STYLES.Safe;
  return (
    <span
      className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide border ${s.bg} ${s.text} ${s.border}`}
    >
      {tag}
    </span>
  );
}

// ── Main component ─────────────────────────────────────────────────────────

export function ChiefOfStaffPanel({
  positionId,
  matchId,
  dice,
  board,
  opponentId,
  onMoveSelect,
  disabled = false,
}: Props) {
  const [taggedCandidates, setTaggedCandidates] = useState<TaggedCandidate[]>([]);
  const [loadingCandidates, setLoadingCandidates] = useState(false);

  const [dialogue, setDialogue] = useState<ChiefOfStaffMessage[]>([]);
  const [strategyInput, setStrategyInput] = useState("");
  const [sending, setSending] = useState(false);

  // Last Chief-of-Staff response for the recommendation highlight + deep-dive.
  const [lastResponse, setLastResponse] = useState<ChiefOfStaffResponse | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  // ── Step 1: Fetch tagged candidates whenever dice change ──────────────

  useEffect(() => {
    if (!dice || !positionId || !matchId) return;
    setTaggedCandidates([]);
    setLastResponse(null);
    setLoadingCandidates(true);

    const controller = new AbortController();
    void (async () => {
      try {
        const res = await fetch(`${GNUBG}/evaluate-tagged`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            position_id: positionId,
            match_id: matchId,
            dice,
            board: board ?? null,
            top_n: 5,
          }),
          signal: controller.signal,
        });
        if (!res.ok) return;
        const data = (await res.json()) as { tagged_candidates: TaggedCandidate[] };
        setTaggedCandidates(data.tagged_candidates ?? []);
      } catch {
        // gnubg offline — panel shows nothing but doesn't block the game.
      } finally {
        setLoadingCandidates(false);
      }
    })();
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [positionId, matchId, dice?.[0], dice?.[1]]);

  // Scroll to latest message whenever dialogue grows.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [dialogue, lastResponse]);

  // ── Step 2: Send strategy to Chief of Staff ──────────────────────────

  const sendStrategy = async (text: string) => {
    if (!text.trim() || sending) return;

    const userMsg: ChiefOfStaffMessage = { role: "human", text: text.trim() };
    const newDialogue = [...dialogue, userMsg];
    setDialogue(newDialogue);
    setStrategyInput("");
    setSending(true);
    setLastResponse(null);

    try {
      const opponentFeatures =
        opponentId != null ? `Agent #${opponentId} in play` : undefined;

      const res = await fetch("/api/chief-of-staff/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tagged_candidates: taggedCandidates,
          human_strategy: text.trim(),
          dialogue: newDialogue.map((m) => ({ role: m.role, text: m.text })),
          opponent_features: opponentFeatures ?? null,
          agent_id: opponentId ?? null,
          turn_index: 0,
          // Use compute backend since the Route Handler only supports 0G Compute
          backend: "compute",
        }),
      });
      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        throw new Error(errorData.error || `${res.status}`);
      }
      const data = (await res.json()) as ChiefOfStaffResponse;

      setLastResponse(data);
      setDialogue([
        ...newDialogue,
        { role: "agent", text: data.reply },
      ]);

      // Pre-select the recommended move in the parent's move input.
      if (data.recommended_move && onMoveSelect) {
        onMoveSelect(data.recommended_move);
      }
    } catch (e: any) {
      setDialogue([
        ...newDialogue,
        {
          role: "agent",
          text: `Chief of Staff (0G Compute) encountered an error: ${e.message}. Please ensure your wallet has a sufficient OG balance and your connection to the 0G network is stable.`,
        },
      ]);
    } finally {
      setSending(false);
    }
  };

  const handleSend = () => void sendStrategy(strategyInput);

  // ── Quick-action chips ────────────────────────────────────────────────

  const QUICK_ACTIONS = [
    "Play safe",
    "Be aggressive",
    "Validate my intuition",
    "Build a prime",
  ];

  // ── Render ─────────────────────────────────────────────────────────────

  return (
    <div className="rounded-xl border border-indigo-200 bg-indigo-50/50 dark:border-indigo-800/40 dark:bg-indigo-900/10">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-indigo-200 px-4 py-2 dark:border-indigo-800/40">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold uppercase tracking-wide text-indigo-700 dark:text-indigo-400">
            Chief of Staff
          </span>
          <span className="text-[10px] text-indigo-500/70 dark:text-indigo-400/50">
            · AI micro-tactics, you set the strategy
          </span>
        </div>
      </div>

      <div className="flex flex-col gap-3 p-4">
        {/* Tagged candidates row */}
        {loadingCandidates && (
          <p className="text-xs text-indigo-500 animate-pulse dark:text-indigo-400">
            Evaluating moves…
          </p>
        )}
        {taggedCandidates.length > 0 && (
          <div>
            <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-indigo-600/70 dark:text-indigo-400/60">
              Top moves this turn
            </p>
            <div className="flex flex-wrap gap-2">
              {taggedCandidates.map((c, i) => {
                const isRecommended =
                  lastResponse?.recommended_move === c.move;
                const s = TAG_STYLES[c.tag] ?? TAG_STYLES.Safe;
                return (
                  <button
                    key={i}
                    type="button"
                    disabled={disabled}
                    onClick={() => onMoveSelect?.(c.move)}
                    title={c.tag_reason}
                    className={[
                      "flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs font-mono transition-shadow",
                      s.bg,
                      s.border,
                      s.text,
                      isRecommended
                        ? "ring-2 ring-indigo-500 ring-offset-1 shadow-md"
                        : "hover:shadow-sm",
                      disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer",
                    ].join(" ")}
                  >
                    <TagBadge tag={c.tag} />
                    <span>{c.move}</span>
                    <span className="text-[10px] opacity-60">
                      {c.equity >= 0 ? "+" : ""}
                      {c.equity.toFixed(3)}
                    </span>
                    {isRecommended && (
                      <span className="text-[10px] font-semibold text-indigo-600 dark:text-indigo-300">
                        ✓
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Deep-dive panel */}
        {lastResponse?.deep_dive && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-700/40 dark:bg-amber-900/10 dark:text-amber-200">
            <span className="mr-1.5 font-semibold">Historical analysis</span>
            {lastResponse.deep_dive}
          </div>
        )}

        {/* Conversation history */}
        {dialogue.length > 0 && (
          <div className="flex max-h-48 flex-col gap-2 overflow-y-auto pr-1">
            {dialogue.map((msg, i) => (
              <div
                key={i}
                className={`flex ${msg.role === "human" ? "justify-end" : "justify-start"}`}
              >
                <div
                  className={[
                    "max-w-[80%] rounded-lg px-3 py-1.5 text-xs leading-5",
                    msg.role === "human"
                      ? "bg-indigo-600 text-white"
                      : "bg-white text-zinc-800 shadow-sm dark:bg-zinc-800 dark:text-zinc-200",
                  ].join(" ")}
                >
                  {msg.text}
                </div>
              </div>
            ))}
            <div ref={bottomRef} />
          </div>
        )}

        {/* Quick-action chips */}
        {!disabled && taggedCandidates.length > 0 && dialogue.length === 0 && (
          <div className="flex flex-wrap gap-1.5">
            {QUICK_ACTIONS.map((action) => (
              <button
                key={action}
                type="button"
                onClick={() => void sendStrategy(action)}
                className="rounded-full border border-indigo-300 bg-white px-2.5 py-0.5 text-[11px] text-indigo-700 hover:bg-indigo-50 dark:border-indigo-700/60 dark:bg-zinc-900 dark:text-indigo-300 dark:hover:bg-indigo-900/20"
              >
                {action}
              </button>
            ))}
          </div>
        )}

        {/* Strategy input */}
        <div className="flex gap-2">
          <input
            ref={inputRef}
            value={strategyInput}
            onChange={(e) => setStrategyInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSend()}
            placeholder={
              disabled
                ? "Waiting for your turn…"
                : taggedCandidates.length === 0
                  ? "Waiting for move evaluation…"
                  : "Tell me your strategy (or ask to validate your intuition)"
            }
            disabled={disabled || taggedCandidates.length === 0 || sending}
            className="flex-1 rounded-lg border border-indigo-200 bg-white px-3 py-2 text-xs placeholder-zinc-400 focus:outline-none focus:ring-2 focus:ring-indigo-400 disabled:bg-zinc-50 disabled:text-zinc-400 dark:border-indigo-700/40 dark:bg-zinc-900 dark:text-zinc-100 dark:placeholder-zinc-600 dark:disabled:bg-zinc-950"
          />
          <button
            type="button"
            onClick={handleSend}
            disabled={disabled || !strategyInput.trim() || sending}
            className="rounded-lg bg-indigo-600 px-3 py-2 text-xs font-semibold text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:bg-zinc-400"
          >
            {sending ? "…" : "Ask"}
          </button>
        </div>

        {sending && (
          <p className="text-xs text-indigo-500 animate-pulse dark:text-indigo-400">
            Chief of Staff is thinking…
          </p>
        )}
      </div>
    </div>
  );
}
