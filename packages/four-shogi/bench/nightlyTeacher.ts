import { SelfPlayStore } from "./selfPlayStore";
import { inspectDataStore, validateGameArtifact } from "./selfPlayInspect";
import { compatibleDataCode, currentDataCode } from "./selfPlayRun";
import { configInput, shouldTeach } from "./selfPlayGame";
import { createDataManifest, gamePlans, sameData, type GameArtifact } from "./selfPlayData";
import {
  restoreAnalysisPosition,
  advanceAnalysisPosition,
  getAnalysisLegalActions,
} from "../src/analysis";
import { encodeAction } from "../src/actionEncoding";
import { analyzeStudyCpu, readStudyCpuSettings, type StudyCpuSettings } from "./studyCpu";
import { loadLocalModel } from "../src/localModel";

/** 確定棋譜を変更せず、新しいdatasetへ選択局面だけを追加解析する。 */
export async function generateStudyTeachers(
  source: string,
  destination: string,
  settings: StudyCpuSettings,
  maxPositions = 24,
  signal?: AbortSignal,
) {
  const input = new SelfPlayStore(source, 1024 ** 4);
  let output: SelfPlayStore | undefined;
  let attempted = 0,
    completed = 0,
    work = 0,
    cpuMs = 0;
  try {
    output = new SelfPlayStore(destination, 1024 ** 4);
    const inspection = await inspectDataStore(input),
      original = input.readManifest()!;
    if (!inspection.complete) throw new Error("教師生成は確定したdatasetだけを使用します");
    compatibleDataCode(currentDataCode(), original.code);
    const manifest = await createDataManifest(
      {
        ...(configInput(original.config) as object),
        derivedFrom: { datasetId: original.datasetId, contentHash: inspection.contentHash },
        studyTeacher: settings,
        sampling: { every: 16, important: true, maxPositions },
      },
      original.code,
      original.cpuSources,
    );
    const previous = output.readManifest();
    if (previous && !sameData(previous, manifest))
      throw new Error("再開元と教師/元datasetが不一致です");
    if (!previous) output.writeManifest(manifest);
    const sourcePlans = gamePlans(original),
      model = settings.modelFile
        ? loadLocalModel(settings.modelFile, settings.modelId, settings.modelSha256)
        : undefined;
    for (const plan of gamePlans(manifest)) {
      if (output.readGame(plan.gameId)) continue;
      const sourcePlan = sourcePlans.find(
        (p) => p.start === plan.start && sameData(p.lineup, plan.lineup),
      )!;
      const record: GameArtifact = {
        ...structuredClone(input.readGame(sourcePlan.gameId)!),
        datasetId: manifest.datasetId,
        plan,
        samples: [],
      };
      let position = await restoreAnalysisPosition(manifest.starts[plan.start].replay);
      for (const [index, actor] of record.actors.entries()) {
        if (signal?.aborted) throw new Error("教師生成を中断しました");
        if (shouldTeach(manifest.config, index, record.samples.length, position)) {
          const result = await analyzeStudyCpu(
            position,
            settings,
            manifest.code.commit,
            { signal },
            { model },
          );
          if (result.status === "cancelled") throw new Error("教師生成を中断しました");
          attempted++;
          work += result.diagnostics.work;
          cpuMs += result.studyCpu.cpuMs;
          const policy =
            result.diagnostics.completedDepth > 0 && result.recommendedAction
              ? encodeAction(result.recommendedAction)
              : null;
          if (policy !== null) completed++;
          record.samples.push({
            eventOffset: position.eventOffset,
            stateHash: position.stateHash,
            state: position.state,
            legalActionIds: getAnalysisLegalActions(position).map(encodeAction),
            playedActionId: actor.actionId,
            policyActionId: policy,
            teacher: result,
          });
        }
        position = await advanceAnalysisPosition(
          position,
          record.replay.events[actor.eventOffset].event,
        );
      }
      await validateGameArtifact(manifest, plan, record);
      output.writeGame(record);
    }
    return {
      ...(await inspectDataStore(output)),
      attemptedThisInvocation: attempted,
      completedThisInvocation: completed,
      workThisInvocation: work,
      cpuMsThisInvocation: cpuMs,
    };
  } finally {
    input.close();
    output?.close();
  }
}
if (import.meta.main) {
  const [source, output, configPath, reportPath] = process.argv.slice(2);
  if (!reportPath) throw new Error("nightlyTeacher source output config report");
  const config = await Bun.file(configPath).json(),
    controller = new AbortController();
  const stop = () => controller.abort();
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    const report = await generateStudyTeachers(
      source,
      output,
      readStudyCpuSettings(config.teacher),
      config.maxPositions,
      controller.signal,
    );
    await Bun.write(reportPath, JSON.stringify(report, null, 2) + "\n");
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}
