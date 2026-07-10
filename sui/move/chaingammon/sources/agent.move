/// agent.move — the tradable, bankrolled AI agent object.
///
/// Replaces contracts/src/AgentRegistry.sol (ERC-721 iNFT: tier, per-agent
/// data hashes, match count, experience version) and
/// contracts/src/AgentVault.sol (per-agent ETH balance, owner-gated
/// withdraw) with a single owned Sui object. There is no separate registry
/// contract: an `Agent` IS the NFT, and it carries its own bankroll
/// (`Balance<SUI>`) directly rather than through a side-mapping keyed by
/// token id.
///
/// `Agent` has `store` (in addition to `key`) specifically so it can later
/// be placed in a Kiosk for trading (Task 8) — this is also why an explicit
/// `owner: address` field exists alongside Sui's native object custody:
/// once an Agent sits inside a Kiosk, the *Sui-level* owner of the object is
/// the Kiosk (a shared object), not the human who can list/withdraw/receive
/// proceeds from it. Every owner-gated function here checks the explicit
/// `owner` field, not "whoever currently holds the object" — Task 8 must
/// update `owner` on a successful Kiosk purchase for this to stay correct
/// after a trade.
module chaingammon::agent {
    use std::string::{Self, String};

    use sui::balance::{Self, Balance};
    use sui::coin::{Self, Coin};
    use sui::event;
    use sui::package;
    use sui::sui::SUI;
    use sui::transfer_policy;

    use chaingammon::elo;

    // ── Errors ──────────────────────────────────────────────────────────
    // Numeric, not named-export, because Move `const`s are private to their
    // declaring module (there is no `public const`) — tests reference these
    // by their literal values (see tests/agent_tests.move for the mapping).
    const ENotOwner: u64 = 0;
    const EInsufficientBalance: u64 = 1;
    const EZeroAmount: u64 = 2;
    const ENoAccess: u64 = 3;

    // ── Types ───────────────────────────────────────────────────────────

    /// A pointer to a Walrus blob: its id and a hash of its plaintext
    /// (post-decrypt) content, for integrity verification after fetch.
    /// Mirrors the "Walrus blob id + content hash" comment on Agent.weights_blob
    /// in docs/superpowers/specs/2026-07-07-sui-port-design.md §3.
    public struct BlobRef has store, copy, drop {
        id: vector<u8>,
        content_hash: vector<u8>,
    }

    public struct Agent has key, store {
        id: UID,
        name: String,
        tier: u8,
        owner: address,
        // Absent until Task 7 uploads weights to Walrus and calls
        // set_weights — an Agent is mintable before it has a trained model.
        weights_blob: Option<BlobRef>,
        overlay_blob: Option<BlobRef>,
        elo: u64,
        match_count: u32,
        experience_version: u32,
        bankroll: Balance<SUI>,
    }

    // ── Events ──────────────────────────────────────────────────────────

    public struct AgentMinted has copy, drop {
        agent_id: ID,
        owner: address,
        tier: u8,
        name: String,
    }

    public struct Deposited has copy, drop {
        agent_id: ID,
        from: address,
        amount: u64,
    }

    public struct Withdrawn has copy, drop {
        agent_id: ID,
        to: address,
        amount: u64,
    }

    public struct WeightsSet has copy, drop {
        agent_id: ID,
        blob_id: vector<u8>,
        content_hash: vector<u8>,
    }

    public struct ResultRecorded has copy, drop {
        agent_id: ID,
        new_elo: u64,
        match_count: u32,
    }

    public struct OwnershipClaimed has copy, drop {
        agent_id: ID,
        new_owner: address,
    }

    // ── One-time witness + Kiosk TransferPolicy (Task 8 prerequisite) ────
    //
    // Claiming a Publisher and creating a no-rules TransferPolicy<Agent> at
    // publish time is what lets Agent be placed in and purchased from a
    // Kiosk later — Kiosk purchases are blocked without a TransferPolicy for
    // the type being sold. v1 policy has no rules (no royalty, no lock);
    // Task 8 can add rules to this same policy later without redeploying
    // the Agent type itself.

    public struct AGENT has drop {}

    fun init(otw: AGENT, ctx: &mut TxContext) {
        let publisher = package::claim(otw, ctx);
        let (policy, policy_cap) = transfer_policy::new<Agent>(&publisher, ctx);
        transfer::public_transfer(publisher, tx_context::sender(ctx));
        transfer::public_share_object(policy);
        transfer::public_transfer(policy_cap, tx_context::sender(ctx));
    }

    // ── Mint ────────────────────────────────────────────────────────────

    /// Pure constructor — does not transfer. Exposed separately from the
    /// `mint` entry function so tests can build and inspect an Agent
    /// without a transfer round-trip.
    public fun new(name: vector<u8>, tier: u8, ctx: &mut TxContext): Agent {
        let owner = tx_context::sender(ctx);
        let name_str = string::utf8(name);
        let agent = Agent {
            id: object::new(ctx),
            name: name_str,
            tier,
            owner,
            weights_blob: option::none(),
            overlay_blob: option::none(),
            elo: elo::initial(),
            match_count: 0,
            experience_version: 0,
            bankroll: balance::zero(),
        };
        event::emit(AgentMinted { agent_id: object::id(&agent), owner, tier, name: name_str });
        agent
    }

    /// CLI/PTB entrypoint: mint and transfer to the caller in one call.
    public fun mint(name: vector<u8>, tier: u8, ctx: &mut TxContext) {
        let agent = new(name, tier, ctx);
        transfer::public_transfer(agent, tx_context::sender(ctx));
    }

    // ── Ownership sync (Task 8: Kiosk trading) ────────────────────────────

    /// Sync the explicit `owner` field to `ctx`'s sender. Needs no
    /// permission check beyond what Sui's own object model already
    /// enforces: `&mut Agent` is only obtainable in a transaction by
    /// whoever currently holds the object (or, mid-PTB, whoever just
    /// received it as a call result — e.g. straight out of
    /// `sui::kiosk::purchase`), so a party who does not hold the Agent can
    /// never construct a transaction that calls this in the first place.
    /// A buyer calls this immediately after `kiosk::purchase` +
    /// `transfer_policy::confirm_request` in the same PTB (see
    /// `sui/scripts/trade_agent.ts`) — without it, `owner` would keep
    /// pointing at the seller, and every owner-gated function here
    /// (`withdraw`, `set_weights`, `seal_approve`) would stay wrong after
    /// a trade, which is exactly the bug this module's header comment
    /// flags as Task 8's job to close.
    public fun claim_ownership(agent: &mut Agent, ctx: &TxContext) {
        let new_owner = tx_context::sender(ctx);
        agent.owner = new_owner;
        event::emit(OwnershipClaimed { agent_id: object::id(agent), new_owner });
    }

    // ── Bankroll ────────────────────────────────────────────────────────

    /// Fund the agent's bankroll. Anyone may sponsor an agent — mirrors
    /// AgentVault.deposit's "anyone can call" semantics.
    public fun deposit(agent: &mut Agent, payment: Coin<SUI>, ctx: &TxContext) {
        let amount = coin::value(&payment);
        assert!(amount > 0, EZeroAmount);
        balance::join(&mut agent.bankroll, coin::into_balance(payment));
        event::emit(Deposited { agent_id: object::id(agent), from: tx_context::sender(ctx), amount });
    }

    /// Withdraw `amount` from the bankroll. Owner-only (checked against the
    /// explicit `owner` field, not Sui object custody — see the module
    /// doc comment). Returns the Coin so callers compose it in a PTB;
    /// `withdraw_to_sender` below is the simple CLI-callable wrapper.
    public fun withdraw(agent: &mut Agent, amount: u64, ctx: &mut TxContext): Coin<SUI> {
        assert!(tx_context::sender(ctx) == agent.owner, ENotOwner);
        assert!(amount > 0, EZeroAmount);
        assert!(balance::value(&agent.bankroll) >= amount, EInsufficientBalance);
        // coin::from_balance needs a mutable TxContext (it derives a fresh
        // UID for the new Coin object), so this function's ctx can't be the
        // read-only &TxContext that would otherwise suffice for the sender
        // check above.
        let coin = coin::from_balance(balance::split(&mut agent.bankroll, amount), ctx);
        event::emit(Withdrawn { agent_id: object::id(agent), to: tx_context::sender(ctx), amount });
        coin
    }

    public fun withdraw_to_sender(agent: &mut Agent, amount: u64, ctx: &mut TxContext) {
        let coin = withdraw(agent, amount, ctx);
        transfer::public_transfer(coin, tx_context::sender(ctx));
    }

    // ── Weights (Task 7 wires the real Walrus/Seal upload path) ─────────

    /// Owner-only. Records where the agent's (Seal-encrypted) weights live
    /// on Walrus and a hash of their plaintext content.
    public fun set_weights(
        agent: &mut Agent,
        blob_id: vector<u8>,
        content_hash: vector<u8>,
        ctx: &TxContext,
    ) {
        assert!(tx_context::sender(ctx) == agent.owner, ENotOwner);
        agent.weights_blob = option::some(BlobRef { id: blob_id, content_hash });
        event::emit(WeightsSet { agent_id: object::id(agent), blob_id, content_hash });
    }

    /// Seal access-control policy (Task 7): gates decryption of an Agent's
    /// Walrus-stored weights blob on CURRENT ownership of that specific
    /// Agent. `sui/scripts/mint_agent.ts` Seal-encrypts the ONNX export
    /// under `id = <this agent's object id bytes>`; `fetch_weights.ts`
    /// builds a PTB calling this function and Seal's key servers dry-run
    /// it to decide whether to release key shares.
    ///
    /// Per the Seal docs' `seal_approve*` convention: the first parameter
    /// is always the requested identity with the package-id prefix already
    /// stripped by the key server (so `id` here is just the per-object
    /// suffix we chose at encrypt time); the function must be side-effect
    /// free (`&Agent`, never `&mut`) and MUST ABORT — not return `false` —
    /// to deny access, since "approved" simply means "did not abort".
    /// Binding `id == object::id_to_bytes(agent)` (not just checking
    /// ownership) matters because a single owner can hold many Agents —
    /// without this check, approval for one Agent's identity would also
    /// approve decryption of every other Agent that owner happens to own.
    /// `public(package) entry`: `entry` so the key servers' dry-run PTB can
    /// invoke it directly; `public(package)` (not plain `public`) so a
    /// different package could never compose this into its own function
    /// and launder an approval — the same composability concern documented
    /// on `game_match::roll`.
    public(package) entry fun seal_approve(id: vector<u8>, agent: &Agent, ctx: &TxContext) {
        let agent_id = object::id(agent);
        assert!(id == object::id_to_bytes(&agent_id), ENoAccess);
        assert!(tx_context::sender(ctx) == agent.owner, ENoAccess);
    }

    // ── Match settlement hook ─────────────────────────────────────────────

    /// Only chaingammon::match (same package) may call this — Task 3 wires
    /// the caller. Bumps elo and match_count together, mirroring
    /// AgentRegistry.updateOverlayHash's "one bump per match" pattern
    /// (experience_version is bumped separately, when the style overlay
    /// itself changes — not yet wired in Task 2).
    public(package) fun record_result(agent: &mut Agent, new_elo: u64) {
        agent.elo = new_elo;
        agent.match_count = agent.match_count + 1;
        event::emit(ResultRecorded {
            agent_id: object::id(agent),
            new_elo,
            match_count: agent.match_count,
        });
    }

    // ── Read-only accessors ───────────────────────────────────────────────

    public fun id(agent: &Agent): ID { object::id(agent) }
    public fun name(agent: &Agent): String { agent.name }
    public fun tier(agent: &Agent): u8 { agent.tier }
    public fun owner(agent: &Agent): address { agent.owner }
    public fun elo(agent: &Agent): u64 { agent.elo }
    public fun match_count(agent: &Agent): u32 { agent.match_count }
    public fun experience_version(agent: &Agent): u32 { agent.experience_version }
    public fun bankroll_value(agent: &Agent): u64 { balance::value(&agent.bankroll) }
    public fun has_weights(agent: &Agent): bool { option::is_some(&agent.weights_blob) }
}
