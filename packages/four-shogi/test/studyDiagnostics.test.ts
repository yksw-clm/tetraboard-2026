import { expect, test } from "bun:test";
import { restoreAnalysisPosition } from "../src/analysis";
import {
  createStudyRootSearch,
  explainStudyEvaluation,
  evaluateStudyPosition,
  type StudyTraceEvent,
  type StudySearchDiagnostics,
} from "../src/studySearch";
import { sides } from "../src/types";

test("末端延長版は通常深さに残延長だけを加え、既存の診断条件と一致する", async () => {
  const position = await restoreAnalysisPosition({
    schemaVersion: 1,
    rulesVersion: 1,
    ruleProfileId: "tetraboard-four-shogi-singles-v1",
    initial: {
      mode: "singles",
      players: { south: "s", west: "w", north: "n", east: "e" },
      threePlayerAttackProhibited: false,
    },
    events: [],
  });
  for (const extensions of [0, 1, 2]) {
    const baseline = createStudyRootSearch(
      position,
      { strategy: "dual", extensions },
      { extendDeepLeaves: true },
    );
    const improved = createStudyRootSearch(position, { strategy: "dual-extensions", extensions });
    try {
      for (const search of [baseline, improved]) {
        while (search.depth < 1 && !search.step()) {}
        search.startTask(0, 4, false, { phase: "deep", width: 2, ownWidth: 3 });
        while (!search.step()) {}
      }
      expect(improved.snapshot().candidates).toEqual(baseline.snapshot().candidates);
      expect(improved.snapshot().stats.extendedNodes).toBe(baseline.snapshot().stats.extendedNodes);
      expect(improved.snapshot().candidates[0].line.length).toBeLessThanOrEqual(4 + extensions);
      expect(improved.snapshot().candidates[0].line.length).toBeGreaterThanOrEqual(4);
    } finally {
      baseline.dispose();
      improved.dispose();
    }
  }
});

test("診断observerは固定タスクの候補・PV・評価・workを変えず、節点の選別を観測する", async () => {
  const position = await restoreAnalysisPosition({
    schemaVersion: 1,
    rulesVersion: 1,
    ruleProfileId: "tetraboard-four-shogi-singles-v1",
    initial: {
      mode: "singles",
      players: { south: "s", west: "w", north: "n", east: "e" },
      threePlayerAttackProhibited: false,
    },
    events: [],
  });
  const events: unknown[] = [];
  const sessions = [
    createStudyRootSearch(position, { strategy: "dual", maxDepth: 3, extensions: 0 }),
    createStudyRootSearch(
      position,
      { strategy: "dual", maxDepth: 3, extensions: 0 },
      { observe: (event: unknown) => events.push(event) },
    ),
  ];
  try {
    for (const session of sessions) {
      while (session.depth < 1 && !session.step()) {}
      session.startTask(0, 3, false, { phase: "deep", width: 2, ownWidth: 3 });
      while (!session.step()) {}
    }
    expect(sessions[1].snapshot().candidates).toEqual(sessions[0].snapshot().candidates);
    expect(sessions[1].snapshot().stats).toEqual(sessions[0].snapshot().stats);
    expect(events.length).toBeGreaterThan(0);
    expect(events.some((event) => (event as { type: string }).type === "selection")).toBe(true);
  } finally {
    sessions.forEach((session) => session.dispose());
  }
});

test("深掘り末端は既定では延長を通らず、診断条件だけで既存の延長規則を適用する", async () => {
  const position = await restoreAnalysisPosition({
    schemaVersion: 1,
    rulesVersion: 1,
    ruleProfileId: "tetraboard-four-shogi-singles-v1",
    initial: {
      mode: "singles",
      players: { south: "s", west: "w", north: "n", east: "e" },
      threePlayerAttackProhibited: false,
    },
    events: [],
  });
  const sessions = [
    createStudyRootSearch(position, { strategy: "dual", maxDepth: 4, extensions: 2 }),
    createStudyRootSearch(
      position,
      { strategy: "dual", maxDepth: 4, extensions: 2 },
      { extendDeepLeaves: true },
    ),
    createStudyRootSearch(
      position,
      { strategy: "dual", maxDepth: 4, extensions: 0 },
      { extendDeepLeaves: true },
    ),
  ];
  try {
    for (const session of sessions) {
      while (session.depth < 1 && !session.step()) {}
      session.startTask(0, 4, false, { phase: "deep", width: 2, ownWidth: 3 });
      while (!session.step()) {}
    }
    expect(sessions[0].snapshot().stats.extendedNodes).toBe(0);
    expect(sessions[1].snapshot().stats.extendedNodes).toBeGreaterThan(0);
    expect(sessions[2].snapshot().stats.extendedNodes).toBe(0);
    expect(sessions[0].snapshot().candidates[0].line).toHaveLength(4);
    expect(sessions[1].snapshot().candidates[0].line.length).toBeGreaterThan(4);
  } finally {
    sessions.forEach((session) => session.dispose());
  }
});

test("一節点への応手追加はその手だけを残し、元の候補と入力を保持する", async () => {
  const position = await restoreAnalysisPosition({
    schemaVersion: 1,
    rulesVersion: 1,
    ruleProfileId: "tetraboard-four-shogi-singles-v1",
    initial: {
      mode: "singles",
      players: { south: "s", west: "w", north: "n", east: "e" },
      threePlayerAttackProhibited: false,
    },
    events: [],
  });
  const original = structuredClone(position);
  function task(diagnostics: StudySearchDiagnostics) {
    const search = createStudyRootSearch(
      position,
      { strategy: "dual", maxDepth: 3, extensions: 0 },
      diagnostics,
    );
    try {
      while (search.depth < 1 && !search.step()) {}
      search.startTask(0, 3, false, { phase: "deep", width: 2, ownWidth: 3 });
      while (!search.step()) {}
      return search.snapshot();
    } finally {
      search.dispose();
    }
  }
  const events: StudyTraceEvent[] = [];
  const before = task({ observe: (event) => events.push(event) });
  const node = events.find(
    (event): event is Extract<StudyTraceEvent, { type: "selection" }> =>
      event.type === "selection" && event.rows.some((row) => !row.selected),
  )!;
  const excluded = node.rows.find((row) => !row.selected)!;
  const changed: StudyTraceEvent[] = [];
  task({
    includeAt: { key: node.key, path: node.path, action: excluded.action },
    observe: (event) => changed.push(event),
  });
  const after = changed.find(
    (event): event is Extract<StudyTraceEvent, { type: "selection" }> =>
      event.type === "selection" && event.key === node.key,
  )!;
  expect(after.rows.filter((row) => row.selected).map((row) => row.index)).toEqual(
    [...node.rows.filter((row) => row.selected).map((row) => row.index), excluded.index].sort(
      (a, b) => a - b,
    ),
  );
  expect(after.rows.find((row) => row.index === excluded.index)?.reason).toBe("diagnostic_include");
  const again = task({
    observe: (event) => {
      if (event.type === "selection") Reflect.set(event.state.board[0], 0, null);
    },
  });
  expect(again.candidates).toEqual(before.candidates);
  expect(again.stats).toEqual(before.stats);
  expect(position).toEqual(original);
  const parts = explainStudyEvaluation(position);
  expect(parts.evaluation).toEqual(evaluateStudyPosition(position));
  for (const side of sides) {
    const base = parts.base![side];
    expect(base.assetTotal).toBeCloseTo(
      base.material +
        base.mobility +
        base.advancement +
        base.risk +
        base.check +
        base.kingRing +
        base.shelter,
      8,
    );
    expect(parts.evaluation.values[side].heuristicScore).toBeCloseTo(
      base.score + parts.adjustments[side]!.engagement - parts.adjustments[side]!.skippedDefense,
      8,
    );
  }
});
