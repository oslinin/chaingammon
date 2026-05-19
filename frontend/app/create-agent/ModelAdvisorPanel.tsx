"use client";

import { useEffect, useRef, useState } from "react";
import { useComputeBackends } from "../ComputeBackendsContext";

interface AdvisorMessage {
  role: "human" | "agent";
  text: string;
}

interface Props {
  onCodeSelect: (code: string) => void;
  disabled?: boolean;
}

const QUICK_ACTIONS = [
  "Suggest a Random Forest model",
  "Suggest a Genetic Algorithm model",
  "What are the tradeoffs of Random Forest?",
  "How does the default MLP compare to others?",
];

export function ModelAdvisorPanel({ onCodeSelect, disabled }: Props) {
  const { backends } = useComputeBackends();
  const backend = backends.coach;
  const [dialogue, setDialogue] = useState<AdvisorMessage[]>([]);
  const [promptInput, setPromptInput] = useState("");
  const [sending, setSending] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [dialogue, sending]);

  const handleSend = async (promptOverride?: string) => {
    const text = promptOverride || promptInput;
    if (!text.trim() || sending || disabled) return;

    const newDialogue = [...dialogue, { role: "human" as const, text }];
    setDialogue(newDialogue);
    if (!promptOverride) setPromptInput("");
    setSending(true);

    try {
      const res = await fetch("/api/model-advisor/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: text,
          dialogue: newDialogue.slice(0, -1),
          backend,
        }),
      });

      if (!res.ok) {
        throw new Error(`Server responded ${res.status}`);
      }

      const data = await res.json();
      if (data.error) throw new Error(data.error);

      setDialogue([
        ...newDialogue,
        { role: "agent", text: data.reply },
      ]);

      if (data.code) {
        onCodeSelect(data.code);
      }
    } catch (e: any) {
      setDialogue([
        ...newDialogue,
        {
          role: "agent",
          text: `Model advisor encountered an error: ${e.message}. Ensure your 0G connection is stable.`,
        },
      ]);
    } finally {
      setSending(false);
    }
  };

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "400px", // fixed height for the side panel
        background: "var(--cg-bg-2)",
        border: "1px solid var(--cg-line-1)",
        borderRadius: "var(--cg-radius)",
        overflow: "hidden",
      }}
    >
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
            Model Advisor
          </span>
          <span style={{ fontSize: 10, color: "var(--cg-fg-4)" }}>
            · 0G AI
          </span>
        </div>
      </div>

      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          gap: 12,
          overflowY: "auto",
          padding: 16,
          minHeight: 0,
        }}
      >
        {dialogue.length === 0 ? (
          <p style={{ fontSize: 12, color: "var(--cg-fg-2)" }}>
            Hi! I'm your AI Model Advisor. I can help you choose the best PyTorch architecture for your new backgammon agent and generate the code for it. What would you like to build?
          </p>
        ) : (
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
                    maxWidth: "85%",
                    borderRadius: "var(--cg-radius)",
                    padding: "6px 12px",
                    fontSize: 12,
                    lineHeight: 1.5,
                    background: msg.role === "human" ? "var(--cg-brass)" : "var(--cg-bg-3)",
                    color: msg.role === "human" ? "var(--cg-brass-ink)" : "var(--cg-fg-2)",
                    border: msg.role === "human" ? "none" : "1px solid var(--cg-line-2)",
                    boxShadow: "var(--cg-shadow-1)",
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word"
                  }}
                >
                  {msg.text}
                </div>
              </div>
            ))}
            <div ref={bottomRef} />
          </div>
        )}

        {!disabled && dialogue.length === 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {QUICK_ACTIONS.map((action) => (
              <button
                key={action}
                type="button"
                onClick={() => void handleSend(action)}
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
            Model advisor is thinking…
          </p>
        )}
      </div>

      <div
        style={{
          flexShrink: 0,
          display: "flex",
          gap: 8,
          borderTop: "1px solid var(--cg-line-1)",
          padding: "10px 16px",
        }}
      >
        <input
          ref={inputRef}
          value={promptInput}
          onChange={(e) => setPromptInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void handleSend()}
          placeholder={
            disabled
              ? "Cannot chat right now…"
              : "Ask for code or tradeoffs…"
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
          onClick={() => void handleSend()}
          disabled={disabled || !promptInput.trim() || sending}
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
