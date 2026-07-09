/// profile.move — HumanProfile registry (Task 5).
///
/// Replaces ENS subnames + text records (see the design spec's compat
/// table): a human's on-chain identity here is a `HumanProfile` object
/// (display name, ELO starting at 1500, match count) rather than an ENS
/// text record. `HumanProfile` is a SHARED object (`key` only, no `store`)
/// — not owned by the human — specifically so `game_match::settle_cosigned_with_profiles`
/// can take `&mut HumanProfile` for BOTH sides in one settling transaction
/// regardless of who submits it, exactly like `Match` itself. An owned
/// object could only be passed as a transaction input by its owner, which
/// would make it impossible for either player (or a sponsor) to settle a
/// match touching the *other* player's profile.
///
/// `ProfileRegistry` is the single shared lookup table (address -> profile
/// object id) a client walks before building a settle PTB: look up both
/// sides' profile ids, then pass `&mut HumanProfile` for each as arguments.
module chaingammon::profile {
    use std::string::{Self, String};

    use sui::event;
    use sui::table::{Self, Table};

    // ── Errors ──────────────────────────────────────────────────────────
    // Numeric, not named-export — see agent.move's Errors section for why
    // Move has no `public const`.
    const EProfileAlreadyExists: u64 = 0;

    // ── Types ───────────────────────────────────────────────────────────

    public struct HumanProfile has key {
        id: UID,
        owner: address,
        display_name: String,
        elo: u64,
        match_count: u32,
    }

    /// Singleton shared object created at publish time (see `init` below).
    public struct ProfileRegistry has key {
        id: UID,
        profiles: Table<address, ID>,
    }

    // ── Events ──────────────────────────────────────────────────────────

    public struct ProfileCreated has copy, drop {
        profile_id: ID,
        owner: address,
        display_name: String,
    }

    public struct ProfileResultRecorded has copy, drop {
        profile_id: ID,
        new_elo: u64,
        match_count: u32,
    }

    // ── Init: share the single ProfileRegistry ───────────────────────────
    //
    // No one-time-witness needed here — this module doesn't claim a
    // Publisher or a TransferPolicy (HumanProfile isn't Kiosk-tradable), so
    // a plain `init(ctx)` genesis function is enough to create and share
    // the one registry this package will ever have.

    fun init(ctx: &mut TxContext) {
        transfer::share_object(ProfileRegistry {
            id: object::new(ctx),
            profiles: table::new(ctx),
        });
    }

    /// `init` only runs at package publish time and is private to this
    /// module, so tests in other modules (game_match_tests) that need a
    /// ProfileRegistry construct one directly through this test-only
    /// escape hatch instead.
    #[test_only]
    public fun new_registry_for_testing(ctx: &mut TxContext): ProfileRegistry {
        ProfileRegistry { id: object::new(ctx), profiles: table::new(ctx) }
    }

    // ── Create ────────────────────────────────────────────────────────────

    /// Create and share a new HumanProfile for the caller, recording it in
    /// the registry. Aborts if the caller already has a profile — one
    /// profile per address, matching ENS's one-subname-per-address shape.
    public fun create_profile(
        registry: &mut ProfileRegistry,
        display_name: vector<u8>,
        ctx: &mut TxContext,
    ) {
        let owner = tx_context::sender(ctx);
        assert!(!table::contains(&registry.profiles, owner), EProfileAlreadyExists);

        let display_name_str = string::utf8(display_name);
        let profile = HumanProfile {
            id: object::new(ctx),
            owner,
            display_name: display_name_str,
            elo: 1500,
            match_count: 0,
        };
        let profile_id = object::id(&profile);
        table::add(&mut registry.profiles, owner, profile_id);

        event::emit(ProfileCreated { profile_id, owner, display_name: display_name_str });
        transfer::share_object(profile);
    }

    // ── Match settlement hook ─────────────────────────────────────────────

    /// Only chaingammon::game_match (same package) may call this. Mirrors
    /// agent::record_result's "one bump per match" pattern.
    public(package) fun record_result(profile: &mut HumanProfile, new_elo: u64) {
        profile.elo = new_elo;
        profile.match_count = profile.match_count + 1;
        event::emit(ProfileResultRecorded {
            profile_id: object::id(profile),
            new_elo,
            match_count: profile.match_count,
        });
    }

    // ── Read-only accessors ───────────────────────────────────────────────

    public fun has_profile(registry: &ProfileRegistry, addr: address): bool {
        table::contains(&registry.profiles, addr)
    }

    public fun profile_id_for(registry: &ProfileRegistry, addr: address): ID {
        *table::borrow(&registry.profiles, addr)
    }

    public fun id(profile: &HumanProfile): ID { object::id(profile) }
    public fun owner(profile: &HumanProfile): address { profile.owner }
    public fun display_name(profile: &HumanProfile): String { profile.display_name }
    public fun elo(profile: &HumanProfile): u64 { profile.elo }
    public fun match_count(profile: &HumanProfile): u32 { profile.match_count }
}
