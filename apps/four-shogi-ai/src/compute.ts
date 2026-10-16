import { resolve } from "node:path";
import { analyzePosition } from "@tetraboard/four-shogi/ai";
import { AnalysisInputError, restoreAnalysisPosition } from "@tetraboard/four-shogi/analysis";
import { ModelInferenceClient } from "@tetraboard/four-shogi/model-inference";
import { aiJobRequestSchema } from "@tetraboard/protocol/four-shogi-ai";
import type { ServiceConfig } from "./config";

export type ComputeSettings = Pick<
  ServiceConfig,
  "codeVersion" | "python" | "modelDirectory" | "modelId"
>;
let model: ModelInferenceClient | null = null;
let settings: ComputeSettings | null = null;
let active: { id: string; abort: AbortController } | null = null;
const send = (value: object) => process.send?.(value);
function close() {
  active?.abort.abort();
  model?.close();
  process.exit(0);
}
process.on("disconnect", close);
process.on("SIGTERM", close);
process.on("message", (value: unknown) => {
  const message = value as {
    type: string;
    settings: ComputeSettings;
    jobId: string;
    request: unknown;
    budgetMs: number;
  };
  if (message.type === "stop") return close();
  if (message.type === "cancel") {
    if (active?.id === message.jobId) active.abort.abort();
    return;
  }
  if (message.type === "init" && !settings) {
    settings = message.settings;
    void (async () => {
      if (settings!.modelDirectory) {
        model = await ModelInferenceClient.start([
          settings!.python,
          resolve(import.meta.dir, "../../../training/four-shogi-ai/inference.py"),
          "serve",
          "--model",
          settings!.modelDirectory,
          "--fixture",
          resolve(settings!.modelDirectory, "probe.json"),
        ]);
        if (
          model.loadedModel.modelId !== settings!.modelId ||
          !model.loadedModel.supportedRestrictions.includes(false) ||
          !model.loadedModel.supportedRestrictions.includes(true)
        )
          throw new Error("model_mismatch");
      }
      send({
        type: "ready",
        modelId: model?.loadedModel.modelId ?? null,
        modelPid: model?.processId ?? null,
      });
    })().catch(() => {
      send({ type: "startup_failed" });
      model?.close();
      process.exit(1);
    });
    return;
  }
  if (message.type !== "run" || active || !settings) return;
  const abort = new AbortController(),
    jobId = message.jobId;
  active = { id: jobId, abort };
  void (async () => {
    const request = aiJobRequestSchema.parse(message.request);
    const started = performance.now();
    const position = await restoreAnalysisPosition(request.position);
    const restoreMs = performance.now() - started;
    if (position.stateHash !== request.stateHash) throw new Error("state_mismatch");
    if (
      request.context.kind === "cpu" &&
      (position.state.status !== "playing" || position.state.turn !== request.context.side)
    )
      throw new Error("stale_context");
    if (abort.signal.aborted) throw new Error("cancelled");
    const search = performance.now();
    const result = await analyzePosition(
      position,
      {
        codeVersion: settings!.codeVersion,
        modelId: request.modelId,
        timeBudgetMs: Math.max(0, message.budgetMs - restoreMs),
        maxWork: request.budget.maxWork,
        maxDepth: 64,
        width: 3,
        rootWidth: 6,
        extensions: 0,
        candidateCount: 5,
        dangerWork: 0,
        includeAction: request.includeAction,
      },
      { signal: abort.signal, ...(model ? { modelEvaluator: model.asEvaluator() } : {}) },
    );
    if (abort.signal.aborted) throw new Error("cancelled");
    if (
      request.modelId &&
      result.evaluation?.evaluationKind !== "terminal" &&
      (result.model.usedModelId !== request.modelId ||
        result.model.inferenceCount === 0 ||
        result.model.fallbackReason)
    )
      throw new Error("model_not_used");
    const inferenceMs = result.model.inferenceMs ?? 0;
    send({
      type: "done",
      jobId,
      value: {
        result,
        restoreMs,
        searchMs: Math.max(0, performance.now() - search - inferenceMs),
        inferenceMs,
      },
    });
  })()
    .catch((error: unknown) => {
      const code =
        error instanceof AnalysisInputError
          ? "invalid_position"
          : error instanceof Error &&
              ["state_mismatch", "stale_context", "cancelled", "model_not_used"].includes(
                error.message,
              )
            ? error.message
            : "compute_failed";
      send({ type: "done", jobId, value: null, error: code });
    })
    .finally(() => {
      active = null;
    });
});
