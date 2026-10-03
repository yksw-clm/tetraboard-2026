import { expect, test } from "bun:test";
import {
  boardPositionForDisplay,
  nextRotation,
  rotatedShogiViewer,
  type QuarterTurn,
} from "../src/features/room/boardRotation";
import { shogiBoardPosition } from "../src/features/room/shogiBoardPresentation";

test("時計回りの回転で基準座標は維持され、8×8と9×9の全マスが一対一に対応する", () => {
  for (const size of [8, 9]) {
    for (const rotation of [0, 1, 2, 3] as const) {
      const positions = Array.from({ length: size * size }, (_, i) =>
        boardPositionForDisplay({ x: i % size, y: Math.floor(i / size) }, size, rotation),
      );
      expect(new Set(positions.map(({ x, y }) => `${x},${y}`)).size).toBe(size * size);
      expect(positions.every(({ x, y }) => x >= 0 && x < size && y >= 0 && y < size)).toBe(true);
    }
  }
  expect(boardPositionForDisplay({ x: 7, y: 0 }, 8, 1)).toEqual({ x: 0, y: 0 });
  expect(boardPositionForDisplay({ x: 7, y: 7 }, 8, 2)).toEqual({ x: 0, y: 0 });
  expect(boardPositionForDisplay({ x: 0, y: 7 }, 8, 3)).toEqual({ x: 0, y: 0 });
});

test("4回で初期方向へ戻り、将棋の既存の座標変換と一致する", () => {
  let rotation: QuarterTurn = 0;
  const viewers = [];
  for (let i = 0; i < 4; i++) {
    const viewer = rotatedShogiViewer("south", rotation);
    viewers.push(viewer);
    expect(shogiBoardPosition({ x: 2, y: 5 }, viewer)).toEqual(
      boardPositionForDisplay({ x: 2, y: 5 }, 9, rotation),
    );
    rotation = nextRotation(rotation);
  }
  expect(viewers).toEqual(["south", "east", "north", "west"]);
  expect(rotation).toBe(0);
});
