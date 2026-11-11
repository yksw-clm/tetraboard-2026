import { aiGames, checkAiDeployment, ensure } from "./deploymentChecks";

const environment = process.argv[2];
ensure(
  environment === "production" || environment === "development",
  "productionまたはdevelopmentを指定してください",
);
const origin = `https://tetraboard-ai-${environment === "production" ? "prod" : "dev"}.chaossi-lab.workers.dev`;
try {
  await checkAiDeployment(
    {
      "four-reversi": origin,
      "four-shogi": origin,
      shogi: origin,
      reversi: origin,
    },
    process.env.AI_SERVICE_TOKEN ?? "",
  );
  console.log(`AI公開確認成功: ${environment} (${aiGames.length}ゲーム)`);
} catch {
  // HTTP実装の例外に含まれ得るリクエストや認証ヘッダーをログへ出しません。
  console.error(`AI公開確認失敗: ${environment}`);
  process.exitCode = 1;
}
