import { afterAll, beforeAll, expect, test } from "bun:test";

const token = "test-ai-service-token-at-least-32-characters";
let server: ReturnType<typeof Bun.spawn>;
let baseUrl = "";
beforeAll(async () => {
  server = Bun.spawn(["cargo", "run", "--quiet", "--locked", "-p", "tetraboard-ai-server"], {
    cwd: new URL("..", import.meta.url).pathname,
    env: {
      ...process.env,
      AI_SERVICE_TOKEN: token,
      AI_SERVICE_LISTEN: "127.0.0.1:0",
      AI_SERVICE_CONCURRENCY: "2",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const reader = (server.stdout as ReadableStream<Uint8Array>).getReader();
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done)
      throw Error(
        `AI Service did not start: ${await new Response(server.stderr as ReadableStream).text()}`,
      );
    text += new TextDecoder().decode(value);
    if (text.includes("\n")) break;
  }
  reader.releaseLock();
  baseUrl = `http://${JSON.parse(text.split("\n")[0]).listen}`;
}, 30000);
afterAll(async () => {
  server?.kill("SIGTERM");
  if (server) await server.exited;
});

test("実HTTPのhealthと認証境界を確認する", async () => {
  expect((await fetch(`${baseUrl}/health`)).status).toBe(200);
  expect(
    (
      await fetch(`${baseUrl}/v1/move`, {
        method: "POST",
        body: "{}",
        headers: { "Content-Type": "application/json" },
      })
    ).status,
  ).toBe(401);
});

test("実AI Serviceへ接続したWorkerで完走・再起動・重複・失敗を検証する", async () => {
  const child = Bun.spawn(["bun", "run", "test", "--config", "vitest.ai-service.config.mts"], {
    cwd: new URL("../../../apps/worker", import.meta.url).pathname,
    env: { ...process.env, TETRABOARD_AI_TEST_URL: baseUrl, TETRABOARD_AI_TEST_TOKEN: token },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw Error(`Worker AI Service integration failed\n${stdout}\n${stderr}`);
  console.log(stdout);
  expect(stdout).toContain("passed");
}, 30000);
