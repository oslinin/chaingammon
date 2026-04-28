// Test fixture page — renders DiceRoll with static values so Playwright
// can verify dice dimensions without requiring any blockchain connection.
import { DiceRoll } from "../DiceRoll";

export default function TestDicePage() {
  return (
    <main className="p-8">
      <DiceRoll dice={[1, 2, 3, 4, 5, 6]} />
    </main>
  );
}
