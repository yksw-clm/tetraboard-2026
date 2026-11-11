import { expect, test } from "bun:test";
import { checkEngineWarmup, checkProbe, deploymentProbes } from "../scripts/deploymentChecks";

const token = "deployment-test-token-at-least-32-characters";
const probe = deploymentProbes().find((p) => p.game === "reversi")!;
test.each(["shogi", "reversi"] as const)("%sの公開確認でエンジン準備を検証する", async (game) => {
  for (const failure of [false, "http", "body"]) {
    const fetcher = (async (url, init) => {
      expect(String(url)).toBe(`https://ai.example.test/admin/warmup?game=${game}`);
      expect(init?.method).toBe("POST");
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${token}`);
      return Response.json(
        { status: failure === "body" ? "starting" : "ok" },
        { status: failure === "http" ? 503 : 200 },
      );
    }) as typeof fetch;
    const result = checkEngineWarmup("https://ai.example.test", token, game, fetcher);
    if (failure) await expect(result).rejects.toThrow();
    else await result;
  }
});
test("将棋の候補手は文字列で受け取り、文字列化できる配列を受理しない", async () => {
  const shogi = deploymentProbes().find((p) => p.game === "shogi")!;
  const fetcher = (async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    return Response.json({
      ...body,
      engine_version: "yaneuraou-material-faeb37f0",
      best_move: ["7g7f"],
    });
  }) as typeof fetch;
  await expect(checkProbe("http://127.0.0.1:3001", token, shogi, 5000, fetcher)).rejects.toThrow();
});
test.each(["http", "request", "revision", "engine", "level", "illegal"])(
  "公開確認は%sの不一致を失敗にする",
  async (failure) => {
    const fetcher = (async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      const response = {
        request_id: failure === "request" ? crypto.randomUUID() : body.request_id,
        position_revision: failure === "revision" ? "b".repeat(64) : body.position_revision,
        engine_version: failure === "engine" ? "unknown" : "egaroucid-console-7.8.2-0c1b84ef",
        level: failure === "level" ? 4 : 1,
        position: failure === "illegal" ? { x: 0, y: 0 } : { x: 3, y: 2 },
      };
      return Response.json(response, { status: failure === "http" ? 503 : 200 });
    }) as typeof fetch;
    await expect(
      checkProbe("http://127.0.0.1:3001", token, probe, 5000, fetcher),
    ).rejects.toThrow();
  },
);
test("公開確認は認証ヘッダーを使い、期限とリダイレクト拒否を付けて合法手を照合する", async () => {
  const fetcher = (async (_url, init) => {
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${token}`);
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(init?.redirect).toBe("manual");
    const body = JSON.parse(String(init?.body));
    return Response.json({
      ...body,
      engine_version: "egaroucid-console-7.8.2-0c1b84ef",
      position: { x: 3, y: 2 },
    });
  }) as typeof fetch;
  await checkProbe("http://127.0.0.1:3001", token, probe, 5000, fetcher);
});
