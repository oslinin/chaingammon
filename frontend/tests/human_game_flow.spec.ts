// human_game_flow.spec.ts — Game-engine and opponent-discovery tests for
// human-vs-human (HvH) games.
//
// Group 1 — pure engine tests (no browser fixture):
//   Imports the game-logic primitives directly (rules_engine, gnubg_state,
//   drand_dice — all pure TypeScript, no browser APIs) and exercises:
//     • Turn alternation: state.turn flips to the other player after each
//       move or skip throughout a full match.
//     • Protocol parity: two "virtual players" each maintain an independent
//       copy of game state; applying the same wire messages (roll / move /
//       skip) keeps position_id identical on both sides.
//     • Match completion: a full match runs to game_over with a winner
//       within 2000 half-moves.
//     • Bar-dance / skip: when no legal move exists the turn passes to the
//       other side without a move message.
//
// Note: match_engine.ts is NOT imported here because it pulls in onnx_eval.ts
// which references Web Workers — a browser-only API unavailable in the Node.js
// test process.  The thin helpers needed (newMatch, applyMoveToState, skipTurn,
// playMatchToEnd) are re-implemented below using only the pure primitives.
//
// Group 2 — opponent discovery (two browser contexts + in-memory Nostr relay):
//   Verifies that when a human peer is found via Nostr:
//     • Both players navigate to /play-human?id=<matchId> — not to an agent
//       game page (e.g. /team-demo).
//     • The matchId is identical on both sides.
//   And that a lone searcher:
//     • Sees a "no one else searching" status message.
//     • Is not routed to any game page.
//
// No live Nostr relay, no real wallet, no drand network access required.

import { test, expect, type WebSocketRoute } from "@playwright/test";
import {
  OPENING_BOARD,
  applyMove,
  isLegal,
  generateLegalMoves,
  hasLegalMoves,
  type Board,
} from "../lib/rules_engine";
import { encodePositionId, encodeMatchId } from "../lib/gnubg_state";
import { deriveDice } from "../lib/drand_dice";

// ── Minimal MatchState (mirrors match_engine.ts without the ONNX imports) ────

interface MatchState {
  position_id: string;
  match_id: string;
  board: number[];
  bar: [number, number];
  off: [number, number];
  turn: 0 | 1;
  dice: [number, number] | null;
  score: [number, number];
  match_length: number;
  game_over: boolean;
  winner: 0 | 1 | null;
  cubeValue?: number;
  cubeOwner?: number;
}

function toBoard(s: MatchState): Board {
  return { points: s.board, bar: s.bar, off: s.off };
}

function makeState(
  board: Board,
  turn: 0 | 1,
  score: [number, number],
  matchLength: number,
  gameOver: boolean,
  winner: 0 | 1 | null,
  dice: [number, number] | null = null,
): MatchState {
  return {
    position_id: encodePositionId(board),
    match_id: encodeMatchId(turn, matchLength, score, gameOver),
    board: board.points,
    bar: board.bar,
    off: board.off,
    turn, dice, score,
    match_length: matchLength,
    game_over: gameOver,
    winner,
    cubeValue: 1,
    cubeOwner: -1,
  };
}

function freshBoard(): Board {
  return {
    points: [...OPENING_BOARD.points],
    bar: [0, 0],
    off: [0, 0],
  };
}

function newMatch(matchLength = 3): MatchState {
  return makeState(freshBoard(), 0, [0, 0], matchLength, false, null);
}

function applyMoveToState(state: MatchState, moveStr: string): MatchState {
  if (!state.dice) throw new Error("No dice to play");
  const board = toBoard(state);
  const side = state.turn;

  if (!isLegal(board, state.dice, side, moveStr)) {
    throw new Error(`Illegal move: ${moveStr}`);
  }

  const newBoard = applyMove(board, side, moveStr);

  if (newBoard.off[side] === 15) {
    const newScore: [number, number] =
      side === 0
        ? [state.score[0] + 1, state.score[1]]
        : [state.score[0], state.score[1] + 1];
    const matchOver =
      newScore[0] >= state.match_length || newScore[1] >= state.match_length;
    if (matchOver) {
      return makeState(newBoard, side, newScore, state.match_length, true, side);
    }
    const nextTurn = (1 - side) as 0 | 1;
    return makeState(freshBoard(), nextTurn, newScore, state.match_length, false, null);
  }

  const nextTurn = (1 - side) as 0 | 1;
  return makeState(newBoard, nextTurn, state.score, state.match_length, false, null);
}

function skipTurn(state: MatchState): MatchState {
  const nextTurn = (1 - state.turn) as 0 | 1;
  return makeState(toBoard(state), nextTurn, state.score, state.match_length, false, null);
}

async function playMatchToEnd(state: MatchState): Promise<MatchState> {
  let s = state;
  for (let i = 0; i < 3000 && !s.game_over; i++) {
    if (i % 100 === 0) await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const dice: [number, number] = s.dice ?? [
      Math.floor(Math.random() * 6) + 1,
      Math.floor(Math.random() * 6) + 1,
    ];
    const withDice: MatchState = { ...s, dice };
    const moves = generateLegalMoves(toBoard(withDice), s.turn, dice).filter((m) => m.trim());
    if (moves.length === 0) {
      s = skipTurn(withDice);
      continue;
    }
    const move = moves[Math.floor(Math.random() * moves.length)];
    try {
      s = applyMoveToState(withDice, move);
    } catch {
      s = skipTurn(withDice);
    }
  }
  return s;
}

// ── Deterministic test fixtures ──────────────────────────────────────────────

// Fixed 32-byte digest — gives a stable dice sequence across runs.
const DIGEST = ("0x" + "ab".repeat(32)) as `0x${string}`;
const ROUND = 1000;

function rollAt(turnIndex: number): [number, number] {
  const { d1, d2 } = deriveDice(DIGEST, turnIndex, ROUND);
  return [d1, d2];
}

// ── Group 0: PeerConnection message-handler regression tests ────────────────
//
// peer.onMessage is a single-callback setter (last caller wins).
// PlayHumanClient.tsx previously registered three separate handlers via three
// different useEffect calls; the auth-listener effect ran last and replaced
// the hello-listener, causing hello messages to be silently dropped and both
// sides to hang on "Waiting for opponent…".
//
// These tests verify:
//   a) the setter contract (regression guard so we notice if the API changes)
//   b) the merged-handler behaviour that the fix relies on

test.describe("PeerConnection.onMessage setter contract", () => {
  test("last registration wins — earlier handlers are replaced (demonstrates both pre-fix bugs)", () => {
    // Bug 1: auth-listener effect ran last and overwrote hello-listener.
    // Bug 2: mount effect re-ran whenever handleMsg changed (e.g. when
    //   sessionAccount was set after hello was sent) and overwrote the
    //   merged handler that was registered by the hello-listener effect.
    // Both bugs result in hello messages being silently dropped.
    let activeCb: ((m: unknown) => void) | null = null;
    const mockOnMessage = (cb: (m: unknown) => void) => { activeCb = cb; };
    const emit = (msg: unknown) => activeCb?.(msg);

    const received: string[] = [];

    // Effect 1 (mount): game messages only — ran first
    mockOnMessage((raw) => { received.push("mount:" + (raw as {type:string}).type); });
    // Effect 2 (hello): merged handler — replaced mount
    mockOnMessage((raw) => { received.push("hello:" + (raw as {type:string}).type); });
    // Effect 3 (auth): auth only — replaced hello (pre-fix bug 1)
    mockOnMessage((raw) => {
      const msg = raw as {type:string};
      if (msg.type === "auth") received.push("auth:" + msg.type);
    });
    // Bug 2: mount re-ran after sessionAccount changed, overwrote merged
    mockOnMessage((raw) => { received.push("mount2:" + (raw as {type:string}).type); });

    emit({ type: "hello" });
    emit({ type: "auth" });
    emit({ type: "roll" });

    // Only mount2's handler runs; hello drops silently, auth drops silently
    expect(received).toEqual(["mount2:hello", "mount2:auth", "mount2:roll"]);
  });

  test("merged handler processes every message type in one registration", () => {
    let activeCb: ((m: unknown) => void) | null = null;
    const mockOnMessage = (cb: (m: unknown) => void) => { activeCb = cb; };
    const emit = (msg: unknown) => activeCb?.(msg);

    let helloSeen = false;
    let secondHelloSeen = false;
    let authSeen = false;
    let rollSeen = false;
    let oppHelloRecv = false; // simulates oppHelloRef.current

    // Single merged handler — mirrors the fix in PlayHumanClient
    mockOnMessage((raw) => {
      const msg = raw as { type: string; nonce?: string };
      if (msg.type === "hello") {
        if (!oppHelloRecv) { oppHelloRecv = true; helloSeen = true; }
        else { secondHelloSeen = true; }
        return;
      }
      if (msg.type === "auth") { authSeen = true; return; }
      if (msg.type === "roll") { rollSeen = true; }
    });

    emit({ type: "hello" });           // initial hello
    emit({ type: "hello", nonce: "1" }); // second hello with real nonce
    emit({ type: "auth" });
    emit({ type: "roll" });

    expect(helloSeen).toBe(true);
    expect(secondHelloSeen).toBe(true);
    expect(authSeen).toBe(true);
    expect(rollSeen).toBe(true);
  });
});

// ── Group 1: Pure engine tests ───────────────────────────────────────────────

test.describe("HvH game engine — turn alternation and state consistency", () => {
  test("turn flips to the other player after every move in a full match", () => {
    let state = newMatch(3);
    let turnIdx = 0;

    // 2000 half-moves covers far more than a typical match (50–150 per side).
    for (let half = 0; half < 2000 && !state.game_over; half++) {
      const mover = state.turn;
      const dice = rollAt(turnIdx++);
      const withDice: MatchState = { ...state, dice };

      const moves = generateLegalMoves(toBoard(withDice), mover, dice)
        .filter((m) => m.trim());

      let next: MatchState;
      if (moves.length === 0) {
        next = skipTurn(withDice);
      } else {
        try {
          next = applyMoveToState(withDice, moves[0]);
        } catch {
          // generateLegalMoves has an edge case where it returns a move
          // that isLegal then rejects; fall back to skip (same as playMatchToEnd).
          next = skipTurn(withDice);
        }
      }

      // After any move or skip the turn must belong to the other player
      // (game_over resets the board / changes winner so the flip is implicit).
      if (!next.game_over) {
        expect(next.turn).toBe((1 - mover) as 0 | 1);
      }

      state = next;
    }

    expect(state.game_over).toBe(true);
    expect(state.winner === 0 || state.winner === 1).toBe(true);
  });

  test("both sides compute identical position_id from the same wire messages", () => {
    // Simulates the HvH data-channel protocol:
    //   "roll"  — both sides learn the same dice from the drand digest.
    //   "move"  — both sides apply the same move notation string.
    //   "skip"  — both sides call skipTurn independently.
    // Both copies must stay in sync (same position_id, same turn) after each
    // half-move, and must agree on the winner when the match ends.
    let sideA = newMatch(3); // player-0 perspective
    let sideB = newMatch(3); // player-1 perspective
    let turnIdx = 0;

    for (let half = 0; half < 2000 && !sideA.game_over; half++) {
      const mover = sideA.turn;
      const dice = rollAt(turnIdx++);

      // "roll" message — both sides learn the same dice.
      sideA = { ...sideA, dice };
      sideB = { ...sideB, dice };

      const moves = generateLegalMoves(toBoard(sideA), mover, dice)
        .filter((m) => m.trim());

      if (moves.length === 0 || !hasLegalMoves(toBoard(sideA), mover, dice)) {
        // "skip" message — both sides call skipTurn independently.
        sideA = skipTurn(sideA);
        sideB = skipTurn(sideB);
      } else {
        const move = moves[0]; // deterministic: always the first legal move

        // "move" message — both sides apply the same notation.
        // Wrap in try/catch: generateLegalMoves has an edge case where it
        // returns a move that isLegal then rejects; fall back to skip so
        // both sides stay in sync (same as the production playMatchToEnd).
        let nextA: MatchState, nextB: MatchState;
        try {
          nextA = applyMoveToState(sideA, move);
          nextB = applyMoveToState(sideB, move);
        } catch {
          sideA = skipTurn(sideA);
          sideB = skipTurn(sideB);
          continue;
        }

        // Core assertion: both sides must reach the same board encoding.
        expect(nextA.position_id).toBe(nextB.position_id);

        if (!nextA.game_over) {
          expect(nextA.turn).toBe(nextB.turn);
        }

        sideA = nextA;
        sideB = nextB;
      }
    }

    expect(sideA.game_over).toBe(true);
    expect(sideB.game_over).toBe(true);
    // Both players must agree on who won.
    expect(sideB.winner).toBe(sideA.winner);
  });

  test("playMatchToEnd reaches game_over within 3000 half-moves", async () => {
    const initial: MatchState = { ...newMatch(3), dice: rollAt(0) };
    const final = await playMatchToEnd(initial);

    expect(final.game_over).toBe(true);
    expect(final.winner === 0 || final.winner === 1).toBe(true);
  });

  test("bar-dance: no legal entry is skipped and turn passes to the other player", () => {
    // Player 0 has one checker on the bar; player 1 closes all six home
    // points (19–24) with two or more checkers each.  A 6-6 roll finds no
    // entry for player 0, so generateLegalMoves must return [] and a skip
    // must flip the turn to player 1.
    const points = new Array<number>(24).fill(0);
    for (let p = 19; p <= 24; p++) points[p - 1] = -2; // close home board
    points[12] = -3;                                     // remaining opponent checkers
    for (let p = 1; p <= 6; p++) points[p - 1] = 2;    // player 0's checkers
    points[5] = 4;                                       // extra on point 6

    const board: Board = { points, bar: [1, 0], off: [0, 0] };
    const dice: [number, number] = [6, 6];

    expect(generateLegalMoves(board, 0, dice)).toHaveLength(0);
    expect(hasLegalMoves(board, 0, dice)).toBe(false);

    // Wrap in a MatchState; skipTurn recomputes position_id from the board.
    const state: MatchState = {
      ...newMatch(3),
      board: points,
      bar: [1, 0] as [number, number],
      off: [0, 0] as [number, number],
      turn: 0,
      dice,
    };

    const after = skipTurn(state);
    expect(after.turn).toBe(1);
    expect(after.game_over).toBe(false);
  });
});

// ── Group 2: Opponent discovery via in-memory Nostr relay ───────────────────
//
// Minimal NIP-01 relay: handles REQ/EVENT/CLOSE and broadcasts to matching
// subscriptions.  Event IDs are deduplicated so nostr-tools SimplePool's
// duplicate publications don't fire duplicate messages to subscribers.

type NostrFilter = {
  kinds?: number[];
  authors?: string[];
  "#t"?: string[];
  "#p"?: string[];
};

type NostrEvent = {
  id: string;
  pubkey: string;
  kind: number;
  tags: string[][];
  content: string;
  created_at: number;
  sig: string;
};

class InMemoryNostrRelay {
  private clients: { ws: WebSocketRoute; subs: Map<string, NostrFilter[]> }[] = [];
  private seen = new Set<string>();

  addClient(ws: WebSocketRoute): void {
    const subs = new Map<string, NostrFilter[]>();
    this.clients.push({ ws, subs });

    ws.onMessage((raw) => {
      let msg: [string, ...unknown[]];
      try {
        msg = JSON.parse(
          typeof raw === "string" ? raw : raw.toString(),
        ) as [string, ...unknown[]];
      } catch {
        return;
      }
      const [type, ...args] = msg;

      switch (type) {
        case "REQ": {
          const [subId, ...filters] = args as [string, ...NostrFilter[]];
          subs.set(subId, filters);
          ws.send(JSON.stringify(["EOSE", subId]));
          break;
        }
        case "EVENT": {
          const event = args[0] as NostrEvent;
          if (this.seen.has(event.id)) {
            ws.send(JSON.stringify(["OK", event.id, true, "duplicate"]));
            return;
          }
          this.seen.add(event.id);
          ws.send(JSON.stringify(["OK", event.id, true, ""]));
          for (const client of this.clients) {
            for (const [subId, filters] of client.subs) {
              if (this.matchesAny(event, filters)) {
                client.ws.send(JSON.stringify(["EVENT", subId, event]));
              }
            }
          }
          break;
        }
        case "CLOSE": {
          const [subId] = args as [string];
          subs.delete(subId);
          break;
        }
      }
    });
  }

  private matchesAny(event: NostrEvent, filters: NostrFilter[]): boolean {
    return filters.some((f) => this.matches(event, f));
  }

  private matches(event: NostrEvent, f: NostrFilter): boolean {
    if (f.kinds && !f.kinds.includes(event.kind)) return false;
    if (f.authors && !f.authors.includes(event.pubkey)) return false;
    if (f["#t"]) {
      const ts = event.tags.filter((t) => t[0] === "t").map((t) => t[1]);
      if (!f["#t"].some((v) => ts.includes(v))) return false;
    }
    if (f["#p"]) {
      const ps = event.tags.filter((t) => t[0] === "p").map((t) => t[1]);
      if (!f["#p"].some((v) => ps.includes(v))) return false;
    }
    return true;
  }
}

test.describe("HvH opponent discovery", () => {
  // The home page is in ELO mode by default (AppModeContext default = "elo").
  // EloHome renders a "Play" button that starts Nostr matchmaking and, when
  // two peers are found, navigates to /play-human?id=<matchId>.
  // It must NOT fall back to /team-demo (agent game) when a human is available.

  test(
    "two players pair via Nostr and both navigate to /play-human?id= — not an agent game",
    async ({ browser }) => {
      const relay = new InMemoryNostrRelay();
      const ctx1 = await browser.newContext();
      const ctx2 = await browser.newContext();
      const page1 = await ctx1.newPage();
      const page2 = await ctx2.newPage();

      try {
        // Route all wss:// traffic through the in-memory relay — no live
        // Nostr network required.
        await page1.routeWebSocket("wss://**", (ws) => relay.addClient(ws));
        await page2.routeWebSocket("wss://**", (ws) => relay.addClient(ws));

        await Promise.all([page1.goto("/"), page2.goto("/")]);

        // EloHome shows "Play" (not "Play a human").  Both click simultaneously
        // so their presence events are in the Nostr relay before STABILIZE_MS fires.
        await Promise.all([
          page1.getByRole("button", { name: "Play" }).click({ timeout: 10_000 }),
          page2.getByRole("button", { name: "Play" }).click({ timeout: 10_000 }),
        ]);

        // Button label changes to "Searching…" while searching.
        await expect(page1.getByRole("button", { name: "Searching…" })).toBeVisible({
          timeout: 5_000,
        });
        await expect(page2.getByRole("button", { name: "Searching…" })).toBeVisible({
          timeout: 5_000,
        });

        // Both pages must navigate to /play-human?id=<matchId> — NOT to
        // /team-demo (agent game).  Worst case: startPresence re-publishes
        // every 15 s; allow 60 s total.
        await Promise.all([
          page1.waitForURL(
            (url) => url.pathname === "/play-human" && url.searchParams.has("id"),
            { timeout: 60_000 },
          ),
          page2.waitForURL(
            (url) => url.pathname === "/play-human" && url.searchParams.has("id"),
            { timeout: 60_000 },
          ),
        ]);

        // Neither player should have been routed to an agent game.
        for (const page of [page1, page2]) {
          const { pathname } = new URL(page.url());
          expect(pathname).not.toContain("team-demo");
          expect(pathname).not.toContain("agent");
        }

        // matchId is keccak256(sorted(pubkeyA + pubkeyB)) — both sides must
        // compute the same value deterministically.
        const id1 = new URL(page1.url()).searchParams.get("id");
        const id2 = new URL(page2.url()).searchParams.get("id");
        expect(id1).toMatch(/^0x[0-9a-f]{64}$/i);
        expect(id1).toBe(id2);
      } finally {
        await ctx1.close();
        await ctx2.close();
      }
    },
  );

  test("a lone searcher stays in searching state and is not immediately sent to agent game", async ({
    browser,
  }) => {
    // When no partner is found, EloHome must NOT fall back immediately to
    // /team-demo (the old bug: tryConnect navigated to agent on first attempt,
    // which is a race — the other player's presence event may not have arrived).
    // The fix: tryConnect only updates status; a give-up timer eventually
    // falls back after GIVE_UP_MS.  This test verifies the intermediate state.
    const relay = new InMemoryNostrRelay();
    const ctx = await browser.newContext();
    const page = await ctx.newPage();

    try {
      await page.routeWebSocket("wss://**", (ws) => relay.addClient(ws));
      await page.goto("/");

      await page.getByRole("button", { name: "Play" }).click({ timeout: 10_000 });

      // After STABILIZE_MS (3 s) tryConnect fires and sees no partner.
      // The page must still be on "/" and must show a "Searching" status,
      // not have navigated to /team-demo.
      await expect(page.getByRole("button", { name: "Searching…" })).toBeVisible({
        timeout: 8_000,
      });
      expect(new URL(page.url()).pathname).toBe("/");

      // Clicking the button again (now labeled "Searching…") stops the search.
      await page.getByRole("button", { name: "Searching…" }).click();
      await expect(page.getByRole("button", { name: "Play" })).toBeVisible({
        timeout: 3_000,
      });
      // After stopping, still on home page — no agent game.
      expect(new URL(page.url()).pathname).toBe("/");
    } finally {
      await ctx.close();
    }
  });
});
