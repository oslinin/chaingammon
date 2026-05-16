"use client";

import React, { useRef, useState, PointerEvent } from "react";

interface BoardProps {
  board: number[];          // length 24; board[i] = checkers on point (i+1). Positive = player 0, negative = player 1
  bar: number[];            // [p0_bar, p1_bar]
  off: number[];            // [p0_off, p1_off]
  turn: number;             // 0 = human, 1 = agent
  opponentName?: string;
  onPointClick?: (point: number) => void;
  onBarClick?: () => void;
  onOffClick?: () => void;
  selectedPoint?: number | null;  // 1-24 = board point, 25 = bar
  onDragStart?: (point: number) => void;
  onDrop?: (point: number) => void;
}

const FRAME = 20;
const POINT_W = 44;
const BAR_W = 52;
const BEAR_W = 48;
const CHECKER_R = 18;
const CHECKER_GAP = 36;
const MAX_DOTS = 5;

// Inner play area x layout
const L_BEAR_X = FRAME; // Left bear-off
const L_QUAD_X = L_BEAR_X + BEAR_W;
const BAR_X = L_QUAD_X + 6 * POINT_W;
const R_QUAD_X = BAR_X + BAR_W;
const R_BEAR_X = R_QUAD_X + 6 * POINT_W;
const TOTAL_W = R_BEAR_X + BEAR_W + FRAME; // 20+48+264+52+264+48+20 = 716
const TOTAL_H = 440;

const INNER_H = TOTAL_H - 2 * FRAME;

type DragState = {
  fromPoint: number | "bar";
  isP0: boolean;
  svgX: number;
  svgY: number;
} | null;

export function Board({
  board,
  bar,
  off,
  turn,
  opponentName,
  onPointClick,
  onBarClick,
  onOffClick,
  selectedPoint,
  onDragStart,
  onDrop,
}: BoardProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [dragState, setDragState] = useState<DragState>(null);
  const [pendingDrop, setPendingDrop] = useState<number | "off" | null>(null);

  // When a drop requires selecting the source point first, we must wait for
  // `selectedPoint` to update before triggering the destination click.
  React.useEffect(() => {
    if (pendingDrop !== null) {
      if (pendingDrop === "off") {
        if (onOffClick) onOffClick();
      } else {
        if (onPointClick) onPointClick(pendingDrop);
        if (onDrop) onDrop(pendingDrop);
      }
      setPendingDrop(null);
    }
  }, [selectedPoint, pendingDrop, onOffClick, onPointClick, onDrop]);

  const turnLabel = turn === 0 ? "Your turn" : `${opponentName ?? "Agent"}'s turn`;
  const turnColor = turn === 0 ? "var(--cg-player-warm)" : "var(--cg-player-cool)";

  const getColXOffset = (col: number, rightHalf: boolean) => {
    const baseX = rightHalf ? R_QUAD_X : L_QUAD_X;
    return baseX + col * POINT_W;
  };

  const clientToSvg = (clientX: number, clientY: number) => {
    if (!svgRef.current) return { x: 0, y: 0 };
    const pt = svgRef.current.createSVGPoint();
    pt.x = clientX;
    pt.y = clientY;
    const ctm = svgRef.current.getScreenCTM();
    if (!ctm) return { x: 0, y: 0 };
    return pt.matrixTransform(ctm.inverse());
  };

  const handlePointerDown = (e: PointerEvent<SVGGElement>, point: number | "bar", isP0: boolean) => {
    if (turn !== 0 || !isP0) return;
    (e.target as Element).setPointerCapture(e.pointerId);
    const { x, y } = clientToSvg(e.clientX, e.clientY);
    setDragState({ fromPoint: point, isP0, svgX: x, svgY: y });
    if (onDragStart && typeof point === "number") onDragStart(point);
  };

  const handlePointerMove = (e: PointerEvent<SVGSVGElement>) => {
    if (!dragState) return;
    const { x, y } = clientToSvg(e.clientX, e.clientY);
    setDragState({ ...dragState, svgX: x, svgY: y });
  };

  const handlePointerUp = (e: PointerEvent<SVGSVGElement>) => {
    if (!dragState) return;
    const ds = dragState;
    setDragState(null);
    const { x, y } = clientToSvg(e.clientX, e.clientY);

    // Hit test Bear-off Tray (Right tray for P0)
    if (x >= R_BEAR_X && x <= R_BEAR_X + BEAR_W && y >= FRAME && y <= FRAME + INNER_H) {
      if (onOffClick) {
          if (ds.fromPoint === "bar" && selectedPoint !== 25) {
              if (onBarClick) onBarClick();
              setPendingDrop("off");
          } else if (typeof ds.fromPoint === "number" && selectedPoint !== ds.fromPoint) {
              if (onPointClick) onPointClick(ds.fromPoint);
              setPendingDrop("off");
          } else {
              onOffClick();
          }
      }
      return;
    }

    // Hit test Bar
    if (x >= BAR_X && x <= BAR_X + BAR_W && y >= FRAME && y <= FRAME + INNER_H) {
      // cannot drop on bar
      return;
    }

    // Hit test Points
    // Bottom row
    if (y >= FRAME + INNER_H / 2 && y <= FRAME + INNER_H) {
      // Left half (points 12-7)
      if (x >= L_QUAD_X && x < L_QUAD_X + 6 * POINT_W) {
        const col = Math.floor((x - L_QUAD_X) / POINT_W);
        const point = 12 - col;
        triggerDrop(ds.fromPoint, point);
        return;
      }
      // Right half (points 6-1)
      if (x >= R_QUAD_X && x < R_QUAD_X + 6 * POINT_W) {
        const col = Math.floor((x - R_QUAD_X) / POINT_W);
        const point = 6 - col;
        triggerDrop(ds.fromPoint, point);
        return;
      }
    }

    // Top row
    if (y >= FRAME && y < FRAME + INNER_H / 2) {
      // Left half (points 13-18)
      if (x >= L_QUAD_X && x < L_QUAD_X + 6 * POINT_W) {
        const col = Math.floor((x - L_QUAD_X) / POINT_W);
        const point = 13 + col;
        triggerDrop(ds.fromPoint, point);
        return;
      }
      // Right half (points 19-24)
      if (x >= R_QUAD_X && x < R_QUAD_X + 6 * POINT_W) {
        const col = Math.floor((x - R_QUAD_X) / POINT_W);
        const point = 19 + col;
        triggerDrop(ds.fromPoint, point);
        return;
      }
    }
  };

  const triggerDrop = (from: number | "bar", to: number) => {
    // If not selected yet, select it, then move (via useEffect)
    if (from === "bar" && selectedPoint !== 25) {
      if (onBarClick) onBarClick();
      setPendingDrop(to);
    } else if (typeof from === "number" && selectedPoint !== from) {
      if (onPointClick) onPointClick(from);
      setPendingDrop(to);
    } else {
      if (onPointClick) onPointClick(to);
      if (onDrop) onDrop(to);
    }
  };

  const renderChecker = (cx: number, cy: number, isP0: boolean, key: string, isDragging: boolean = false) => {
    return (
      <g key={key} style={{ pointerEvents: "none" }}>
        <circle
          cx={cx}
          cy={cy}
          r={CHECKER_R}
          fill={isP0 ? "url(#cg-p0)" : "url(#cg-p1)"}
          stroke="rgba(0,0,0,0.5)"
          strokeWidth="1"
          opacity={isDragging ? 0.3 : 1}
        />
        <ellipse
          cx={cx}
          cy={cy - CHECKER_R * 0.3}
          rx={CHECKER_R * 0.6}
          ry={CHECKER_R * 0.3}
          fill="rgba(255,255,255,0.2)"
          transform={`rotate(-20 ${cx} ${cy - CHECKER_R * 0.3})`}
        />
      </g>
    );
  };

  const renderPoint = (point: number) => {
    const isTop = point >= 13;
    const isLeft = (isTop && point <= 18) || (!isTop && point >= 7);
    let col = 0;
    if (isTop) {
      col = isLeft ? point - 13 : point - 19;
    } else {
      col = isLeft ? 12 - point : 6 - point;
    }

    const startX = getColXOffset(col, !isLeft);
    const tipY = isTop ? FRAME + 180 : TOTAL_H - FRAME - 180;
    const baseY = isTop ? FRAME : TOTAL_H - FRAME;

    // Alternating colors
    // col 0 = crimson on bottom, amber on top
    const isCrimson = isTop ? col % 2 !== 0 : col % 2 === 0;
    const triColor = isCrimson ? "#8B2210" : "#C47820";

    const pts = `${startX},${baseY} ${startX + POINT_W},${baseY} ${startX + POINT_W / 2},${tipY}`;

    const count = board[point - 1];
    const isP0 = count > 0;
    const absCount = Math.abs(count);

    // Dragging state info
    const isDragSource = dragState?.fromPoint === point;
    // Visually, if we're dragging from here, we show one fewer checker (the ghost is on the mouse)
    const displayCount = isDragSource ? absCount - 1 : absCount;

    const dotsToShow = Math.min(displayCount, MAX_DOTS);
    const extra = displayCount > MAX_DOTS ? displayCount - MAX_DOTS : 0;

    const isSelected = selectedPoint === point;

    return (
      <g
        key={`point-${point}`}
        data-testid={`point-${point - 1}`}
        data-point={point}
        data-count={count}
      >
        {/* Triangle */}
        <polygon
          points={pts}
          fill={triColor}
          opacity={0.9}
        />
        {/* Selection Highlight */}
        {isSelected && (
          <rect
            x={startX}
            y={isTop ? FRAME : FRAME + INNER_H - 180}
            width={POINT_W}
            height={180}
            fill="var(--cg-brass)"
            fillOpacity={0.15}
            stroke="var(--cg-brass)"
            strokeWidth={1}
            pointerEvents="none"
          />
        )}

        {/* Point Label */}
        <text
          x={startX + POINT_W / 2}
          y={isTop ? FRAME - 5 : TOTAL_H - FRAME + 12}
          textAnchor="middle"
          fontSize="10"
          fontFamily="var(--cg-font-mono, monospace)"
          fill="var(--cg-fg-4, #4A4339)"
        >
          {point}
        </text>

        {/* Clickable Overlay */}
        <rect
          x={startX}
          y={isTop ? FRAME : FRAME + INNER_H - 180}
          width={POINT_W}
          height={180}
          fill="transparent"
          cursor={onPointClick ? "pointer" : "default"}
          onClick={() => onPointClick && onPointClick(point)}
          onPointerDown={(e) => {
            if (count > 0 && turn === 0) handlePointerDown(e, point, true);
          }}
          style={{ touchAction: "none" }}
        />

        {/* Checkers */}
        <g pointerEvents="none">
          {Array.from({ length: dotsToShow }).map((_, i) => {
            const cy = isTop
              ? FRAME + CHECKER_R + i * CHECKER_GAP
              : TOTAL_H - FRAME - CHECKER_R - i * CHECKER_GAP;
            return renderChecker(startX + POINT_W / 2, cy, isP0, `checker-${point}-${i}`);
          })}
          {extra > 0 && (
            <text
              x={startX + POINT_W / 2}
              y={isTop
                  ? FRAME + CHECKER_R + dotsToShow * CHECKER_GAP + 4
                  : TOTAL_H - FRAME - CHECKER_R - dotsToShow * CHECKER_GAP + 4}
              textAnchor="middle"
              fontSize="12"
              fontFamily="var(--cg-font-mono, monospace)"
              fill="var(--cg-fg-4, #4A4339)"
            >
              +{extra}
            </text>
          )}
        </g>
      </g>
    );
  };

  const renderBar = () => {
    const isSelected = selectedPoint === 25;
    const [p0Bar, p1Bar] = bar;

    const p0Display = dragState?.fromPoint === "bar" ? p0Bar - 1 : p0Bar;

    return (
      <g key="bar">
        <rect
          x={BAR_X}
          y={FRAME}
          width={BAR_W}
          height={INNER_H}
          fill="rgba(0,0,0,0.1)"
          stroke="rgba(0,0,0,0.3)"
        />
        {isSelected && (
          <rect
            x={BAR_X}
            y={FRAME}
            width={BAR_W}
            height={INNER_H}
            fill="var(--cg-brass)"
            fillOpacity={0.15}
            stroke="var(--cg-brass)"
            strokeWidth={1}
            pointerEvents="none"
          />
        )}
        <text
          x={BAR_X + BAR_W / 2}
          y={TOTAL_H / 2 + 4}
          textAnchor="middle"
          fontSize="10"
          fontFamily="var(--cg-font-mono, monospace)"
          fill="var(--cg-fg-4, #4A4339)"
        >
          BAR
        </text>

        {/* Clickable Overlay */}
        <rect
          x={BAR_X}
          y={FRAME}
          width={BAR_W}
          height={INNER_H}
          fill="transparent"
          cursor={onBarClick ? "pointer" : "default"}
          onClick={() => onBarClick && onBarClick()}
          onPointerDown={(e) => {
            if (p0Bar > 0 && turn === 0) handlePointerDown(e, "bar", true);
          }}
          style={{ touchAction: "none" }}
        />

        {/* P1 Bar Checkers (Top Down) */}
        <g pointerEvents="none">
          {Array.from({ length: Math.min(p1Bar, 3) }).map((_, i) => (
            renderChecker(BAR_X + BAR_W / 2, FRAME + 60 + i * CHECKER_GAP, false, `bar-p1-${i}`)
          ))}
          {p1Bar > 3 && (
            <text
              x={BAR_X + BAR_W / 2}
              y={FRAME + 60 + 3 * CHECKER_GAP + 4}
              textAnchor="middle"
              fontSize="12"
              fontFamily="var(--cg-font-mono, monospace)"
              fill="var(--cg-fg-4, #4A4339)"
            >
              +{p1Bar - 3}
            </text>
          )}
        </g>

        {/* P0 Bar Checkers (Bottom Up) */}
        <g pointerEvents="none">
          {Array.from({ length: Math.min(p0Display, 3) }).map((_, i) => (
            renderChecker(BAR_X + BAR_W / 2, TOTAL_H - FRAME - 60 - i * CHECKER_GAP, true, `bar-p0-${i}`)
          ))}
          {p0Display > 3 && (
            <text
              x={BAR_X + BAR_W / 2}
              y={TOTAL_H - FRAME - 60 - 3 * CHECKER_GAP + 4}
              textAnchor="middle"
              fontSize="12"
              fontFamily="var(--cg-font-mono, monospace)"
              fill="var(--cg-fg-4, #4A4339)"
            >
              +{p0Display - 3}
            </text>
          )}
        </g>
      </g>
    );
  };

  const renderBearOff = () => {
    // Left Tray = P1
    // Right Tray = P0
    const [p0Off, p1Off] = off;

    const p1MiniRadius = 6;
    const p0MiniRadius = 6;

    return (
      <g>
        {/* Left Tray Background */}
        <rect
          x={L_BEAR_X}
          y={FRAME}
          width={BEAR_W}
          height={INNER_H}
          fill="rgba(0,0,0,0.15)"
        />
        {/* P1 Off Mini Checkers */}
        <g pointerEvents="none">
          {Array.from({ length: p1Off }).map((_, i) => (
            <rect
              key={`p1off-${i}`}
              x={L_BEAR_X + 10}
              y={TOTAL_H - FRAME - 20 - i * 14}
              width={BEAR_W - 20}
              height={10}
              rx={3}
              fill="url(#cg-p1)"
              stroke="rgba(0,0,0,0.5)"
            />
          ))}
          <text
             x={L_BEAR_X + BEAR_W/2}
             y={TOTAL_H - FRAME - 5}
             textAnchor="middle"
             fontSize="10"
             fontFamily="var(--cg-font-mono, monospace)"
             fill="var(--cg-player-cool, #E8E1CF)"
          >
            {p1Off}
          </text>
        </g>

        {/* Right Tray Background */}
        <rect
          x={R_BEAR_X}
          y={FRAME}
          width={BEAR_W}
          height={INNER_H}
          fill="rgba(0,0,0,0.15)"
        />
        {/* P0 Off Mini Checkers */}
        <g pointerEvents="none">
          {Array.from({ length: p0Off }).map((_, i) => (
            <rect
              key={`p0off-${i}`}
              x={R_BEAR_X + 10}
              y={TOTAL_H - FRAME - 20 - i * 14}
              width={BEAR_W - 20}
              height={10}
              rx={3}
              fill="url(#cg-p0)"
              stroke="rgba(0,0,0,0.5)"
            />
          ))}
          <text
             x={R_BEAR_X + BEAR_W/2}
             y={TOTAL_H - FRAME - 5}
             textAnchor="middle"
             fontSize="10"
             fontFamily="var(--cg-font-mono, monospace)"
             fill="var(--cg-player-warm, #E3B779)"
          >
            {p0Off}
          </text>
        </g>
      </g>
    );
  };

  let pip0 = (bar[0] ?? 0) * 25;
  let pip1 = (bar[1] ?? 0) * 25;
  for (let i = 0; i < 24; i++) {
    if (board[i] > 0) pip0 += (i + 1) * board[i];
    if (board[i] < 0) pip1 += (24 - i) * (-board[i]);
  }

  return (
    <div className="flex flex-col gap-2">
      <p style={{ color: turnColor, fontWeight: "bold", fontSize: "14px" }}>
        {turnLabel}
      </p>

      <div style={{ width: "100%", maxWidth: `${TOTAL_W}px`, overflow: "hidden" }}>
        <svg
          ref={svgRef}
          viewBox={`0 0 ${TOTAL_W} ${TOTAL_H}`}
          width="100%"
          style={{ touchAction: dragState ? "none" : "auto", display: "block" }}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerLeave={handlePointerUp}
        >
          <defs>
            <pattern id="cg-wood" patternUnits="userSpaceOnUse" width="80" height="80">
              <rect width="80" height="80" fill="#5C3A1E" />
              <rect x="0" y="0" width="10" height="120" fill="#6B4423" opacity="0.6" transform="rotate(-12)" />
              <rect x="20" y="-10" width="15" height="120" fill="#4A2D14" opacity="0.7" transform="rotate(-12)" />
              <rect x="50" y="-20" width="8" height="120" fill="#6B4423" opacity="0.5" transform="rotate(-12)" />
              <rect x="70" y="-10" width="12" height="120" fill="#4A2D14" opacity="0.8" transform="rotate(-12)" />
            </pattern>
            <radialGradient id="cg-felt" cx="50%" cy="50%" r="60%">
              <stop offset="0%" stopColor="#3D2220" />
              <stop offset="100%" stopColor="var(--cg-bg-felt, #2D1A18)" />
            </radialGradient>
            <radialGradient id="cg-p0" cx="38%" cy="30%" r="70%">
              <stop offset="0%" stopColor="#F5D49A" />
              <stop offset="38%" stopColor="var(--cg-player-warm, #E3B779)" />
              <stop offset="100%" stopColor="#A07830" />
            </radialGradient>
            <radialGradient id="cg-p1" cx="38%" cy="30%" r="70%">
              <stop offset="0%" stopColor="#FDFAF4" />
              <stop offset="38%" stopColor="var(--cg-player-cool, #E8E1CF)" />
              <stop offset="100%" stopColor="#B0A898" />
            </radialGradient>
            <filter id="cg-glow" x="-50%" y="-50%" width="200%" height="200%">
              <feGaussianBlur in="SourceGraphic" stdDeviation="4" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>

          {/* Outer Frame */}
          <rect x="0" y="0" width={TOTAL_W} height={TOTAL_H} fill="url(#cg-wood)" rx="4" />

          {/* Inner Felt */}
          <rect x={FRAME} y={FRAME} width={TOTAL_W - 2 * FRAME} height={INNER_H} fill="url(#cg-felt)" />

          {/* Bear-Off Trays */}
          {renderBearOff()}

          {/* Points */}
          {Array.from({ length: 24 }).map((_, i) => renderPoint(i + 1))}

          {/* Center Bar */}
          {renderBar()}

          {/* Drag Ghost */}
          {dragState && (
            <g filter="url(#cg-glow)" style={{ pointerEvents: "none" }}>
              <circle
                cx={dragState.svgX}
                cy={dragState.svgY}
                r={CHECKER_R}
                fill={dragState.isP0 ? "url(#cg-p0)" : "url(#cg-p1)"}
                stroke="var(--cg-brass, #C99B5C)"
                strokeWidth="2"
              />
              <ellipse
                cx={dragState.svgX}
                cy={dragState.svgY - CHECKER_R * 0.3}
                rx={CHECKER_R * 0.6}
                ry={CHECKER_R * 0.3}
                fill="rgba(255,255,255,0.2)"
                transform={`rotate(-20 ${dragState.svgX} ${dragState.svgY - CHECKER_R * 0.3})`}
              />
            </g>
          )}
        </svg>
      </div>

      {onOffClick && (
        <button
          type="button"
          onClick={onOffClick}
          aria-label="Bear off selected checker"
          className="self-start rounded border border-zinc-300 px-2 py-1 text-xs text-zinc-600 hover:bg-zinc-100 dark:border-zinc-600 dark:text-zinc-400 dark:hover:bg-zinc-800"
        >
          Bear off →
        </button>
      )}

      <div className="flex gap-6 text-sm text-zinc-600 dark:text-zinc-400">
        <span>
          <span style={{ color: "var(--cg-player-warm)" }} className="font-semibold">You</span>{" "}
          borne off: {off[0]} / 15 · <span className="font-mono">{pip0} pip{pip0 !== 1 ? "s" : ""}</span>
        </span>
        <span>
          <span style={{ color: "var(--cg-player-cool)" }} className="font-semibold">Agent</span>{" "}
          borne off: {off[1]} / 15 · <span className="font-mono">{pip1} pip{pip1 !== 1 ? "s" : ""}</span>
        </span>
      </div>
    </div>
  );
}
