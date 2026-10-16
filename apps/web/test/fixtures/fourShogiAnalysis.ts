import { createInitialState, getLegalActions, type FourShogiState } from "@tetraboard/four-shogi";
import { analyzePosition, type AiModelEvaluator } from "@tetraboard/four-shogi/ai";
import { applyReplayEvent } from "@tetraboard/four-shogi/replay";
import { fourShogiMatchDetailSchema, type FourShogiReplayEvent } from "@tetraboard/protocol";
import { shogiArchives } from "../../../../test-fixtures/matches";
import { createFourShogiReplayFrame } from "../../src/features/room/fourShogiReplayV1";
import {
  replayAnalysisRoot,
  analysisBudgets,
  type AnalysisProfile,
} from "../../src/features/room/fourShogiAnalysis";
export const analysisCode = "a".repeat(40);
export const analysisModel = "four-shogi-tiny-policy-value-v1:" + "b".repeat(64);
export const analysisInstance = "00000000-0000-4000-8000-000000000099";
export const analysisHealth = {
  schemaVersion: 1,
  serviceInstanceId: analysisInstance,
  requestWindow: 0,
  codeVersion: analysisCode,
  engineVersion: "tetraboard-four-shogi-rules-v1",
  modelId: analysisModel,
  status: "ready",
  workers: 2,
  running: 0,
  queued: 0,
  cpuReserved: 1,
  memory: { observedBytes: 100, peakBytes: 100, limitBytes: 939524096 },
};
export function analysisFixture(prohibited = true) {
  const match = fourShogiMatchDetailSchema.parse(
    shogiArchives.find((f) => f.name === "shogi-singles-draw")!.detail,
  );
  match.replay.initial.threePlayerAttackProhibited = prohibited;
  match.settings.threePlayerAttackProhibited = prohibited;
  const events: FourShogiReplayEvent[] = [];
  let state: FourShogiState = createInitialState(match.replay.initial);
  const frames = [createFourShogiReplayFrame(state)];
  const add = (event: FourShogiReplayEvent) => {
    const before = state;
    const result = applyReplayEvent(state, event);
    if (!result.ok) throw Error("Invalid analysis fixture");
    state = result.state;
    events.push(event);
    frames.push(createFourShogiReplayFrame(state, { before, event }));
  };
  for (let i = 0; i < 4; i++)
    add({
      type: "action",
      side: state.turn!,
      action: i === 0 ? getLegalActions(state).at(-1)! : getLegalActions(state)[0],
    });
  for (const side of ["west", "north", "east"] as const)
    add({ type: "eliminate", side, reason: "left" });
  match.game = frames.at(-1)!.game as typeof match.game;
  match.replay.eventCount = events.length;
  return { match, frames, events };
}
const evaluator: AiModelEvaluator = {
  modelId: analysisModel,
  evaluate: async (rows) => ({
    modelId: analysisModel,
    rows: rows.map((row) => {
      const values = [0.1, 0.2, 0.3, 0.2].map((v, i) =>
        row.features.current.indices.includes(2689 + i) ? v : 0,
      );
      return {
        id: row.id,
        legalActionIds: row.legalActionIds,
        policy: row.legalActionIds.map((_, i) => Number(i === 0)),
        policyLogits: row.legalActionIds.map((_, i) => Number(i === 0)),
        topActionId: row.legalActionIds[0],
        value: [...values, 1 - values.reduce((a, b) => a + b, 0)],
        illegalPolicyNonzero: 0,
      };
    }),
  }),
};
export async function fixtureAnalysis(
  fixture: ReturnType<typeof analysisFixture>,
  index = 0,
  profile: AnalysisProfile = "trial-500ms",
) {
  const root = await replayAnalysisRoot(fixture.match, fixture.frames, index);
  let now = 0;
  const result = await analyzePosition(
    root.position,
    {
      codeVersion: analysisCode,
      modelId: analysisModel,
      ...analysisBudgets[profile],
      maxDepth: 64,
      width: 3,
      rootWidth: 6,
      extensions: 0,
      candidateCount: 5,
      dangerWork: 0,
      includeAction: root.actual,
    },
    {
      modelEvaluator: evaluator,
      now: () => now,
      yieldToHost: async () => {},
      onProgress: (progress) => {
        if (progress.completedDepth >= 2) now = analysisBudgets[profile].timeBudgetMs;
      },
    },
  );
  return { root, result };
}
