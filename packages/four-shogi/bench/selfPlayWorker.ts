import { generateSelfPlayGame } from "./selfPlayGame";
import { validateGameArtifact } from "./selfPlayInspect";
import { compatibleDataCode, currentDataCode } from "./selfPlayRun";
import type { DataManifest, GameArtifact, GamePlan } from "./selfPlayData";
import { startModelRuntime, type ModelRuntime } from "./modelRuntime";

let started = false;
let finished = false;
let ticket = 0;
let acknowledge: { ticket: number; resolve: () => void } | null = null;
process.on("disconnect", () => process.exit(finished ? 0 : 1));
process.on("message", (message: unknown) => {
  const request = message as {
    type: string;
    ticket?: number;
    manifest: DataManifest;
    plan: GamePlan;
    saved: GameArtifact | null;
    scratch: string;
    modelRuntime?: ModelRuntime;
  };
  if (request.type === "ack" && acknowledge && acknowledge.ticket === request.ticket) {
    const callback = acknowledge.resolve;
    acknowledge = null;
    callback();
    return;
  }
  if (request.type !== "start" || started) return;
  started = true;
  void (async () => {
    compatibleDataCode(currentDataCode(), request.manifest.code);
    if (request.saved) await validateGameArtifact(request.manifest, request.plan, request.saved);
    const model = request.manifest.config.model
      ? await startModelRuntime(request.modelRuntime!, request.manifest.config.model)
      : null;
    if (model?.client.processId)
      process.send?.({ type: "model_process", pid: model.client.processId });
    try {
      await generateSelfPlayGame(
        request.manifest,
        request.plan,
        request.saved,
        (record) =>
          new Promise<void>((resolve) => {
            const id = ++ticket;
            acknowledge = { ticket: id, resolve };
            process.send?.({ type: "checkpoint", ticket: id, record });
          }),
        model ? { modelEvaluator: model.evaluator } : {},
        request.scratch,
      );
    } finally {
      model?.client.close();
    }
    finished = true;
    process.disconnect?.();
    process.exit(0);
  })().catch((error) => {
    const message = String(error?.stack ?? error);
    process.send?.({ type: "error", message });
    process.stderr.write(message + "\n", () => process.exit(1));
  });
});
