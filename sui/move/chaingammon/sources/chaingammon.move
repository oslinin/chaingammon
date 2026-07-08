/// Placeholder module for the `chaingammon` package scaffold (Task 0 of
/// docs/superpowers/plans/2026-07-08-sui-port.md). Task 1 adds `elo.move`,
/// Task 2 adds `agent.move`, Task 3 adds `match.move` alongside this file.
module chaingammon::version {
    /// Bumped whenever the on-chain package logic changes in a way callers
    /// (the app, scripts) should be aware of. Purely informational in v1 —
    /// no on-chain migration logic depends on it yet.
    const PACKAGE_VERSION: u64 = 1;

    public fun package_version(): u64 {
        PACKAGE_VERSION
    }
}
