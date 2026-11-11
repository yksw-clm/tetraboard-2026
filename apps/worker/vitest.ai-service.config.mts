import { workerTestConfig } from "./vitest.config.mts";

const url = process.env.TETRABOARD_AI_TEST_URL;
const token = process.env.TETRABOARD_AI_TEST_TOKEN;
const cloud = process.env.TETRABOARD_AI_TEST_CLOUD === "1";
const allowed =
  url &&
  (url.startsWith("http://127.0.0.1:") ||
    (cloud && url === "https://tetraboard-ai-validation.chaossi-lab.workers.dev"));
if (!allowed || !token)
  throw new Error(
    "AI Service比較テスト用のloopback URL、または明示したクラウド検証先とtokenが必要です",
  );
const base = workerTestConfig({
  AI_SERVICE_URL: url,
  AI_REVERSI_ENABLED: process.env.TETRABOARD_REVERSI_TEST_REAL === "1" ? "true" : "false",
  AI_SHOGI_ENABLED: process.env.TETRABOARD_SHOGI_TEST_REAL === "1" ? "true" : "false",
  MATCHMAKING_ENABLED: "true",
  FOUR_SHOGI_MATCHMAKING_ENABLED: "true",
  FOUR_SHOGI_DIAGNOSTICS: "true",
  FOUR_PLAYER_AI_WARMUP_ENABLED: process.env.TETRABOARD_AI_TEST_WARMUP === "1" ? "true" : "false",
  AI_SERVICE_TOKEN: token,
  AI_SERVICE_TIMEOUT_MS: cloud ? "5000" : "2000",
});
export default { ...base, test: { ...base.test, include: ["test-ai-service/**/*.test.ts"] } };
