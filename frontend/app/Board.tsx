// Phase 14: visual backgammon board. Phase 27: click-to-move interaction.
// Phase 31: drag-and-drop — onDragStart/onDrop on PointCell enable HTML5 drag.
//
// Layout (from player 0 / human's perspective):
//   Top row  — points 13..24 left→right (player 0 enters at 24, moves left)
//   Bottom row — points 12..1  left→right (player 0 bears off at 1..6)
//
// board[i] = checkers on point (i+1).
//   Positive → player 0 (human, warm gold)
//   Negative → player 1 (agent, bone ivory)
//
// bar[0] = player 0 checkers on bar, bar[1] = player 1 checkers on bar.
// off[0] = player 0 borne off, off[1] = player 1 borne off.
//
// Phase 27 additions:
//   onPointClick(n) — called when the user clicks a point column (1-24).
//   onBarClick()    — called when the user clicks the bar zone.
//   onOffClick()    — called when the user clicks the bear-off button.
//   selectedPoint   — highlights the currently-selected source (1-24 or 25=bar).
//   data-point / data-count attributes on every PointCell for Playwright selectors.
//
// Phase 31 additions:
//   onDragStart(n)  — fired when the user begins dragging from point n (1-24).
//   onDrop(n)       — fired when the user drops onto point n (1-24).
//   A PointCell is draggable only when it has player-0 checkers and onDragStart
//   is provided. All PointCells accept drops when onDrop is provided.

interface BoardProps {
  board: number[]; // length 24; index = point - 1
  bar: number[]; // [p0_bar, p1_bar]
  off: number[]; // [p0_off, p1_off]
  turn: number; // 0 = human, 1 = agent
  opponentName?: string; // display name for the agent (player 1)
  // Click-to-move (all optional — Board is a pure visual component when omitted).
  onPointClick?: (point: number) => void;
  onBarClick?: () => void;
  onOffClick?: () => void;
  selectedPoint?: number | null; // 1-24 = board point, 25 = bar
  // Drag-and-drop (Phase 31 — optional, independent of click props).
  onDragStart?: (point: number) => void;
  onDrop?: (point: number) => void;
}

// Maximum checkers shown as dots before falling back to a "+N" label.
const MAX_DOTS = 5;

// Checker coin — warm gold for player 0, bone ivory for player 1.
function Checker({ isP0, size = 16 }: { isP0: boolean; size?: number }) {
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        flexShrink: 0,
        background: isP0 ? "var(--cg-player-warm)" : "var(--cg-player-cool)",
        boxShadow: "var(--cg-shadow-coin)",
      }}
    />
  );
}

interface PointProps {
  point: number; // 1-indexed point number
  count: number; // signed: positive = p0, negative = p1
  flip?: boolean; // true for top row (dots grow downward)
  onClick?: () => void;
  isSelected?: boolean;
  // Drag-and-drop (Phase 31).
  onDragStart?: () => void; // drag begins from this cell
  onDrop?: () => void;      // checker dropped onto this cell
}

function PointCell({ point, count, flip = false, onClick, isSelected, onDragStart, onDrop }: PointProps) {
  const abs = Math.abs(count);
  const isP0 = count > 0;
  const dotsToShow = Math.min(abs, MAX_DOTS);
  const extra = abs > MAX_DOTS ? abs - MAX_DOTS : 0;

  const dots = Array.from({ length: dotsToShow }, (_, i) => (
    <Checker key={i} isP0={isP0} size={16} />
  ));

  const extraLabel = extra > 0 && (
    <span style={{ fontSize: 9, fontFamily: "var(--cg-font-mono)", color: "var(--cg-fg-3)" }}>
      +{extra}
    </span>
  );

  const isDraggable = !!onDragStart && count > 0;

  return (
    <div
      data-testid={`point-${point - 1}`}
      data-point={point}
      data-count={count}
      data-selected={isSelected ? "true" : undefined}
      style={{
        width: 24,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 2,
        cursor: onClick ? "pointer" : isDraggable ? "grab" : "default",
        borderRadius: "var(--cg-radius-sm)",
        background: isSelected ? "rgba(201,155,92,0.12)" : "transparent",
        outline: isSelected ? "1px solid var(--cg-brass)" : "none",
        outlineOffset: 1,
        transition: "background 120ms ease",
      }}
      onClick={onClick}
      draggable={isDraggable}
      onDragStart={isDraggable ? (e) => { e.dataTransfer.effectAllowed = "move"; onDragStart!(); } : undefined}
      onDragOver={onDrop ? (e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; } : undefined}
      onDrop={onDrop ? (e) => { e.preventDefault(); onDrop(); } : undefined}
    >
      {/* Point label */}
      {!flip && (
        <span style={{ fontSize: 9, fontFamily: "var(--cg-font-mono)", color: "var(--cg-fg-4)" }}>
          {point}
        </span>
      )}
      {/* Checkers — flip reverses order so top-row dots grow downward */}
      {flip ? (
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2 }}>
          {extra > 0 && extraLabel}
          {[...dots].reverse()}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2 }}>
          {dots}
          {extra > 0 && extraLabel}
        </div>
      )}
      {flip && (
        <span style={{ fontSize: 9, fontFamily: "var(--cg-font-mono)", color: "var(--cg-fg-4)" }}>
          {point}
        </span>
      )}
    </div>
  );
}

interface BarCellProps {
  p0Bar: number;
  p1Bar: number;
  onBarClick?: () => void;
  isBarSelected?: boolean;
}

function BarCell({ p0Bar, p1Bar, onBarClick, isBarSelected }: BarCellProps) {
  return (
    <div
      onClick={onBarClick}
      style={{
        width: 32,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 4,
        borderLeft: "1px solid var(--cg-line-2)",
        borderRight: "1px solid var(--cg-line-2)",
        cursor: onBarClick ? "pointer" : "default",
        background: isBarSelected ? "rgba(201,155,92,0.10)" : "transparent",
        outline: isBarSelected ? "1px solid var(--cg-brass)" : "none",
        transition: "background 120ms ease",
      }}
    >
      {p1Bar > 0 && (
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2 }}>
          {Array.from({ length: Math.min(p1Bar, 3) }, (_, i) => (
            <Checker key={i} isP0={false} size={12} />
          ))}
          {p1Bar > 3 && (
            <span style={{ fontSize: 9, fontFamily: "var(--cg-font-mono)", color: "var(--cg-fg-3)" }}>
              +{p1Bar - 3}
            </span>
          )}
        </div>
      )}
      <span style={{ fontSize: 8, fontFamily: "var(--cg-font-mono)", color: "var(--cg-fg-4)", letterSpacing: "0.05em" }}>
        BAR
      </span>
      {p0Bar > 0 && (
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2 }}>
          {Array.from({ length: Math.min(p0Bar, 3) }, (_, i) => (
            <Checker key={i} isP0={true} size={12} />
          ))}
          {p0Bar > 3 && (
            <span style={{ fontSize: 9, fontFamily: "var(--cg-font-mono)", color: "var(--cg-fg-3)" }}>
              +{p0Bar - 3}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

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
  const topPoints = Array.from({ length: 12 }, (_, i) => i + 13); // [13..24]
  const bottomPoints = Array.from({ length: 12 }, (_, i) => 12 - i); // [12..1]

  const turnLabel = turn === 0 ? "Your turn" : `${opponentName ?? "Agent"}'s turn`;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {/* Turn indicator */}
      <p
        style={{
          fontSize: 13,
          fontWeight: 600,
          color: turn === 0 ? "var(--cg-brass)" : "var(--cg-fg-2)",
          fontFamily: "var(--cg-font-sans)",
        }}
      >
        {turnLabel}
      </p>

      <div style={{ overflowX: "auto" }}>
        <div
          style={{
            display: "inline-flex",
            flexDirection: "column",
            gap: 0,
            borderRadius: "var(--cg-radius)",
            border: "1px solid var(--cg-line-2)",
            background: "var(--cg-bg-felt)",
            padding: 8,
            boxShadow: "var(--cg-shadow-1)",
          }}
        >
          {/* Top row — points 13..24 */}
          <div style={{ display: "flex", alignItems: "flex-start", gap: 2 }}>
            {topPoints.slice(0, 6).map((pt) => (
              <PointCell
                key={pt}
                point={pt}
                count={board[pt - 1]}
                flip={true}
                onClick={onPointClick ? () => onPointClick(pt) : undefined}
                isSelected={selectedPoint === pt}
                onDragStart={onDragStart ? () => onDragStart(pt) : undefined}
                onDrop={onDrop ? () => onDrop(pt) : undefined}
              />
            ))}
            <BarCell
              p0Bar={bar[0]}
              p1Bar={bar[1]}
              onBarClick={onBarClick}
              isBarSelected={selectedPoint === 25}
            />
            {topPoints.slice(6).map((pt) => (
              <PointCell
                key={pt}
                point={pt}
                count={board[pt - 1]}
                flip={true}
                onClick={onPointClick ? () => onPointClick(pt) : undefined}
                isSelected={selectedPoint === pt}
                onDragStart={onDragStart ? () => onDragStart(pt) : undefined}
                onDrop={onDrop ? () => onDrop(pt) : undefined}
              />
            ))}
          </div>

          {/* Mid spacer */}
          <div style={{ height: 12, borderTop: "1px solid var(--cg-line-2)", borderBottom: "1px solid var(--cg-line-2)" }} />

          {/* Bottom row — points 12..1 */}
          <div style={{ display: "flex", alignItems: "flex-end", gap: 2 }}>
            {bottomPoints.slice(0, 6).map((pt) => (
              <PointCell
                key={pt}
                point={pt}
                count={board[pt - 1]}
                flip={false}
                onClick={onPointClick ? () => onPointClick(pt) : undefined}
                isSelected={selectedPoint === pt}
                onDragStart={onDragStart ? () => onDragStart(pt) : undefined}
                onDrop={onDrop ? () => onDrop(pt) : undefined}
              />
            ))}
            <div style={{ width: 32, display: "flex", alignItems: "center", justifyContent: "center" }}>
              <div style={{ width: 1, height: 12, background: "var(--cg-line-2)" }} />
            </div>
            {bottomPoints.slice(6).map((pt) => (
              <PointCell
                key={pt}
                point={pt}
                count={board[pt - 1]}
                flip={false}
                onClick={onPointClick ? () => onPointClick(pt) : undefined}
                isSelected={selectedPoint === pt}
                onDragStart={onDragStart ? () => onDragStart(pt) : undefined}
                onDrop={onDrop ? () => onDrop(pt) : undefined}
              />
            ))}
          </div>
        </div>
      </div>

      {/* Bear-off button */}
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

      {/* Off-board checkers + pip counts */}
      {(() => {
        let pip0 = (bar[0] ?? 0) * 25;
        let pip1 = (bar[1] ?? 0) * 25;
        for (let i = 0; i < 24; i++) {
          if (board[i] > 0) pip0 += (i + 1) * board[i];
          if (board[i] < 0) pip1 += (24 - i) * (-board[i]);
        }
        return (
          <div style={{ display: "flex", gap: 24, fontSize: 13, color: "var(--cg-fg-2)", fontFamily: "var(--cg-font-sans)" }}>
            <span>
              <span style={{ color: "var(--cg-player-warm)", fontWeight: 600 }}>You</span>{" "}
              borne off: {off[0]} / 15 · <span style={{ fontFamily: "var(--cg-font-mono)" }}>{pip0} pip{pip0 !== 1 ? "s" : ""}</span>
            </span>
            <span>
              <span style={{ color: "var(--cg-player-cool)", fontWeight: 600 }}>{opponentName ?? "Agent"}</span>{" "}
              borne off: {off[1]} / 15 · <span style={{ fontFamily: "var(--cg-font-mono)" }}>{pip1} pip{pip1 !== 1 ? "s" : ""}</span>
            </span>
          </div>
        );
      })()}
    </div>
  );
}
