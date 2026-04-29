// Phase 21: fixture page for Playwright ENS-name-claim validation tests.
//
// Renders ClaimForm in isolation with a hard-coded test address so the
// Playwright suite can assert validation messages and button states without
// needing a live wallet or a blockchain connection.
import { ClaimForm } from "../ProfileBadge";

const TEST_ADDRESS = "0x1111111111111111111111111111111111111111" as const;

export default function TestEnsClaimPage() {
  return (
    <div className="flex min-h-screen items-center justify-center p-8">
      <ClaimForm address={TEST_ADDRESS} />
    </div>
  );
}
