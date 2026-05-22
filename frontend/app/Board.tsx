"use client";

import React, { useRef, useState, PointerEvent } from "react";
import { BOARD_THEMES, type BoardThemeKey } from "./boardThemes";

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
  ghostMove?: string | null;      // A move string to preview on hover, e.g. "24/18 13/7"
  onDragStart?: (point: number) => void;
  onDrop?: (point: number) => void;
  themeKey?: BoardThemeKey;
  cubeValue?: number;       // current doubling cube value (1, 2, 4, 8…)
  cubeOwner?: number;       // -1 = centered, 0 = human, 1 = agent
  onCubeClick?: () => void; // called when the human clicks the cube to offer a double
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
  ghostMove,
  onDragStart,
  onDrop,
  themeKey = "walnut",
  cubeValue = 1,
  cubeOwner = -1,
  onCubeClick,
}: BoardProps) {
  const theme = BOARD_THEMES[themeKey] ?? BOARD_THEMES.walnut;
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

  // Parse ghostMove into an array of {from, to} segments for visualization
  const previewSegments = React.useMemo(() => {
    if (!ghostMove) return [];
    return ghostMove.split(/\s+/).filter(Boolean).map((seg, index) => {
      const parts = seg.split("/");
      if (parts.length !== 2) return null;
      const from = parts[0] === "bar" ? 25 : parseInt(parts[0], 10);
      const to = parts[1] === "off" ? 0 : parseInt(parts[1], 10);
      if (isNaN(from) || isNaN(to)) return null;
      return { from, to, segIndex: index };
    }).filter(Boolean) as { from: number; to: number, segIndex: number }[];
  }, [ghostMove]);

  const GHOST_COLORS = [
    "#34d399", // emerald-400
    "#60a5fa", // blue-400
    "#f472b6", // pink-400
    "#fbbf24", // amber-400
    "#a78bfa", // violet-400
  ];

  // Aggregate ghost states per point
  const ghostDepartures: Record<number, number[]> = {};
  const ghostArrivals: Record<number, number[]> = {};
  previewSegments.forEach(seg => {
    if (!ghostDepartures[seg.from]) ghostDepartures[seg.from] = [];
    ghostDepartures[seg.from].push(seg.segIndex);

    if (!ghostArrivals[seg.to]) ghostArrivals[seg.to] = [];
    ghostArrivals[seg.to].push(seg.segIndex);
  });

  const turnLabel = turn === 0 ? "Your turn" : `${opponentName ?? "Agent"}'s turn`;
  const turnColor = turn === 0 ? "var(--cg-player-warm)" : "var(--cg-player-cool)";

  const getColXOffset = (col: number, rightHalf: boolean) => {
    const baseX = rightHalf ? R_QUAD_X : L_QUAD_X;
    return baseX + col * POINT_W;
  };

  const getCheckerCenter = (point: number | "bar" | "off", index: number, isP0: boolean) => {
    if (point === "bar") {
      const cy = isP0
        ? TOTAL_H - FRAME - 60 - index * CHECKER_GAP
        : FRAME + 60 + index * CHECKER_GAP;
      return { x: BAR_X + BAR_W / 2, y: cy };
    }

    if (point === "off") {
      const x = isP0 ? R_BEAR_X + BEAR_W / 2 : L_BEAR_X + BEAR_W / 2;
      const cy = TOTAL_H - FRAME - 20 - index * 14 + 5; // +5 for middle of the 10px rect
      return { x, y: cy };
    }

    const isTop = point >= 13;
    const isLeft = (isTop && point <= 18) || (!isTop && point >= 7);
    let col = 0;
    if (isTop) {
      col = isLeft ? point - 13 : point - 19;
    } else {
      col = isLeft ? 12 - point : 6 - point;
    }
    const startX = getColXOffset(col, !isLeft);
    const x = startX + POINT_W / 2;

    const cy = isTop
      ? FRAME + CHECKER_R + index * CHECKER_GAP
      : TOTAL_H - FRAME - CHECKER_R - index * CHECKER_GAP;

    return { x, y: cy };
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
    svgRef.current?.setPointerCapture(e.pointerId);
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

  const renderChecker = (cx: number, cy: number, isP0: boolean, key: string, isDragging: boolean = false, haloColor?: string) => {
    return (
      <g key={key} style={{ pointerEvents: "none" }}>
        {haloColor && (
          <circle
            cx={cx}
            cy={cy}
            r={CHECKER_R + 2}
            fill="none"
            stroke={haloColor}
            strokeWidth="3"
            opacity={0.8}
          />
        )}
        <circle
          cx={cx}
          cy={cy}
          r={CHECKER_R}
          fill={isP0 ? "url(#cg-p0)" : "url(#cg-p1)"}
          stroke={haloColor ? haloColor : "rgba(0,0,0,0.5)"}
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

    const isCrimson = isTop ? col % 2 !== 0 : col % 2 === 0;
    const triColor = isCrimson ? theme.pointDark : theme.pointLight;

    const pts = `${startX},${baseY} ${startX + POINT_W},${baseY} ${startX + POINT_W / 2},${tipY}`;

    const count = board[point - 1];
    const isP0 = count > 0 || (count === 0 && turn === 0); // If empty but turn is 0, we assume dropping P0 checker
    const absCount = Math.abs(count);

    const isDragSource = dragState?.fromPoint === point;
    // Preview departures
    const departuresArr = ghostDepartures[point] || [];
    const arrivalsArr = ghostArrivals[point] || [];
    const departures = departuresArr.length;
    const arrivals = arrivalsArr.length;

    // Visually, if we're dragging from here or departing, we show fewer real checkers
    const displayCount = Math.max(0, absCount - (isDragSource ? 1 : 0) - departures);

    // For ghost visuals, we want to render the normal ones, then the fading out ones, then fading in ones
    const totalPhysicalDots = Math.min(absCount - (isDragSource ? 1 : 0), MAX_DOTS);
    const dotsToShow = Math.min(displayCount, MAX_DOTS);

    // The visual stacked height includes arrivals up to MAX_DOTS
    const combinedDots = Math.min(displayCount + departures + arrivals, MAX_DOTS);
    const extra = displayCount + departures + arrivals > MAX_DOTS ? displayCount + departures + arrivals - MAX_DOTS : 0;

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
          {Array.from({ length: combinedDots }).map((_, i) => {
            const cy = isTop
              ? FRAME + CHECKER_R + i * CHECKER_GAP
              : TOTAL_H - FRAME - CHECKER_R - i * CHECKER_GAP;

            // Determine if this specific dot is solid, a departure ghost, or an arrival ghost
            let isDragging = false;
            let dotIsP0 = isP0;
            let haloColor: string | undefined;

            if (i >= displayCount) {
              if (i < displayCount + departures) {
                // It's a departing checker (show as transparent)
                isDragging = true;
                dotIsP0 = count > 0;
                const depIndex = i - displayCount;
                if (depIndex < departuresArr.length) {
                   haloColor = GHOST_COLORS[departuresArr[depIndex] % GHOST_COLORS.length];
                }
              } else {
                // It's an arriving checker (show as transparent ghost belonging to current turn)
                isDragging = true;
                dotIsP0 = turn === 0;
                const arrIndex = i - (displayCount + departures);
                if (arrIndex < arrivalsArr.length) {
                   haloColor = GHOST_COLORS[arrivalsArr[arrIndex] % GHOST_COLORS.length];
                }
              }
            } else {
              dotIsP0 = count > 0;
            }

            return renderChecker(startX + POINT_W / 2, cy, dotIsP0, `checker-${point}-${i}`, isDragging, haloColor);
          })}
          {extra > 0 && (
            <text
              x={startX + POINT_W / 2}
              y={isTop
                  ? FRAME + CHECKER_R + combinedDots * CHECKER_GAP + 4
                  : TOTAL_H - FRAME - CHECKER_R - combinedDots * CHECKER_GAP + 4}
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

    const p0DeparturesArr = ghostDepartures[25] || [];
    const p0Departures = p0DeparturesArr.length;
    // p1 bar is not playable by the human turn, so we don't ghost it
    const p0Display = Math.max(0, p0Bar - (dragState?.fromPoint === "bar" ? 1 : 0) - p0Departures);
    const p0Combined = Math.min(p0Display + p0Departures, 3);
    const p0Extra = p0Display + p0Departures > 3 ? p0Display + p0Departures - 3 : 0;

    return (
      <g key="bar">
        <rect
          x={BAR_X}
          y={FRAME}
          width={BAR_W}
          height={INNER_H}
          fill={theme.bar}
          stroke={theme.barEdge}
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
          {Array.from({ length: p0Combined }).map((_, i) => {
            const isDragging = i >= p0Display;
            let haloColor: string | undefined;
            if (isDragging) {
              const depIndex = i - p0Display;
              if (depIndex < p0DeparturesArr.length) {
                haloColor = GHOST_COLORS[p0DeparturesArr[depIndex] % GHOST_COLORS.length];
              }
            }
            return renderChecker(BAR_X + BAR_W / 2, TOTAL_H - FRAME - 60 - i * CHECKER_GAP, true, `bar-p0-${i}`, isDragging, haloColor);
          })}
          {p0Extra > 0 && (
            <text
              x={BAR_X + BAR_W / 2}
              y={TOTAL_H - FRAME - 60 - p0Combined * CHECKER_GAP + 4}
              textAnchor="middle"
              fontSize="12"
              fontFamily="var(--cg-font-mono, monospace)"
              fill="var(--cg-fg-4, #4A4339)"
            >
              +{p0Extra}
            </text>
          )}
        </g>
      </g>
    );
  };

  const renderBearOff = () => {
    const [p0Off, p1Off] = off;

    const arrivalsArr = ghostArrivals[0] || [];
    const arrivals = arrivalsArr.length;
    const p0CombinedOff = p0Off + (turn === 0 ? arrivals : 0);
    const p1CombinedOff = p1Off + (turn === 1 ? arrivals : 0);


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
          {Array.from({ length: p1CombinedOff }).map((_, i) => {
            const isGhost = i >= p1Off;
            return (
              <rect
                key={`p1off-${i}`}
                x={L_BEAR_X + 10}
                y={TOTAL_H - FRAME - 20 - i * 14}
                width={BEAR_W - 20}
                height={10}
                rx={3}
                fill="url(#cg-p1)"
                stroke={isGhost && arrivalsArr[i - p1Off] !== undefined ? GHOST_COLORS[arrivalsArr[i - p1Off] % GHOST_COLORS.length] : "rgba(0,0,0,0.5)"}
                strokeWidth={isGhost ? 2 : 1}
                opacity={isGhost ? 0.3 : 1}
              />
            );
          })}
          <text
             x={L_BEAR_X + BEAR_W/2}
             y={TOTAL_H - FRAME - 5}
             textAnchor="middle"
             fontSize="10"
             fontFamily="var(--cg-font-mono, monospace)"
             fill="var(--cg-player-cool, #E8E1CF)"
          >
            {p1CombinedOff}
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
          {Array.from({ length: p0CombinedOff }).map((_, i) => {
            const isGhost = i >= p0Off;
            return (
              <rect
                key={`p0off-${i}`}
                x={R_BEAR_X + 10}
                y={TOTAL_H - FRAME - 20 - i * 14}
                width={BEAR_W - 20}
                height={10}
                rx={3}
                fill="url(#cg-p0)"
                stroke={isGhost && arrivalsArr[i - p0Off] !== undefined ? GHOST_COLORS[arrivalsArr[i - p0Off] % GHOST_COLORS.length] : "rgba(0,0,0,0.5)"}
                strokeWidth={isGhost ? 2 : 1}
                opacity={isGhost ? 0.3 : 1}
              />
            );
          })}
          <text
             x={R_BEAR_X + BEAR_W/2}
             y={TOTAL_H - FRAME - 5}
             textAnchor="middle"
             fontSize="10"
             fontFamily="var(--cg-font-mono, monospace)"
             fill="var(--cg-player-warm, #E3B779)"
          >
            {p0CombinedOff}
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
            {/* Arrowhead markers — one per ghost color so each segment gets a matching tip */}
            {GHOST_COLORS.map((color, i) => (
              <marker
                key={`ghost-arrow-${i}`}
                id={`ghost-arrow-${i}`}
                markerWidth="8"
                markerHeight="8"
                refX="7"
                refY="3"
                orient="auto"
              >
                <path d="M0,0 L0,6 L8,3 z" fill={color} opacity={0.85} />
              </marker>
            ))}
            <linearGradient id="cg-frame" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={theme.frameStart} />
              <stop offset="100%" stopColor={theme.frameEnd} />
            </linearGradient>
            <radialGradient id="cg-felt" cx="50%" cy="50%" r="60%">
              <stop offset="0%" stopColor={theme.feltAccent} />
              <stop offset="100%" stopColor={theme.felt} />
            </radialGradient>
            <radialGradient id="cg-p0" cx="38%" cy="30%" r="70%">
              <stop offset="0%" stopColor={theme.checkerWarm.fill} stopOpacity={0.7} />
              <stop offset="100%" stopColor={theme.checkerWarm.fill} />
            </radialGradient>
            <radialGradient id="cg-p1" cx="38%" cy="30%" r="70%">
              <stop offset="0%" stopColor={theme.checkerCool.fill} stopOpacity={0.7} />
              <stop offset="100%" stopColor={theme.checkerCool.fill} />
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
          <rect x="0" y="0" width={TOTAL_W} height={TOTAL_H} fill="url(#cg-frame)" rx="4" />

          {/* Inner Felt */}
          <rect x={FRAME} y={FRAME} width={TOTAL_W - 2 * FRAME} height={INNER_H} fill="url(#cg-felt)" />

          {/* Bear-Off Trays */}
          {renderBearOff()}

          {/* Points */}
          {Array.from({ length: 24 }).map((_, i) => renderPoint(i + 1))}

          {/* Center Bar */}
          {renderBar()}

          {/* Doubling Cube */}
          {(() => {
            const cubeRectH = 34;
            const cubeRectW = BAR_W - 16;
            const cubeX = BAR_X + 8;
            // y: agent side = top of bar, centered = middle, human side = bottom
            const cubeRectY =
              cubeOwner === 1
                ? FRAME + 5
                : cubeOwner === 0
                  ? TOTAL_H - FRAME - cubeRectH - 5
                  : TOTAL_H / 2 - cubeRectH / 2 - 14;
            const cubeTextY = cubeRectY + cubeRectH * 0.66;
            const isClickable = !!onCubeClick;
            return (
              <g
                onClick={isClickable ? onCubeClick : undefined}
                style={{ cursor: isClickable ? "pointer" : "default" }}
              >
                <rect
                  x={cubeX}
                  y={cubeRectY}
                  width={cubeRectW}
                  height={cubeRectH}
                  rx={5}
                  fill="var(--cg-brass, #E3B779)"
                  stroke="rgba(0,0,0,0.4)"
                  strokeWidth={1.5}
                  opacity={isClickable ? 0.95 : 0.7}
                />
                {isClickable && (
                  <rect
                    x={cubeX - 1}
                    y={cubeRectY - 1}
                    width={cubeRectW + 2}
                    height={cubeRectH + 2}
                    rx={6}
                    fill="none"
                    stroke="var(--cg-brass-hi, #F5D28A)"
                    strokeWidth={1.5}
                    opacity={0.6}
                  />
                )}
                <text
                  x={cubeX + cubeRectW / 2}
                  y={cubeTextY}
                  textAnchor="middle"
                  fontSize={cubeValue >= 10 ? 16 : 20}
                  fontWeight="bold"
                  fontFamily="var(--cg-font-mono, monospace)"
                  fill="#1A1208"
                >
                  {cubeValue}
                </text>
              </g>
            );
          })()}

          {/* Dotted Connecting Lines for Ghost Moves */}
          <g style={{ pointerEvents: "none" }}>
            {previewSegments.map((seg) => {
              // Find the indices for this segment in departures/arrivals arrays
              const depArr = ghostDepartures[seg.from] || [];
              const arrArr = ghostArrivals[seg.to] || [];
              const depIndex = depArr.indexOf(seg.segIndex);
              const arrIndex = arrArr.indexOf(seg.segIndex);

              if (depIndex === -1 || arrIndex === -1) return null;

              // We need to calculate the actual stacked index on the board to position the line
              let fromDisplayIndex = 0;
              if (seg.from === 25) {
                // Bar (P0 is the only human bar we support ghosting from)
                const p0Display = Math.max(0, bar[0] - (dragState?.fromPoint === "bar" ? 1 : 0) - depArr.length);
                fromDisplayIndex = p0Display + depIndex;
              } else {
                const count = board[seg.from - 1] || 0;
                const isDragSource = dragState?.fromPoint === seg.from;
                const absCount = Math.abs(count);
                const displayCount = Math.max(0, absCount - (isDragSource ? 1 : 0) - depArr.length);
                fromDisplayIndex = displayCount + depIndex;
              }

              let toDisplayIndex = 0;
              if (seg.to === 0) {
                 // Off
                 toDisplayIndex = (turn === 0 ? off[0] : off[1]) + arrIndex;
              } else {
                 const count = board[seg.to - 1] || 0;
                 const isDragSource = dragState?.fromPoint === seg.to;
                 const absCount = Math.abs(count);
                 const displayCount = Math.max(0, absCount - (isDragSource ? 1 : 0) - (ghostDepartures[seg.to]?.length || 0));
                 const baseIndex = displayCount + (ghostDepartures[seg.to]?.length || 0);
                 toDisplayIndex = baseIndex + arrIndex;
              }

              const fromCenter = getCheckerCenter(seg.from === 25 ? "bar" : seg.from, Math.min(fromDisplayIndex, MAX_DOTS - 1), turn === 0);
              const toCenter = getCheckerCenter(seg.to === 0 ? "off" : seg.to, seg.to === 0 ? toDisplayIndex : Math.min(toDisplayIndex, MAX_DOTS - 1), turn === 0);

              const color = GHOST_COLORS[seg.segIndex % GHOST_COLORS.length];

              return (
                <line
                  key={`ghost-line-${seg.segIndex}`}
                  x1={fromCenter.x}
                  y1={fromCenter.y}
                  x2={toCenter.x}
                  y2={toCenter.y}
                  stroke={color}
                  strokeWidth="3"
                  strokeDasharray="6, 6"
                  opacity={0.6}
                  markerEnd={`url(#ghost-arrow-${seg.segIndex % GHOST_COLORS.length})`}
                />
              );
            })}
          </g>

          {/* Drag Ghost */}
          {dragState && (
            <g filter="url(#cg-glow)" style={{ pointerEvents: "none" }}>
              <circle
                cx={dragState.svgX}
                cy={dragState.svgY}
                r={CHECKER_R}
                fill={dragState.isP0 ? "url(#cg-p0)" : "url(#cg-p1)"}
                stroke="var(--cg-brass, #E8C07E)"
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
          style={{
            alignSelf: "flex-start",
            border: "1px solid var(--cg-line-2)",
            borderRadius: "var(--cg-radius-sm)",
            padding: "4px 10px",
            fontSize: 12,
            color: "var(--cg-fg-2)",
            background: "var(--cg-bg-2)",
            cursor: "pointer",
            transition: "background 120ms ease",
          }}
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
          <span style={{ color: "var(--cg-player-cool)" }} className="font-semibold">{opponentName ?? "Agent"}</span>{" "}
          borne off: {off[1]} / 15 · <span className="font-mono">{pip1} pip{pip1 !== 1 ? "s" : ""}</span>
        </span>
      </div>
    </div>
  );
}
