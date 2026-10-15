import { resolve } from "node:path";
import { restoreAnalysisPosition } from "../src/analysis";
import { ModelInferenceClient } from "../src/modelInference";

const [python, model, fixture] = process.argv.slice(2);
if (!python || !model || !fixture) throw new Error("Python・推論配布物・fixtureのパスが必要です");
const positions = await Promise.all(
  [false, true].map((restricted) =>
    restoreAnalysisPosition({
      schemaVersion: 1,
      ruleProfileId: "tetraboard-four-shogi-singles-v1",
      rulesVersion: 1,
      initial: {
        mode: "singles",
        players: { south: "s", west: "w", north: "n", east: "e" },
        threePlayerAttackProhibited: restricted,
      },
      events: [],
    }),
  ),
);
const started = performance.now();
const client = await ModelInferenceClient.start([
  python,
  resolve(import.meta.dir, "../../../training/four-shogi-ai/inference.py"),
  "serve",
  "--model",
  resolve(model),
  "--fixture",
  resolve(fixture),
]);
try {
  const startupMs = performance.now() - started;
  const times = [];
  let outputs;
  for (let i = 0; i < 30; i++) {
    const before = performance.now();
    outputs = await client.evaluate(positions);
    times.push(performance.now() - before);
  }
  console.log(
    JSON.stringify(
      {
        health: client.loadedModel,
        runtime: { bun: Bun.version, platform: process.platform, arch: process.arch },
        startupMs,
        batchSize: 2,
        iterations: times.length,
        meanRoundTripMs: times.reduce((a, b) => a + b, 0) / times.length,
        maxRoundTripMs: Math.max(...times),
        outputs,
      },
      null,
      2,
    ),
  );
} finally {
  client.close();
}
