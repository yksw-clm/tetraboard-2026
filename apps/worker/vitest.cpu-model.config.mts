import { workerTestConfig } from "./vitest.config.mts";
const bindings: Record<string, string> = {};
for (const key of [
  "AI_CPU_SMOKE_URL",
  "AI_CPU_SMOKE_SECRET",
  "AI_CPU_SMOKE_MODEL_ID",
  "AI_CPU_SMOKE_CODE_VERSION",
]) {
  const value = process.env[key];
  if (!value) throw new Error("実モデルCPU検証には " + key + " が必要です");
  bindings[key] = value;
}
const config = workerTestConfig(bindings);
config.test = {
  ...config.test,
  include: ["test/fourShogiAiCpu.test.ts"],
  testNamePattern: "実モデルCPU",
};
export default config;
