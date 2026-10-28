import { expect, test } from "bun:test";
import { createStudySearchRuntime, type StudySearchSnapshot } from "../src/search/runtime";
import type { StudyPositionInput } from "../src/shared/model";
import { createStudy, resolveStudyPositions, studyPositionInput } from "../src/domain/study";
import { parseRecordedAnalyses } from "../src/domain/recordedAnalysis";

const input: StudyPositionInput = {
  origin: {
    kind: "replay",
    replay: {
      schemaVersion: 1,
      rulesVersion: 1,
      ruleProfileId: "tetraboard-four-shogi-singles-v1",
      initial: {
        mode: "singles",
        players: { south: "s", west: "w", north: "n", east: "e" },
        threePlayerAttackProhibited: false,
      },
      events: [],
    },
  },
  events: [],
};

test("浅い比較を保持し、同深さの主要候補だけを深い比較として公開する", async () => {
  const runtime = createStudySearchRuntime({ threads: 2 });
  const seen: StudySearchSnapshot[] = [];
  try {
    let complete!: (value: StudySearchSnapshot) => void;
    const finished = new Promise<StudySearchSnapshot>((resolve) => (complete = resolve));
    await runtime.start(
      input,
      { strategy: "dual", broadDepth: 2, maxDepth: 4, timeBudgetMs: null, extensions: 0 },
      (value) => {
        seen.push(value);
        if (value.status === "completed" || value.status === "error") complete(value);
      },
    );
    const result = await finished;
    expect(result.coverage?.phase).toBe("deep");
    expect(result.coverage?.broadDepth).toBe(2);
    expect(result.candidates.length).toBeLessThanOrEqual(3);
    expect(result.broadCandidates?.every((candidate) => candidate.completedDepth === 2)).toBe(true);
    expect(result.candidates.every((candidate) => candidate.completedDepth === 4)).toBe(true);
    expect(
      seen.every((value) =>
        value.candidates.every((candidate) => candidate.completedDepth === value.completedDepth),
      ),
    ).toBe(true);
  } finally {
    await runtime.close();
  }
}, 20000);

test("深掘りの範囲を保存・復元し、広い比較深さの偽装を拒否する", async () => {
  const study = await createStudy({ settings: { mode: "analysis", searchStrategy: "dual" } });
  const runtime = createStudySearchRuntime({ threads: 1 });
  try {
    let complete!: (value: StudySearchSnapshot) => void;
    const finished = new Promise<StudySearchSnapshot>((resolve) => (complete = resolve));
    await runtime.start(
      studyPositionInput(study),
      { strategy: "dual", broadDepth: 2, maxDepth: 4, extensions: 0, timeBudgetMs: null },
      (value) => {
        if (value.status === "completed" || value.status === "error") complete(value);
      },
    );
    const result = await finished;
    const positions = await resolveStudyPositions(study);
    const source = {
      root: {
        stateHash: positions.get("root")!.stateHash,
        savedAt: new Date().toISOString(),
        searchVersion: "local-root-maxn-v6",
        evaluationVersion: "local-sole-first-pressure-v1",
        engineVersion: "tetraboard-four-shogi-rules-v1",
        timeBudgetMs: null,
        threads: 1,
        memoryMb: 512,
        elapsedMs: result.elapsedMs,
        completedDepth: result.completedDepth,
        coverage: result.coverage,
        evaluation: result.evaluation,
        candidates: result.candidates.map((candidate) => ({
          evaluation: candidate.evaluation,
          events: candidate.line.map((step) => ({
            type: "action",
            side: step.side,
            action: step.action,
          })),
        })),
      },
    };
    const records = await parseRecordedAnalyses(source, positions);
    expect(records.root.coverage).toEqual(result.coverage);
    await expect(
      parseRecordedAnalyses(
        { root: { ...source.root, coverage: { ...result.coverage, broadDepth: 4 } } },
        positions,
      ),
    ).rejects.toThrow("一致しません");
  } finally {
    await runtime.close();
  }
});
