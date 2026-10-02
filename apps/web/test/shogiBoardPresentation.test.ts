import { expect, test } from "bun:test";
import type { FourShogiAction } from "@tetraboard/four-shogi";
import {
  shogiActionChoices,
  shogiBoardPosition,
  shogiBoardPositionAtPoint,
  shogiDisplayPosition,
  shogiDragThresholdReached,
  shogiPieceDirection,
  shogiSameSelection,
  shogiSidePlacement,
  shogiSides,
} from "../src/features/room/shogiBoardPresentation";

test("本人方向を下に置き、全81マスを表示座標と基準座標の間で往復する", () => {
  const expected = {
    south: { x: 0, y: 1 },
    west: { x: 1, y: 8 },
    north: { x: 8, y: 7 },
    east: { x: 7, y: 0 },
  };
  for (const viewer of shogiSides) {
    expect(shogiDisplayPosition({ x: 0, y: 1 }, viewer)).toEqual(expected[viewer]);
    expect(shogiSidePlacement(viewer, viewer)).toBe("bottom");
    expect(shogiPieceDirection(viewer, viewer)).toBe("up");
    const positions = new Set<string>();
    for (let y = 0; y < 9; y++) {
      for (let x = 0; x < 9; x++) {
        const display = shogiDisplayPosition({ x, y }, viewer);
        positions.add(`${display.x},${display.y}`);
        expect(shogiBoardPosition(display, viewer)).toEqual({ x, y });
      }
    }
    expect(positions.size).toBe(81);
  }
});

test("四陣営の相対配置と進行向きを同じ順序で表示する", () => {
  const placements = ["bottom", "left", "top", "right"];
  const directions = ["up", "right", "down", "left"];
  for (const [index, viewer] of shogiSides.entries()) {
    for (let offset = 0; offset < 4; offset++) {
      const side = shogiSides[(index + offset) % 4];
      expect(shogiSidePlacement(side, viewer)).toBe(placements[offset]);
      expect(shogiPieceDirection(side, viewer)).toBe(directions[offset]);
    }
  }
});

test("ドラッグの終点は木目の内側の矩形で判定し、盤外や不正値を送信先にしない", () => {
  const rectangle = { left: 20, top: 30, width: 450, height: 490 };
  expect(shogiBoardPositionAtPoint({ x: 21, y: 31 }, rectangle, "south")).toEqual({ x: 0, y: 0 });
  expect(shogiBoardPositionAtPoint({ x: 469, y: 519 }, rectangle, "south")).toEqual({ x: 8, y: 8 });
  expect(shogiBoardPositionAtPoint({ x: 21, y: 31 }, rectangle, "west")).toEqual({ x: 8, y: 0 });
  expect(shogiBoardPositionAtPoint({ x: 21, y: 31 }, rectangle, "north")).toEqual({ x: 8, y: 8 });
  expect(shogiBoardPositionAtPoint({ x: 21, y: 31 }, rectangle, "east")).toEqual({ x: 0, y: 8 });
  for (const point of [
    { x: 19, y: 30 },
    { x: 470, y: 30 },
    { x: 20, y: 520 },
    { x: 20, y: 29 },
    { x: NaN, y: 31 },
  ]) {
    expect(shogiBoardPositionAtPoint(point, rectangle, "south")).toBeNull();
  }
  expect(
    shogiBoardPositionAtPoint({ x: 20, y: 30 }, { ...rectangle, width: 0 }, "south"),
  ).toBeNull();
});

test("選択駒と移動先に対応するサーバーの候補だけを取り出し、成りの二択を保つ", () => {
  const actions: FourShogiAction[] = [
    { type: "movePiece", from: { x: 4, y: 3 }, to: { x: 4, y: 2 }, promote: false },
    { type: "movePiece", from: { x: 4, y: 3 }, to: { x: 4, y: 2 }, promote: true },
    { type: "movePiece", from: { x: 5, y: 3 }, to: { x: 4, y: 2 }, promote: true },
    { type: "dropPiece", pieceKind: "silver", to: { x: 4, y: 2 } },
    { type: "dropPiece", pieceKind: "pawn", to: { x: 4, y: 2 } },
  ];
  const snapshot = structuredClone(actions);
  expect(
    shogiActionChoices(actions, { type: "movePiece", from: { x: 4, y: 3 } }, { x: 4, y: 2 }),
  ).toEqual(actions.slice(0, 2));
  expect(
    shogiActionChoices(actions, { type: "dropPiece", pieceKind: "silver" }, { x: 4, y: 2 }),
  ).toEqual([actions[3]]);
  expect(
    shogiActionChoices(actions, { type: "dropPiece", pieceKind: "rook" }, { x: 4, y: 2 }),
  ).toEqual([]);
  expect(
    shogiActionChoices(actions, { type: "movePiece", from: { x: 4, y: 3 } }, { x: 3, y: 2 }),
  ).toEqual([]);
  expect(actions).toEqual(snapshot);
});

test("同じ駒の再選択と異なる選択元を区別する", () => {
  const first = { type: "movePiece" as const, from: { x: 4, y: 3 } };
  expect(shogiSameSelection(first, { type: "movePiece", from: { x: 4, y: 3 } })).toBe(true);
  expect(shogiSameSelection(first, { type: "movePiece", from: { x: 5, y: 3 } })).toBe(false);
  expect(shogiSameSelection(first, { type: "dropPiece", pieceKind: "pawn" })).toBe(false);
  expect(
    shogiSameSelection(
      { type: "dropPiece", pieceKind: "pawn" },
      { type: "dropPiece", pieceKind: "pawn" },
    ),
  ).toBe(true);
  expect(
    shogiSameSelection(
      { type: "dropPiece", pieceKind: "pawn" },
      { type: "dropPiece", pieceKind: "silver" },
    ),
  ).toBe(false);
});

test("8px未満の動きはクリックのままとし、斜めも実距離でドラッグに切り替える", () => {
  expect(shogiDragThresholdReached({ x: 10, y: 10 }, { x: 17, y: 10 })).toBe(false);
  expect(shogiDragThresholdReached({ x: 10, y: 10 }, { x: 18, y: 10 })).toBe(true);
  expect(shogiDragThresholdReached({ x: 10, y: 10 }, { x: 15, y: 15 })).toBe(false);
  expect(shogiDragThresholdReached({ x: 10, y: 10 }, { x: 16, y: 16 })).toBe(true);
});
