import { join } from "node:path";
import { loadLocalModel } from "../src/localModel";
import { ModelInferenceClient } from "../src/modelInference";
import { validateModelOutputs, type AiModelInput } from "../src/aiModel";
import { repoRoot } from "./baseline";
import { processRss } from "./selfPlayRun";
import { runNativeStudy } from "./nightlyStudy";
import { atomicJson, readJson } from "./nightlyStore";
import archive from "../../../test-fixtures/matches/shogi-singles.json";
import { getAnalysisLegalActions, restoreAnalysisPosition } from "../src/analysis";
import { encodeAction } from "../src/actionEncoding";
import { readReplayEvent } from "../src/analysisInput";

export async function probeInference(
  directory: string,
  python: string,
  fixture: string,
  signal?: AbortSignal,
) {
  const started = performance.now(),
    local = loadLocalModel(join(directory, "local-model.json")),
    loadMs = performance.now() - started;
  const rows = readJson<{ rows: AiModelInput[] }>(fixture).rows;
  const perRow: number[] = [];
  for (let i = 0; i < 32; i++) {
    const input = rows[i % rows.length],
      start = performance.now();
    const output = local.predict(input);
    validateModelOutputs([input], [output]);
    perRow.push(performance.now() - start);
  }
  const batchStart = performance.now();
  for (let i = 0; i < 8; i++) rows.map((row) => local.predict(row));
  const localBatchMs = (performance.now() - batchStart) / 8;
  const clients: ModelInferenceClient[] = [];
  const pythonResults = [];
  try {
    for (const count of [1, 4]) {
      const start = performance.now();
      for (let i = 0; i < count; i++)
        clients.push(
          await ModelInferenceClient.start([
            python,
            join(repoRoot, "training/four-shogi-ai/inference.py"),
            "serve",
            "--model",
            directory,
            "--fixture",
            fixture,
            "--threads",
            "1",
          ]),
        );
      const startupMs = performance.now() - start,
        rss = processRss(clients.flatMap((c) => (c.processId ? [c.processId] : []))),
        single = [];
      for (let i = 0; i < 8; i++) {
        const t = performance.now();
        const output = await clients[0].asEvaluator().evaluate([rows[i % rows.length]], signal);
        const expected = local.predict(rows[i % rows.length]);
        for (const name of ["policyLogits", "policy", "value"] as const)
          output.rows[0][name].forEach((v, j) => {
            if (Math.abs(v - expected[name][j]) > 1e-5 + Math.abs(v) * 1e-4)
              throw new Error("PythonとBun推論が不一致です");
          });
        single.push(performance.now() - t);
      }
      const batch = performance.now();
      await Promise.all(clients.map((c) => c.asEvaluator().evaluate(rows, signal)));
      const batchMs = performance.now() - batch;
      pythonResults.push({
        processes: count,
        startupMs,
        residentRssWithBunBytes: rss,
        singleMedianMs: single.sort((a, b) => a - b)[4],
        concurrentBatchMs: batchMs,
        rowsPerProcess: rows.length,
      });
      for (const client of clients.splice(0)) client.close();
      await new Promise((r) => setTimeout(r, 25));
    }
  } finally {
    for (const client of clients) client.close();
  }
  const native = [];
  for (const offset of [0, 26]) {
    const replay = {
      schemaVersion: 1 as const,
      ruleProfileId: "tetraboard-four-shogi-singles-v1" as const,
      rulesVersion: 1 as const,
      initial: {
        mode: "singles" as const,
        players: { south: "probe-s", west: "probe-w", north: "probe-n", east: "probe-e" },
        threePlayerAttackProhibited: true,
      },
      events: archive.events
        .slice(0, offset)
        .map(({ index, event }) => ({ index, event: readReplayEvent(event) })),
      eventOffset: offset,
    };
    const position = await restoreAnalysisPosition(replay),
      legal = getAnalysisLegalActions(position).map(encodeAction);
    for (const model of [
      null,
      { file: join(directory, "local-model.json"), modelId: local.modelId },
    ]) {
      if (signal?.aborted) throw new Error("推論検証を中断しました");
      const measured = await runNativeStudy(
        { origin: { kind: "replay", replay }, events: [] },
        model,
        5000,
        4,
        signal,
      );
      const result = measured.result,
        valid =
          !!result.recommendedAction && legal.includes(encodeAction(result.recommendedAction));
      native.push({
        offset,
        modelId: model?.modelId ?? null,
        elapsedMs: measured.elapsedMs,
        completedDepth: result.completedDepth,
        coverage: result.coverage,
        work: result.work,
        memoryBytes: result.memoryBytes,
        modelInferences: result.performance?.modelInferences ?? 0,
        modelInferenceMs: result.performance?.modelInferenceMs ?? 0,
        workerCpuMs: measured.workerCpuMs,
        parentCpuMs: measured.parentCpuMs,
        peakWorkerRssBytes: measured.peakWorkerRssBytes,
        complete: measured.complete,
        legal: valid,
        modelUsed: measured.modelUsed,
        withinBudget: measured.withinBudget,
      });
    }
  }
  return {
    passed: native.every((r) => r.complete && r.legal && r.modelUsed && r.withinBudget),
    modelId: local.modelId,
    local: {
      loadMs,
      weightBytes: local.bytes,
      historyCacheEntries: local.historyCacheEntries(),
      singleMedianMs: perRow.sort((a, b) => a - b)[16],
      batchRows: rows.length,
      batchMs: localBatchMs,
    },
    python: pythonResults,
    native,
    interpretation:
      "同じtiny重みの疎なBun推論とPython常駐IPCを比較。Python4プロセス/集約1プロセスの費用を含み、同じ総CPUでの探索高速化や棋力改善を認定しない。",
  };
}
if (import.meta.main) {
  const [directory, python, fixture, report] = process.argv.slice(2);
  if (!report) throw new Error("nightlyInferenceProbe model python fixture report");
  const controller = new AbortController(),
    stop = () => controller.abort();
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    atomicJson(report, await probeInference(directory, python, fixture, controller.signal));
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}
