// Phase 14: visual dice display.
// Shows each die as a rounded square with the pip count written in the
// centre. Used on the match page to show the current roll.

interface DiceRollProps {
  dice: number[] | null;
}

// Dot pattern for standard die faces (1-6).
const DOT_POSITIONS: Record<number, [number, number][]> = {
  1: [[50, 50]],
  2: [
    [25, 25],
    [75, 75],
  ],
  3: [
    [25, 25],
    [50, 50],
    [75, 75],
  ],
  4: [
    [25, 25],
    [75, 25],
    [25, 75],
    [75, 75],
  ],
  5: [
    [25, 25],
    [75, 25],
    [50, 50],
    [25, 75],
    [75, 75],
  ],
  6: [
    [25, 20],
    [75, 20],
    [25, 50],
    [75, 50],
    [25, 80],
    [75, 80],
  ],
};

function Die({ value }: { value: number }) {
  const dots = DOT_POSITIONS[value] ?? [[50, 50]];
  return (
    <svg
      viewBox="0 0 100 100"
      className="h-6 w-6 rounded-md bg-white shadow-md dark:bg-zinc-800"
      aria-label={`Die showing ${value}`}
    >
      <rect
        x="2"
        y="2"
        width="96"
        height="96"
        rx="16"
        ry="16"
        fill="none"
        stroke="currentColor"
        strokeWidth="4"
        className="text-zinc-300 dark:text-zinc-600"
      />
      {dots.map(([cx, cy], i) => (
        <circle
          key={i}
          cx={cx}
          cy={cy}
          r="8"
          className="fill-zinc-800 dark:fill-zinc-100"
        />
      ))}
    </svg>
  );
}

export function DiceRoll({ dice }: DiceRollProps) {
  if (!dice || dice.length === 0) {
    return null;
  }
  return (
    <div className="flex items-center gap-2" aria-label={`Rolled ${dice.join(" and ")}`}>
      {dice.map((d, i) => (
        <Die key={i} value={d} />
      ))}
    </div>
  );
}
