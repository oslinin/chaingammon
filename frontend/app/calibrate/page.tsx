"use client";

import { useState, useRef, useCallback } from "react";
import { BOARD_THEMES, type BoardThemeKey } from "../boardThemes";

const W = 716;
const H = 440;

const IMAGE_KEYS = (Object.keys(BOARD_THEMES) as BoardThemeKey[]).filter(
  (k) => !!BOARD_THEMES[k].backgroundImageUrl
);

// 17 wizard steps: topY, bottomY, barX, barTopY, barBottomY, col0..col11
const STEP_DEFS: { id: string; useX: boolean; label: string }[] = [
  {
    id: "topY",
    useX: false,
    label: "Top row Y — click where the first checker center sits on the TOP points (row starting at point 13, leftmost)",
  },
  {
    id: "bottomY",
    useX: false,
    label: "Bottom row Y — click where the first checker center sits on the BOTTOM points (row starting at point 12, leftmost)",
  },
  {
    id: "barX",
    useX: true,
    label: "Bar X — click the center of the bar strip",
  },
  {
    id: "barTopY",
    useX: false,
    label: "Bar top Y — click where the first AGENT (top) bar checker center sits",
  },
  {
    id: "barBottomY",
    useX: false,
    label: "Bar bottom Y — click where the first HUMAN (bottom) bar checker center sits",
  },
  ...Array.from({ length: 12 }, (_, i) => ({
    id: `col${i}`,
    useX: true,
    label: `Column ${i + 1}/12 X — click the center of column ${i + 1} (left→right). Col 1 = points 13/12, col 6 = just left of bar, col 7 = just right of bar, col 12 = points 24/1`,
  })),
];

function buildJson(coords: Record<string, number>): string {
  const columnsX = Array.from({ length: 12 }, (_, i) =>
    parseFloat(((coords[`col${i}_x`] ?? 0)).toFixed(4))
  );
  const result = {
    columnsX,
    topY: parseFloat((coords["topY_y"] ?? 0).toFixed(4)),
    bottomY: parseFloat((coords["bottomY_y"] ?? 0).toFixed(4)),
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

  // Background image crop math — mirrors Board.tsx exactly
  const crop = theme.backgroundImageCrop;
  let imgX = 0,
    imgY = 0,
    imgW = W,
    imgH = H;
  if (crop) {
    const scaleX = W / crop.srcW;
    const scaleY = H / crop.srcH;
    imgX = -crop.srcX * scaleX;
    imgY = -crop.srcY * scaleY;
    imgW = crop.totalSrcW * scaleX;
    imgH = crop.totalSrcH * scaleY;
  }

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
        <div style={{ flexShrink: 0 }}>
          <svg
            ref={svgRef}
            width={W}
            height={H}
            viewBox={`0 0 ${W} ${H}`}
            style={{
              display: "block",
              cursor: done ? "default" : "crosshair",
              border: "1px solid #333",
            }}
            onMouseMove={handleMouseMove}
            onMouseLeave={() => setHover(null)}
            onClick={handleClick}
          >
            <defs>
              <clipPath id="cal-clip">
                <rect x={0} y={0} width={W} height={H} />
              </clipPath>
            </defs>

            {/* Board background */}
            <image
              href={theme.backgroundImageUrl}
              x={imgX}
              y={imgY}
              width={imgW}
              height={imgH}
              clipPath="url(#cal-clip)"
              preserveAspectRatio="none"
            />

            {/* Existing checkerSpots — faded white dashed circles */}
            {existing &&
              existing.columnsX.map((cx, i) => (
                <g key={`ex-col${i}`}>
                  <circle
                    cx={cx * W}
                    cy={existing.topY * H}
                    r={7}
                    fill="none"
                    stroke="rgba(255,255,255,0.5)"
                    strokeWidth={1.5}
                    strokeDasharray="3 2"
                  />
                  <circle
                    cx={cx * W}
                    cy={existing.bottomY * H}
                    r={7}
                    fill="none"
                    stroke="rgba(255,255,255,0.5)"
                    strokeWidth={1.5}
                    strokeDasharray="3 2"
                  />
                </g>
              ))}
            {existing && (
              <>
                <circle
                  cx={existing.barX * W}
                  cy={existing.barTopY * H}
                  r={9}
                  fill="none"
                  stroke="rgba(255,255,255,0.5)"
                  strokeWidth={1.5}
                  strokeDasharray="3 2"
                />
                <circle
                  cx={existing.barX * W}
                  cy={existing.barBottomY * H}
                  r={9}
                  fill="none"
                  stroke="rgba(255,255,255,0.5)"
                  strokeWidth={1.5}
                  strokeDasharray="3 2"
                />
              </>
            )}

            {/* Recorded clicks — green dots */}
            {STEP_DEFS.map(({ id, useX }) => {
              const x = coords[`${id}_x`];
              const y = coords[`${id}_y`];
              if (x === undefined) return null;
              const px = x * W;
              const py = y * H;
              return (
                <g key={id} pointerEvents="none">
                  <circle cx={px} cy={py} r={7} fill="#4ade80" opacity={0.85} />
                  <circle cx={px} cy={py} r={7} fill="none" stroke="#065f46" strokeWidth={1.5} />
                  {/* For X-only steps, also show a vertical line */}
                  {useX && (
                    <line
                      x1={px}
                      y1={0}
                      x2={px}
                      y2={H}
                      stroke="rgba(74,222,128,0.3)"
                      strokeWidth={1}
                    />
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
