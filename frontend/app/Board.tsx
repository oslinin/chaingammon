// Phase 14: visual backgammon board. Phase 27: click-to-move interaction.
// Phase 31: drag-and-drop — onDragStart/onDrop on PointCell enable HTML5 drag.
//
// Layout (from player 0 / human's perspective):
//   Top row  — points 13..24 left→right (player 0 enters at 24, moves left)
//   Bottom row — points 12..1  left→right (player 0 bears off at 1..6)
//
// board[i] = checkers on point (i+1).
//   Positive → player 0 (human, blue)
//   Negative → player 1 (agent, red)
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

  const dot = (
    <div
      className={`h-4 w-4 shrink-0 rounded-full ${
        isP0
          ? "bg-blue-500 dark:bg-blue-400"
          : "bg-red-500 dark:bg-red-400"
      }`}
    />
  );

  const dots = Array.from({ length: dotsToShow }, (_, i) => (
    <div key={i}>{dot}</div>
  ));

  const extraLabel = extra > 0 && (
    <span className="text-[9px] font-mono text-zinc-500 dark:text-zinc-400">
      +{extra}
    </span>
  );

  // Cell is draggable when it has player-0 (blue) checkers and the drag handler is wired.
  const isDraggable = !!onDragStart && count > 0;

  const classes = [
    "flex flex-col items-center gap-0.5",
    onClick ? "cursor-pointer hover:opacity-75" : "",
    isDraggable ? "cursor-grab" : "",
    isSelected
      ? "rounded bg-amber-100 ring-1 ring-amber-400 dark:bg-amber-900/30"
      : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      // data-testid keyed by zero-based index for match-board-state.spec.ts.
      // data-point / data-count are 1-indexed signed attrs for piece-stability.spec.ts.
      data-testid={`point-${point - 1}`}
      data-point={point}
      data-count={count}
      data-selected={isSelected ? "true" : undefined}
      className={classes}
      style={{ width: 24 }}
      onClick={onClick}
      draggable={isDraggable}
      onDragStart={isDraggable ? (e) => { e.dataTransfer.effectAllowed = "move"; onDragStart!(); } : undefined}
      onDragOver={onDrop ? (e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; } : undefined}
      onDrop={onDrop ? (e) => { e.preventDefault(); onDrop(); } : undefined}
    >
      {/* Point label */}
      {!flip && (
        <span className="text-[9px] font-mono text-zinc-400 dark:text-zinc-500">
          {point}
        </span>
      )}
      {/* Checkers — flip reverses order so top-row dots grow downward */}
      {flip ? (
        <div className="flex flex-col items-center gap-0.5">
          {extra > 0 && extraLabel}
          {[...dots].reverse()}
        </div>
      ) : (
        <div className="flex flex-col items-center gap-0.5">
          {dots}
          {extra > 0 && extraLabel}
        </div>
      )}
      {flip && (
        <span className="text-[9px] font-mono text-zinc-400 dark:text-zinc-500">
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
  const classes = [
    "flex w-8 flex-col items-center justify-center gap-1 border-x border-zinc-300 dark:border-zinc-600",
    onBarClick ? "cursor-pointer hover:opacity-75" : "",
    isBarSelected
      ? "bg-amber-100 ring-1 ring-amber-400 dark:bg-amber-900/30"
      : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={classes} onClick={onBarClick}>
      {p1Bar > 0 && (
        <div className="flex flex-col items-center gap-0.5">
          {Array.from({ length: Math.min(p1Bar, 3) }, (_, i) => (
            <div
              key={i}
              className="h-3 w-3 rounded-full bg-red-500 dark:bg-red-400"
            />
          ))}
          {p1Bar > 3 && (
            <span className="text-[9px] font-mono text-zinc-500">
              +{p1Bar - 3}
            </span>
          )}
        </div>
      )}
      <span className="text-[8px] font-mono text-zinc-400 dark:text-zinc-500">
        BAR
      </span>
      {p0Bar > 0 && (
        <div className="flex flex-col items-center gap-0.5">
          {Array.from({ length: Math.min(p0Bar, 3) }, (_, i) => (
            <div
              key={i}
              className="h-3 w-3 rounded-full bg-blue-500 dark:bg-blue-400"
            />
          ))}
          {p0Bar > 3 && (
            <span className="text-[9px] font-mono text-zinc-500">
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
  onPointClick,
  onBarClick,
  onOffClick,
  selectedPoint,
  onDragStart,
  onDrop,
}: BoardProps) {
  // Top row: points 13–24 (indices 12–23), displayed left→right.
  const topPoints = Array.from({ length: 12 }, (_, i) => i + 13); // [13..24]
  // Bottom row: points 12–1 (indices 11–0), displayed left→right (12 down to 1).
  const bottomPoints = Array.from({ length: 12 }, (_, i) => 12 - i); // [12..1]

  const turnLabel = turn === 0 ? "Your turn (blue)" : "Agent's turn (red)";
  const turnColor =
    turn === 0
      ? "text-blue-600 dark:text-blue-400"
      : "text-red-600 dark:text-red-400";

  return (
    <div className="flex flex-col gap-2">
      {/* Turn indicator */}
      <p className={`text-sm font-semibold ${turnColor}`}>{turnLabel}</p>

      <div className="overflow-x-auto">
        <div className="inline-flex flex-col gap-0 rounded-lg border border-zinc-300 bg-amber-50 p-2 dark:border-zinc-600 dark:bg-zinc-900">
          {/* Top row — points 13..24 */}
          <div className="flex items-start gap-0.5">
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

          {/* Spacer */}
          <div className="h-3 border-y border-zinc-300 dark:border-zinc-600" />

          {/* Bottom row — points 12..1 */}
          <div className="flex items-end gap-0.5">
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
            <div className="flex w-8 items-center justify-center">
              <div className="h-3 w-px bg-zinc-300 dark:bg-zinc-600" />
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

      {/* Bear-off button — shown only when a source checker is selected */}
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

      {/* Off-board checkers */}
      <div className="flex gap-6 text-sm text-zinc-600 dark:text-zinc-400">
        <span>
          <span className="text-blue-500 dark:text-blue-400 font-semibold">
            You
          </span>{" "}
          borne off: {off[0]} / 15
        </span>
        <span>
          <span className="text-red-500 dark:text-red-400 font-semibold">
            Agent
          </span>{" "}
          borne off: {off[1]} / 15
        </span>
      </div>
    </div>
  );
}
