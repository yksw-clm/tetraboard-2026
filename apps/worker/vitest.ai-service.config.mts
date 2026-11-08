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
  MATCHMAKING_ENABLED: "true",
  AI_SERVICE_TOKEN: token,
  AI_SERVICE_TIMEOUT_MS: cloud ? "5000" : "2000",
});
export default { ...base, test: { ...base.test, include: ["test-ai-service/**/*.test.ts"] } };
