import { expect, test } from "bun:test";
import { applyAction, getLegalActions } from "../src/index";
import type {
  AttackRelation,
  AttackReason,
  FourShogiState,
  HandPieceKind,
  Side,
} from "../src/index";
import { drop, fixture, move, position, succeeded } from "./helpers";

function relation(state: FourShogiState, attacker: Side = "south", target: Side = "west") {
  return state.attackRelations.find(
    (entry) => entry.attacker === attacker && entry.target === target,
  );
}

function activeAttack(
  attacker: Side,
  target: Side,
  reasons: AttackReason[] = ["check"],
  targetPieceIds: number[] = [],
  pendingSides?: Side[],
): AttackRelation {
  return {
    attacker,
    target,
    reasons,
    targetPieceIds,
    pendingSides:
      pendingSides ??
      (["south", "west", "north", "east"] as Side[]).filter((side) => side !== attacker),
  };
}

const twoAttacks = [activeAttack("north", "west"), activeAttack("east", "west")];

const targetColumns = [
  { name: "遠い歩", kind: "pawn" as const, king: "A1", protected: false },
  { name: "近い歩・守りあり", kind: "pawn" as const, king: "F1", protected: true },
  { name: "近い歩・守りなし", kind: "pawn" as const, king: "F1", protected: false },
  { name: "金・守りあり", kind: "gold" as const, king: "A1", protected: true },
  { name: "金・守りなし", kind: "gold" as const, king: "A1", protected: false },
  { name: "飛車", kind: "rook" as const, king: "A1", protected: false },
];
const attackerRows: { kind: HandPieceKind | "king"; from: string; expected: boolean[] }[] = [
  { kind: "pawn", from: "D5", expected: [false, true, true, true, true, true] },
  { kind: "gold", from: "C5", expected: [false, false, true, true, true, true] },
  { kind: "rook", from: "B4", expected: [false, false, true, false, true, true] },
  { kind: "king", from: "B5", expected: [false, false, false, false, false, false] },
];

for (const attacker of attackerRows)
  for (const [index, target] of targetColumns.entries()) {
    test(`取りの狙いの判定表: ${attacker.kind}→${target.name}`, () => {
      const state = fixture({
        threePlayerAttackProhibited: true,
        kings: { west: target.king, ...(attacker.kind === "king" ? { south: attacker.from } : {}) },
        pieces: [
          ...(attacker.kind === "king"
            ? []
            : [{ side: "south" as const, kind: attacker.kind, at: attacker.from }]),
          { side: "west", kind: target.kind, at: "D3", id: 200 },
          ...(target.protected ? [{ side: "west" as const, kind: "gold" as const, at: "E3" }] : []),
        ],
      });
      const result = succeeded(
        applyAction(state, "south", move(attacker.from, attacker.kind === "king" ? "C4" : "D4")),
      );
      expect(relation(result.state)?.targetPieceIds.includes(200) ?? false).toBe(
        attacker.expected[index],
      );
    });
  }

for (const entry of [
  {
    kind: "pawn" as const,
    promoted: true,
    from: "C5",
    target: "gold" as const,
    protected: true,
    expected: true,
  },
  {
    kind: "silver" as const,
    promoted: false,
    from: "C5",
    target: "gold" as const,
    protected: true,
    expected: true,
  },
  {
    kind: "silver" as const,
    promoted: true,
    from: "C5",
    target: "gold" as const,
    protected: true,
    expected: true,
  },
  {
    kind: "rook" as const,
    promoted: true,
    from: "B4",
    target: "gold" as const,
    protected: true,
    expected: false,
  },
  {
    kind: "rook" as const,
    promoted: true,
    from: "B4",
    target: "pawn" as const,
    protected: false,
    expected: true,
  },
]) {
  test(`成駒と銀も対応する取りの狙い行を使う: ${entry.kind}/${entry.promoted}/${entry.target}/${entry.protected}`, () => {
    const state = fixture({
      threePlayerAttackProhibited: true,
      kings: { west: "F1" },
      pieces: [
        { side: "south", kind: entry.kind, at: entry.from, promoted: entry.promoted },
        { side: "west", kind: entry.target, at: "D3", id: 200 },
        ...(entry.protected ? [{ side: "west" as const, kind: "gold" as const, at: "E3" }] : []),
      ],
    });
    const result = succeeded(applyAction(state, "south", move(entry.from, "D4")));
    expect(relation(result.state)?.targetPieceIds.includes(200) ?? false).toBe(entry.expected);
  });
}

test("守りには自王へピンされた駒の幾何的な利きを含める", () => {
  const state = fixture({
    threePlayerAttackProhibited: true,
    kings: { west: "E9" },
    pieces: [
      { side: "south", kind: "rook", at: "C6" },
      { side: "south", kind: "rook", at: "E1" },
      { side: "west", kind: "gold", at: "D5", id: 200 },
      { side: "west", kind: "gold", at: "E5" },
    ],
  });
  const result = succeeded(applyAction(state, "south", move("C6", "D6")));
  expect(relation(result.state)?.targetPieceIds.includes(200) ?? false).toBe(false);
});

test("移動で発生した新しい王手を着手者の攻撃として記録する", () => {
  const state = fixture({
    threePlayerAttackProhibited: true,
    kings: { west: "E1" },
    pieces: [{ side: "south", kind: "rook", at: "D3" }],
  });
  const result = succeeded(applyAction(state, "south", move("D3", "E3")));
  expect(relation(result.state)?.reasons).toContain("check");
});

for (const target of [
  { kind: "rook" as const, promoted: false },
  { kind: "rook" as const, promoted: true },
  { kind: "gold" as const, promoted: false },
  { kind: "silver" as const, promoted: false },
  { kind: "silver" as const, promoted: true },
  { kind: "pawn" as const, promoted: false },
  { kind: "pawn" as const, promoted: true },
]) {
  test(`捕獲分類: ${target.kind}/${target.promoted}`, () => {
    const state = fixture({
      threePlayerAttackProhibited: true,
      pieces: [
        { side: "south", kind: "pawn", at: "D4" },
        { side: "west", ...target, at: "D3" },
      ],
    });
    const result = succeeded(applyAction(state, "south", move("D4", "D3")));
    expect(relation(result.state)?.reasons.includes("capture") ?? false).toBe(
      target.kind !== "pawn",
    );
  });
}

test("王による金の捕獲は捕獲分類の攻撃にしない", () => {
  const state = fixture({
    threePlayerAttackProhibited: true,
    kings: { south: "C4" },
    pieces: [{ side: "west", kind: "gold", at: "D3" }],
  });
  const result = succeeded(applyAction(state, "south", move("C4", "D3")));
  expect(relation(result.state)?.reasons.includes("capture") ?? false).toBe(false);
});

test("第三者の飛車の空き王手も利きを開けた着手者の攻撃とする", () => {
  const state = fixture({
    threePlayerAttackProhibited: true,
    kings: { west: "E1" },
    pieces: [
      { side: "north", kind: "rook", at: "E6" },
      { side: "south", kind: "gold", at: "E4" },
    ],
  });
  const result = succeeded(applyAction(state, "south", move("E4", "D4")));
  expect(relation(result.state)?.reasons).toContain("check");
  expect(relation(result.state, "north", "west")).toBeUndefined();
});

test("第三者の飛車の新しい封鎖は利きを開けた着手者へ帰属する", () => {
  const state = fixture({
    threePlayerAttackProhibited: true,
    kings: { west: "E1" },
    pieces: [
      { side: "north", kind: "rook", at: "D6" },
      { side: "south", kind: "gold", at: "D4" },
    ],
  });
  const result = succeeded(applyAction(state, "south", move("D4", "C4")));
  expect(relation(result.state)?.reasons).toContain("blockade");
  expect(relation(result.state)?.reasons).not.toContain("check");
  expect(relation(result.state, "north", "west")).toBeUndefined();
});

test("第三者の駒への空き利きだけでは新しい取りの狙いに数えない", () => {
  const state = fixture({
    threePlayerAttackProhibited: true,
    pieces: [
      { side: "north", kind: "rook", at: "D6" },
      { side: "south", kind: "gold", at: "D4" },
      { side: "west", kind: "gold", at: "D2" },
    ],
  });
  const result = succeeded(applyAction(state, "south", move("D4", "C4")));
  expect(relation(result.state)?.reasons.includes("threat") ?? false).toBe(false);
});

test("同じ駒の取りを維持しただけの手は新しい攻撃にしない", () => {
  const state = fixture({
    threePlayerAttackProhibited: true,
    pieces: [
      { side: "south", kind: "rook", at: "D6" },
      { side: "west", kind: "gold", at: "D3", id: 200 },
    ],
  });
  const result = succeeded(applyAction(state, "south", move("D6", "D4")));
  expect(relation(result.state)?.targetPieceIds.includes(200) ?? false).toBe(false);
});

test("同じ飛車が王の周囲に利いていれば封鎖マスが入れ替わっても維持とする", () => {
  const state = fixture({
    threePlayerAttackProhibited: true,
    kings: { west: "E1" },
    pieces: [{ side: "south", kind: "rook", at: "D3" }],
    attackRelations: twoAttacks,
  });
  const result = succeeded(applyAction(state, "south", move("D3", "F3")));
  expect(relation(result.state)?.reasons.includes("blockade") ?? false).toBe(false);
});

for (const pendingSides of [["south", "west", "east"], ["south"]] as Side[][]) {
  test(`同じ標的駒への追加の取りは免除し、直後に元の関係が消えても遡及しない: ${pendingSides.length}`, () => {
    const state = fixture({
      threePlayerAttackProhibited: true,
      pieces: [
        { side: "south", kind: "pawn", at: "D5" },
        { side: "west", kind: "gold", at: "D3", id: 200 },
      ],
      attackRelations: [activeAttack("north", "west", ["threat"], [200], pendingSides)],
    });
    const result = succeeded(applyAction(state, "south", move("D5", "D4")));
    expect(relation(result.state)?.targetPieceIds.includes(200) ?? false).toBe(false);
    if (pendingSides.length === 1) expect(result.state.attackRelations).toEqual([]);
  });
}

test("三人目の新しい取りを合法手から除き、拒否時には履歴も盤面も変えない", () => {
  const state = fixture({
    threePlayerAttackProhibited: true,
    pieces: [
      { side: "south", kind: "pawn", at: "D5" },
      { side: "west", kind: "gold", at: "D3" },
    ],
    attackRelations: twoAttacks,
  });
  const before = structuredClone(state);
  expect(getLegalActions(state)).not.toContainEqual(move("D5", "D4"));
  expect(applyAction(state, "south", move("D5", "D4"))).toEqual({
    ok: false,
    reason: "three_player_attack",
  });
  expect(state).toEqual(before);
});

test("自王への王手の応手では同時に作った取りも全相手への攻撃から除外する", () => {
  const state = fixture({
    threePlayerAttackProhibited: true,
    kings: { south: "E9", north: "I3" },
    pieces: [
      { side: "west", kind: "rook", at: "E1" },
      { side: "west", kind: "gold", at: "F7" },
      { side: "south", kind: "gold", at: "D8" },
    ],
    attackRelations: twoAttacks,
  });
  const result = succeeded(applyAction(state, "south", move("D8", "E8")));
  expect(result.state.attackRelations.filter((entry) => entry.attacker === "south")).toEqual([]);
});

test("次の自手番で複数の捕獲マスのどれかを取り返す手は攻撃から免除する", () => {
  const state = fixture({
    threePlayerAttackProhibited: true,
    pieces: [
      { side: "south", kind: "pawn", at: "D4" },
      { side: "west", kind: "gold", at: "D3" },
    ],
    attackRelations: twoAttacks,
    recaptureSquares: { south: [position("F6"), position("D3")] },
  });
  const result = succeeded(applyAction(state, "south", move("D4", "D3")));
  expect(result.state.attackRelations.filter((entry) => entry.attacker === "south")).toEqual([]);
  expect(result.state.recaptureSquares.south).toEqual([]);
});

test("取り返さなかった自手番の後は、以前の捕獲マスへの取り返し免除を失う", () => {
  const state = fixture({
    threePlayerAttackProhibited: true,
    pieces: [
      { side: "south", kind: "pawn", at: "D4" },
      { side: "west", kind: "gold", at: "D3" },
    ],
    attackRelations: twoAttacks,
    recaptureSquares: { south: [position("D3")] },
  });
  const result = succeeded(applyAction(state, "south", move("A9", "B9")));
  expect(result.state.recaptureSquares.south).toEqual([]);
  const later = {
    ...result.state,
    status: "playing" as const,
    turn: "south" as const,
    result: null,
  };
  expect(applyAction(later, "south", move("D4", "D3"))).toEqual({
    ok: false,
    reason: "three_player_attack",
  });
});

test("攻撃状態は他の3人それぞれの実着手で解除する", () => {
  let state = fixture({
    turn: "west",
    threePlayerAttackProhibited: true,
    attackRelations: [activeAttack("south", "west")],
  });
  state = succeeded(applyAction(state, "west", move("A1", "B1"))).state;
  expect(relation(state)?.pendingSides).toEqual(["north", "east"]);
  state = succeeded(applyAction(state, "north", move("I1", "H1"))).state;
  expect(relation(state)?.pendingSides).toEqual(["east"]);
  state = succeeded(applyAction(state, "east", move("I9", "H9"))).state;
  expect(relation(state)).toBeUndefined();
});

test("王手で飛ばされた陣営は攻撃期限の実着手に数えない", () => {
  const state = fixture({
    threePlayerAttackProhibited: true,
    kings: { east: "I5" },
    pieces: [
      { side: "south", kind: "rook", at: "E4" },
      { side: "north", kind: "pawn", at: "I2" },
    ],
    attackRelations: [activeAttack("west", "north")],
  });
  const first = succeeded(applyAction(state, "south", move("E4", "I4"))).state;
  expect(first.turn).toBe("east");
  expect(relation(first, "west", "north")?.pendingSides).toEqual(["north", "east"]);
  const next = succeeded(applyAction(first, "east", move("I5", "H5"))).state;
  expect(relation(next, "west", "north")?.pendingSides).toEqual(["north"]);
});

test("非攻撃手では自分の古い攻撃状態を消さない", () => {
  const state = fixture({
    threePlayerAttackProhibited: true,
    attackRelations: [activeAttack("south", "west", ["check"], [], ["east"])],
  });
  const result = succeeded(applyAction(state, "south", move("A9", "B9")));
  expect(relation(result.state)).toEqual(state.attackRelations[0]);
});

test("攻撃に使った駒が捕獲されても他の3人の着手まで状態は継続する", () => {
  const state = fixture({
    turn: "west",
    threePlayerAttackProhibited: true,
    pieces: [
      { side: "south", kind: "pawn", at: "D4" },
      { side: "west", kind: "gold", at: "D3", id: 200 },
    ],
    attackRelations: [activeAttack("south", "west", ["threat"], [200])],
  });
  const result = succeeded(applyAction(state, "west", move("D3", "D4")));
  expect(relation(result.state)?.pendingSides).toEqual(["north", "east"]);
});

test("再攻撃は期限と今回の理由へ更新し、以前の理由や標的駒を引き継がない", () => {
  const state = fixture({
    threePlayerAttackProhibited: true,
    pieces: [
      { side: "south", kind: "pawn", at: "D4" },
      { side: "west", kind: "gold", at: "D3" },
    ],
    attackRelations: [activeAttack("south", "west", ["check", "threat"], [300], ["east"])],
  });
  const result = succeeded(applyAction(state, "south", move("D4", "D3")));
  expect(relation(result.state)).toEqual({
    attacker: "south",
    target: "west",
    reasons: ["capture"],
    targetPieceIds: [],
    pendingSides: ["west", "north", "east"],
  });
});

test("通常合法手が全て同じ標的を攻撃するときだけ、その標的の制限を免除する", () => {
  const state = fixture({
    threePlayerAttackProhibited: true,
    pieces: [
      { side: "south", kind: "pawn", at: "A8" },
      { side: "south", kind: "pawn", at: "B8" },
      { side: "south", kind: "pawn", at: "B9" },
      { side: "west", kind: "gold", at: "A7" },
      { side: "west", kind: "gold", at: "B7" },
    ],
    attackRelations: twoAttacks,
  });
  expect(getLegalActions(state)).toEqual(
    expect.arrayContaining([move("A8", "A7"), move("B8", "B7")]),
  );
  expect(getLegalActions(state)).toHaveLength(2);
});

test("選択肢がない免除は標的別であり、他の標的への三人攻撃は引き続き拒否する", () => {
  const state = fixture({
    threePlayerAttackProhibited: true,
    pieces: [
      { side: "south", kind: "pawn", at: "A8" },
      { side: "south", kind: "pawn", at: "B8" },
      { side: "south", kind: "pawn", at: "B9" },
      { side: "west", kind: "gold", at: "A7" },
      { side: "west", kind: "gold", at: "B7" },
      { side: "north", kind: "gold", at: "A6" },
    ],
    attackRelations: [...twoAttacks, activeAttack("west", "north"), activeAttack("east", "north")],
  });
  expect(applyAction(state, "south", move("A8", "A7"))).toEqual({
    ok: false,
    reason: "three_player_attack",
  });
  expect(getLegalActions(state)).toContainEqual(move("B8", "B7"));
});

test("禁止対象を直ちに詰ませる一手撃破は三人目でも受理する", () => {
  const state = fixture({
    threePlayerAttackProhibited: true,
    kings: { west: "E1" },
    pieces: [
      { side: "south", kind: "rook", at: "D3" },
      { side: "south", kind: "rook", at: "F3" },
      { side: "south", kind: "silver", at: "E3" },
      { side: "south", kind: "rook", at: "G2" },
    ],
    attackRelations: twoAttacks,
  });
  const result = succeeded(applyAction(state, "south", move("G2", "E2")));
  expect(
    result.eliminations.some((entry) => entry.side === "west" && entry.reason === "checkmate"),
  ).toBe(true);
});

test("別の陣営を詰ませても禁止対象への三人攻撃は免除しない", () => {
  const state = fixture({
    threePlayerAttackProhibited: true,
    kings: { north: "E2" },
    pieces: [
      { side: "south", kind: "pawn", at: "E4" },
      { side: "west", kind: "silver", at: "E3" },
      { side: "south", kind: "rook", at: "D4" },
      { side: "south", kind: "rook", at: "F4" },
      { side: "south", kind: "rook", at: "E5" },
      { side: "south", kind: "gold", at: "D1" },
    ],
    attackRelations: twoAttacks,
  });
  expect(applyAction(state, "south", move("E4", "E3"))).toEqual({
    ok: false,
    reason: "three_player_attack",
  });
});

for (const variant of ["off", "doubles", "eliminated"] as const) {
  test(`${variant}では三人攻撃の追加制限を作用させない`, () => {
    const state = fixture({
      mode: variant === "doubles" ? "doubles" : "singles",
      threePlayerAttackProhibited: variant !== "off",
      pieces: [
        { side: "south", kind: "pawn", at: "D5" },
        { side: "west", kind: "gold", at: "D3" },
      ],
      attackRelations: twoAttacks,
      ...(variant === "eliminated"
        ? { eliminations: [{ side: "east" as const, reason: "left" as const, rank: 4, group: 1 }] }
        : {}),
    });
    expect(getLegalActions(state)).toContainEqual(move("D5", "D4"));
    succeeded(applyAction(state, "south", move("D5", "D4")));
  });
}

for (const occupant of ["west", "north"] as const) {
  test(`封鎖は標的自身の駒の占有マスを除き、第三者の駒のマスは含める: ${occupant}`, () => {
    const state = fixture({
      threePlayerAttackProhibited: true,
      pieces: [
        { side: "south", kind: "rook", at: "C4" },
        { side: occupant, kind: "pawn", at: "B2" },
      ],
    });
    const result = succeeded(applyAction(state, "south", move("C4", "B4")));
    expect(relation(result.state)?.reasons.includes("blockade") ?? false).toBe(occupant !== "west");
  });
}

test("既に別の敵駒が利いている王の周囲へ、新しい駒を利かせても封鎖に数える", () => {
  const state = fixture({
    threePlayerAttackProhibited: true,
    pieces: [
      { side: "south", kind: "rook", at: "C4" },
      { side: "north", kind: "pawn", at: "B2" },
      { side: "east", kind: "gold", at: "C3" },
    ],
  });
  const result = succeeded(applyAction(state, "south", move("C4", "B4")));
  expect(relation(result.state)?.reasons).toContain("blockade");
});

test("元の捕獲者とは別の第三者へ入れ替わった駒の取り返しも免除する", () => {
  const state = fixture({
    threePlayerAttackProhibited: true,
    pieces: [
      { side: "south", kind: "pawn", at: "D4" },
      { side: "east", kind: "gold", at: "D3" },
    ],
    attackRelations: [activeAttack("west", "east"), activeAttack("north", "east")],
    recaptureSquares: { south: [position("D3")] },
  });
  const result = succeeded(applyAction(state, "south", move("D4", "D3")));
  expect(result.state.attackRelations.filter((entry) => entry.attacker === "south")).toEqual([]);
});

test("同じ標的駒への取りの狙い免除は、その駒の捕獲分類には適用しない", () => {
  const state = fixture({
    threePlayerAttackProhibited: true,
    pieces: [
      { side: "south", kind: "pawn", at: "D4" },
      { side: "west", kind: "gold", at: "D3", id: 200 },
    ],
    attackRelations: [
      activeAttack("north", "west", ["threat"], [200]),
      activeAttack("east", "west"),
    ],
  });
  expect(applyAction(state, "south", move("D4", "D3"))).toEqual({
    ok: false,
    reason: "three_player_attack",
  });
});

test("同じマスに新IDの標的がいても捕獲前の標的IDの免除を引き継がない", () => {
  const state = fixture({
    threePlayerAttackProhibited: true,
    pieces: [
      { side: "south", kind: "pawn", at: "D5" },
      { side: "west", kind: "gold", at: "D3", id: 201 },
    ],
    attackRelations: [
      activeAttack("north", "west", ["threat"], [200]),
      activeAttack("east", "west"),
    ],
  });
  expect(applyAction(state, "south", move("D5", "D4"))).toEqual({
    ok: false,
    reason: "three_player_attack",
  });
});

test("守りは候補手後に調べ、飛車打ちで守りを遮る取りの狙いを検出する", () => {
  const state = fixture({
    threePlayerAttackProhibited: true,
    pieces: [
      { side: "west", kind: "gold", at: "D4", id: 200 },
      { side: "west", kind: "rook", at: "G4" },
    ],
    hands: { south: { rook: 1 } },
  });
  const result = succeeded(applyAction(state, "south", drop("rook", "E4")));
  expect(relation(result.state)?.targetPieceIds).toContain(200);
});

for (const target of [
  { kind: "pawn" as const, promoted: true },
  { kind: "silver" as const, promoted: false },
  { kind: "silver" as const, promoted: true },
  { kind: "rook" as const, promoted: true },
]) {
  test(`標的のと金・銀・成銀・龍も対応する表の列で判定する: ${target.kind}/${target.promoted}`, () => {
    const state = fixture({
      threePlayerAttackProhibited: true,
      kings: { west: "F1" },
      pieces: [
        { side: "south", kind: "pawn", at: "D5" },
        { side: "west", ...target, at: "D3", id: 200 },
      ],
    });
    const result = succeeded(applyAction(state, "south", move("D5", "D4")));
    expect(relation(result.state)?.targetPieceIds).toContain(200);
  });
}
