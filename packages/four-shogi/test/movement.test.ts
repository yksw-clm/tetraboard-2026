import { expect, test } from "bun:test";
import {
  applyAction,
  createInitialState,
  getLegalActions,
  getLegalActionsForSide,
} from "../src/index";
import type { FourShogiState, PieceKind, Side } from "../src/index";
import { drop, fixture, move, position, succeeded } from "./helpers";

const sides = ["south", "west", "north", "east"] as const;

function destinations(state: FourShogiState, from: string): string[] {
  const at = position(from);
  return [
    ...new Set(
      getLegalActions(state)
        .filter(
          (action) =>
            action.type === "movePiece" && action.from.x === at.x && action.from.y === at.y,
        )
        .map((action) => `${String.fromCharCode(65 + action.to.x)}${action.to.y + 1}`),
    ),
  ].sort();
}

test("初期配置は36枚・9枚ずつ、全駒不成・持ち駒なしで南から始まる", () => {
  const state = createInitialState({
    mode: "singles",
    players: { south: "s", west: "w", north: "n", east: "e" },
  });
  expect(state.turn).toBe("south");
  expect(state.threePlayerAttackProhibited).toBe(true);
  expect(state.moveNumber).toBe(0);
  expect(state.lastMove).toBeNull();
  expect(state.board.flat().filter(Boolean)).toHaveLength(36);
  const expected: Record<Side, Record<PieceKind, string[]>> = {
    south: {
      king: ["E9"],
      rook: ["E8"],
      gold: ["D9", "F9"],
      silver: ["C9", "G9"],
      pawn: ["D8", "E7", "F8"],
    },
    west: {
      king: ["A5"],
      rook: ["B5"],
      gold: ["A4", "A6"],
      silver: ["A3", "A7"],
      pawn: ["B4", "B6", "C5"],
    },
    north: {
      king: ["E1"],
      rook: ["E2"],
      gold: ["D1", "F1"],
      silver: ["C1", "G1"],
      pawn: ["D2", "E3", "F2"],
    },
    east: {
      king: ["I5"],
      rook: ["H5"],
      gold: ["I4", "I6"],
      silver: ["I3", "I7"],
      pawn: ["G5", "H4", "H6"],
    },
  };
  for (const side of sides) {
    expect(state.hands[side]).toEqual({ rook: 0, gold: 0, silver: 0, pawn: 0 });
    for (const kind of ["king", "rook", "gold", "silver", "pawn"] as const) {
      const squares: string[] = [];
      for (let y = 0; y < 9; y++)
        for (let x = 0; x < 9; x++) {
          const piece = state.board[y][x];
          if (piece?.side === side && piece.kind === kind) {
            expect(piece.promoted).toBe(false);
            squares.push(`${String.fromCharCode(65 + x)}${y + 1}`);
          }
        }
      expect(squares.sort()).toEqual(expected[side][kind].sort());
    }
  }
  expect(
    new Set(
      state.board
        .flat()
        .filter(Boolean)
        .map((piece) => piece!.id),
    ).size,
  ).toBe(36);
});

const directionCases: { side: Side; gold: string[]; silver: string[]; pawn: string[] }[] = [
  {
    side: "south",
    gold: ["D4", "D5", "E4", "E6", "F4", "F5"],
    silver: ["D4", "D6", "E4", "F4", "F6"],
    pawn: ["E4"],
  },
  {
    side: "west",
    gold: ["D5", "E4", "E6", "F4", "F5", "F6"],
    silver: ["D4", "D6", "F4", "F5", "F6"],
    pawn: ["F5"],
  },
  {
    side: "north",
    gold: ["D5", "D6", "E4", "E6", "F5", "F6"],
    silver: ["D4", "D6", "E6", "F4", "F6"],
    pawn: ["E6"],
  },
  {
    side: "east",
    gold: ["D4", "D5", "D6", "E4", "E6", "F5"],
    silver: ["D4", "D5", "D6", "F4", "F6"],
    pawn: ["D5"],
  },
];
for (const entry of directionCases) {
  for (const kind of ["gold", "silver", "pawn"] as const) {
    test(`${entry.side}の${kind}は所属方向に従って動く`, () => {
      const state = fixture({ turn: entry.side, pieces: [{ side: entry.side, kind, at: "E5" }] });
      expect(destinations(state, "E5")).toEqual(entry[kind]);
    });
  }
  for (const kind of ["silver", "pawn"] as const) {
    test(`${entry.side}の成った${kind}は金と同じ6方向へ動く`, () => {
      const state = fixture({
        turn: entry.side,
        pieces: [{ side: entry.side, kind, at: "E5", promoted: true }],
      });
      expect(destinations(state, "E5")).toEqual(entry.gold);
    });
  }
}

for (const promoted of [false, true]) {
  test(
    promoted ? "龍は飛車の直線に斜め1マスを加える" : "飛車は縦横の障害物のないマスへ動く",
    () => {
      const state = fixture({ pieces: [{ side: "south", kind: "rook", at: "E5", promoted }] });
      expect(destinations(state, "E5")).toEqual(
        [
          "A5",
          "B5",
          "C5",
          "D5",
          "E1",
          "E2",
          "E3",
          "E4",
          "E6",
          "E7",
          "E8",
          "E9",
          "F5",
          "G5",
          "H5",
          "I5",
          ...(promoted ? ["D4", "D6", "F4", "F6"] : []),
        ].sort(),
      );
    },
  );
}

test("自駒・相手駒・裏王は飛車を遮り、王の捕獲を許可しない", () => {
  const state = fixture({
    kings: { east: "I5" },
    pieces: [
      { side: "south", kind: "rook", at: "E5" },
      { side: "south", kind: "gold", at: "E3" },
      { side: "west", kind: "pawn", at: "E7" },
      { side: "north", kind: "pawn", at: "G5" },
    ],
    eliminations: [{ side: "east", reason: "left", rank: 4, group: 1 }],
  });
  expect(destinations(state, "E5")).toEqual(["A5", "B5", "C5", "D5", "E4", "E6", "E7", "F5", "G5"]);
  expect(applyAction(state, "south", move("E5", "E3"))).toEqual({
    ok: false,
    reason: "friendly_piece",
  });
  expect(applyAction(state, "south", move("E5", "I5"))).toEqual({
    ok: false,
    reason: "king_capture",
  });
});

for (const entry of [
  { side: "south" as const, from: "E4", to: "E3" },
  { side: "west" as const, from: "F5", to: "G5" },
  { side: "north" as const, from: "E6", to: "E7" },
  { side: "east" as const, from: "D5", to: "C5" },
]) {
  test(`${entry.side}は対面の3段に入ると成り・不成を選べる`, () => {
    const state = fixture({
      turn: entry.side,
      pieces: [{ side: entry.side, kind: "silver", at: entry.from }],
    });
    expect(getLegalActions(state)).toContainEqual(move(entry.from, entry.to));
    expect(getLegalActions(state)).toContainEqual(move(entry.from, entry.to, true));
    const result = succeeded(applyAction(state, entry.side, move(entry.from, entry.to, true)));
    const at = position(entry.to);
    expect(result.state.board[at.y][at.x]?.promoted).toBe(true);
    const source = position(entry.from);
    expect(result.state.board[at.y][at.x]?.id).toBe(state.board[source.y][source.x]?.id);
  });
}
for (const [from, to] of [
  ["E3", "E2"],
  ["E3", "D4"],
]) {
  test(`成れる区域の中と退出時にも成れる: ${from}→${to}`, () => {
    const state = fixture({ pieces: [{ side: "south", kind: "silver", at: from }] });
    expect(getLegalActions(state)).toContainEqual(move(from, to, true));
  });
}
for (const entry of [
  { side: "south" as const, from: "E2", to: "E1" },
  { side: "west" as const, from: "H5", to: "I5" },
  { side: "north" as const, from: "E8", to: "E9" },
  { side: "east" as const, from: "B5", to: "A5" },
]) {
  test(`${entry.side}の最終段への歩は必ず成り、最終段に歩を打てない`, () => {
    const state = fixture({
      turn: entry.side,
      pieces: [{ side: entry.side, kind: "pawn", at: entry.from }],
      hands: { [entry.side]: { pawn: 1 } },
    });
    expect(applyAction(state, entry.side, move(entry.from, entry.to))).toEqual({
      ok: false,
      reason: "promotion_required",
    });
    expect(getLegalActions(state)).toContainEqual(move(entry.from, entry.to, true));
    expect(applyAction(state, entry.side, drop("pawn", entry.to))).toEqual({
      ok: false,
      reason: "dead_end_pawn",
    });
  });
}

test("成れない金と区域外の銀の成り、不可能な移動を拒否する", () => {
  const state = fixture({
    pieces: [
      { side: "south", kind: "gold", at: "C5" },
      { side: "south", kind: "silver", at: "F5" },
    ],
  });
  expect(applyAction(state, "south", move("C5", "C4", true))).toEqual({
    ok: false,
    reason: "invalid_promotion",
  });
  expect(applyAction(state, "south", move("F5", "F4", true))).toEqual({
    ok: false,
    reason: "invalid_promotion",
  });
  expect(applyAction(state, "south", move("F5", "H3"))).toEqual({
    ok: false,
    reason: "invalid_movement",
  });
});

test("捕獲した成駒は不成の持ち駒になり、打ち直した駒には新IDを与える", () => {
  const state = fixture({
    pieces: [
      { side: "south", kind: "rook", at: "E5", id: 200 },
      { side: "west", kind: "rook", at: "E7", promoted: true, id: 201 },
    ],
  });
  const original = structuredClone(state);
  const captured = succeeded(applyAction(state, "south", move("E5", "E7")));
  expect(captured.captured).toEqual(state.board[6][4]);
  expect(captured.state.board[6][4]).toEqual({
    id: 200,
    side: "south",
    kind: "rook",
    promoted: false,
  });
  expect(captured.state.hands.south.rook).toBe(1);
  const dropped = succeeded(
    applyAction(
      { ...captured.state, status: "playing", turn: "south", result: null },
      "south",
      drop("rook", "D5"),
    ),
  );
  expect(dropped.state.board[4][3]).toMatchObject({ side: "south", kind: "rook", promoted: false });
  expect(dropped.state.board[4][3]?.id).not.toBe(201);
  expect(dropped.state.hands.south.rook).toBe(0);
  expect(state).toEqual(original);
});

for (const entry of [
  { side: "south" as const, pawn: "D6", nifu: "D4", other: "E4" },
  { side: "west" as const, pawn: "C6", nifu: "E6", other: "E5" },
  { side: "north" as const, pawn: "D4", nifu: "D6", other: "E6" },
  { side: "east" as const, pawn: "F6", nifu: "D6", other: "D5" },
]) {
  test(`${entry.side}の二歩は所属の筋を調べ、他の筋への歩打ちは許可する`, () => {
    const state = fixture({
      turn: entry.side,
      pieces: [{ side: entry.side, kind: "pawn", at: entry.pawn }],
      hands: { [entry.side]: { pawn: 1 } },
    });
    expect(applyAction(state, entry.side, drop("pawn", entry.nifu))).toEqual({
      ok: false,
      reason: "nifu",
    });
    expect(getLegalActions(state)).toContainEqual(drop("pawn", entry.other));
  });
}

test("他陣営の歩と自分のと金は二歩に数えず、持ち駒不足と占有マスを拒否する", () => {
  const state = fixture({
    pieces: [
      { side: "west", kind: "pawn", at: "D6" },
      { side: "south", kind: "pawn", at: "E6", promoted: true },
    ],
    hands: { south: { pawn: 2 } },
  });
  expect(getLegalActions(state)).toContainEqual(drop("pawn", "D4"));
  expect(getLegalActions(state)).toContainEqual(drop("pawn", "E4"));
  expect(applyAction(state, "south", drop("silver", "F5"))).toEqual({
    ok: false,
    reason: "missing_hand_piece",
  });
  expect(applyAction(state, "south", drop("pawn", "D6"))).toEqual({
    ok: false,
    reason: "occupied",
  });
});

test("王を守る駒を外して空き王手を受ける手は拒否する", () => {
  const state = fixture({
    kings: { south: "E9" },
    pieces: [
      { side: "west", kind: "rook", at: "E1" },
      { side: "south", kind: "rook", at: "E5" },
    ],
  });
  expect(applyAction(state, "south", move("E5", "F5"))).toEqual({
    ok: false,
    reason: "self_check",
  });
  expect(getLegalActions(state)).not.toContainEqual(move("E5", "F5"));
  expect(getLegalActions(state)).toContainEqual(move("E5", "E4"));
});

test("敵王へピンされた敵飛車の利きも自王の安全判定に使う", () => {
  const state = fixture({
    kings: { south: "E9", west: "A1", north: "I3" },
    pieces: [
      { side: "west", kind: "rook", at: "E1" },
      { side: "south", kind: "rook", at: "I1" },
      { side: "south", kind: "pawn", at: "G7" },
    ],
  });
  expect(applyAction(state, "south", move("G7", "G6"))).toEqual({
    ok: false,
    reason: "self_check",
  });
});

test("敵王の隣へ王を移動できない", () => {
  const state = fixture({ kings: { south: "D5", west: "F5" } });
  expect(applyAction(state, "south", move("D5", "E5"))).toEqual({
    ok: false,
    reason: "self_check",
  });
  expect(getLegalActions(state)).not.toContainEqual(move("D5", "E5"));
});

test("直接の歩打ちで応手をなくす打ち歩詰めを拒否する", () => {
  const state = fixture({
    kings: { north: "E1" },
    pieces: [
      { side: "south", kind: "rook", at: "D4" },
      { side: "south", kind: "rook", at: "F4" },
      { side: "south", kind: "gold", at: "E3" },
    ],
    hands: { south: { pawn: 1 } },
  });
  expect(applyAction(state, "south", drop("pawn", "E2"))).toEqual({
    ok: false,
    reason: "pawn_drop_mate",
  });
  expect(getLegalActions(state)).not.toContainEqual(drop("pawn", "E2"));
});

test("盤上の歩を進める突き歩詰めは受理し、詰んだ陣営を脱落させる", () => {
  const state = fixture({
    kings: { north: "E1" },
    pieces: [
      { side: "south", kind: "rook", at: "D3" },
      { side: "south", kind: "rook", at: "F3" },
      { side: "south", kind: "rook", at: "E5" },
      { side: "south", kind: "pawn", at: "E3" },
    ],
  });
  const result = succeeded(applyAction(state, "south", move("E3", "E2")));
  expect(result.eliminations).toContainEqual({
    side: "north",
    reason: "checkmate",
    rank: 4,
    group: 1,
  });
});

test("裏王へ直接利かせる歩打ちは禁止し、盤上の歩の前進は許可する", () => {
  const state = fixture({
    kings: { east: "I5" },
    pieces: [{ side: "south", kind: "pawn", at: "I7" }],
    hands: { south: { pawn: 1 } },
    eliminations: [{ side: "east", reason: "left", rank: 4, group: 1 }],
  });
  const withoutPawn = fixture({
    kings: { east: "I5" },
    hands: { south: { pawn: 1 } },
    eliminations: state.eliminations,
  });
  expect(applyAction(withoutPawn, "south", drop("pawn", "I6"))).toEqual({
    ok: false,
    reason: "dead_king_pawn_drop",
  });
  expect(getLegalActions(state)).toContainEqual(move("I7", "I6"));
});

test("脱落者の成駒は利きを失うが捕獲して持ち駒にできる", () => {
  const state = fixture({
    pieces: [
      { side: "south", kind: "rook", at: "E5" },
      { side: "west", kind: "silver", at: "C5", promoted: true },
    ],
    eliminations: [{ side: "west", reason: "timeout", rank: 4, group: 1 }],
  });
  const result = succeeded(applyAction(state, "south", move("E5", "C5")));
  expect(result.state.hands.south.silver).toBe(1);
  expect(getLegalActionsForSide(state, "west")).toEqual([]);
});

test("手番違い・空マス・他人の駒・非整数座標を状態を変えずに拒否する", () => {
  const state = fixture({
    pieces: [
      { side: "south", kind: "silver", at: "E5" },
      { side: "west", kind: "gold", at: "G5" },
    ],
  });
  const before = structuredClone(state);
  expect(applyAction(state, "west", move("G5", "H5"))).toEqual({
    ok: false,
    reason: "not_your_turn",
  });
  expect(applyAction(state, "south", move("D5", "D4"))).toEqual({ ok: false, reason: "no_piece" });
  expect(applyAction(state, "south", move("G5", "H5"))).toEqual({
    ok: false,
    reason: "not_your_piece",
  });
  expect(
    applyAction(state, "south", {
      type: "movePiece",
      from: position("E5"),
      to: { x: 3.5, y: 3 },
      promote: false,
    }),
  ).toEqual({ ok: false, reason: "out_of_bounds" });
  expect(state).toEqual(before);
});
