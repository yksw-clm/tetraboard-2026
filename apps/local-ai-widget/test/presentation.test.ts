import { expect, test } from "bun:test";
import { shogiCandidateLabel } from "../src/presentation";
import { eligible } from "../src/model";
import { shogiObservation } from "./fixtures";
test("将棋の移動・成り・不成・駒打ちを移動先が同じでも区別する", () => {
  const o = shogiObservation();
  if (!eligible(o)) throw Error("fixture");
  expect(
    shogiCandidateLabel(
      { type: "movePiece", from: { x: 4, y: 6 }, to: { x: 4, y: 5 }, promote: false },
      o,
    ),
  ).toBe("5七 → 5六 歩不成");
  expect(
    shogiCandidateLabel(
      { type: "movePiece", from: { x: 4, y: 6 }, to: { x: 4, y: 5 }, promote: true },
      o,
    ),
  ).toBe("5七 → 5六 歩成");
  expect(shogiCandidateLabel({ type: "dropPiece", pieceKind: "rook", to: { x: 4, y: 5 } }, o)).toBe(
    "5六 飛打",
  );
});
