import { getAnalysisLegalActions } from "@tetraboard/four-shogi/analysis";
import { expect, test } from "bun:test";
import {
  createStudy,
  appendStudyEvent,
  studyPositionInput,
  restoreStudyPosition,
} from "../src/domain/study";
import {
  createStudySearchRuntime,
  type StudySearchRuntime,
  type StudySearchSnapshot,
  type StudySearchOptions,
} from "../src/search/runtime";
import { createPvFocusRuntime } from "../src/search/focusRuntime";
const options: StudySearchOptions = {
  strategy: "dual-continuations",
  timeBudgetMs: null,
  maxDepth: 2,
  rootWidth: 6,
  width: 2,
  extensions: 0,
};
async function done(
  runtime: StudySearchRuntime,
  input: Parameters<StudySearchRuntime["start"]>[0],
  opts = options,
  onSnapshot = (_s: StudySearchSnapshot) => {},
) {
  return new Promise<StudySearchSnapshot>((resolve, reject) => {
    void runtime
      .start(input, opts, (s) => {
        onSnapshot(s);
        if (s.status === "error") reject(Error(s.reason ?? "search error"));
        else if (s.status === "completed") resolve(s);
      })
      .catch(reject);
  });
}
test("PVの優先順位は固定深さの全候補・四人評価・PVと根集合を変えない", async () => {
  const study = await createStudy(),
    input = studyPositionInput(study);
  const first = createStudySearchRuntime({ threads: 1, memoryMb: 256 });
  let control: StudySearchSnapshot;
  try {
    control = await done(first, input);
  } finally {
    await first.close();
  }
  const hint = control!.candidates[2].action;
  const queues: number[][] = [];
  const runtime = createStudySearchRuntime({
    threads: 1,
    memoryMb: 256,
    rootOrderHint: () => hint,
    observeDiagnostic: (e) => {
      if (e.type === "iteration" && e.depth === 2) queues.push(e.roots);
    },
  });
  try {
    const result = await done(runtime, input);
    const semantic = (s: StudySearchSnapshot) =>
      s.candidates.map((c) => ({
        action: c.action,
        evaluation: c.evaluation,
        line: c.line,
        depth: c.completedDepth,
      }));
    expect(semantic(result)).toEqual(semantic(control!));
    expect(result.diagnostics.hintReorders).toBeGreaterThan(0);
    const legal = getAnalysisLegalActions(await restoreStudyPosition(input));
    expect(queues[0][0]).toBe(legal.findIndex((a) => JSON.stringify(a) === JSON.stringify(hint)));
  } finally {
    await runtime.close();
  }
});
test("実着手一致のPVを次ジョブへ渡し、別scopeと明示取消では破棄する", async () => {
  const study = await createStudy(),
    runtime = createPvFocusRuntime({ threads: 1, memoryMb: 256 });
  const opts = { ...options, maxDepth: 3, focusSide: "south" as const, sessionKey: "same-game" };
  try {
    const first = await done(runtime, studyPositionInput(study), opts);
    await runtime.holdFocus!(first.id);
    const step = first.candidates[0].line[0];
    const next = await appendStudyEvent(study, {
      type: "action",
      side: step.side,
      action: step.action,
    });
    let seen: StudySearchSnapshot | null = null;
    const second = await done(runtime, studyPositionInput(next), opts, (s) => {
      seen = s;
    });
    expect(second.id).not.toBe(first.id);
    expect(second.continuation?.pvHit).toBe(true);
    expect(second.focus?.conditional).toBe(true);
    expect(second.recommendedAction).toBeNull();
    await runtime.holdFocus!(second.id);
    const other = await done(runtime, studyPositionInput(next), {
      ...opts,
      sessionKey: "other-game",
    });
    expect(other.continuation?.pvHit).toBe(false);
    await runtime.cancel(other.id);
    const restarted = await done(runtime, studyPositionInput(next), opts);
    expect(restarted.continuation?.pvHit).toBe(false);
    expect(seen).not.toBeNull();
  } finally {
    await runtime.close();
  }
});
