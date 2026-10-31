import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { advanceAnalysisPosition, restoreAnalysisPosition } from "@tetraboard/four-shogi/analysis";
import { sides, handPieceKinds, getActiveSides, type FourShogiState } from "@tetraboard/four-shogi";
import { pieceValue } from "../../../packages/four-shogi/src/cpuEvaluation";
import { encodeAction } from "../../../packages/four-shogi/src/actionEncoding";
import { explainStudyEvaluation } from "../../../packages/four-shogi/src/studySearch";
import type { StudyTraceEvent } from "../../../packages/four-shogi/src/studyDiagnostics";
import type { LossCase } from "./lossAnalysisCases";
import type { LossFixedResult } from "./lossAnalysisWorker";
import { summarizeLossAnalysis } from "./lossAnalysis";

const read = <T>(file: string): T => JSON.parse(readFileSync(file, "utf8"));
function material(state: FourShogiState) {
  const active = getActiveSides(state);
  return Object.fromEntries(
    sides.map((side) => [
      side,
      {
        active: active.includes(side),
        hand: state.hands[side],
        handMaterial: handPieceKinds.reduce(
          (sum, kind) =>
            sum + state.hands[side][kind] * pieceValue({ id: 0, side, kind, promoted: false }),
          0,
        ),
        boardMaterial: state.board
          .flat()
          .reduce((sum, piece) => sum + (piece?.side === side ? pieceValue(piece) : 0), 0),
      },
    ]),
  );
}

/** 保存済みの完成探索だけを分析します。探索条件の再調整や追加探索は行いません。 */
export async function collectLossEvidence(directory: string) {
  const summary = summarizeLossAnalysis(directory);
  const witnesses: (Record<string, unknown> & {
    caseId: string;
    gameId: string;
    kind: LossCase["kind"];
  })[] = [];
  const interventions = [];
  const observerControls = [];
  for (const row of summary.cases) {
    const record = read<LossCase>(join(directory, "cases", row.caseId + ".json"));
    const actionId = encodeAction(record.chosenAction);
    const fixed = read<{ result: LossFixedResult }>(
      join(directory, "diagnostics", `${row.caseId}-fixed-${actionId}.json`),
    ).result;
    if (fixed.observerControl)
      observerControls.push({ caseId: row.caseId, result: fixed.observerControl });
    if (fixed.intervention)
      interventions.push({ caseId: row.caseId, kind: row.kind, result: fixed.intervention });
    const depths = new Set(
      fixed.results.filter((entry) => entry.candidate).map((entry) => entry.depth),
    );
    const trace = fixed.trace as StudyTraceEvent[];
    for (const node of fixed.traceNodes ?? []) {
      if (
        !node.samePosition ||
        !node.legal ||
        !node.row?.selected ||
        node.expectedSide === record.side ||
        !depths.has(node.event.taskDepth)
      )
        continue;
      const atNode = trace.filter(
        (event) =>
          event.key === node.event.key &&
          event.taskDepth === node.event.taskDepth &&
          JSON.stringify(event.path) === JSON.stringify(node.event.path),
      );
      const child = atNode.find(
        (event) =>
          event.type === "child" &&
          encodeAction(event.action) === encodeAction(node.expectedAction),
      );
      const returned = atNode.find(
        (event) => event.type === "return" && event.reason === "searched",
      );
      if (
        child?.type !== "child" ||
        returned?.type !== "return" ||
        child.evaluation.values[record.side].primary !== 0 ||
        returned.evaluation.values[record.side].primary === 0 ||
        !returned.line.length
      )
        continue;
      let prefix = await restoreAnalysisPosition(record.replay);
      for (const step of record.actualSuffix.slice(0, node.event.path.length))
        prefix = await advanceAnalysisPosition(prefix, step.event);
      if (prefix.stateHash !== node.stateHash) throw Error("評価証拠の局面が相違します");
      const actualAfter = await advanceAnalysisPosition(prefix, {
        type: "action",
        side: node.expectedSide,
        action: node.expectedAction,
      });
      let selectedLeaf = prefix;
      for (const step of returned.line)
        selectedLeaf = await advanceAnalysisPosition(selectedLeaf, {
          type: "action",
          side: step.side,
          action: step.action,
        });
      witnesses.push({
        caseId: row.caseId,
        gameId: row.gameId,
        kind: row.kind,
        depth: node.event.taskDepth,
        path: node.event.path,
        stateHash: node.stateHash,
        actor: node.expectedSide,
        target: record.side,
        actualAction: node.expectedAction,
        selectedAction: returned.line[0].action,
        actualBranchEvaluation: child.evaluation,
        selectedBranchEvaluation: returned.evaluation,
        actorPrefersSelected:
          returned.evaluation.values[node.expectedSide].primary >
          child.evaluation.values[node.expectedSide].primary,
        actualAfterHash: actualAfter.stateHash,
        actualAfterExplanation: explainStudyEvaluation(actualAfter),
        actualAfterMaterial: material(actualAfter.state),
        selectedLeafHash: selectedLeaf.stateHash,
        selectedLeafExplanation: explainStudyEvaluation(selectedLeaf),
        selectedLeafMaterial: material(selectedLeaf.state),
        selectedLine: returned.line,
        scope: "完成した固定探索の同一局面。元の時間制限実行の採否や係数の欠陥は証明しない。",
      });
    }
  }
  const groupCounts = (kind: "loss" | "win-control") => {
    const rows = summary.cases.filter((row) => row.kind === kind);
    const labelCount = (prefix: string) =>
      rows.filter((row) => row.labels.some((label) => label.startsWith(prefix))).length;
    return {
      cases: rows.length,
      rootSelectionPossible: labelCount("根候補"),
      opponentSelectionPossible: labelCount("相手応手"),
      ownContinuationPossible: labelCount("自手継続"),
      horizonEvidence: labelCount("探索地平"),
      modelWitnessCases: new Set(
        witnesses.filter((row) => row.kind === kind).map((row) => row.caseId),
      ).size,
    };
  };
  const result = {
    schemaVersion: 1,
    analysisSourceSha256: new Bun.CryptoHasher("sha256")
      .update(readFileSync(import.meta.path))
      .digest("hex"),
    inputSource: summary.source,
    groups: { loss: groupCounts("loss"), control: groupCounts("win-control") },
    witnesses,
    observerControls,
    interventions,
    scope: "既存の完成した診断結果の事後集計。対照は記述比較のみ、同一seedの独立標本ではない。",
  };
  writeFileSync(
    join(directory, "diagnostics/evidence.json"),
    JSON.stringify(result, null, 2) + "\n",
  );
  return result;
}
if (import.meta.main) {
  const result = await collectLossEvidence(resolve(Bun.argv[2]));
  console.log(JSON.stringify({ groups: result.groups, witnesses: result.witnesses.length }));
}
