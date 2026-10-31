import {
  advanceAnalysisPosition,
  getAnalysisLegalActions,
  createAnalysisCacheKey,
  type AnalysisPosition,
} from "../src/analysis";
import { encodeAction } from "../src/actionEncoding";
import { studyEvaluationVersion } from "../src/studySearch";
import { sameData, dataHash, type TeacherSample } from "./selfPlayData";
import {
  studyCpuVersions,
  studyCpuAiSettings,
  studyCpuRunner,
  studyStaticEvaluation,
  type StudyCpuSettings,
  type StudyCpuResult,
} from "./studyCpu";

export function validateStudyDecision(
  result: StudyCpuResult,
  settings: StudyCpuSettings,
  code: string,
) {
  if (
    !result.studyCpu ||
    result.studyCpu.runner !== studyCpuRunner ||
    !sameData(result.versions, studyCpuVersions(settings, code)) ||
    !sameData(result.settings, studyCpuAiSettings(settings)) ||
    result.studyCpu.profileHash !==
      dataHash({
        settings,
        versions: studyCpuVersions(settings, code),
        workers: 1,
        partition: "root",
        pass: 0,
      }) ||
    result.model.requestedModelId !== (settings.modelId ?? null) ||
    result.model.usedModelId !== (settings.modelId ?? null) ||
    (settings.modelId && result.model.inferenceCount < 1)
  )
    throw new Error("P0-5のプロフィール/モデル/運転版が不一致です");
}
export async function validateStudyTeacher(
  sample: TeacherSample,
  position: AnalysisPosition,
  playedId: number,
  settings: StudyCpuSettings,
  code: string,
) {
  const result = sample.teacher as StudyCpuResult;
  validateStudyDecision(result, settings, code);
  const mask = getAnalysisLegalActions(position).map(encodeAction);
  if (
    sample.stateHash !== position.stateHash ||
    !sameData(sample.state, position.state) ||
    !sameData(sample.legalActionIds, mask) ||
    sample.playedActionId !== playedId ||
    !mask.includes(playedId) ||
    result.input.stateHash !== position.stateHash ||
    result.input.rootSide !== position.state.turn ||
    result.input.eventOffset !== position.eventOffset ||
    result.input.ruleProfileId !== position.ruleProfileId ||
    result.input.rulesVersion !== 1 ||
    result.input.threePlayerAttackProhibited !== position.state.threePlayerAttackProhibited ||
    !sameData(result.staticEvaluation, studyStaticEvaluation(position)) ||
    result.cacheKey !==
      (await createAnalysisCacheKey(position, {
        codeVersion: code,
        analysisVersion: studyCpuRunner,
        modelId: settings.modelId ?? null,
        parameters: settings,
      }))
  )
    throw new Error("P0-5教師の完全状態/履歴/合法手/識別が不一致です");
  const policy =
    result.diagnostics.completedDepth > 0 && result.recommendedAction
      ? encodeAction(result.recommendedAction)
      : null;
  if (
    sample.policyActionId !== policy ||
    (policy !== null && !mask.includes(policy)) ||
    result.status === "cancelled" ||
    (policy !== null &&
      (!result.candidates.length || encodeAction(result.candidates[0].action) !== policy))
  )
    throw new Error("P0-5教師の完成比較/Policyが不一致です");
  for (const candidate of result.candidates) {
    if (
      !mask.includes(encodeAction(candidate.action)) ||
      candidate.completedDepth !== result.diagnostics.completedDepth ||
      !candidate.line.length ||
      !sameData(candidate.action, candidate.line[0].action)
    )
      throw new Error("P0-5の候補/PV/完成深さが不一致です");
    let branch = position;
    for (const [i, step] of candidate.line.entries()) {
      if (step.side !== branch.state.turn || step.afterPly !== i + 1)
        throw new Error("P0-5教師PVの手番が不一致です");
      branch = await advanceAnalysisPosition(branch, {
        type: "action",
        side: step.side,
        action: step.action,
      });
      if (step.nextTurn !== branch.state.turn || !sameData(step.result, branch.state.result))
        throw new Error("P0-5教師PVの遷移が不一致です");
    }
    if (!settings.modelId || branch.state.status === "finished") {
      if (!sameData(candidate.lineEvaluation, studyStaticEvaluation(branch)))
        throw new Error("P0-5教師のPV末端評価が不一致です");
    } else if (
      candidate.lineEvaluation?.evaluationKind !== "model" ||
      candidate.lineEvaluation.probabilities !== null ||
      Object.values(candidate.lineEvaluation.values).some(
        (v) => !Number.isFinite(v.primary) || v.primary < 0 || v.primary >= 1,
      )
    )
      throw new Error("P0-5教師のモデル評価が不正です");
  }
  if (!settings.modelId && result.versions.evaluationVersion !== studyEvaluationVersion)
    throw new Error("P0-5の従来評価版が不一致です");
}
