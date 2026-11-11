import { aiGames, checkAiDeployment, ensure, type AiGame } from "./deploymentChecks";

const cwd = new URL("..", import.meta.url).pathname;
const token = crypto.randomUUID() + crypto.randomUUID();
const prefix = `tetraboard-ai-check-${crypto.randomUUID()}`;
const containers: string[] = [];
const images = { rust: `${prefix}-rust`, shogi: `${prefix}-shogi`, reversi: `${prefix}-reversi` };
async function docker(args: string[], capture = false): Promise<string> {
  const child = Bun.spawn(["docker", ...args], {
    cwd,
    env: { ...process.env, AI_SERVICE_TOKEN: token },
    stdout: capture ? "pipe" : "inherit",
    stderr: "inherit",
  });
  const output = capture
    ? new Response(child.stdout as ReadableStream).text()
    : Promise.resolve("");
  ensure((await child.exited) === 0, "コンテナイメージ検証のDocker操作が失敗しました");
  return output;
}

try {
  for (const [image, file] of [
    [images.rust, "Dockerfile.four-reversi"],
    [images.shogi, "Dockerfile"],
    [images.reversi, "Dockerfile.reversi"],
  ]) {
    console.log(`イメージをビルド: ${file}`);
    await docker(["build", "--platform", "linux/amd64", "--tag", image!, "--file", file!, "."]);
  }
  const origins = {} as Record<AiGame, string>;
  for (const game of aiGames) {
    const name = `${prefix}-${game}`;
    containers.push(name);
    const image =
      game === "shogi" ? images.shogi : game === "reversi" ? images.reversi : images.rust;
    await docker(
      [
        "run",
        "--detach",
        "--platform",
        "linux/amd64",
        "--name",
        name,
        "--cpus",
        "0.25",
        "--memory",
        "1g",
        "--env",
        "AI_SERVICE_TOKEN",
        "--env",
        "AI_SERVICE_CONCURRENCY=4",
        ...(game === "shogi" ? ["--env", "AI_SHOGI_ENGINE=/usr/local/bin/yaneuraou"] : []),
        ...(game === "reversi" ? ["--env", "AI_REVERSI_ENGINE=/opt/egaroucid/egaroucid"] : []),
        "--publish",
        "127.0.0.1::3001",
        image,
      ],
      true,
    );
    const port = (await docker(["port", name, "3001/tcp"], true)).trim();
    ensure(/^127\.0\.0\.1:\d+$/.test(port), "検証用コンテナの公開先が不正です");
    origins[game] = `http://${port}`;
    let ready = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      try {
        ready = (await fetch(`${origins[game]}/health`, { signal: AbortSignal.timeout(1000) })).ok;
      } catch {
        /* 起動中の接続失敗だけを再試行します。 */
      }
      if (ready) break;
      await Bun.sleep(500);
    }
    ensure(ready, `${game}: コンテナが起動しませんでした`);
  }
  await checkAiDeployment(origins, token, true);
  console.log("本番相当4コンテナの検証成功");
} finally {
  // この実行が作成したものだけを回収し、既存の開発用イメージには触れません。
  for (const name of containers) await docker(["rm", "--force", name], true).catch(() => {});
  for (const image of Object.values(images))
    await docker(["image", "rm", image], true).catch(() => {});
}
