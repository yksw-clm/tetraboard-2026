import {
  advanceAnalysisPosition,
  getAnalysisLegalActions,
  type AnalysisPosition,
} from "@tetraboard/four-shogi/analysis";
import { getActiveSides, sides } from "@tetraboard/four-shogi";
import type { AiCandidate } from "@tetraboard/four-shogi/ai";
import { encodeAction } from "../../../packages/four-shogi/src/actionEncoding";
import { getCheckState } from "../../../packages/four-shogi/src/board";
import { explainStudyEvaluation } from "../../../packages/four-shogi/src/studySearch";
import { validateFiniteProof } from "../../../packages/four-shogi/src/finiteSurvival";
import type { LethalGuardReport } from "../src/search/lethalGuard";

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
export async function validateGuardCandidate(position: AnalysisPosition, candidate: AiCandidate) {
  let current = position;
  if (
    candidate.line.length &&
    encodeAction(candidate.line[0].action) !== encodeAction(candidate.action)
  )
    throw Error("候補初手とPV不一致");
  for (const [index, step] of candidate.line.entries()) {
    const before = current;
    if (current.state.turn !== step.side || step.afterPly !== index + 1)
      throw Error("PVの手番/深さ不一致");
    current = await advanceAnalysisPosition(current, {
      type: "action",
      side: step.side,
      action: step.action,
    });
    const check = getCheckState(current.state);
    if (
      current.state.turn !== step.nextTurn ||
      !same(
        sides.filter((s) => check[s]),
        step.checkedSides,
      ) ||
      !same(current.state.lastMove?.captured ?? null, step.captured) ||
      !same(
        current.state.eliminations.slice(before.state.eliminations.length),
        step.eliminations,
      ) ||
      !same(current.state.status === "finished" ? current.state.result : null, step.result)
    )
      throw Error("PV正本情報不一致");
  }
  if (
    candidate.lineEvaluation &&
    !same(explainStudyEvaluation(current).evaluation, candidate.lineEvaluation)
  )
    throw Error("PV評価不一致");
  return { steps: candidate.line.length, leafHash: current.stateHash };
}

export async function validateGuardReport(position: AnalysisPosition, report: LethalGuardReport) {
  if (position.stateHash !== report.stateHash) throw Error("ガードの入力hash不一致");
  const legal = new Set(getAnalysisLegalActions(position).map(encodeAction));
  let certificates = 0,
    verified = 0,
    witnesses = 0;
  for (const row of report.rows) {
    if (!legal.has(row.actionId) || row.actionId !== encodeAction(row.action))
      throw Error("検査初手が非合法");
    if (row.proof) {
      if (
        row.proof.horizon !== report.horizon ||
        row.proof.inputHash !== position.stateHash ||
        encodeAction(row.proof.action) !== row.actionId
      )
        throw Error("証明条件不一致");
      const result = await validateFiniteProof(position, row.proof);
      certificates++;
      verified += Number(result.verified);
      if (
        row.status !== "unknown" &&
        (!result.verified ||
          !row.completedWithinBudget ||
          row.proof.status !== row.status ||
          row.queryBudgetMs === null ||
          row.proof.elapsedMs > row.queryBudgetMs)
      )
        throw Error("未完成/予算外の証明を採用");
    } else if (row.status !== "unknown") throw Error("証拠なしの確定判定");
    if (row.witness) {
      let current = position;
      for (const action of row.witness)
        current = await advanceAnalysisPosition(current, {
          type: "action",
          side: current.state.turn!,
          action,
        });
      if (getActiveSides(current.state).includes(position.state.turn!))
        throw Error("危険手順で本人が脱落しない");
      witnesses++;
    }
    if (row.candidate) await validateGuardCandidate(position, row.candidate);
  }
  return { certificates, verified, witnesses };
}
