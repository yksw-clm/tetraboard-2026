import { resolveAiOptions, type AiControl, type AiResult } from "../src/ai";
import { aiVersions } from "../src/aiTypes";
import {
  getAnalysisLegalActions,
  createAnalysisCacheKey,
  type AnalysisPosition,
} from "../src/analysis";
import { getCheckState } from "../src/board";
import {
  createStudyRootSearch,
  selectStudyRootIndices,
  compareStudyCandidates,
  studyStrategyVersion,
  studyEvaluationVersion,
  evaluateStudyPosition,
  type StudyCandidate,
  type StudyRootOptions,
} from "../src/studySearch";
import { dataHash, dataInteger, dataObject } from "./selfPlayData";
import { loadLocalModel } from "../src/localModel";

/** 単一プロセス・固定workの運転版。アプリの壁時計/並列スケジューラーとは別に識別する。 */
export const studyCpuRunner = "p0-5-fixed-work-first-pass-v1";
export type StudyCpuSettings = {
  strategy: "dual-continuations" | "adaptive";
  maxWork: number;
  maxDepth: number;
  broadDepth: number;
  width: number;
  rootWidth: number;
  extensions: number;
  cacheSize: number;
  dangerWork: number;
  modelFile?: string;
  modelId?: string;
};
export function readStudyCpuSettings(value: unknown): StudyCpuSettings {
  const raw = dataObject(value, [
    "strategy",
    "maxWork",
    "maxDepth",
    "broadDepth",
    "width",
    "rootWidth",
    "extensions",
    "cacheSize",
    "dangerWork",
    "modelFile",
    "modelId",
  ]);
  const strategy = raw.strategy ?? "dual-continuations";
  if (strategy !== "dual-continuations" && strategy !== "adaptive")
    throw new Error("study CPUはP0-5/v5です");
  if (
    (raw.modelId === undefined) !== (raw.modelFile === undefined) ||
    (raw.modelId !== undefined &&
      (typeof raw.modelFile !== "string" ||
        typeof raw.modelId !== "string" ||
        !/^four-shogi-tiny-policy-value-v1:[a-f0-9]{64}$/.test(raw.modelId)))
  )
    throw new Error("studyモデルのIDとファイルを同時に指定してください");
  return {
    strategy,
    maxWork: dataInteger(raw.maxWork ?? 4096, 1, 1e9),
    maxDepth: dataInteger(raw.maxDepth ?? 9, 2, 64),
    broadDepth: dataInteger(raw.broadDepth ?? 3, 2, 4),
    width: dataInteger(raw.width ?? 6, 1, 32),
    rootWidth: dataInteger(raw.rootWidth ?? 24, 1, 256),
    extensions: dataInteger(raw.extensions ?? 2, 0, 8),
    cacheSize: dataInteger(raw.cacheSize ?? 1024, 0, 65536),
    dangerWork: dataInteger(raw.dangerWork ?? 128, 0, 100000),
    ...(raw.modelId ? { modelId: raw.modelId as string, modelFile: raw.modelFile as string } : {}),
  };
}
export function studyCpuVersions(settings: StudyCpuSettings, codeVersion: string) {
  return {
    ...aiVersions,
    analysisVersion: studyCpuRunner,
    searchVersion: studyStrategyVersion(settings.strategy),
    evaluationVersion: settings.modelId ?? studyEvaluationVersion,
    featureVersion: settings.modelId ? "four-shogi-features-v1" : null,
    codeVersion,
  };
}
export function studyCpuAiSettings(settings: StudyCpuSettings) {
  const { maxWork, maxDepth, width, rootWidth, extensions, cacheSize, dangerWork } = settings;
  return resolveAiOptions({
    codeVersion: studyCpuRunner,
    maxWork,
    maxDepth,
    width,
    rootWidth,
    extensions,
    cacheSize,
    dangerWork,
    candidateCount: 5,
  }).settings;
}
export type StudyCpuResult = AiResult & {
  studyCpu: {
    runner: string;
    profileHash: string;
    cpuMs: number;
    rssBytes: number;
    phase: "broad" | "deep";
    completedRoots: number;
  };
};
export async function analyzeStudyCpu(
  position: AnalysisPosition,
  settings: StudyCpuSettings,
  codeVersion: string,
  control: AiControl = {},
  modelOptions: Pick<StudyRootOptions, "model"> = {},
): Promise<StudyCpuResult> {
  const started = performance.now(),
    cpu = process.cpuUsage();
  const model =
    modelOptions.model ??
    (settings.modelFile ? loadLocalModel(settings.modelFile, settings.modelId) : undefined);
  const search = createStudyRootSearch(position, { ...settings, ...(model ? { model } : {}) });
  let published: StudyCandidate[] = [],
    completedDepth = 0,
    phase: "broad" | "deep" = "broad";
  let reason: AiResult["diagnostics"]["stopReason"] = "work_limit";
  let yields = 0,
    slice = performance.now();
  const cancelled = () => control.signal?.aborted || control.isCancelled?.();
  async function finishTask(depth: number) {
    while (true) {
      if (cancelled()) {
        reason = "cancelled";
        return false;
      }
      if (search.work >= settings.maxWork) return false;
      const done = search.step();
      if (search.depth >= depth || done) return search.depth >= depth;
      if (performance.now() - slice >= 8) {
        yields++;
        await (control.yieldToHost?.() ?? new Promise<void>((r) => setTimeout(r, 0)));
        slice = performance.now();
      }
    }
  }
  try {
    if (await finishTask(1)) {
      published = search.snapshot().candidates;
      completedDepth = 1;
      for (let depth = 2; depth <= settings.maxDepth; depth++) {
        const deep = settings.strategy === "dual-continuations" && depth > settings.broadDepth;
        const indices = selectStudyRootIndices(
          published,
          position.state.turn!,
          settings.rootWidth,
        ).slice(0, deep ? 3 : undefined);
        const completed: StudyCandidate[] = [];
        for (const index of indices) {
          search.startTask(index, depth, depth === 2 && completed.length < 5, {
            phase: deep ? "deep" : "broad",
            width: deep ? 2 : settings.width,
            ownWidth: deep ? 3 : settings.width,
          });
          if (!(await finishTask(depth))) break;
          completed.push(...search.snapshot().candidates);
        }
        if (completed.length !== indices.length || !indices.length) break;
        published = completed;
        completedDepth = depth;
        phase = deep ? "deep" : "broad";
        const best = [...published].sort((a, b) =>
          compareStudyCandidates(a, b, position.state.turn!),
        )[0];
        if (
          best.evaluation?.evaluationKind === "terminal" &&
          best.evaluation.values[position.state.turn!].primary === 1
        ) {
          reason = "sole_win";
          break;
        }
        if (depth === settings.maxDepth) reason = "max_depth";
      }
    }
    const snap = search.snapshot();
    const candidates = published
      .sort((a, b) => compareStudyCandidates(a, b, position.state.turn!))
      .slice(0, 5);
    const versions = studyCpuVersions(settings, codeVersion),
      aiSettings = studyCpuAiSettings(settings);
    const terminal = position.state.status === "finished";
    const legal = getAnalysisLegalActions(position);
    if (terminal) reason = "terminal";
    else if (!legal.length) reason = "no_legal_actions";
    if (cancelled()) reason = "cancelled";
    const used = process.cpuUsage(cpu);
    return {
      schemaVersion: 1,
      status:
        reason === "cancelled"
          ? "cancelled"
          : terminal
            ? "terminal"
            : !legal.length
              ? "no_legal_actions"
              : reason === "work_limit"
                ? "limited"
                : "completed",
      input: {
        stateHash: position.stateHash,
        eventOffset: position.eventOffset,
        ruleProfileId: position.ruleProfileId,
        rulesVersion: 1,
        threePlayerAttackProhibited: position.state.threePlayerAttackProhibited,
        rootSide: position.state.turn,
      },
      cacheKey: await createAnalysisCacheKey(position, {
        codeVersion,
        analysisVersion: studyCpuRunner,
        modelId: settings.modelId ?? null,
        parameters: settings,
      }),
      versions,
      settings: aiSettings,
      model: {
        requestedModelId: settings.modelId ?? null,
        loadedModelId: settings.modelId ?? null,
        usedModelId: settings.modelId ?? null,
        inferenceCount: snap.performance?.modelInferences ?? 0,
      },
      recommendedAction: candidates[0]?.action ?? legal[0] ?? null,
      staticEvaluation: snap.staticEvaluation,
      evaluation: candidates[0]?.evaluation ?? null,
      candidates,
      comparedAction: null,
      currentDanger: {
        checkedSides: Object.entries(getCheckState(position.state))
          .filter(([, v]) => v)
          .map(([k]) => k as NonNullable<AnalysisPosition["state"]["turn"]>),
        eliminations: position.state.eliminations,
      },
      diagnostics: {
        ...snap.stats,
        completedDepth,
        stopReason: reason,
        fallbackReason: completedDepth ? null : "no_completed_iteration",
        legalPreparationMs: 0,
        deadlineOverrunMs: 0,
        yields,
        elapsedMs: performance.now() - started,
        algorithm: "maxn",
      },
      studyCpu: {
        runner: studyCpuRunner,
        profileHash: dataHash({ settings, versions, workers: 1, partition: "root", pass: 0 }),
        cpuMs: (used.user + used.system) / 1000,
        rssBytes: process.memoryUsage().rss,
        phase,
        completedRoots: published.length,
      },
    };
  } finally {
    search.dispose();
  }
}
export function studyStaticEvaluation(position: AnalysisPosition) {
  return evaluateStudyPosition(position);
}
