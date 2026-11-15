import { expect, test } from "bun:test";
import { fourShogiDefinition as game, type FourShogiGameAction } from "../src/definition";
import { fourShogiCatalog } from "../src/catalog";
import {
  applyAction,
  chooseCpuAction,
  createInitialState,
  eliminateSide,
  getLegalActions,
  setDrawProposal,
  sides,
  type FourShogiState,
  type Side,
} from "../src";
import { fixture, move, drop, succeeded } from "./helpers";

function matches(state: FourShogiState, side: Side, action: FourShogiGameAction) {
  const before = structuredClone(state);
  const expected =
    action.type === "drawProposal"
      ? setDrawProposal(state, side, action.proposed)
      : applyAction(state, side, action);
  const actual = game.rules.applyAction(state, side, action);
  expect(actual.ok).toBe(expected.ok);
  if (actual.ok && expected.ok) expect(actual.state).toEqual(expected.state);
  else if (!actual.ok && !expected.ok) expect(actual.reason).toEqual({ type: expected.reason });
  else throw new Error("Mismatched acceptance");
  expect(state).toEqual(before);
  return actual;
}

test("カタログ・初期化・手番・skillの方式を既存の初期化へ対応させる", () => {
  expect(game.catalog).toBe(fourShogiCatalog);
  expect(game.catalog.seats).toEqual(sides);
  expect(game.catalog.rating).toBe("skill");
  for (const mode of ["singles", "doubles"] as const)
    for (const threePlayerAttackProhibited of [true, false]) {
      const initial = { ...game.catalog.defaultSettings, mode, threePlayerAttackProhibited };
      const state = game.rules.createInitialState(initial);
      expect(state).toEqual(createInitialState(initial));
      expect(game.rules.getTurn(state)).toBe("south");
      expect(game.rules.getResult(state)).toBeNull();
      expect(game.replay(initial, [])).toEqual([]);
    }
});

test("着手・駒打ち・不正着手・手番外の拒否とイベントが既存と一致する", () => {
  const state = createInitialState(game.catalog.defaultSettings);
  const action = getLegalActions(state)[0];
  const moved = matches(state, "south", action);
  expect(moved.ok).toBe(true);
  expect(moved.ok && moved.event).toEqual({ type: "action", side: "south", action });
  expect(game.rules.requiresTurn?.(action)).toBe(true);
  expect(game.rules.endsTurn?.(action)).toBe(true);
  matches(state, "west", action);
  matches(state, "south", { ...action, to: { x: -1, y: 0 } });
  matches(state, "south", drop("silver", "E5"));
  const held = fixture({ hands: { south: { silver: 1 } } });
  const dropped = matches(held, "south", drop("silver", "E5"));
  expect(dropped.ok).toBe(true);
  expect(dropped.ok && dropped.event).toEqual({
    type: "action",
    side: "south",
    action: drop("silver", "E5"),
  });
  expect(dropped.ok && dropped.state.hands.south.silver).toBe(0);
  matches(held, "west", drop("silver", "E5"));
});

test("三人攻撃禁止のON/OFFが既存と同じ手を拒否・受理する", () => {
  for (const threePlayerAttackProhibited of [true, false]) {
    const state = fixture({
      threePlayerAttackProhibited,
      pieces: [
        { side: "south", kind: "pawn", at: "D5" },
        { side: "west", kind: "gold", at: "D3" },
      ],
      attackRelations: (["north", "east"] as const).map((attacker) => ({
        attacker,
        target: "west",
        reasons: ["check"],
        targetPieceIds: [],
        pendingSides: sides.filter((side) => side !== attacker),
      })),
    });
    const result = matches(state, "south", move("D5", "D4"));
    expect(result.ok).toBe(!threePlayerAttackProhibited);
    if (!result.ok) expect(result.reason.type).toBe("three_player_attack");
  }
});

test("引分提案・取消・全生存者の同意は既存と一致し、手番を終えない", () => {
  const proposal = { type: "drawProposal", proposed: true } as const;
  expect(game.rules.endsTurn?.(proposal)).toBe(false);
  for (const mode of ["singles", "doubles"] as const) {
    let state = fixture({ mode });
    matches(state, "west", proposal);
    for (const side of sides) {
      const before = state;
      const offered = matches(state, side, proposal);
      if (!offered.ok) throw new Error("Expected proposal");
      expect(offered.event).toEqual({ type: "drawProposal", side, proposed: true });
      expect(offered.state.moveNumber).toBe(before.moveNumber);
      expect(offered.state.repetitions).toEqual(before.repetitions);
      expect(offered.state.board).toEqual(before.board);
      matches(offered.state, side, { type: "drawProposal", proposed: false });
      state = offered.state;
      if (side !== "east") {
        expect(state.turn).toBe(before.turn);
        const moved = matches(state, side, getLegalActions(state)[0]);
        if (!moved.ok) throw new Error("Expected move");
        state = moved.state;
      }
    }
    expect(state.result?.reason).toBe("agreement");
    expect(game.rules.getResult(state)).toEqual(state.result);
    expect(game.rules.getTurn(state)).toBeNull();
    matches(state, "south", proposal);
  }
  const eliminated = succeeded(eliminateSide(fixture(), "west", "left")).state;
  matches(eliminated, "west", proposal);
  const remaining = { ...eliminated, drawProposals: ["north", "east"] as Side[] };
  expect(matches(remaining, "south", proposal).ok).toBe(true);
});

test("シングルス・ダブルスの投了と外部脱落・結果が既存と一致する", () => {
  for (const mode of ["singles", "doubles"] as const)
    for (const reason of ["resigned", "left", "timeout", "disconnected"] as const) {
      let state = createInitialState({ ...game.catalog.defaultSettings, mode });
      for (const side of sides) {
        if (state.status === "finished") break;
        const seat = reason === "resigned" ? state.turn : side;
        const before = structuredClone(state);
        const expected = succeeded(eliminateSide(state, seat, reason));
        const actual = game.rules.eliminateSeat(state, seat, reason);
        expect(actual).toEqual({
          state: expected.state,
          event: { type: "eliminate", side: seat, reason },
        });
        expect(state).toEqual(before);
        expect(() => game.rules.eliminateSeat(actual.state, seat, reason)).toThrow();
        state = actual.state;
      }
      expect(game.rules.getTurn(state)).toBeNull();
      expect(game.rules.getResult(state)).toEqual(state.result);
      expect(state.result?.reason).toBe(mode === "singles" ? "last_player" : "team_eliminated");
      expect(game.cpu.chooseAction(state, "south", 1, () => 0)).toBeNull();
    }
  expect(() => game.rules.eliminateSeat(fixture(), "west", "resigned")).toThrow();
});

test.each([1, 2] as const)("CPU Lv%i は乱数・履歴を渡して既存と同じ手を選ぶ", (level) => {
  const base = fixture({
    pieces: [
      { side: "south", kind: "rook", at: "E5" },
      { side: "west", kind: "pawn", at: "C5" },
    ],
  });
  const repeated = succeeded(applyAction(base, "south", move("A9", "A8"))).state;
  const history = Object.fromEntries(Object.keys(repeated.repetitions).map((key) => [key, 3]));
  let calls = 0;
  const lookup = (key: string) => {
    calls++;
    return history[key] ?? 0;
  };
  for (const state of [base, createInitialState(game.catalog.defaultSettings)]) {
    const before = structuredClone(state);
    expect(game.cpu.chooseAction(state, "south", level, () => 0.25, lookup)).toEqual(
      chooseCpuAction(
        state,
        level,
        () => 0.25,
        (key) => history[key] ?? 0,
      ),
    );
    expect(game.cpu.chooseAction(state, "west", level, () => 0.25, lookup)).toBeNull();
    expect(state).toEqual(before);
  }
  if (level === 2) expect(calls).toBeGreaterThan(0);
  expect(Object.values(history).every((count) => count === 3)).toBe(true);
});
