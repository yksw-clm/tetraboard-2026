import { expect } from "bun:test";
import type { ApplyActionResult, EliminateSideResult, TransitionSuccess } from "../src/index";
export {
  position,
  move,
  drop,
  fixture,
  type FixturePiece,
  type FixtureOptions,
} from "../bench/positionFixture";

export function succeeded(result: ApplyActionResult | EliminateSideResult): TransitionSuccess {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(`Expected a legal action, received ${result.reason}`);
  return result;
}
