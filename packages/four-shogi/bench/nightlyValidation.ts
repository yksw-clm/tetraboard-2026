import { join } from "node:path";
import { existsSync } from "node:fs";
import {
  studyTacticalCases,
  acceptsStudyTactic,
} from "../../../apps/four-shogi-study/bench/studyTactics";
import { tacticInput } from "../../../apps/four-shogi-study/bench/tacticsDiagnostics";
import { restoreStudyPosition } from "../../../apps/four-shogi-study/src/domain/study";
import { getAnalysisLegalActions } from "../src/analysis";
import { encodeAction } from "../src/actionEncoding";
import { runNativeStudy } from "./nightlyStudy";
import { analyzeStudyCpu, readStudyCpuSettings } from "./studyCpu";
import {
  atomicJson,
  immutableJson,
  readJson,
  checkedJson,
  readCheckedJson,
  type GenerationManifest,
} from "./nightlyStore";
import { nightlySource } from "./nightlyConfig";

export async function validateGenerationTactics(
  directory: string,
  generation: GenerationManifest,
  signal?: AbortSignal,
) {
  const specification = {
    format: "four-shogi-nightly-tactics-v1",
    generationId: generation.id,
    modelId: generation.modelId,
    sourceFingerprint: nightlySource().fingerprint,
    criticalMs: 1000,
    knownWork: 1000000,
    knownDepth: 9,
    threads: 4,
  };
  immutableJson(join(directory, "tactics-plan.json"), specification);
  const path = join(directory, "tactics-progress.json");
  const rows: {
    id: string;
    cohort: string;
    passed: boolean;
    legal: boolean;
    completedDepth: number;
    work: number;
    elapsedMs: number;
    modelUsed: boolean;
    resourcePassed: boolean;
  }[] = existsSync(path) ? readCheckedJson(path) : [];
  const cases = studyTacticalCases().filter((t) => t.critical || t.family === "inactive-rook");
  if (
    new Set(rows.map((row) => row.id)).size !== rows.length ||
    rows.some((row) => !cases.some((tactic) => tactic.id === row.id))
  )
    throw new Error("戦術検証の保存行に未知/重複した問題があります");
  const model =
    generation.localModelFile && generation.modelId
      ? {
          file: generation.localModelFile,
          modelId: generation.modelId,
          sha256: generation.localModelSha256 ?? undefined,
        }
      : null;
  for (const tactic of cases) {
    if (rows.some((r) => r.id === tactic.id)) continue;
    if (signal?.aborted) throw new Error("戦術検証を中断しました");
    const input = tacticInput(tactic.state),
      position = await restoreStudyPosition(input),
      known = tactic.family === "inactive-rook";
    if (known) {
      const result = await analyzeStudyCpu(
        position,
        readStudyCpuSettings({
          maxWork: 1000000,
          maxDepth: 9,
          ...(model
            ? { modelFile: model.file, modelId: model.modelId, modelSha256: model.sha256 }
            : {}),
        }),
        "nightly-known-depth9",
        { signal },
      );
      const legal =
        !!result.recommendedAction &&
        getAnalysisLegalActions(position).some(
          (a) => encodeAction(a) === encodeAction(result.recommendedAction!),
        );
      // 同じ既存採点関数へ渡し、探索方式の実測情報は別に保持する。
      const accepted = acceptsStudyTactic(tactic, {
        candidates: result.candidates,
        recommendedAction: result.recommendedAction,
      } as Parameters<typeof acceptsStudyTactic>[1]);
      rows.push({
        id: tactic.id,
        cohort: "known",
        passed: legal && result.diagnostics.completedDepth === 9 && accepted,
        legal,
        completedDepth: result.diagnostics.completedDepth,
        work: result.diagnostics.work,
        elapsedMs: result.diagnostics.elapsedMs,
        modelUsed: model === null || result.model.inferenceCount > 0,
        resourcePassed: result.studyCpu.rssBytes <= 4096 * 1024 ** 2,
      });
    } else {
      const measured = await runNativeStudy(input, model, 1000, 4, signal),
        result = measured.result;
      const legal =
        !!result.recommendedAction &&
        getAnalysisLegalActions(position).some(
          (a) => encodeAction(a) === encodeAction(result.recommendedAction!),
        );
      rows.push({
        id: tactic.id,
        cohort: "critical",
        passed: measured.complete && legal && acceptsStudyTactic(tactic, result),
        legal,
        completedDepth: result.completedDepth,
        work: result.work,
        elapsedMs: measured.elapsedMs,
        modelUsed: measured.modelUsed,
        resourcePassed: measured.withinBudget && result.memoryBytes <= 4096 * 1024 ** 2,
      });
    }
    checkedJson(path, rows);
  }
  const cohort = (name: string) => ({
    total: rows.filter((r) => r.cohort === name).length,
    passed: rows.filter((r) => r.cohort === name && r.passed).length,
  });
  return {
    specification,
    critical: cohort("critical"),
    known: cohort("known"),
    resourcePassed: rows.every((r) => r.resourcePassed && r.legal && r.modelUsed),
    rows,
  };
}
if (import.meta.main) {
  const [directory, generationFile, report] = process.argv.slice(2);
  if (!report) throw new Error("nightlyValidation directory generation report");
  const controller = new AbortController(),
    stop = () => controller.abort();
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    atomicJson(
      report,
      await validateGenerationTactics(directory, readJson(generationFile), controller.signal),
    );
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}
