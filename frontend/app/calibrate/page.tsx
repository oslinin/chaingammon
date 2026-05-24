"use client";

import { useState, useRef, useCallback } from "react";
import { BOARD_THEMES, type BoardThemeKey } from "../boardThemes";

const W = 716;
const H = 440;

const IMAGE_KEYS = (Object.keys(BOARD_THEMES) as BoardThemeKey[]).filter(
  (k) => !!BOARD_THEMES[k].backgroundImageUrl
);

// 16 wizard steps: col0 top, col0 bottom, barX, barTopY, barBottomY, col1..col11
// col0 top  → captures col0_x + topY
// col0 bot  → captures col0_x (averaged) + bottomY
// cols 1-11 → captures X only (topY/bottomY are uniform across all columns)
const STEP_DEFS: { id: string; useX: boolean; useY: boolean; label: string }[] = [
  {
    id: "col0top",
    useX: true,
    useY: true,
    label: "Column 1 TOP — click the checker center on the TOP of column 1 (point 13). Sets col1 X and top-row Y.",
  },
  {
    id: "col0bot",
    useX: true,
    useY: true,
    label: "Column 1 BOTTOM — click the checker center on the BOTTOM of column 1 (point 12). Sets bottom-row Y.",
  },
  {
    id: "barX",
    useX: true,
    useY: false,
    label: "Bar X — click the center of the bar strip",
  },
  {
    id: "barTopY",
    useX: false,
    useY: true,
    label: "Bar top Y — click where the first AGENT (top) bar checker center sits",
  },
  {
    id: "barBottomY",
    useX: false,
    useY: true,
    label: "Bar bottom Y — click where the first HUMAN (bottom) bar checker center sits",
  },
  ...Array.from({ length: 11 }, (_, i) => ({
    id: `col${i + 1}`,
    useX: true,
    useY: false,
    label: `Column ${i + 2}/12 X — click anywhere in column ${i + 2} (left→right). Col 6 = just left of bar, col 7 = just right of bar, col 12 = points 24/1`,
  })),
];

function buildJson(coords: Record<string, number>): string {
  const col0x = ((coords["col0top_x"] ?? 0) + (coords["col0bot_x"] ?? 0)) / 2;
  const columnsX = [
    parseFloat(col0x.toFixed(4)),
    ...Array.from({ length: 11 }, (_, i) =>
      parseFloat((coords[`col${i + 1}_x`] ?? 0).toFixed(4))
    ),
  ];
  const result = {
    columnsX,
    topY: parseFloat((coords["col0top_y"] ?? 0).toFixed(4)),
    bottomY: parseFloat((coords["col0bot_y"] ?? 0).toFixed(4)),
    barX: parseFloat((coords["barX_x"] ?? 0).toFixed(4)),
    barTopY: parseFloat((coords["barTopY_y"] ?? 0).toFixed(4)),
    barBottomY: parseFloat((coords["barBottomY_y"] ?? 0).toFixed(4)),
    leftOffX: 0.03,
    rightOffX: 0.97,
  };
  return `checkerSpots: ${JSON.stringify(result, null, 4)},`;
}

export default function CalibratePage() {
  const [themeKey, setThemeKey] = useState<BoardThemeKey>(IMAGE_KEYS[0]);
  const [step, setStep] = useState(0);
  const [coords, setCoords] = useState<Record<string, number>>({});
  const [hover, setHover] = useState<{ x: number; y: number } | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  const theme = BOARD_THEMES[themeKey];
  const existing = theme.checkerSpots;

  const clientToFrac = useCallback(
    (clientX: number, clientY: number): { x: number; y: number } | null => {
      const svg = svgRef.current;
      if (!svg) return null;
      const rect = svg.getBoundingClientRect();
      return {
        x: (clientX - rect.left) / rect.width,
        y: (clientY - rect.top) / rect.height,
      };
    },
    []
  );

  const handleMouseMove = (e: React.MouseEvent) => {
    setHover(clientToFrac(e.clientX, e.clientY));
  };

  const handleClick = (e: React.MouseEvent) => {
    if (step >= STEP_DEFS.length) return;
    const f = clientToFrac(e.clientX, e.clientY);
    if (!f) return;
    const { id } = STEP_DEFS[step];
    setCoords((prev) => ({ ...prev, [`${id}_x`]: f.x, [`${id}_y`]: f.y }));
    setStep((s) => s + 1);
  };

  const handleUndo = () => {
    if (step === 0) return;
    const prev = step - 1;
    const { id } = STEP_DEFS[prev];
    setCoords((c) => {
      const next = { ...c };
      delete next[`${id}_x`];
      delete next[`${id}_y`];
      return next;
    });
    setStep(prev);
  };

  const reset = () => {
    setCoords({});
    setStep(0);
  };

  const done = step >= STEP_DEFS.length;

  // Background crop math for the HTML img layer (mirrors Board.tsx)
  const crop = theme.backgroundImageCrop;
  const bgImgStyle: React.CSSProperties = crop ? {
    position: "absolute",
    width:  `${crop.totalSrcW / crop.srcW * 100}%`,
    height: `${crop.totalSrcH / crop.srcH * 100}%`,
    left:   `${-crop.srcX / crop.srcW * 100}%`,
    top:    `${-crop.srcY / crop.srcH * 100}%`,
  } : { position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" as const };

  // Calibrate always in 2D — no CSS transform applied to any board.
  // imageIs3d boards can't be truly flattened via CSS; calibrate on the native image.
  const bgTransform = undefined;

  return (
    <div
      style={{
        padding: 24,
        background: "#111",
        minHeight: "100vh",
        color: "#eee",
        fontFamily: "monospace",
        fontSize: 13,
      }}
    >
      <h1 style={{ fontSize: 20, marginBottom: 16, color: "#4ade80" }}>
        Board Calibration Tool
      </h1>

      {/* Controls */}
      <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 16 }}>
        <label>Theme:</label>
        <select
          value={themeKey}
          onChange={(e) => {
            setThemeKey(e.target.value as BoardThemeKey);
            reset();
          }}
          style={{
            background: "#222",
            color: "#eee",
            padding: "4px 8px",
            borderRadius: 4,
            border: "1px solid #444",
          }}
        >
          {IMAGE_KEYS.map((k) => (
            <option key={k} value={k}>
              {BOARD_THEMES[k].label}
            </option>
          ))}
        </select>
        <button
          onClick={handleUndo}
          disabled={step === 0}
          style={{
            padding: "4px 12px",
            background: "#333",
            color: step === 0 ? "#555" : "#eee",
            border: "1px solid #555",
            borderRadius: 4,
            cursor: step === 0 ? "default" : "pointer",
          }}
        >
          Undo
        </button>
        <button
          onClick={reset}
          style={{
            padding: "4px 12px",
            background: "#333",
            color: "#eee",
            border: "1px solid #555",
            borderRadius: 4,
            cursor: "pointer",
          }}
        >
          Reset
        </button>
      </div>

      {/* Current step instruction */}
      {!done && (
        <div
          style={{
            marginBottom: 12,
            padding: "8px 12px",
            background: "#0f1f0f",
            border: "1px solid #2a4a2a",
            borderRadius: 6,
          }}
        >
          <span style={{ color: "#4ade80" }}>
            Step {step + 1}/{STEP_DEFS.length}:
          </span>{" "}
          {STEP_DEFS[step].label}
        </div>
      )}
      {done && (
        <div
          style={{
            marginBottom: 12,
            padding: "8px 12px",
            background: "#0f0f1f",
            border: "1px solid #2a2a4a",
            borderRadius: 6,
          }}
        >
          ✓ All steps done — copy the checkerSpots below into boardThemes.ts
        </div>
      )}

      <div style={{ display: "flex", gap: 24, alignItems: "flex-start" }}>
        {/* Board image with overlay */}
        <div style={{ flexShrink: 0, position: "relative", width: W, height: H, border: "1px solid #333" }}>
          {/* Background image layer — inverse-tilt applied for imageIs3d boards so calibration is always flat */}
          <div style={{ position: "absolute", inset: 0, overflow: "hidden", transform: bgTransform, transformOrigin: "50% 50%" }}>
            <img src={theme.backgroundImageUrl} style={bgImgStyle} alt="" draggable={false} />
          </div>
          <svg
            ref={svgRef}
            width={W}
            height={H}
            viewBox={`0 0 ${W} ${H}`}
            style={{
              display: "block",
              position: "relative",
              cursor: done ? "default" : "crosshair",
            }}
            onMouseMove={handleMouseMove}
            onMouseLeave={() => setHover(null)}
            onClick={handleClick}
          >
            <defs />

            {/* Reference circle for current step — shows only the one spot being asked for */}
            {existing && !done && (() => {
              const id = STEP_DEFS[step]?.id;
              const ref = (cx: number, cy: number, r = 10) => (
                <circle cx={cx * W} cy={cy * H} r={r} fill="rgba(255,255,0,0.25)" stroke="#ffff00" strokeWidth={3} />
              );
              if (id === "col0top") return ref(existing.columnsX[0], existing.topY);
              if (id === "col0bot") return ref(existing.columnsX[0], existing.bottomY);
              if (id === "barX") return <>{ref(existing.barX, existing.barTopY, 9)}{ref(existing.barX, existing.barBottomY, 9)}</>;
              if (id === "barTopY") return ref(existing.barX, existing.barTopY, 9);
              if (id === "barBottomY") return ref(existing.barX, existing.barBottomY, 9);
              const colMatch = id?.match(/^col(\d+)$/);
              if (colMatch) {
                const i = parseInt(colMatch[1]);
                const cx = existing.columnsX[i];
                return ref(cx, existing.topY);
              }
              return null;
            })()}
            {/* When done, show all spots as confirmation */}
            {existing && done && (
              <>
                {existing.columnsX.map((cx, i) => (
                  <g key={`ex-col${i}`}>
                    <circle cx={cx * W} cy={existing.topY * H} r={7} fill="none" stroke="rgba(255,255,255,0.5)" strokeWidth={1.5} strokeDasharray="3 2" />
                    <circle cx={cx * W} cy={existing.bottomY * H} r={7} fill="none" stroke="rgba(255,255,255,0.5)" strokeWidth={1.5} strokeDasharray="3 2" />
                  </g>
                ))}
                <circle cx={existing.barX * W} cy={existing.barTopY * H} r={9} fill="none" stroke="rgba(255,255,255,0.5)" strokeWidth={1.5} strokeDasharray="3 2" />
                <circle cx={existing.barX * W} cy={existing.barBottomY * H} r={9} fill="none"
                  stroke="rgba(255,255,255,0.5)"
                  strokeWidth={1.5}
                  strokeDasharray="3 2"
                />
              </>
            )}

            {/* Recorded clicks — green dots */}
            {STEP_DEFS.map(({ id, useX, useY }) => {
              const x = coords[`${id}_x`];
              const y = coords[`${id}_y`];
              if (x === undefined) return null;
              const px = x * W;
              const py = y * H;
              return (
                <g key={id} pointerEvents="none">
                  <circle cx={px} cy={py} r={7} fill="#4ade80" opacity={0.85} />
                  <circle cx={px} cy={py} r={7} fill="none" stroke="#065f46" strokeWidth={1.5} />
                  {useX && (
                    <line x1={px} y1={0} x2={px} y2={H} stroke="rgba(74,222,128,0.3)" strokeWidth={1} />
                  )}
                  {useY && !useX && (
                    <line x1={0} y1={py} x2={W} y2={py} stroke="rgba(74,222,128,0.3)" strokeWidth={1} />
                  )}
                  <text
                    x={px + 9}
                    y={py + 4}
                    fontSize={9}
                    fill="#4ade80"
                    style={{ userSelect: "none" }}
                  >
                    {id}
                  </text>
                </g>
              );
            })}

            {/* Hover crosshair */}
            {hover && !done && (
              <g pointerEvents="none">
                <line
                  x1={hover.x * W}
                  y1={0}
                  x2={hover.x * W}
                  y2={H}
                  stroke="rgba(74,222,128,0.7)"
                  strokeWidth={0.5}
                />
                <line
                  x1={0}
                  y1={hover.y * H}
                  x2={W}
                  y2={hover.y * H}
                  stroke="rgba(74,222,128,0.7)"
                  strokeWidth={0.5}
                />
                <rect
                  x={hover.x * W + 4}
                  y={hover.y * H - 17}
                  width={100}
                  height={14}
                  fill="rgba(0,0,0,0.6)"
                  rx={2}
                />
                <text
                  x={hover.x * W + 6}
                  y={hover.y * H - 6}
                  fontSize={11}
                  fill="#4ade80"
                  style={{ userSelect: "none" }}
                >
                  {hover.x.toFixed(4)}, {hover.y.toFixed(4)}
                </text>
              </g>
            )}
          </svg>
        </div>

        {/* Right panel: step list + JSON output */}
        <div style={{ flex: 1, minWidth: 320, maxWidth: 480 }}>
          <div style={{ marginBottom: 12 }}>
            {STEP_DEFS.map(({ id, label }, i) => {
              const recorded = coords[`${id}_x`] !== undefined;
              const isCurrent = i === step && !done;
              return (
                <div
                  key={id}
                  style={{
                    padding: "3px 8px",
                    borderLeft: `3px solid ${recorded ? "#4ade80" : isCurrent ? "#4ade80" : "#333"}`,
                    marginBottom: 2,
                    fontSize: 11,
                    color: recorded ? "#4ade80" : isCurrent ? "#eee" : "#555",
                    background: isCurrent ? "#0f1f0f" : "transparent",
                  }}
                >
                  {recorded ? "✓" : isCurrent ? "→" : "○"}{" "}
                  <strong>{id}</strong> — {label.split(" — ")[0]}
                </div>
              );
            })}
          </div>

          {done && (
            <textarea
              readOnly
              value={buildJson(coords)}
              onClick={(e) => (e.target as HTMLTextAreaElement).select()}
              style={{
                width: "100%",
                height: 340,
                background: "#0a0a0a",
                color: "#4ade80",
                fontFamily: "monospace",
                fontSize: 12,
                padding: 12,
                border: "1px solid #2a4a2a",
                borderRadius: 6,
                resize: "vertical",
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
}
