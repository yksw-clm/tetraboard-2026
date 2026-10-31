import { analyzePosition, resolveAiOptions, type AiControl, type AiResult } from "../src/ai";
import {
  restoreAnalysisPosition,
  getAnalysisLegalActions,
  type AnalysisPosition,
  type AnalysisReplayInput,
} from "../src/analysis";
import { getCheckState } from "../src/board";
import { encodeAction } from "../src/actionEncoding";
import { sides } from "../src/types";
import { loadPlayer, type Player } from "./baseline";
import { hashJson } from "./singlesMeasurement";
import { analyzeStudyCpu } from "./studyCpu";
import { loadLocalModel } from "../src/localModel";
import { playAnalysisSingles, type PositionDecision } from "./searchExperiment";
import {
  sameData,
  selfPlayVersion,
  outcomeFor,
  type DataManifest,
  type GameArtifact,
  type GamePlan,
  type SelfPlayConfig,
} from "./selfPlayData";

export class GenerationPaused extends Error {}
export function analysisDetails(result: AiResult) {
  return {
    versions: result.versions,
    settings: result.settings,
    model: result.model,
    diagnostics: result.diagnostics,
  };
}
export async function loadDataPlayers(
  manifest: DataManifest,
  control: AiControl = {},
  temporaryDirectory?: string,
) {
  const disposables: Player[] = [];
  const selectors = new Map<string, (position: AnalysisPosition) => Promise<PositionDecision>>();
  try {
    for (const agent of manifest.config.agents) {
      if (agent.kind === "cpu") {
        const player = await loadPlayer(agent.reference, {}, { temporaryDirectory });
        disposables.push(player);
        if (!sameData(player.metadata, manifest.cpuSources[agent.id]))
          throw new Error("固定CPUの版/設定がmanifestと不一致です");
        selectors.set(agent.id, async (position) => {
          if (control.signal?.aborted || control.isCancelled?.())
            throw new GenerationPaused("cancelled");
          return {
            ...player.selector(position.state),
            details: { source: player.metadata, featureVersion: null },
          };
        });
      } else if (agent.kind === "study") {
        const model = agent.settings.modelFile
          ? loadLocalModel(
              agent.settings.modelFile,
              agent.settings.modelId,
              agent.settings.modelSha256,
            )
          : undefined;
        selectors.set(agent.id, async (position) => {
          const result = await analyzeStudyCpu(
            position,
            agent.settings,
            manifest.code.commit,
            control,
            { model },
          );
          if (result.status === "cancelled") throw new GenerationPaused("cancelled");
          return {
            action: result.recommendedAction,
            stats: {
              work: result.diagnostics.work,
              completedDepth: result.diagnostics.completedDepth,
              cutoff: result.status === "limited",
            },
            details: result,
          };
        });
      } else
        selectors.set(agent.id, async (position) => {
          const result = await analyzePosition(
            position,
            {
              ...agent.settings,
              modelId: manifest.config.model?.modelId ?? null,
              codeVersion: manifest.code.commit,
            },
            control,
          );
          if (result.status === "cancelled") throw new GenerationPaused("cancelled");
          requireGenerationModel(manifest, result);
          return {
            action: result.recommendedAction,
            stats: {
              work: result.diagnostics.work,
              completedDepth: result.diagnostics.completedDepth,
              cutoff: result.status === "limited",
            },
            details: analysisDetails(result),
          };
        });
    }
    return { selectors, dispose: () => disposables.forEach((p) => p.dispose()) };
  } catch (error) {
    disposables.forEach((p) => p.dispose());
    throw error;
  }
}
export function shouldTeach(
  config: SelfPlayConfig,
  moves: number,
  samples: number,
  position: AnalysisPosition,
) {
  if (samples >= config.sampling.maxPositions || position.state.status !== "playing") return false;
  const periodic = config.sampling.every > 0 && moves % config.sampling.every === 0;
  const important =
    config.sampling.important &&
    (getCheckState(position.state)[position.state.turn] ||
      Boolean(position.state.lastMove?.captured));
  return periodic || important;
}
function finish(record: GameArtifact, position: AnalysisPosition, limit: number) {
  record.stateHash = position.stateHash;
  record.status =
    position.state.status === "finished"
      ? "finished"
      : record.actors.length >= limit
        ? "truncated"
        : "in_progress";
  record.outcome = outcomeFor(position);
}

/** 既存対戦runnerの保存hookで一手ずつ確定し、ACK前の枝を再開位置へ採用しません。 */
export async function generateSelfPlayGame(
  manifest: DataManifest,
  plan: GamePlan,
  saved: GameArtifact | null,
  commit: (record: GameArtifact) => Promise<void>,
  control: AiControl = {},
  temporaryDirectory?: string,
) {
  if (manifest.config.teacherSelection) throw new Error("軌跡選別は確定棋譜の追加教師専用です");
  const start = manifest.starts[plan.start];
  let position = await restoreAnalysisPosition(saved?.replay ?? start.replay);
  const replay: AnalysisReplayInput = {
    ...start.replay,
    events: start.replay.events.slice(0, position.eventOffset),
    eventOffset: position.eventOffset,
  };
  const record: GameArtifact = saved
    ? structuredClone(saved)
    : {
        format: selfPlayVersion,
        datasetId: manifest.datasetId,
        plan,
        status: "in_progress",
        replay,
        openingEventCount: position.eventOffset,
        stateHash: position.stateHash,
        actors: [],
        samples: [],
        outcome: null,
      };
  if (!sameData(record.plan, plan) || record.datasetId !== manifest.datasetId)
    throw new Error("再開するゲームの識別が不一致です");
  if (saved && saved.stateHash !== position.stateHash)
    throw new Error("再開状態のhashが不一致です");
  finish(record, position, manifest.config.maxPlies);
  if (!saved) await commit(record);
  if (record.status !== "in_progress") return record;
  const studyTeacherModel = manifest.config.studyTeacher?.modelFile
    ? loadLocalModel(
        manifest.config.studyTeacher.modelFile,
        manifest.config.studyTeacher.modelId,
        manifest.config.studyTeacher.modelSha256,
      )
    : undefined;
  const players = await loadDataPlayers(manifest, control, temporaryDirectory);
  try {
    const benchStart = {
      position,
      replay: record.replay,
      start: {
        kind: "opening" as const,
        seed: start.seed,
        seriesId: hashJson(position.state),
        state: position.state,
      },
    };
    await playAnalysisSingles(
      benchStart,
      "south",
      plan.lineup,
      players.selectors,
      manifest.config.maxPlies - record.actors.length,
      async (step) => {
        if (control.signal?.aborted || control.isCancelled?.())
          throw new GenerationPaused("cancelled");
        const action = step.decision.action!;
        const actionId = encodeAction(action);
        if (
          shouldTeach(manifest.config, record.actors.length, record.samples.length, step.before)
        ) {
          const teacher = manifest.config.studyTeacher
            ? await analyzeStudyCpu(
                step.before,
                manifest.config.studyTeacher,
                manifest.code.commit,
                control,
                { model: studyTeacherModel },
              )
            : await analyzePosition(
                step.before,
                {
                  ...manifest.config.teacher,
                  modelId: manifest.config.model?.modelId ?? null,
                  includeAction: action,
                  codeVersion: manifest.code.commit,
                },
                control,
              );
          if (teacher.status === "cancelled") throw new GenerationPaused("cancelled");
          if (!manifest.config.studyTeacher) requireGenerationModel(manifest, teacher);
          record.samples.push({
            eventOffset: step.before.eventOffset,
            stateHash: step.before.stateHash,
            state: step.before.state,
            legalActionIds: getAnalysisLegalActions(step.before).map(encodeAction),
            playedActionId: actionId,
            policyActionId:
              teacher.diagnostics.completedDepth > 0 && teacher.recommendedAction
                ? encodeAction(teacher.recommendedAction)
                : null,
            teacher,
          });
        }
        record.actors.push({
          eventOffset: step.before.eventOffset,
          agentId: step.playerId,
          actionId,
          diagnostics: step.decision.details,
        });
        const events = [
          ...record.replay.events,
          {
            index: step.before.eventOffset,
            event: { type: "action" as const, side: step.side, action },
          },
        ];
        record.replay = { ...record.replay, events, eventOffset: events.length };
        position = step.after;
        finish(record, position, manifest.config.maxPlies);
        await commit(record);
      },
    );
    return record;
  } finally {
    players.dispose();
  }
}

export function configInput(config: SelfPlayConfig): unknown {
  return {
    ...config,
    origins: config.origins.map((o) => (o.replay ? o : { seed: o.seed })),
    agents: config.agents.map((a) =>
      a.kind === "analysis" || a.kind === "study"
        ? { id: a.id, kind: a.kind, options: a.settings }
        : a,
    ),
  };
}
export function teacherSettings(
  manifest: DataManifest,
  action: Parameters<typeof encodeAction>[0],
) {
  return resolveAiOptions({
    ...manifest.config.teacher,
    modelId: manifest.config.model?.modelId ?? null,
    includeAction: action,
    codeVersion: manifest.code.commit,
  });
}
function requireGenerationModel(manifest: DataManifest, result: AiResult) {
  if (
    manifest.config.model &&
    (result.model.usedModelId !== manifest.config.model.modelId ||
      result.model.inferenceCount < 1 ||
      result.model.fallbackReason)
  )
    throw new GenerationPaused("指定モデルを実使用できないため、fallback教師を保存せず停止します");
}
export function validateOutcome(record: GameArtifact, position: AnalysisPosition, limit: number) {
  const status =
    position.state.status === "finished"
      ? "finished"
      : record.actors.length >= limit
        ? "truncated"
        : "in_progress";
  if (
    record.status !== status ||
    !sameData(record.outcome, outcomeFor(position)) ||
    record.stateHash !== position.stateHash
  )
    throw new Error("終局/打切り/単独勝ちの結果が不一致です");
  if (record.outcome && record.outcome.target.length !== sides.length + 1)
    throw new Error("Valueの方向が不一致です");
}
