import { resolveAiOptions, type AiResult } from "../src/ai";
import {
  createAnalysisCacheKey,
  restoreAnalysisPosition,
  advanceAnalysisPosition,
  getAnalysisLegalActions,
  type AnalysisPosition,
} from "../src/analysis";
import { actionEncodingVersion, encodeAction, decodeAction } from "../src/actionEncoding";
import { evaluateAiPosition } from "../src/aiEvaluation";
import { modelEvaluation, type AiModelOutput } from "../src/aiModel";
import type { FourShogiState } from "../src/types";
import {
  dataHash,
  sameData,
  selfPlayVersion,
  createDataManifest,
  manifestIdentity,
  gamePlans,
  positionFamilyKey,
  type DataManifest,
  type GameArtifact,
  type GamePlan,
  type TeacherSample,
  type DataSplit,
} from "./selfPlayData";
import {
  configInput,
  loadDataPlayers,
  shouldTeach,
  teacherSettings,
  validateOutcome,
} from "./selfPlayGame";
import type { SelfPlayStore } from "./selfPlayStore";
import { validateStudyDecision, validateStudyTeacher } from "./studyCpuInspect";
import type { StudyCpuResult } from "./studyCpu";

export async function validateManifest(manifest: DataManifest, temporaryDirectory?: string) {
  const { datasetId, ...content } = manifest;
  if (
    manifest.schemaVersion !== 1 ||
    manifest.format !== selfPlayVersion ||
    manifest.actionEncodingVersion !== actionEncodingVersion ||
    manifest.featureVersion !== null ||
    manifest.stateEncodingVersion !== "analysis-state-v1" ||
    manifestIdentity(content) !== datasetId
  )
    throw new Error("datasetの形式/版/識別子が不一致です");
  const reconstructed = await createDataManifest(
    configInput(manifest.config),
    manifest.code,
    manifest.cpuSources,
  );
  if (!sameData(reconstructed, manifest))
    throw new Error("開始系列/分割/設定がmanifestと不一致です");
  const expectedCpuIds = manifest.config.agents
    .filter((a) => a.kind === "cpu")
    .map((a) => a.id)
    .sort();
  if (!sameData(Object.keys(manifest.cpuSources).sort(), expectedCpuIds))
    throw new Error("相手の版が混在しています");
  const players = await loadDataPlayers(manifest, {}, temporaryDirectory);
  players.dispose();
}
function checkDetails(
  result: Pick<AiResult, "versions" | "settings" | "model" | "diagnostics">,
  expected: ReturnType<typeof resolveAiOptions>,
  modelId: string | null = null,
) {
  const modelMatches =
    modelId === null
      ? sameData(result.model, {
          requestedModelId: null,
          loadedModelId: null,
          usedModelId: null,
          inferenceCount: 0,
        })
      : result.model.requestedModelId === modelId &&
        result.model.loadedModelId === modelId &&
        result.model.usedModelId === modelId &&
        Number.isSafeInteger(result.model.inferenceCount) &&
        result.model.inferenceCount > 0 &&
        result.model.fallbackReason === null;
  if (
    !sameData(result.versions, expected.versions) ||
    !sameData(result.settings, expected.settings) ||
    !modelMatches ||
    result.diagnostics.algorithm !== expected.settings.algorithm
  )
    throw new Error("探索のコード/モデル/条件/版が混在しています");
}
async function checkTeacher(
  manifest: DataManifest,
  sample: TeacherSample,
  position: AnalysisPosition,
  playedId: number,
) {
  if (manifest.config.studyTeacher)
    return validateStudyTeacher(
      sample,
      position,
      playedId,
      manifest.config.studyTeacher,
      manifest.code.commit,
    );
  const action = decodeAction(playedId);
  const expected = teacherSettings(manifest, action);
  const result = sample.teacher;
  checkDetails(result, expected, manifest.config.model?.modelId ?? null);
  const mask = getAnalysisLegalActions(position).map(encodeAction);
  if (
    sample.stateHash !== position.stateHash ||
    !sameData(sample.state, position.state) ||
    !sameData(sample.legalActionIds, mask) ||
    new Set(mask).size !== mask.length ||
    sample.playedActionId !== playedId ||
    !mask.includes(playedId)
  )
    throw new Error("完全状態/履歴/合法手マスク/方向が不一致です");
  if (
    !sameData(result.input, {
      stateHash: position.stateHash,
      eventOffset: position.eventOffset,
      ruleProfileId: position.ruleProfileId,
      rulesVersion: 1,
      threePlayerAttackProhibited: position.state.threePlayerAttackProhibited,
      rootSide: position.state.turn,
    })
  )
    throw new Error("教師の入力/ON・OFFが不一致です");
  const cacheKey = await createAnalysisCacheKey(position, {
    codeVersion: manifest.code.commit,
    analysisVersion: expected.versions.analysisVersion,
    modelId: manifest.config.model?.modelId ?? null,
    parameters: { ...expected.versions, ...expected.settings },
  });
  if (
    result.cacheKey !== cacheKey ||
    !sameData(
      result.staticEvaluation,
      evaluateAiPosition(position.state, manifest.config.teacher.evaluationWeights),
    )
  )
    throw new Error("教師の識別/評価版が不一致です");
  const policy =
    result.diagnostics.completedDepth > 0 && result.recommendedAction
      ? encodeAction(result.recommendedAction)
      : null;
  if (
    sample.policyActionId !== policy ||
    (policy !== null && !mask.includes(policy)) ||
    result.status === "cancelled"
  )
    throw new Error("教師の完成比較/Policyが不一致です");
  for (const candidate of result.candidates) {
    if (!mask.includes(encodeAction(candidate.action)))
      throw new Error("教師候補に違法手があります");
    let branch = position;
    for (const [index, step] of candidate.line.entries()) {
      if (
        branch.state.turn !== step.side ||
        step.afterPly !== index + 1 ||
        (index === 0 && !sameData(step.action, candidate.action))
      )
        throw new Error("教師PVの実手番/候補が不一致です");
      branch = await advanceAnalysisPosition(branch, {
        type: "action",
        side: step.side,
        action: step.action,
      });
      if (step.nextTurn !== branch.state.turn || !sameData(step.result, branch.state.result))
        throw new Error("教師PVの遷移が不一致です");
    }
    if (
      candidate.line.length &&
      !validLineEvaluation(branch.state, candidate.lineEvaluation, manifest)
    )
      throw new Error("PV末尾と試行平均の評価が混同されています");
    if (
      manifest.config.model &&
      (!sameData(candidate.evaluation, candidate.lineEvaluation) ||
        candidate.comparisonKind !== "uniform_depth")
    )
      throw new Error("モデル教師へ異なる尺度/末尾の評価が混在しています");
  }
}
function validLineEvaluation(
  state: FourShogiState,
  value: AiResult["evaluation"],
  manifest: DataManifest,
) {
  if (value?.evaluationKind !== "model")
    return sameData(value, evaluateAiPosition(state, manifest.config.teacher.evaluationWeights));
  if (!manifest.config.model || state.status !== "playing" || value.probabilities !== null)
    return false;
  const vector = (["south", "west", "north", "east"] as const).map(
    (side) => value.values[side].primary,
  );
  if (
    vector.some((v) => !Number.isFinite(v) || v < 0 || v >= 1) ||
    vector.reduce((a, b) => a + b, 0) > 1 + 1e-5
  )
    return false;
  const reconstructed = modelEvaluation(state, {
    value: [...vector, Math.max(0, 1 - vector.reduce((a, b) => a + b, 0))],
  } as AiModelOutput);
  return sameData(value, reconstructed);
}

/** 保存された全イベントを一度ずつ正本で再生し、必要局面と終局ラベルを照合します。 */
export async function validateGameArtifact(
  manifest: DataManifest,
  plan: GamePlan,
  record: GameArtifact,
) {
  if (
    record.format !== selfPlayVersion ||
    record.datasetId !== manifest.datasetId ||
    !sameData(record.plan, plan)
  )
    throw new Error("異なるゲーム/分割/設定のデータです");
  const start = manifest.starts[plan.start];
  let position = await restoreAnalysisPosition(start.replay);
  const opening = position.eventOffset;
  const events = record.replay.events;
  if (
    record.openingEventCount !== opening ||
    record.replay.eventOffset !== events.length ||
    !sameData(record.replay.initial, start.replay.initial) ||
    !sameData(events.slice(0, opening), start.replay.events.slice(0, opening)) ||
    record.actors.length !== events.length - opening ||
    record.actors.length > manifest.config.maxPlies
  )
    throw new Error("開始系列/再開位置/件数が不一致です");
  const byOffset = new Map(record.samples.map((sample) => [sample.eventOffset, sample]));
  if (byOffset.size !== record.samples.length) throw new Error("同じ局面を二重採用しています");
  let samples = 0;
  for (let offset = opening; offset < events.length; offset++) {
    const actor = record.actors[offset - opening];
    const event = events[offset];
    const side = position.state.turn;
    if (
      event.index !== offset ||
      event.event.type !== "action" ||
      event.event.side !== side ||
      side === null ||
      actor.eventOffset !== offset ||
      actor.agentId !== plan.lineup[side] ||
      actor.actionId !== encodeAction(event.event.action)
    )
      throw new Error("実手番/相手群/イベントの連番が不一致です");
    const agent = manifest.config.agents.find((a) => a.id === actor.agentId)!;
    if (agent.kind === "analysis")
      checkDetails(
        actor.diagnostics as Parameters<typeof checkDetails>[0],
        resolveAiOptions({
          ...agent.settings,
          modelId: manifest.config.model?.modelId ?? null,
          codeVersion: manifest.code.commit,
        }),
        manifest.config.model?.modelId ?? null,
      );
    else if (agent.kind === "study")
      validateStudyDecision(
        actor.diagnostics as StudyCpuResult,
        agent.settings,
        manifest.code.commit,
      );
    else if (
      !sameData(actor.diagnostics, { source: manifest.cpuSources[agent.id], featureVersion: null })
    )
      throw new Error("固定相手の版が不一致です");
    const sample = byOffset.get(offset);
    if (Boolean(sample) !== shouldTeach(manifest.config, offset - opening, samples, position))
      throw new Error("教師局面の選別/件数が不一致です");
    if (sample) {
      await checkTeacher(manifest, sample, position, actor.actionId);
      samples++;
    }
    position = await advanceAnalysisPosition(position, event.event);
  }
  if (samples !== record.samples.length) throw new Error("棋譜外の教師局面があります");
  const restored = await restoreAnalysisPosition(record.replay);
  if (restored.stateHash !== position.stateHash)
    throw new Error("全保存イベントの再生が不一致です");
  validateOutcome(record, position, manifest.config.maxPlies);
  return position;
}

export async function inspectDataStore(store: SelfPlayStore) {
  const manifest = store.readManifest();
  if (!manifest) throw new Error("manifestがありません");
  await validateManifest(manifest, store.scratchDirectory);
  const plans = gamePlans(manifest);
  const expected = new Map(plans.map((p) => [p.gameId, p]));
  const splitByFamily = new Map<string, DataSplit>();
  const splitByPosition = new Map<string, DataSplit>();
  const counts = {
    planned: plans.length,
    pending: 0,
    inProgress: 0,
    finished: 0,
    truncated: 0,
    positions: 0,
    policySamples: 0,
    valueSamples: 0,
  };
  const splits = { train: 0, validation: 0, calibration: 0, test: 0 };
  const checksums: { gameId: string; checksum: string | null }[] = [];
  for (const id of store.gameIds()) {
    const plan = expected.get(id);
    if (!plan) throw new Error("不明/重複したゲームIDがあります");
    const record = store.readGame(id)!;
    checksums.push({ gameId: id, checksum: dataHash(record) });
    await validateGameArtifact(manifest, plan, record);
    if (splitByFamily.has(plan.familyId) && splitByFamily.get(plan.familyId) !== plan.split)
      throw new Error("同じ系列がsplitを横断しています");
    splitByFamily.set(plan.familyId, plan.split);
    for (const sample of record.samples) {
      const key = positionFamilyKey(sample.state);
      if (splitByPosition.has(key) && splitByPosition.get(key) !== plan.split)
        throw new Error("同じ局面/回転局面がsplitを横断しています");
      splitByPosition.set(key, plan.split);
    }
    counts.positions += record.actors.length;
    if (record.status === "in_progress") counts.inProgress++;
    else {
      splits[plan.split]++;
      if (record.status === "finished") counts.finished++;
      else counts.truncated++;
      counts.policySamples += record.samples.filter((s) => s.policyActionId !== null).length;
      if (record.outcome) counts.valueSamples += record.samples.length;
    }
  }
  counts.pending = plans.length - store.gameIds().length;
  return {
    datasetId: manifest.datasetId,
    ...counts,
    splits,
    logicalBytes: store.bytes(),
    splitFamilies: splitByFamily.size,
    complete: counts.pending === 0 && counts.inProgress === 0,
    contentHash: dataHash(
      plans.map((p) => ({
        gameId: p.gameId,
        checksum: checksums.find((c) => c.gameId === p.gameId)?.checksum ?? null,
      })),
    ),
  };
}
