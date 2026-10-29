import { expect, test } from "bun:test";
import type { Side } from "@tetraboard/four-shogi";
import { getAnalysisLegalActions } from "@tetraboard/four-shogi/analysis";
import { evaluateAiPosition } from "../../../packages/four-shogi/src/aiEvaluation";
import type { AiEvaluation } from "@tetraboard/four-shogi/ai";
import { EvaluationPanel } from "../src/client/EvaluationPanel";
import { StudyApp } from "../src/client/StudyApp";
import type { StudyAnalysisView, StudySnapshot } from "../src/contracts";
import { appendStudyEvent, createStudy, resolveStudyPositions } from "../src/domain/study";
import type { StudyDocument } from "../src/shared/model";
import { flush, render, requests } from "../../web/test-dom/support";

async function snapshot(study: StudyDocument): Promise<StudySnapshot> {
  const positions = await resolveStudyPositions(study);
  const position = positions.get(study.currentNodeId)!;
  return {
    study,
    position,
    legalActions: getAnalysisLegalActions(position),
    forbiddenActions: [],
    staticEvaluation: evaluateAiPosition(position.state),
    analysis: null,
    history: study.nodes.map((node) => ({
      id: node.id,
      parentId: node.parentId,
      label: node.parentId ? "進行した局面" : "開始局面",
      moveNumber: positions.get(node.id)!.state.moveNumber,
      evaluation: evaluateAiPosition(positions.get(node.id)!.state),
    })),
  };
}
async function eliminate(study: StudyDocument, sides: readonly Side[]) {
  let current = study;
  for (const side of sides)
    current = await appendStudyEvent(current, { type: "eliminate", side, reason: "timeout" });
  return snapshot(current);
}
function projection(current: StudySnapshot, evaluation: AiEvaluation): StudyAnalysisView {
  return {
    id: "projected-line",
    nodeId: current.study.currentNodeId,
    stateHash: current.position.stateHash,
    generation: 1,
    status: "completed",
    reason: "sole_win",
    elapsedMs: 1000,
    completedDepth: 8,
    work: 100,
    nodes: 50,
    memoryBytes: 0,
    candidates: [],
    recommendedAction: null,
    evaluation,
  };
}
function panel(current: StudySnapshot) {
  return render(
    <EvaluationPanel
      snapshot={current}
      pending={false}
      analyze={async () => true}
      command={async () => true}
      select={() => {}}
    />,
  );
}

test("広い比較と主要候補の深さを分けて表示する", async () => {
  const current = await snapshot(await createStudy({ settings: { mode: "analysis" } }));
  const analysis = projection(current, current.staticEvaluation);
  analysis.completedDepth = 9;
  analysis.coverage = {
    phase: "deep",
    broadDepth: 3,
    broadRoots: 24,
    deepRoots: 3,
    pass: 0,
    opponentWidth: 2,
    ownWidth: 3,
  };
  const view = panel({ ...current, analysis });
  expect(view.textContent).toContain("主要候補の深さ");
  expect(view.textContent).toContain("広い比較：深さ3・24候補");
  expect(view.textContent).toContain("主要3候補を深掘り");
  expect(view.textContent).not.toContain("全候補を深さ9");
});

test("完成比較と進行中の深さを分け、並列計測を経過時間と混同しない", async () => {
  const current = await snapshot(await createStudy({ settings: { mode: "analysis" } }));
  const analysis = projection(current, current.staticEvaluation);
  analysis.status = "running";
  analysis.completedDepth = 3;
  analysis.performance = {
    legalMs: 1000,
    transitionMs: 2000,
    evaluationMs: 3000,
    orderingMs: 400,
    cacheEvictions: 5,
    branchCacheHits: 6,
    branchCacheEntries: 7,
    keyMs: 8,
    immediateWork: 9,
    materialWork: 10,
    reducedNodes: 11,
    researches: 12,
    promotionExtraMoves: 0,
    legalCacheHits: 13,
    transitionCacheHits: 14,
    evaluationCacheHits: 15,
    iterationDepth: 4,
    completedTasks: 2,
    totalTasks: 8,
    workerNodes: [10, 20],
    workerWaitMs: [0, 1],
    depths: [{ depth: 3, elapsedMs: 1000, roots: 8 }],
  };
  const view = panel({ ...current, analysis });
  expect(view.textContent).toContain("比較深さ");
  expect(view.textContent).toContain("深さ4を検討中");
  expect(view.textContent).toContain("2/8候補完了");
  expect(view.textContent).toContain("全合法手を網羅した深さではありません");
  expect(view.textContent).toContain("並列実行のため経過時間とは異なります");
});

test("現在は対局中でも読み筋末尾が終局なら、確定順位ではなく予想順位を表示する", async () => {
  const study = await createStudy({ settings: { mode: "analysis" } });
  const current = await snapshot(study);
  const projected = await eliminate(study, ["east", "north", "west"]);
  expect(current.position.state.status).toBe("playing");
  expect(projected.staticEvaluation.evaluationKind).toBe("terminal");
  const view = panel({ ...current, analysis: projection(current, projected.staticEvaluation) });
  expect(view.textContent).toContain("読み筋末尾の予想");
  expect(view.textContent).toContain("予想1位（読み筋末尾）");
  expect(view.textContent).not.toContain("確定1位");
  expect(view.textContent).toContain("単独勝ちに至る予想進行が見つかったため停止しました");
  expect(view.textContent).toContain("相手の応手により結果は変わります");
  expect(view.textContent).not.toContain("単独勝ちとなる手が見つかりました");
});

test("読み筋で将来脱落する人のconfirmedも、現在局面の確定順位にしない", async () => {
  const study = await createStudy({ settings: { mode: "analysis" } });
  const current = await snapshot(study);
  const projected = await eliminate(study, ["east"]);
  expect(projected.position.state.status).toBe("playing");
  expect(projected.staticEvaluation.ranks.find((entry) => entry.side === "east")).toMatchObject({
    kind: "confirmed",
    rank: 4,
  });
  const view = panel({ ...current, analysis: projection(current, projected.staticEvaluation) });
  expect(view.textContent).toContain("予想4位（読み筋末尾）");
  expect(view.textContent).not.toContain("確定4位");
});

test("表示中の局面ですでに脱落している順位は、予想進行があっても確定と表示する", async () => {
  const study = await createStudy({ settings: { mode: "analysis" } });
  const current = await eliminate(study, ["east"]);
  const projected = await eliminate(current.study, ["north", "west"]);
  const view = panel({ ...current, analysis: projection(current, projected.staticEvaluation) });
  expect(view.textContent).toContain("確定4位");
  expect(view.textContent).toContain("予想1位（読み筋末尾）");
  expect(view.textContent).not.toContain("確定1位");
});

test("表示中の盤面が終局した場合だけ、勝者の順位も確定と表示する", async () => {
  const study = await createStudy({ settings: { mode: "analysis" } });
  const finished = await eliminate(study, ["east", "north", "west"]);
  const view = panel(finished);
  expect(finished.position.state.status).toBe("finished");
  for (const rank of [1, 2, 3, 4]) expect(view.textContent).toContain(`確定${rank}位`);
  expect(view.textContent).not.toContain("予想1位");
});

test("元局面の静的順位は暫定とし、保存された予想終局も確定にしない", async () => {
  const study = await createStudy({ settings: { mode: "analysis" } });
  const current = await snapshot(study);
  const staticView = panel(current);
  expect(staticView.textContent).toContain("元局面の静的評価");
  expect(staticView.textContent).toContain("暫定1位");
  expect(staticView.textContent).not.toContain("確定1位");
  const projected = await eliminate(study, ["east", "north", "west"]);
  const savedView = panel({
    ...current,
    analysis: {
      ...projection(current, projected.staticEvaluation),
      saved: {
        savedAt: "2026-10-28T00:00:00.000Z",
        searchVersion: "saved-search",
        evaluationVersion: "saved-evaluation",
        engineVersion: "saved-engine",
        timeBudgetMs: 1000,
        threads: 4,
        memoryMb: 8192,
      },
    },
  });
  expect(savedView.textContent).toContain("保存済み");
  expect(savedView.textContent).toContain("予想1位（読み筋末尾）");
  expect(savedView.textContent).not.toContain("確定1位");
});

test("盤面のプレイヤーカードも読み筋の終局順位を予想として表示する", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "EventSource");
  Object.defineProperty(globalThis, "EventSource", {
    configurable: true,
    writable: true,
    value: class {
      close() {}
    },
  });
  try {
    const study = await createStudy({ id: "score-meaning", settings: { mode: "analysis" } });
    const current = await snapshot(study);
    const projected = await eliminate(study, ["east", "north", "west"]);
    const withProjection = {
      ...current,
      analysis: projection(current, projected.staticEvaluation),
    };
    const view = render(<StudyApp />);
    requests
      .find((entry) => entry.url === "/api/config")!
      .respond({
        logicalCpus: 10,
        totalMemoryMb: 24576,
        defaultThreads: 4,
        defaultMemoryMb: 8192,
        dataDirectory: "/tmp/score-meaning",
      });
    const library = [
      { id: study.id, title: study.title, updatedAt: study.updatedAt, cpuSide: study.cpuSide },
    ];
    requests.find((entry) => entry.url === "/api/studies")!.respond(library);
    await flush();
    requests.find((entry) => entry.url === `/api/studies/${study.id}`)!.respond(withProjection);
    await flush();
    requests
      .filter((entry) => entry.url === "/api/studies")
      .at(-1)!
      .respond(library);
    await flush();
    const south = [...view.querySelectorAll("strong")].find((entry) => entry.textContent === "南");
    const card = south?.closest('[class*="player-height"]');
    expect(card?.textContent).toContain("予想1位");
    expect(card?.textContent).not.toContain("確定1位");
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "EventSource", descriptor);
    else Reflect.deleteProperty(globalThis, "EventSource");
  }
});
