import { expect, test } from "bun:test";
import { fixture } from "../bench/positionFixture";
import { studyCheckingRays } from "../src/studyTacticalSelection";

test("王手筋は距離だけの違いを同じとし、異なる方向を区別する", () => {
  const state = (at: string) => fixture({ pieces: [{ side: "south", kind: "rook", at }] });
  expect(studyCheckingRays(state("A3"), "south")).toEqual(studyCheckingRays(state("A4"), "south"));
  expect(studyCheckingRays(state("A3"), "south").length).toBeGreaterThan(0);
  expect(studyCheckingRays(state("A3"), "south")).not.toEqual(
    studyCheckingRays(state("D1"), "south"),
  );
});
