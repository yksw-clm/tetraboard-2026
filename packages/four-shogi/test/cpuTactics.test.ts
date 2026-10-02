import { expect, test } from "bun:test";
import {
  applyAction,
  chooseCpuAction,
  getActiveSides,
  getCheckState,
  getLegalActions,
} from "../src/index";
import type { FourShogiAction, FourShogiState } from "../src/index";
import { fixture, move, succeeded } from "./helpers";

function chosen(state: FourShogiState): FourShogiAction {
  const action = chooseCpuAction(state, 2);
  expect(action).not.toBeNull();
  if (action === null) throw new Error("Expected a CPU action in the tactical position");
  return action;
}

test("レベル2はダブルスの即時チーム勝利を選ぶ", () => {
  const state = fixture({
    mode: "doubles",
    kings: { south: "E9", west: "A1", north: "I9", east: "I1" },
    pieces: [
      { side: "south", kind: "rook", at: "E2" },
      { side: "south", kind: "gold", at: "B3" },
      { side: "south", kind: "gold", at: "H3" },
    ],
  });
  const action = chosen(state);
  expect(action).toEqual(move("E2", "E1"));
  const result = succeeded(applyAction(state, "south", action));
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

test("味方を詰ませる龍取りと、次の敵手で味方が詰む飛車取りを避ける", () => {
  const state = fixture({
    mode: "doubles",
    kings: { south: "A8", north: "E1", east: "I1" },
    pieces: [
      { side: "west", kind: "rook", at: "E9" },
      { side: "south", kind: "gold", at: "E5" },
      { side: "west", kind: "gold", at: "C2" },
      { side: "west", kind: "gold", at: "F2" },
      { side: "east", kind: "gold", at: "G3" },
      { side: "west", kind: "rook", promoted: true, at: "D4" },
      { side: "west", kind: "rook", at: "F5" },
      { side: "south", kind: "rook", at: "H5" },
    ],
  });
  const exposed = succeeded(applyAction(state, "south", move("E5", "D4")));
  expect(exposed.state.result).toEqual({
    mode: "doubles",
    reason: "team_eliminated",
    winner: "west-east",
  });
  const captured = succeeded(applyAction(state, "south", move("H5", "F5")));
  const punishment = succeeded(applyAction(captured.state, "west", move("E9", "E5")));
  expect(punishment.eliminations).toContainEqual({
    side: "north",
    reason: "checkmate",
    rank: null,
    group: 1,
  });
  const action = chosen(state);
  expect(action).toEqual(move("H5", "H1", true));
  const result = succeeded(applyAction(state, "south", action));
  expect(result.state.status).toBe("playing");
  expect(result.state.turn).toBe("east");
  expect(getCheckState(result.state).east).toBe(true);
  expect(result.eliminations).toEqual([]);
});

test("味方が王手への応手で飛車を取れる協力手を読む", () => {
  const state = fixture({
    mode: "doubles",
    kings: { south: "A8", north: "E1" },
    pieces: [
      { side: "west", kind: "rook", at: "E9" },
      { side: "south", kind: "gold", at: "E5" },
      { side: "west", kind: "gold", at: "C2" },
      { side: "west", kind: "gold", at: "F2" },
      { side: "east", kind: "gold", at: "G3" },
      { side: "west", kind: "rook", promoted: true, at: "D4" },
      { side: "north", kind: "rook", at: "B9" },
    ],
  });
  const action = chosen(state);
  expect(action).toEqual(move("E5", "D4"));
  const result = succeeded(applyAction(state, "south", action));
  expect(result.state.turn).toBe("north");
  expect(getCheckState(result.state).north).toBe(true);
  expect(getLegalActions(result.state)).toEqual([move("B9", "E9"), move("B9", "E9", true)]);
  const response = succeeded(applyAction(result.state, "north", move("B9", "E9", true)));
  expect(response.state.status).toBe("playing");
  expect(response.eliminations).toEqual([]);
  expect(getCheckState(response.state).north).toBe(false);
  expect(response.state.hands.south.rook).toBe(1);
  expect(response.state.hands.north.rook).toBe(1);
});

test("王手で実際の次手番を西から北へ変え、飛車取り後の即詰みを避ける", () => {
  const state = fixture({
    kings: { north: "E1", east: "E7" },
    pieces: [
      { side: "south", kind: "rook", at: "H5" },
      { side: "south", kind: "pawn", at: "A8" },
      { side: "west", kind: "rook", at: "A5" },
      { side: "west", kind: "rook", at: "F5" },
      { side: "west", kind: "gold", at: "C8" },
      { side: "east", kind: "gold", at: "B7" },
      { side: "east", kind: "gold", at: "C9" },
    ],
  });
  const captured = succeeded(applyAction(state, "south", move("H5", "F5")));
  expect(captured.state.turn).toBe("west");
  const punishment = succeeded(applyAction(captured.state, "west", move("A5", "A8")));
  expect(punishment.eliminations).toContainEqual({
    side: "south",
    reason: "checkmate",
    rank: 4,
    group: 1,
  });
  const action = chosen(state);
  expect(action).toEqual(move("H5", "H1", true));
  const result = succeeded(applyAction(state, "south", action));
  expect(result.state.turn).toBe("north");
  expect(getCheckState(result.state).north).toBe(true);
  expect(result.eliminations).toEqual([]);
});

test("東を撃破した後は西が応手する局面で撃破手を選ぶ", () => {
  const state = fixture({
    kings: { north: "E1" },
    pieces: [
      { side: "south", kind: "rook", at: "I5" },
      { side: "south", kind: "gold", at: "I7" },
      { side: "south", kind: "gold", at: "H8" },
    ],
  });
  const action = chosen(state);
  expect(action).toEqual(move("I7", "H7"));
  const result = succeeded(applyAction(state, "south", action));
  expect(result.eliminations).toEqual([{ side: "east", reason: "checkmate", rank: 4, group: 1 }]);
  expect(result.state.turn).toBe("west");
  expect(getActiveSides(result.state)).toEqual(["south", "west", "north"]);
});

test("脱落した西を飛ばし、次の北の応手を読む", () => {
  const state = fixture({
    kings: { north: "E1", east: "E7" },
    eliminations: [{ side: "west", reason: "left", rank: 4, group: 1 }],
    pieces: [
      { side: "south", kind: "rook", at: "H5" },
      { side: "south", kind: "pawn", at: "A8" },
      { side: "north", kind: "rook", at: "A5" },
      { side: "north", kind: "rook", at: "F5" },
      { side: "north", kind: "gold", at: "C8" },
      { side: "east", kind: "gold", at: "B7" },
      { side: "east", kind: "gold", at: "C9" },
    ],
  });
  const captured = succeeded(applyAction(state, "south", move("H5", "F5")));
  expect(captured.state.turn).toBe("north");
  const punishment = succeeded(applyAction(captured.state, "north", move("A5", "A8")));
  expect(punishment.eliminations).toContainEqual({
    side: "south",
    reason: "checkmate",
    rank: 3,
    group: 2,
  });
  const action = chosen(state);
  expect(action).toEqual(move("H5", "H1", true));
  const result = succeeded(applyAction(state, "south", action));
  expect(result.state.turn).toBe("north");
  expect(getActiveSides(result.state)).toEqual(["south", "north", "east"]);
  expect(getCheckState(result.state).north).toBe(true);
  expect(result.eliminations).toEqual([]);
  expect(result.state.board[0][0]?.kind).toBe("king");
});

test("千日手による確定1位を、継続局面の駒得より優先する", () => {
  const base = fixture({
    pieces: [
      { side: "south", kind: "rook", at: "E5" },
      { side: "west", kind: "pawn", at: "C5" },
    ],
  });
  const repeated = succeeded(applyAction(base, "south", move("A9", "A8"))).state;
  const [key] = Object.keys(repeated.repetitions);
  if (key === undefined) throw new Error("Expected the next settled position to be recorded");
  const state: FourShogiState = { ...base, repetitions: { [key]: 3 } };
  const gain = succeeded(applyAction(state, "south", move("E5", "C5")));
  expect(gain.state.status).toBe("playing");
  expect(gain.state.hands.south.pawn).toBe(1);
  const action = chosen(state);
  expect(action).toEqual(move("A9", "A8"));
  const result = succeeded(applyAction(state, "south", action));
  expect(result.state.result).toEqual({
    mode: "singles",
    reason: "repetition",
    standings: [
      { side: "south", rank: 1 },
      { side: "west", rank: 1 },
      { side: "north", rank: 1 },
      { side: "east", rank: 1 },
    ],
  });
});
