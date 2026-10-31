import { expect, test } from "bun:test";
import { fixture } from "../../../packages/four-shogi/bench/positionFixture";
import { tacticInput } from "../bench/tacticsDiagnostics";
import { createGuardedStudySearchRuntime } from "../src/search/guardedRuntime";
import type { StudySearchRuntime, StudySearchSnapshot } from "../src/search/runtime";

async function finish(runtime: StudySearchRuntime, id: string) {
  const until = performance.now() + 3000;
  while (performance.now() < until) {
    const snapshot = runtime.get(id);
    if (snapshot && !["running", "paused"].includes(snapshot.status)) return snapshot;
    await Bun.sleep(2);
  }
  throw Error("フォーカスの検査が終了しませんでした");
}

for (const restricted of [false, true])
  for (const alive of [2, 3, 4])
    test(`実手番と一致するフォーカスでも有限ガードを実行する: ${alive}人/禁止${restricted}`, async () => {
      const input = tacticInput(
        fixture({
          threePlayerAttackProhibited: restricted,
          eliminations: [
            { side: "west" as const, reason: "left" as const, rank: 4, group: 1 },
            { side: "north" as const, reason: "left" as const, rank: 3, group: 2 },
          ].slice(0, 4 - alive),
        }),
      );
      const runtime = createGuardedStudySearchRuntime(
        { threads: 1, memoryMb: 512 },
        { mode: "observe", budgetMs: 50, horizon: 1 },
      );
      try {
        const id = await runtime.start(input, {
          focusSide: "south",
          timeBudgetMs: 1000,
          maxDepth: 1,
        });
        const result = await finish(runtime, id);
        expect(result.lethalGuard?.stateHash).toBe(result.stateHash);
        expect(result.lethalGuard?.horizon).toBe(1);
        expect(result.completion?.guard).toBe("complete");
        expect(result.focus?.prefix).toHaveLength(0);
        expect(result.analysisStateHash).toBe(result.stateHash);
        expect(result.recommendedAction).toEqual(result.analysisRecommendedAction);
      } finally {
        await runtime.close();
      }
    });

test("未来のフォーカスに現在局面の生存証明を付けず、直接推奨もしない", async () => {
  const runtime = createGuardedStudySearchRuntime(
    { threads: 1, memoryMb: 512 },
    { mode: "observe", budgetMs: 50, horizon: 1 },
  );
  try {
    const id = await runtime.start(tacticInput(fixture()), {
      focusSide: "west",
      timeBudgetMs: 1000,
      maxDepth: 1,
    });
    const result = await finish(runtime, id);
    expect(result.lethalGuard).toBeUndefined();
    expect(result.focus?.conditional).toBe(true);
    expect(result.recommendedAction).toBeNull();
    expect(result.analysisStateHash).not.toBe(result.stateHash);
  } finally {
    await runtime.close();
  }
});

test("フォーカスの復元中に置換した要求は検査を起動せず、新しい世代だけを公開する", async () => {
  const runtime = createGuardedStudySearchRuntime(
    { threads: 1, memoryMb: 512 },
    { mode: "observe", budgetMs: 50, horizon: 1 },
  );
  const old: StudySearchSnapshot[] = [];
  try {
    const options = { focusSide: "south" as const, timeBudgetMs: 1000, maxDepth: 1 };
    const first = runtime.start(tacticInput(fixture()), options, (s) => old.push(s));
    const second = runtime.start(tacticInput(fixture()), options);
    await expect(first).rejects.toThrow("取り消され");
    const result = await finish(runtime, await second);
    expect(result.lethalGuard?.stateHash).toBe(result.stateHash);
    expect(old).toHaveLength(0);
  } finally {
    await runtime.close();
  }
});
