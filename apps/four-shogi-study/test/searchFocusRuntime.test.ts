import { expect, test } from "bun:test";
import type { FourShogiState } from "@tetraboard/four-shogi";
import { advanceAnalysisPosition, getAnalysisLegalActions } from "@tetraboard/four-shogi/analysis";
import { fixture } from "../../../packages/four-shogi/bench/positionFixture";
import { tacticalCases } from "../../../packages/four-shogi/bench/tactics";
import { restoreStudyPosition } from "../src/domain/study";
import { createStudySearchRuntime, type StudySearchSnapshot } from "../src/search/runtime";
import type { StudyPositionInput } from "../src/shared/model";

function setup(state: FourShogiState = fixture()): StudyPositionInput {
  return {
    origin: {
      kind: "setup",
      setup: {
        schemaVersion: 1,
        board: state.board.map((row) =>
          row.map((piece) =>
            piece ? { side: piece.side, kind: piece.kind, promoted: piece.promoted } : null,
          ),
        ),
        hands: state.hands,
        turn: state.turn!,
        threePlayerAttackProhibited: state.threePlayerAttackProhibited,
        eliminations: state.eliminations.map((entry) => ({
          side: entry.side,
          rank: entry.rank!,
          group: entry.group,
        })),
      },
    },
    events: [],
  };
}
async function completed(read: () => StudySearchSnapshot | null) {
  const deadline = performance.now() + 5000;
  while (performance.now() < deadline) {
    const value = read();
    if (value && ["completed", "cancelled", "error"].includes(value.status)) return value;
    await Bun.sleep(5);
  }
  throw new Error("フォーカス解析が終了しませんでした");
}
const shallow = { timeBudgetMs: null, maxDepth: 1, extensions: 0, dangerWork: 0 } as const;

test("他席の実手番を進めた局面で1/4並列解析し、元局面へ未来の手を推奨しない", async () => {
  const input = setup();
  const source = await restoreStudyPosition(input);
  const results: StudySearchSnapshot[] = [];
  for (const threads of [1, 4]) {
    const runtime = createStudySearchRuntime({ threads });
    try {
      const id = await runtime.start(input, { ...shallow, focusSide: "east" });
      const result = await completed(() => runtime.get(id));
      expect(result.status).toBe("completed");
      expect(result.focus?.status).toBe("ready");
      expect(result.focus?.prefix.map((step) => step.side)).toEqual(["south", "west", "north"]);
      expect(result.stateHash).toBe(source.stateHash);
      expect(result.analysisStateHash).not.toBe(source.stateHash);
      expect(result.rootSide).toBe("east");
      expect(result.focus?.conditional).toBe(true);
      expect(result.recommendedAction).toBeNull();
      expect(result.analysisRecommendedAction).toEqual(result.candidates[0]?.action);
      expect(result.candidates[0]?.line[0]?.side).toBe("east");
      let current = source;
      for (const step of result.focus!.prefix) {
        expect(current.state.turn).toBe(step.side);
        current = await advanceAnalysisPosition(current, {
          type: "action",
          side: step.side,
          action: step.action,
        });
      }
      expect(current.stateHash).toBe(result.analysisStateHash!);
      if (!result.analysisRecommendedAction) throw new Error("対象局面の推奨手がありません");
      expect(getAnalysisLegalActions(current)).toContainEqual(result.analysisRecommendedAction);
      results.push(result);
    } finally {
      await runtime.close();
    }
  }
  expect(results[0].candidates).toEqual(results[1].candidates);
  expect(results[0].analysisStateHash).toBe(results[1].analysisStateHash);
});

test("元からフォーカス本人の手番なら予測なしで直接採用できる推奨を返す", async () => {
  const runtime = createStudySearchRuntime({ threads: 1 });
  try {
    const id = await runtime.start(setup(), { ...shallow, focusSide: "south" });
    const result = await completed(() => runtime.get(id));
    expect(result.focus).toMatchObject({ status: "ready", conditional: false, prefix: [] });
    expect(result.analysisStateHash).toBe(result.stateHash);
    expect(result.recommendedAction).toEqual(result.analysisRecommendedAction);
    expect(result.recommendedAction).not.toBeNull();
  } finally {
    await runtime.close();
  }
});

test("投射前に一時停止しても時間と候補を凍結し、再開後に投射から進める", async () => {
  const runtime = createStudySearchRuntime({ threads: 1 });
  let pause = true;
  try {
    const id = await runtime.start(setup(), { ...shallow, focusSide: "east" }, (value) => {
      if (pause && value.status === "running") {
        pause = false;
        void runtime.pause(value.id);
      }
    });
    const paused = runtime.get(id)!;
    expect(paused.status).toBe("paused");
    expect(paused.analysisStateHash).toBeNull();
    await Bun.sleep(10);
    expect(runtime.get(id)?.elapsedMs).toBe(paused.elapsedMs);
    expect(runtime.get(id)?.candidates).toEqual([]);
    await runtime.resume(id);
    const result = await completed(() => runtime.get(id));
    expect(result.focus?.status).toBe("ready");
    expect(result.completedDepth).toBe(1);
  } finally {
    await runtime.close();
  }
});

test("予測中の取消と新しいフォーカスへの置換で古い結果を混ぜない", async () => {
  const runtime = createStudySearchRuntime({ threads: 1 });
  const old: StudySearchSnapshot[] = [];
  try {
    const first = await runtime.start(setup(), { ...shallow, focusSide: "east" }, (value) =>
      old.push(value),
    );
    await runtime.cancel(first);
    expect(runtime.get(first)?.status).toBe("cancelled");
    const count = old.length;
    const second = await runtime.start(setup(), { ...shallow, focusSide: "west" });
    const result = await completed(() => runtime.get(second));
    expect(result.focus?.side).toBe("west");
    expect(result.rootSide).toBe("west");
    expect(result.focus?.prefix.map((step) => step.side)).toEqual(["south"]);
    expect(old).toHaveLength(count);
    expect(runtime.get(first)?.analysisRecommendedAction).toBeNull();
  } finally {
    await runtime.close();
  }
});

test("投射も有限予算に含め、未到達なら未評価で停止して無制限に再開できる", async () => {
  const runtime = createStudySearchRuntime({ threads: 1 });
  try {
    const id = await runtime.start(setup(), { ...shallow, timeBudgetMs: 1, focusSide: "east" });
    const timed = await completed(() => runtime.get(id));
    expect(timed.reason).toBe("deadline");
    expect(timed.focus).toMatchObject({ status: "unreached", reason: "deadline" });
    expect(timed.analysisStateHash).toBeNull();
    expect(timed.candidates).toEqual([]);
    expect(timed.recommendedAction).toBeNull();
    expect(timed.analysisRecommendedAction).toBeNull();
    expect(timed.evaluation).toBeNull();
    await runtime.resume(id);
    const resumed = await completed(() => runtime.get(id));
    expect(resumed.focus?.status).toBe("ready");
    expect(resumed.completedDepth).toBe(1);
  } finally {
    await runtime.close();
  }
});

test("脱落済みフォーカスは手番を差し替えず、候補と推奨を返さない", async () => {
  const runtime = createStudySearchRuntime({ threads: 1 });
  try {
    const state = tacticalCases().find((entry) => entry.id === "last-opponent-false-south")!.state;
    const id = await runtime.start(setup(state), { ...shallow, focusSide: "north" });
    const result = await completed(() => runtime.get(id));
    expect(result.reason).toBe("focus_eliminated");
    expect(result.focus?.status).toBe("focus_eliminated");
    expect(result.analysisStateHash).toBeNull();
    expect(result.candidates).toEqual([]);
    expect(result.recommendedAction).toBeNull();
    expect(result.analysisRecommendedAction).toBeNull();
    await runtime.resume(id);
    expect(runtime.get(id)?.status).toBe("completed");
  } finally {
    await runtime.close();
  }
});
