import { test, expect } from "bun:test";
import {
  selectTrajectoryPoints,
  trajectoryTeacherPoints,
  type TeacherPoint,
  trajectoryTeacherVersion,
} from "../bench/teacherSelection";
import {
  createDataManifest,
  gamePlans,
  defaultSelfPlayConfig,
  type DataCode,
} from "../bench/selfPlayData";
import { generateSelfPlayGame, configInput } from "../bench/selfPlayGame";
import { validateGameArtifact } from "../bench/selfPlayInspect";
const code: DataCode = {
  commit: "0".repeat(40),
  dirty: false,
  sourceHash: "1".repeat(64),
  runnerHash: "2".repeat(64),
  runtime: { bun: Bun.version, platform: process.platform, arch: process.arch },
};

test("軌跡教師は序中終盤の錨と重要事象を残し、短い棋譜でも上限と最後の局面を守る", () => {
  const points: TeacherPoint[] = Array.from({ length: 90 }, (_, index) => ({
    index,
    priority: [10, 40, 70].includes(index) ? 100 : 0,
    alive: 4,
    checked: false,
    capture: false,
    promotion: false,
    elimination: false,
  }));
  const selected = selectTrajectoryPoints(points, 12);
  expect(selected.length).toBe(12);
  expect(new Set(selected).size).toBe(12);
  expect([0, 1, 2].map((bin) => selected.filter((i) => Math.floor(i / 30) === bin).length)).toEqual(
    [4, 4, 4],
  );
  for (const index of [10, 40, 70, 89]) expect(selected).toContain(index);
  for (let length = 1; length < 10; length++)
    for (let limit = 0; limit < 10; limit++) {
      const value = selectTrajectoryPoints(points.slice(0, length), limit);
      expect(value.length).toBe(Math.min(length, limit));
      if (limit > 0) expect(value).toContain(length - 1);
    }
});

test("完全履歴から決めた軌跡の選別を再検査し、欠落した教師とオンライン生成への誤用を拒否する", async () => {
  const manifest = await createDataManifest(
    {
      ...defaultSelfPlayConfig(),
      origins: [{ seed: 41823 }],
      restrictions: [true],
      seatOffsets: ["south"],
      agents: [{ id: "a", kind: "analysis", options: { maxWork: 16 } }],
      lineups: [["a", "a", "a", "a"]],
      studyTeacher: { maxWork: 600, maxDepth: 2, extensions: 0 },
      sampling: { every: 1, important: false, maxPositions: 12 },
      maxPlies: 12,
    },
    code,
  );
  const plan = gamePlans(manifest)[0],
    original = await generateSelfPlayGame(manifest, plan, null, async () => {});
  const selection = await trajectoryTeacherPoints(manifest.starts[0].replay, original, 6);
  const derived = await createDataManifest(
    {
      ...(configInput(manifest.config) as object),
      derivedFrom: { datasetId: manifest.datasetId, contentHash: "3".repeat(64) },
      teacherSelection: trajectoryTeacherVersion,
      sampling: { every: 0, important: false, maxPositions: 6 },
    },
    code,
    manifest.cpuSources,
  );
  const nextPlan = gamePlans(derived)[0],
    record = {
      ...structuredClone(original),
      datasetId: derived.datasetId,
      plan: nextPlan,
      samples: original.samples.filter((s) =>
        selection.indices.includes(s.eventOffset - original.openingEventCount),
      ),
    };
  expect(record.samples.length).toBe(6);
  await validateGameArtifact(derived, nextPlan, record);
  const broken = structuredClone(record);
  broken.samples.shift();
  await expect(validateGameArtifact(derived, nextPlan, broken)).rejects.toThrow("選別");
  await expect(generateSelfPlayGame(derived, nextPlan, null, async () => {})).rejects.toThrow(
    "追加教師",
  );
});
