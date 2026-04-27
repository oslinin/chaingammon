// Phase 14: visual backgammon board.
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

interface BoardProps {
  board: number[]; // length 24; index = point - 1
  bar: number[]; // [p0_bar, p1_bar]
  off: number[]; // [p0_off, p1_off]
  turn: number; // 0 = human, 1 = agent
}

// Maximum checkers shown as dots before falling back to a "+N" label.
const MAX_DOTS = 5;

interface PointProps {
  point: number; // 1-indexed point number
  count: number; // signed: positive = p0, negative = p1
  flip?: boolean; // true for top row (dots grow downward)
}

function PointCell({ point, count, flip = false }: PointProps) {
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

  return (
    <div className="flex flex-col items-center gap-0.5" style={{ width: 24 }}>
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

function BarCell({ p0Bar, p1Bar }: { p0Bar: number; p1Bar: number }) {
  return (
    <div className="flex w-8 flex-col items-center justify-center gap-1 border-x border-zinc-300 dark:border-zinc-600">
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

export function Board({ board, bar, off, turn }: BoardProps) {
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
              />
            ))}
            <BarCell p0Bar={bar[0]} p1Bar={bar[1]} />
            {topPoints.slice(6).map((pt) => (
              <PointCell
                key={pt}
                point={pt}
                count={board[pt - 1]}
                flip={true}
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
              />
            ))}
          </div>
        </div>
      </div>

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
