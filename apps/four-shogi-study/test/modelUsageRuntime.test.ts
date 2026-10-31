import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeZeroLocalModelFixture } from "../../../packages/four-shogi/bench/localModelFixture";
import { fixture } from "../../../packages/four-shogi/bench/positionFixture";
import { tacticInput } from "../bench/tacticsDiagnostics";
import { createStudySearchRuntime, type StudySearchSnapshot } from "../src/search/runtime";
import { focusConditions } from "../src/search/focusRuntime";

test("同じモデルでもPolicy利用とValue利用をフォーカスの再利用条件で区別する", () => {
  const options = {
    timeBudgetMs: 5000,
    evaluationModel: { file: "fixture", modelId: "same", usage: "policy" as const },
  };
  expect(focusConditions({}, options)).not.toBe(
    focusConditions(
      {},
      { ...options, evaluationModel: { ...options.evaluationModel, usage: "policy-value" } },
    ),
  );
});

test("実workerでPolicyだけを使いG0 Valueを保ち、両headやG0への切替で評価を混ぜない", async () => {
  const directory = mkdtempSync(join(tmpdir(), "study-model-usage-"));
  const runtime = createStudySearchRuntime({ threads: 1, memoryMb: 512, measureStages: true });
  try {
    const model = await writeZeroLocalModelFixture(directory);
    const input = tacticInput(fixture());
    async function run(usage?: "policy" | "policy-value") {
      let settle!: (value: StudySearchSnapshot) => void;
      const done = new Promise<StudySearchSnapshot>((r) => {
        settle = r;
      });
      await runtime.start(
        input,
        {
          strategy: "dual-continuations",
          timeBudgetMs: 1000,
          maxDepth: 1,
          ...(usage
            ? { evaluationModel: { file: model.file, modelId: model.modelId, usage } }
            : {}),
        },
        (s) => {
          if (!["running", "paused"].includes(s.status)) settle(s);
        },
      );
      return done;
    }
    const policy = await run("policy");
    expect(policy.status).toBe("completed");
    expect(policy.evaluation?.evaluationKind).toBe("heuristic");
    expect(policy.performance?.modelPolicyUses).toBeGreaterThan(0);
    expect(policy.performance?.modelValueUses).toBe(0);
    expect(policy.diagnostics.searchVersion).toContain("model-policy");
    const full = await run("policy-value");
    expect(full.id).not.toBe(policy.id);
    expect(full.evaluation?.evaluationKind).toBe("model");
    expect(full.performance?.modelValueUses).toBeGreaterThan(0);
    const g0 = await run();
    expect(g0.evaluation?.evaluationKind).toBe("heuristic");
    expect(g0.performance?.modelInferences ?? 0).toBe(0);
    expect(g0.diagnostics.searchVersion).not.toContain("model-policy");
  } finally {
    await runtime.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
