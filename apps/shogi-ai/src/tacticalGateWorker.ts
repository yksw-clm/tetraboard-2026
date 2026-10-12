import { applyAction, type FourShogiState } from "@tetraboard/four-shogi";
import { chooseLv3Action } from "@tetraboard/four-shogi/lv3";
import { lv3Fixtures as fixtures } from "../../../packages/four-shogi/bench/lv3Fixtures";
import { AiStore } from "./store";
const store = new AiStore(process.env.AI_DATA_DIR ?? ".shogi-ai");
const model = store.model(process.argv[2]);
for (const fixture of fixtures.slice(0, 3)) {
  const state = fixture.state as FourShogiState;
  const result = chooseLv3Action(state, { maxWork: model.maxWork, weights: model.weights });
  if (
    !result.action ||
    !applyAction(state, state.turn!, result.action).ok ||
    JSON.stringify(result.action) === JSON.stringify(fixture.avoid)
  ) {
    store.close();
    process.exit(1);
  }
}
store.close();
