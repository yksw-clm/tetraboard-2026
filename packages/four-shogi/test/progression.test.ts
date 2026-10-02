import { expect, test } from "bun:test";
import {
  applyAction,
  createInitialState,
  eliminateSide,
  getActiveSides,
  getCheckState,
  getLegalActions,
  getLegalActionsForSide,
  sides,
} from "../src/index";
import type { ExternalEliminationReason, FourShogiAction, FourShogiState } from "../src/index";
import { fixture, move, position, succeeded } from "./helpers";

test("複数王手は時計回りで近い人から応じ、盤面から次の王手を選び直す", () => {
  const initial = fixture({
    kings: { west: "D1", north: "H1" },
    pieces: [{ side: "south", kind: "rook", at: "F5" }],
  });
  const first = succeeded(applyAction(initial, "south", move("F5", "F1"))).state;
  expect(getCheckState(first)).toEqual({ south: false, west: true, north: true, east: false });
  expect(first.turn).toBe("west");
  const response = succeeded(applyAction(first, "west", move("D1", "D2"))).state;
  expect(response.turn).toBe("north");
  expect(getCheckState(response).west).toBe(false);
  expect(getCheckState(response).north).toBe(true);
});

test("第三者の飛車の空き王手でも王手中の人へ手番を移す", () => {
  const state = fixture({
    kings: { north: "E5" },
    pieces: [
      { side: "west", kind: "rook", at: "E1" },
      { side: "south", kind: "gold", at: "E3" },
    ],
  });
  expect(getCheckState(state).north).toBe(false);
  const result = succeeded(applyAction(state, "south", move("E3", "F3")));
  expect(getCheckState(result.state).north).toBe(true);
  expect(result.state.turn).toBe("north");
});

test("南が東を詰ませた次は、南の次に当たる西へ手番を移す", () => {
  const state = fixture({
    kings: { north: "E1" },
    pieces: [
      { side: "south", kind: "rook", at: "I5" },
      { side: "south", kind: "gold", at: "I7" },
      { side: "south", kind: "gold", at: "H8" },
    ],
  });
  expect(getCheckState(state)).toEqual({ south: false, west: false, north: false, east: false });
  const result = succeeded(applyAction(state, "south", move("I7", "H7")));
  expect(result.eliminations).toEqual([{ side: "east", reason: "checkmate", rank: 4, group: 1 }]);
  expect(result.state.turn).toBe("west");
  expect(result.state.moveNumber).toBe(1);
  expect(result.state.lastMove?.side).toBe("south");
});

function doubleMate(thirdPartyRook = false): FourShogiState {
  return fixture({
    kings: { south: "E9" },
    pieces: [
      { side: "south", kind: "rook", at: "E2" },
      { side: "south", kind: "gold", at: "B3" },
      { side: "south", kind: "gold", at: "H3" },
      ...(thirdPartyRook
        ? [
            { side: "west" as const, kind: "rook" as const, at: "G1" },
            { side: "south" as const, kind: "pawn" as const, promoted: true, at: "F1" },
          ]
        : []),
    ],
  });
}

test("同じ盤面で二人の詰みを確定し、両者3位として持ち駒を破棄する", () => {
  const state = doubleMate();
  const result = succeeded(applyAction(state, "south", move("E2", "E1")));
  expect(result.eliminations).toEqual([
    { side: "west", reason: "checkmate", rank: 3, group: 1 },
    { side: "north", reason: "checkmate", rank: 3, group: 1 },
  ]);
  expect(result.state.turn).toBe("east");
  expect(getActiveSides(result.state)).toEqual(["south", "east"]);
  expect(result.state.board[0][0]).toEqual(state.board[0][0]);
  expect(result.state.hands.west).toEqual({ rook: 0, gold: 0, silver: 0, pawn: 0 });
  expect(result.state.hands.north.pawn).toBe(0);
  const end = succeeded(eliminateSide(result.state, "east", "left")).state;
  expect(end.status).toBe("finished");
  expect(end.result).toEqual({
    mode: "singles",
    reason: "last_player",
    standings: [
      { side: "south", rank: 1 },
      { side: "east", rank: 2 },
      { side: "west", rank: 3 },
      { side: "north", rank: 3 },
    ],
  });
});

test("先に脱落する人の利きが消えて救われる詰みも、同じ処理群で脱落させる", () => {
  const result = succeeded(applyAction(doubleMate(true), "south", move("E2", "E1")));
  expect(result.eliminations.map(({ side }) => side)).toEqual(["west", "north"]);
  expect(new Set(result.eliminations.map(({ group }) => group)).size).toBe(1);
});

test("王手なしの合法手0件は、その人の手番になったときに脱落させる", () => {
  const state = fixture({
    pieces: [
      { side: "south", kind: "gold", at: "B3" },
      { side: "south", kind: "gold", at: "C2" },
      { side: "south", kind: "pawn", at: "F6" },
    ],
  });
  expect(getCheckState(state).west).toBe(false);
  expect(getLegalActionsForSide(state, "west")).toEqual([]);
  expect(state.eliminations).toEqual([]);
  const result = succeeded(applyAction(state, "south", move("F6", "F5")));
  expect(result.eliminations).toEqual([
    { side: "west", reason: "no_legal_actions", rank: 4, group: 1 },
  ]);
  expect(result.state.turn).toBe("north");
});

for (const reason of ["resigned", "left", "timeout", "disconnected"] as const) {
  test(`${reason}で裏王化・持ち駒破棄し、生存者だけで続行する`, () => {
    const state = fixture({
      turn: reason === "resigned" ? "west" : "south",
      hands: { west: { rook: 2 } },
      pieces: [
        { side: "west", kind: "silver", promoted: true, at: "E5" },
        { side: "south", kind: "rook", at: "E7" },
      ],
    });
    const result = succeeded(eliminateSide(state, "west", reason));
    expect(result.state.turn).toBe(reason === "resigned" ? "north" : "south");
    expect(result.eliminations).toEqual([{ side: "west", reason, rank: 4, group: 1 }]);
    expect(result.state.hands.west.rook).toBe(0);
    expect(result.state.board[0][0]).toEqual(state.board[0][0]);
    expect(result.state.board[4][4]).toEqual(state.board[4][4]);
    expect(getCheckState(result.state).west).toBe(false);
    expect(getLegalActionsForSide(result.state, "west")).toEqual([]);
    expect(eliminateSide(result.state, "west", reason)).toEqual({
      ok: false,
      reason: "already_eliminated",
    });
  });
}

test("手番外脱落後に残る駒を取り、成りを戻して自分の持ち駒にする", () => {
  const state = fixture({
    pieces: [
      { side: "west", kind: "silver", promoted: true, at: "E5" },
      { side: "south", kind: "rook", at: "E7" },
    ],
  });
  const dropped = succeeded(eliminateSide(state, "west", "timeout")).state;
  const result = succeeded(applyAction(dropped, "south", move("E7", "E5")));
  expect(result.captured?.promoted).toBe(true);
  expect(result.state.hands.south.silver).toBe(1);
  expect(result.state.hands.west.silver).toBe(0);
});

test("投了は自手番だけで受理し、終局後の操作を拒否する", () => {
  let state = fixture();
  expect(eliminateSide(state, "west", "resigned")).toEqual({ ok: false, reason: "not_your_turn" });
  for (const side of ["west", "north", "east"] as const)
    state = succeeded(eliminateSide(state, side, "left")).state;
  expect(state.status).toBe("finished");
  expect(getLegalActions(state)).toEqual([]);
  expect(getLegalActionsForSide(state, "south")).toEqual([]);
  expect(applyAction(state, "south", move("A9", "B9"))).toEqual({
    ok: false,
    reason: "game_finished",
  });
  expect(eliminateSide(state, "south", "left")).toEqual({ ok: false, reason: "game_finished" });
});

test("ダブルスは対面ペアの誰かの脱落でチーム敗北とし個人順位を付けない", () => {
  for (const reason of [
    "resigned",
    "left",
    "timeout",
    "disconnected",
  ] as ExternalEliminationReason[]) {
    const result = succeeded(eliminateSide(fixture({ mode: "doubles" }), "south", reason));
    expect(result.state.result).toEqual({
      mode: "doubles",
      reason: "team_eliminated",
      winner: "west-east",
    });
    expect(result.eliminations[0].rank).toBeNull();
  }
});

test("両チームが同じ盤面で詰んだダブルスは引き分けにする", () => {
  const singles = doubleMate(true);
  const board = singles.board.map((row) => [...row]);
  board[2][7] = { ...board[2][7]!, side: "west" };
  const state: FourShogiState = { ...singles, board, mode: "doubles" };
  const result = succeeded(applyAction(state, "south", move("E2", "E1")));
  expect(result.state.result).toEqual({
    mode: "doubles",
    reason: "simultaneous_mate",
    winner: null,
  });
  expect(result.eliminations.map(({ side }) => side)).toEqual(["west", "north"]);
});

function freezeDeep(value: unknown): void {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) freezeDeep(item);
  }
}

test("全初期合法手は受理され、凍結した入力状態・着手を変更しない", () => {
  const state = createInitialState({
    mode: "singles",
    players: { south: "s", west: "w", north: "n", east: "e" },
  });
  const before = JSON.stringify(state);
  freezeDeep(state);
  const actions = getLegalActions(state);
  expect(actions.length).toBeGreaterThan(0);
  expect(getLegalActions(state)).toEqual(actions);
  for (const action of actions) {
    freezeDeep(action);
    const result = succeeded(applyAction(state, "south", action));
    expect(result.state.moveNumber).toBe(1);
    expect(result.state.lastMove?.side).toBe("south");
  }
  expect(JSON.stringify(state)).toBe(before);
  expect(applyAction(state, "west", actions[0])).toEqual({ ok: false, reason: "not_your_turn" });
  expect(applyAction(state, "south", move("A9", "J9"))).toEqual({
    ok: false,
    reason: "out_of_bounds",
  });
  expect(JSON.stringify(state)).toBe(before);
});

test("JSON保存復元後も合法手・着手結果・外部脱落結果が一致する", () => {
  let state = createInitialState({
    mode: "singles",
    players: { south: "s", west: "w", north: "n", east: "e" },
  });
  for (let index = 0; index < 12 && state.status === "playing"; index++) {
    const restored: FourShogiState = JSON.parse(JSON.stringify(state));
    const actions = getLegalActions(state);
    expect(getLegalActions(restored)).toEqual(actions);
    expect(getCheckState(restored)).toEqual(getCheckState(state));
    const action = actions[index % actions.length];
    const original = applyAction(state, state.turn, action);
    expect(applyAction(restored, restored.turn!, action)).toEqual(original);
    state = succeeded(original).state;
  }
  if (state.status === "playing") {
    const restored = JSON.parse(JSON.stringify(state)) as FourShogiState;
    expect(eliminateSide(restored, "east", "disconnected")).toEqual(
      eliminateSide(state, "east", "disconnected"),
    );
  }
});

test("初期化は担当者の重複・空ID・不正設定を拒否する", () => {
  expect(() =>
    createInitialState({
      mode: "singles",
      players: { south: "s", west: "s", north: "n", east: "e" },
    }),
  ).toThrow(TypeError);
  expect(() =>
    createInitialState({
      mode: "singles",
      players: { south: "", west: "w", north: "n", east: "e" },
    }),
  ).toThrow(TypeError);
  const options = {
    mode: "singles" as const,
    players: { south: "s", west: "w", north: "n", east: "e" },
  };
  const initial = createInitialState(options);
  options.players.south = "changed";
  expect(initial.players.south).toBe("s");
  expect(initial.rulesVersion).toBe(1);
  expect(Object.values(initial.repetitions)).toEqual([1]);
  expect(sides).toEqual(["south", "west", "north", "east"]);
  expect(position("E9")).toEqual({ x: 4, y: 8 });
});

test("型外の着手形や脱落理由も状態を変更せず拒否する", () => {
  const state = fixture();
  const before = structuredClone(state);
  for (const invalid of [
    null,
    undefined,
    { type: "unknown" },
    { type: "movePiece", from: position("A9"), to: position("B9") },
  ]) {
    expect(applyAction(state, "south", invalid as FourShogiAction)).toEqual({
      ok: false,
      reason: "invalid_action",
    });
  }
  expect(eliminateSide(state, "west", "unknown" as ExternalEliminationReason)).toEqual({
    ok: false,
    reason: "invalid_reason",
  });
  expect(state).toEqual(before);
});

test("呼び出し後に操作引数を変更しても確定した最終手へ影響しない", () => {
  const action = {
    type: "movePiece" as const,
    from: { x: 0, y: 8 },
    to: { x: 1, y: 8 },
    promote: false,
  };
  const result = succeeded(applyAction(fixture(), "south", action));
  action.from.x = 3;
  action.to.y = 4;
  expect(result.state.lastMove?.action).toEqual(move("A9", "B9"));
  expect(result.state.board[8][1]?.kind).toBe("king");
});
