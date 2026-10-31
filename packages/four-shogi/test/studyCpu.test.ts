import { test, expect } from "bun:test";
import {
  createDataManifest,
  gamePlans,
  defaultSelfPlayConfig,
  type DataCode,
} from "../bench/selfPlayData";
import { generateSelfPlayGame } from "../bench/selfPlayGame";
import { validateGameArtifact } from "../bench/selfPlayInspect";
import { analyzeStudyCpu, readStudyCpuSettings } from "../bench/studyCpu";
import { restoreAnalysisPosition, getAnalysisLegalActions } from "../src/analysis";
import { encodeAction } from "../src/actionEncoding";
import type { AiSyncModel } from "../src/aiModel";
import type { StudySearchPerformance } from "../src/studySearch";
const code: DataCode = {
  commit: "0".repeat(40),
  dirty: false,
  sourceHash: "1".repeat(64),
  runnerHash: "2".repeat(64),
  runtime: { bun: Bun.version, platform: process.platform, arch: process.arch },
};

test("研究用Policy/Valueを独立に使い、既定の両方使用と異なる比較を識別する", async () => {
  const position = await restoreAnalysisPosition({
    schemaVersion: 1,
    ruleProfileId: "tetraboard-four-shogi-singles-v1",
    rulesVersion: 1,
    initial: {
      mode: "singles",
      players: { south: "s", west: "w", north: "n", east: "e" },
      threePlayerAttackProhibited: true,
    },
    events: [],
  });
  const modelId = "four-shogi-tiny-policy-value-v1:" + "1".repeat(64);
  const model: AiSyncModel = {
    modelId,
    predict(input) {
      const ids = input.legalActionIds;
      return {
        id: input.id,
        legalActionIds: ids,
        policy: ids.map((_, i) => Number(i === ids.length - 1)),
        policyLogits: ids.map((_, i) => Number(i === ids.length - 1)),
        topActionId: ids.at(-1)!,
        value: [0.4, 0.3, 0.2, 0.1, 0],
        illegalPolicyNonzero: 0,
      };
    },
  };
  const results = [];
  for (const usage of [undefined, "policy-value", "policy", "value"] as const) {
    const settings = readStudyCpuSettings({
      maxWork: 20000,
      maxDepth: 2,
      width: 2,
      extensions: 0,
      dangerWork: 0,
      modelFile: "unused-model",
      modelId,
      ...(usage ? { modelUsage: usage } : {}),
    });
    let metrics: StudySearchPerformance | undefined;
    const result = await analyzeStudyCpu(
      position,
      settings,
      code.commit,
      {},
      {
        model,
        onIteration(row) {
          metrics = row.performance;
        },
      },
    );
    expect(result.diagnostics.completedDepth).toBe(2);
    expect(result.model.inferenceCount).toBeGreaterThan(0);
    expect((metrics?.modelPolicyUses ?? 0) > 0).toBe(usage !== "value");
    expect((metrics?.modelValueUses ?? 0) > 0).toBe(usage !== "policy");
    expect(result.candidates.every((c) => c.lineEvaluation?.evaluationKind === "model")).toBe(
      usage !== "policy",
    );
    results.push(result);
  }
  expect(results[0].candidates).toEqual(results[1].candidates);
  expect(results[0].diagnostics.work).toBe(results[1].diagnostics.work);
  expect(new Set(results.map((r) => r.cacheKey)).size).toBe(4);
  expect(() => readStudyCpuSettings({ modelUsage: "value" })).toThrow("使用条件");
});

test("P0-5固定workは完成した比較だけを残し、同条件で手とPVを再現する", async () => {
  const position = await restoreAnalysisPosition({
    schemaVersion: 1,
    ruleProfileId: "tetraboard-four-shogi-singles-v1",
    rulesVersion: 1,
    initial: {
      mode: "singles",
      players: { south: "s", west: "w", north: "n", east: "e" },
      threePlayerAttackProhibited: true,
    },
    events: [],
  });
  const settings = readStudyCpuSettings({ maxWork: 1200, maxDepth: 3, extensions: 0 });
  const a = await analyzeStudyCpu(position, settings, code.commit),
    b = await analyzeStudyCpu(position, settings, code.commit);
  expect(a.diagnostics.completedDepth).toBeGreaterThan(0);
  expect(a.candidates).toEqual(b.candidates);
  expect(a.diagnostics.work).toBe(b.diagnostics.work);
  expect(getAnalysisLegalActions(position).map(encodeAction)).toContain(
    encodeAction(a.recommendedAction!),
  );
  const controller = new AbortController();
  controller.abort();
  const cancelled = await analyzeStudyCpu(position, settings, code.commit, {
    signal: controller.signal,
  });
  expect(cancelled.status).toBe("cancelled");
  expect(cancelled.diagnostics.completedDepth).toBe(0);
});
test("P0-5の対局/教師を完全再生し、打切りValueと違法Policy・版混入を拒否する", async () => {
  const manifest = await createDataManifest(
    {
      ...defaultSelfPlayConfig(),
      origins: [{ seed: 41809 }],
      restrictions: [true],
      seatOffsets: ["south"],
      agents: [{ id: "p0", kind: "study", options: { maxWork: 800, maxDepth: 3, extensions: 0 } }],
      lineups: [["p0", "p0", "p0", "p0"]],
      studyTeacher: { maxWork: 1200, maxDepth: 3, extensions: 0 },
      sampling: { every: 1, important: true, maxPositions: 2 },
      maxPlies: 2,
    },
    code,
  );
  const plan = gamePlans(manifest)[0];
  const record = await generateSelfPlayGame(manifest, plan, null, async () => {});
  expect(record.status).toBe("truncated");
  expect(record.outcome).toBeNull();
  await validateGameArtifact(manifest, plan, record);
  const corrupt = structuredClone(record);
  corrupt.samples[0].policyActionId = -1;
  await expect(validateGameArtifact(manifest, plan, corrupt)).rejects.toThrow("Policy");
  const mixed = structuredClone(record);
  (mixed.samples[0].teacher.versions as { searchVersion: string }).searchVersion =
    "selective-maxn-v2";
  await expect(validateGameArtifact(manifest, plan, mixed)).rejects.toThrow("版");
});
