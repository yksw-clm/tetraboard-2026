import { expect, test } from "bun:test";
import { EvaluationPanel } from "../src/client/EvaluationPanel";
import type { StudyAnalysisView, StudySnapshot } from "../src/contracts";
import type { AnalysisInput, CommandInput } from "../src/client/api";
import { appendStudyEvent, createStudy, resolveStudyPositions } from "../src/domain/study";
import { createStudyRootSearch, evaluateStudyPosition } from "@tetraboard/four-shogi/study-search";
import { getAnalysisLegalActions, type AnalysisPosition } from "@tetraboard/four-shogi/analysis";
import { act, flush, press, render } from "../../web/test-dom/support";

function candidate(position: AnalysisPosition) {
  const search = createStudyRootSearch(position, { maxDepth: 1 });
  while (!search.step()) {}
  const value = search.snapshot().candidates[0];
  search.dispose();
  return value;
}
async function focusedSnapshot(): Promise<StudySnapshot> {
  const study = await createStudy({ settings: { mode: "analysis", focusSide: "west" } });
  const position = (await resolveStudyPositions(study)).get(study.currentNodeId)!;
  const prefix = candidate(position).line;
  const nextStudy = await appendStudyEvent(study, {
    type: "action",
    side: position.state.turn!,
    action: prefix[0].action,
  });
  const target = (await resolveStudyPositions(nextStudy)).get(nextStudy.currentNodeId)!;
  expect(target.state.turn).toBe("west");
  const next = candidate(target);
  const analysis: StudyAnalysisView = {
    id: "focus-west",
    nodeId: study.currentNodeId,
    generation: 1,
    stateHash: position.stateHash,
    analysisStateHash: target.stateHash,
    status: "completed",
    reason: "deadline",
    elapsedMs: 1000,
    completedDepth: 1,
    work: 10,
    nodes: 10,
    memoryBytes: 0,
    candidates: [next],
    recommendedAction: null,
    analysisRecommendedAction: next.action,
    evaluation: next.evaluation,
    focus: {
      side: "west",
      status: "ready",
      reason: null,
      sourceStateHash: position.stateHash,
      analysisStateHash: target.stateHash,
      prefix,
      conditional: true,
      projectionElapsedMs: 1,
      model: null,
      result: null,
    },
  };
  return {
    study,
    position,
    analysis,
    history: [],
    staticEvaluation: evaluateStudyPosition(position),
    legalActions: getAnalysisLegalActions(position),
    forbiddenActions: [],
  };
}
function panel(snapshot: StudySnapshot) {
  const commands: CommandInput[] = [];
  const analyses: AnalysisInput[] = [];
  const view = render(
    <EvaluationPanel
      snapshot={snapshot}
      pending={false}
      analyze={async (input) => {
        analyses.push(input);
        return true;
      }}
      command={async (input) => {
        commands.push(input);
        return true;
      }}
      select={() => {}}
    />,
  );
  return { view, commands, analyses };
}

test("フォーカス席を切り替え、未来の候補を現在の推奨手と区別する", async () => {
  const snapshot = await focusedSnapshot();
  const { view, commands } = panel(snapshot);
  expect(view.textContent).toContain("西の次手番を検討");
  expect(view.textContent).toContain("相手の予測1手を前提");
  expect(view.textContent).toContain("西視点");
  expect(view.textContent).not.toContain("推奨手を指す");
  const select = view.querySelector("select")!;
  act(() => {
    select.value = "east";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await flush();
  expect(commands).toEqual([{ type: "settings", settings: { focusSide: "east" } }]);
});

test("未来の候補は相手の予測prefixとともに分岐へ送り、現在の手としてadoptしない", async () => {
  const snapshot = await focusedSnapshot();
  const { view, commands, analyses } = panel(snapshot);
  press(view, "予測手順とこの手を分岐で確認 →");
  await flush();
  expect(analyses).toEqual([]);
  const expectedLine = [
    ...snapshot.analysis!.focus!.prefix,
    snapshot.analysis!.candidates[0].line[0],
  ];
  expect(commands).toEqual([
    {
      type: "variation",
      analysisId: "focus-west",
      stateHash: snapshot.position.stateHash,
      candidateIndex: 0,
      plies: 1,
      lineSignature: JSON.stringify(expectedLine.map(({ side, action }) => ({ side, action }))),
    },
  ]);
});

test("PV引継ぎの未来候補を現在の手と表示・採用しない", async () => {
  const snapshot = await focusedSnapshot();
  const { view, commands } = panel({
    ...snapshot,
    analysis: {
      ...snapshot.analysis!,
      continuation: {
        mode: "pv",
        pvHit: true,
        pvEntries: 3,
        hintReorders: 1,
        priorWork: 0,
        newWork: 10,
      },
    },
  });
  expect(view.textContent).toContain("西の次手番を検討");
  expect(view.textContent).toContain("フォーカスの検討");
  expect(view.textContent).toContain("前回の読みと一致");
  expect(view.textContent).not.toContain("現在の手番の検討");
  expect(view.textContent).not.toContain("推奨手を指す");
  press(view, "予測手順とこの手を分岐で確認 →");
  await flush();
  expect(commands).toHaveLength(1);
  expect(commands[0]?.type).toBe("variation");
});

test("予測上の脱落を現在の脱落と取り違えず、次手番未到達を表示する", async () => {
  const snapshot = await focusedSnapshot();
  const { view } = panel({
    ...snapshot,
    analysis: {
      ...snapshot.analysis!,
      candidates: [],
      evaluation: null,
      analysisRecommendedAction: null,
      focus: { ...snapshot.analysis!.focus!, status: "focus_eliminated" },
    },
  });
  expect(view.textContent).toContain("予測手順の途中でフォーカスした席が脱落");
  expect(view.textContent).not.toContain("この手を試す");
});
