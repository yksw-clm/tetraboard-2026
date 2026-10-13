import { applyAction } from "@tetraboard/four-shogi";
import { chooseLv3Action } from "@tetraboard/four-shogi/lv3";
import type { AiModel } from "@tetraboard/protocol/shogi-ai";
import { lv3Fixtures as fixtures } from "../../../packages/four-shogi/bench/lv3Fixtures";
export function passesTacticalGate(model: Pick<AiModel, "maxWork" | "weights">): boolean {
  return fixtures.slice(0, 3).every((fixture) => {
    const state = fixture.state,
      result = chooseLv3Action(state, { maxWork: model.maxWork, weights: model.weights });
    return (
      !!result.action &&
      applyAction(state, state.turn!, result.action).ok &&
      JSON.stringify(result.action) !== JSON.stringify(fixture.avoid)
    );
  });
}
