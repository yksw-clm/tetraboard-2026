import { expect, test } from "bun:test";
import { applyAction, getCheckState, getLegalActions, getLegalActionsForSide } from "../src/index";
import { drop, fixture, move, succeeded } from "./helpers";

test("ダブルスの味方駒は捕獲できず、飛車の通過も遮る", () => {
  const state = fixture({
    mode: "doubles",
    pieces: [
      { side: "south", kind: "rook", at: "E5" },
      { side: "north", kind: "gold", at: "E3" },
    ],
  });
  const before = structuredClone(state);
  expect(applyAction(state, "south", move("E5", "E3"))).toEqual({
    ok: false,
    reason: "friendly_piece",
  });
  expect(applyAction(state, "south", move("E5", "E2"))).toEqual({
    ok: false,
    reason: "invalid_movement",
  });
  expect(getLegalActions(state)).not.toContainEqual(move("E5", "E3"));
  expect(state).toEqual(before);
});

test("ダブルスでは味方王の隣へ王を移動できる", () => {
  const state = fixture({ mode: "doubles", kings: { south: "D5", north: "F5" } });
  const result = succeeded(applyAction(state, "south", move("D5", "E5")));
  expect(getCheckState(result.state)).toEqual({
    south: false,
    west: false,
    north: false,
    east: false,
  });
  expect(result.eliminations).toEqual([]);
});

test("自王と味方飛車の間の駒を動かしても、自王への王手にはしない", () => {
  const state = fixture({
    mode: "doubles",
    kings: { south: "E9" },
    pieces: [
      { side: "north", kind: "rook", at: "E1" },
      { side: "south", kind: "silver", at: "E5" },
    ],
  });
  const result = succeeded(applyAction(state, "south", move("E5", "F4")));
  expect(getCheckState(result.state).south).toBe(false);
  expect(result.state.board[8][4]?.kind).toBe("king");
  expect(result.eliminations).toEqual([]);
});

test("自駒を外して味方王へ空き王手を発生させる手は受理し、味方の応手を優先する", () => {
  const state = fixture({
    mode: "doubles",
    kings: { south: "A8", north: "E1" },
    pieces: [
      { side: "west", kind: "rook", at: "E9" },
      { side: "south", kind: "gold", at: "E5" },
    ],
  });
  expect(getCheckState(state).north).toBe(false);
  const result = succeeded(applyAction(state, "south", move("E5", "F5")));
  expect(result.state.status).toBe("playing");
  expect(result.state.turn).toBe("north");
  expect(getCheckState(result.state).north).toBe(true);
  expect(result.eliminations).toEqual([]);
  expect(getLegalActions(result.state)).toContainEqual(move("E1", "D1"));
});

test("ダブルスでも持ち駒を共有せず、二歩は本人の歩だけを調べる", () => {
  const noHand = fixture({ mode: "doubles", hands: { north: { pawn: 2 } } });
  expect(applyAction(noHand, "south", drop("pawn", "E6"))).toEqual({
    ok: false,
    reason: "missing_hand_piece",
  });
  const state = fixture({
    mode: "doubles",
    pieces: [
      { side: "south", kind: "pawn", at: "D7" },
      { side: "north", kind: "pawn", at: "E4" },
    ],
    hands: { south: { pawn: 1 }, north: { pawn: 2 } },
  });
  expect(applyAction(state, "south", drop("pawn", "D4"))).toEqual({
    ok: false,
    reason: "nifu",
  });
  const result = succeeded(applyAction(state, "south", drop("pawn", "E6")));
  expect(result.state.hands.south.pawn).toBe(0);
  expect(result.state.hands.north.pawn).toBe(2);
  expect(result.state.board[3][4]?.side).toBe("north");
  expect(result.state.board[5][4]?.side).toBe("south");
});

test("同じチームの二人だけが同時に詰んだ場合は、そのチームの敗北になる", () => {
  const state = fixture({
    mode: "doubles",
    kings: { south: "E9", west: "A1", north: "I9", east: "I1" },
    pieces: [
      { side: "south", kind: "rook", at: "E2" },
      { side: "south", kind: "gold", at: "B3" },
      { side: "south", kind: "gold", at: "H3" },
    ],
  });
  const result = succeeded(applyAction(state, "south", move("E2", "E1")));
  expect(result.eliminations).toEqual([
    { side: "west", reason: "checkmate", rank: null, group: 1 },
    { side: "east", reason: "checkmate", rank: null, group: 1 },
  ]);
  expect(result.state.result).toEqual({
    mode: "doubles",
    reason: "team_eliminated",
    winner: "south-north",
  });
});

test("直接の歩打ち王手でも、王が退避できれば打ち歩詰めではない", () => {
  const state = fixture({ kings: { north: "E1" }, hands: { south: { pawn: 1 } } });
  const result = succeeded(applyAction(state, "south", drop("pawn", "E2")));
  expect(result.eliminations).toEqual([]);
  expect(result.state.turn).toBe("north");
  expect(getCheckState(result.state).north).toBe(true);
  expect(getLegalActions(result.state)).toContainEqual(move("E1", "D1"));
});

test("王の退避先がなくても、他の駒が打った歩を取れるなら打ち歩詰めではない", () => {
  const state = fixture({
    kings: { north: "E1" },
    pieces: [
      { side: "south", kind: "gold", at: "E3" },
      { side: "north", kind: "gold", at: "D2" },
      { side: "north", kind: "pawn", at: "D1" },
      { side: "north", kind: "pawn", at: "F1" },
      { side: "north", kind: "pawn", at: "F2" },
    ],
    hands: { south: { pawn: 1 } },
  });
  const result = succeeded(applyAction(state, "south", drop("pawn", "E2")));
  expect(result.eliminations).toEqual([]);
  expect(result.state.turn).toBe("north");
  expect(getLegalActionsForSide(result.state, "north")).toEqual([move("D2", "E2")]);
});

test("別の相手の既存詰みを、直接王手先への打ち歩詰めとは判定しない", () => {
  const state = fixture({
    kings: { north: "H5" },
    pieces: [
      { side: "south", kind: "rook", at: "C1" },
      { side: "south", kind: "gold", at: "B3" },
    ],
    hands: { south: { pawn: 1 } },
  });
  expect(getCheckState(state).west).toBe(true);
  expect(getLegalActionsForSide(state, "west")).toEqual([]);
  const result = succeeded(applyAction(state, "south", drop("pawn", "H6")));
  expect(result.eliminations).toEqual([{ side: "west", reason: "checkmate", rank: 4, group: 1 }]);
  expect(result.state.turn).toBe("north");
  expect(getCheckState(result.state).north).toBe(true);
  expect(getLegalActions(result.state)).toContainEqual(move("H5", "H4"));
});
