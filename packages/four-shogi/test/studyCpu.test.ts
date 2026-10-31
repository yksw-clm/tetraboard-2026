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
const code: DataCode = {
  commit: "0".repeat(40),
  dirty: false,
  sourceHash: "1".repeat(64),
  runnerHash: "2".repeat(64),
  runtime: { bun: Bun.version, platform: process.platform, arch: process.arch },
};

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
