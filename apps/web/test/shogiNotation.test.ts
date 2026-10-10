import { expect, test } from "bun:test";
import {
  shogiMoveNotation,
  shogiNotationPiece,
  shogiNotationSquare,
  shogiReplayLabel,
  type NotationMove,
} from "../src/features/room/shogiNotation";
import type { Position, Side } from "../src/features/room/shogiUiTypes";

const square = (text: string): Position => ({
  x: 9 - Number(text[0]),
  y: "一二三四五六七八九".indexOf(text[1]),
});
const gold = { kind: "gold", promoted: false } as const;
function notation(
  from: string,
  to: string,
  origins: readonly string[],
  piece: NotationMove["piece"] = gold,
  side: Side = "south",
) {
  const action = { type: "movePiece", from: square(from), to: square(to), promote: false } as const;
  return shogiMoveNotation({
    action,
    piece,
    side,
    previousDestination: null,
    legalMoves: origins.map((origin) => ({ action: { ...action, from: square(origin) }, piece })),
  });
}

test("全81マスを固定の筋・段へ変換する", () => {
  const expected = [
    "9一 8一 7一 6一 5一 4一 3一 2一 1一",
    "9二 8二 7二 6二 5二 4二 3二 2二 1二",
    "9三 8三 7三 6三 5三 4三 3三 2三 1三",
    "9四 8四 7四 6四 5四 4四 3四 2四 1四",
    "9五 8五 7五 6五 5五 4五 3五 2五 1五",
    "9六 8六 7六 6六 5六 4六 3六 2六 1六",
    "9七 8七 7七 6七 5七 4七 3七 2七 1七",
    "9八 8八 7八 6八 5八 4八 3八 2八 1八",
    "9九 8九 7九 6九 5九 4九 3九 2九 1九",
  ];
  for (let y = 0; y < 9; y++)
    for (let x = 0; x < 9; x++)
      expect(shogiNotationSquare({ x, y })).toBe(expected[y].split(" ")[x]);
});

test.each([
  ["king", false, "王"],
  ["rook", false, "飛"],
  ["bishop", false, "角"],
  ["gold", false, "金"],
  ["silver", false, "銀"],
  ["knight", false, "桂"],
  ["lance", false, "香"],
  ["pawn", false, "歩"],
  ["rook", true, "龍"],
  ["bishop", true, "馬"],
  ["silver", true, "成銀"],
  ["knight", true, "成桂"],
  ["lance", true, "成香"],
  ["pawn", true, "と"],
] as const)("駒名 %s/%s は %s", (kind, promoted, name) => {
  expect(shogiNotationPiece({ kind, promoted })).toBe(name);
});

test.each([
  ["9三", "8二", ["9三", "7二"], "8二金上"],
  ["7二", "8二", ["9三", "7二"], "8二金寄"],
  ["3一", "3二", ["4三", "3一"], "3二金引"],
  ["7九", "7八", ["8九", "7九"], "7八金直"],
  ["8九", "7八", ["8九", "7九"], "7八金左"],
  ["4九", "5八", ["6九", "4九"], "5八金右"],
] as const)("動作・直・左右 %s→%s", (from, to, origins, expected) => {
  expect(notation(from, to, origins)).toBe(expected);
});

test("3枚以上の同種駒には必要な複合語だけを付ける", () => {
  const origins = ["7九", "8九", "9九", "9八", "8七"];
  const piece = { kind: "pawn", promoted: true } as const;
  expect(notation("9九", "8八", origins, piece)).toBe("8八と左上");
  expect(notation("7九", "8八", origins, piece)).toBe("8八と右");
  expect(notation("8九", "8八", origins, piece)).toBe("8八と直");
  expect(notation("9八", "8八", origins, piece)).toBe("8八と寄");
  expect(notation("8七", "8八", origins, piece)).toBe("8八と引");
});

test.each(["rook", "bishop"] as const)(
  "%sの成駒には直を使わず、縦移動を他候補との左右関係で識別する",
  (kind) => {
    const piece = { kind, promoted: true };
    expect(notation("8九", "8八", ["9九", "8九"], piece)).toBe(
      `8八${kind === "rook" ? "龍" : "馬"}右`,
    );
  },
);

test("不正な候補集合を曖昧なラベルや移動元表示へ読み替えない", () => {
  expect(() => notation("8九", "5五", ["8九", "7八"], { kind: "rook", promoted: true })).toThrow(
    "Unable to disambiguate",
  );
});

test("成り・強制成り・不成・既成駒と成り二択の重複を区別する", () => {
  const piece = { kind: "silver", promoted: false } as const;
  const action = {
    type: "movePiece",
    from: square("5四"),
    to: square("5三"),
    promote: false,
  } as const;
  const legalMoves = [
    { action, piece },
    { action: { ...action, promote: true }, piece },
  ];
  const input = { action, piece, legalMoves, previousDestination: null, side: "south" as const };
  expect(shogiMoveNotation(input)).toBe("5三銀不成");
  expect(shogiMoveNotation({ ...input, action: { ...action, promote: true } })).toBe("5三銀成");
  expect(shogiMoveNotation({ ...input, legalMoves: [{ action, piece }] })).toBe("5三銀");
  const promoted = { ...piece, promoted: true };
  expect(
    shogiMoveNotation({ ...input, piece: promoted, legalMoves: [{ action, piece: promoted }] }),
  ).toBe("5三成銀");
  expect(
    shogiMoveNotation({
      ...input,
      piece: { kind: "pawn", promoted: false },
      action: { ...action, to: square("5一"), promote: true },
      legalMoves: [],
    }),
  ).toBe("5一歩成");
});

test.each([
  ["rook", "飛"],
  ["bishop", "角"],
  ["gold", "金"],
  ["silver", "銀"],
  ["knight", "桂"],
  ["lance", "香"],
  ["pawn", "歩"],
] as const)("打ち駒 %s には常に打を付ける", (kind, name) => {
  expect(
    shogiMoveNotation({
      action: { type: "dropPiece", pieceKind: kind, to: square("5五") },
      piece: { kind, promoted: false },
      legalMoves: [],
      previousDestination: null,
      side: "north",
    }),
  ).toBe(`5五${name}打`);
});

test("同の比較は固定座標、方向語は全4陣営の向きを使い、入力を変更しない", () => {
  const cases = [
    ["south", "6九", "5八", ["6九", "4九"], "5八金左"],
    ["west", "9四", "8五", ["9四", "9六"], "8五金左"],
    ["north", "4一", "5二", ["4一", "6一"], "5二金左"],
    ["east", "1六", "2五", ["1六", "1四"], "2五金左"],
  ] as const;
  for (const [side, from, to, origins, expected] of cases)
    expect(notation(from, to, origins, gold, side)).toBe(expected);
  const action = {
    type: "movePiece",
    from: square("5六"),
    to: square("5五"),
    promote: false,
  } as const;
  const input = {
    action,
    piece: gold,
    legalMoves: [{ action, piece: gold }],
    previousDestination: square("5五"),
    side: "west" as const,
  };
  const before = JSON.stringify(input);
  expect(shogiMoveNotation(input)).toBe("同金");
  expect(JSON.stringify(input)).toBe(before);
});

test("手数と▲△・方角、特殊イベントと読み上げ名", () => {
  expect(shogiReplayLabel("▲", "先手", "7六歩", 1)).toEqual({
    label: "1: ▲7六歩",
    accessibleLabel: "1: 先手7六歩",
  });
  expect(shogiReplayLabel("△", "後手", "3四歩", 2)).toEqual({
    label: "2: △3四歩",
    accessibleLabel: "2: 後手3四歩",
  });
  expect(shogiReplayLabel("▲", "先手", "入玉宣言")).toEqual({
    label: "▲ 入玉宣言",
    accessibleLabel: "先手 入玉宣言",
  });
  expect(shogiReplayLabel("西", "西", "同銀", 2)).toEqual({ label: "2: 西同銀" });
});
