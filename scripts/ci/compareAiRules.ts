/** Pythonとの開発用差分比較。ルール実行・状態出力には実TSエンジンを使います。 */
import { validateAnalysisReplay } from "../../packages/four-shogi/src/analysis";
import { createInitialState, getLegalActions } from "../../packages/four-shogi/src/index";
import { applyReplayEvent } from "../../packages/four-shogi/src/replay";

const requests: unknown[] = JSON.parse(await Bun.stdin.text());
const traces = requests.map((input) => {
  const replay = validateAnalysisReplay(input);
  let state = createInitialState(replay.initial);
  const frames: unknown[] = [{ state, legalActions: getLegalActions(state), transition: null }];
  for (const { event } of replay.events.slice(0, replay.eventOffset)) {
    const result = applyReplayEvent(state, event);
    if (result.ok) state = result.state;
    const transition = result.ok
      ? {
          ok: true,
          captured: "captured" in result ? result.captured : null,
          eliminations: "eliminations" in result ? result.eliminations : [],
        }
      : result;
    frames.push({ state, legalActions: getLegalActions(state), transition });
    if (!result.ok) break;
  }
  return frames;
});
process.stdout.write(JSON.stringify(traces));
