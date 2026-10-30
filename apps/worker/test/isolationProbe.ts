import { env, runInDurableObject } from "cloudflare:test";
import { expect, test } from "vitest";

test("同じD1主キー・DO ID・R2キーを並行利用しても別プロセスの保存を読まない", async () => {
  const marker = crypto.randomUUID();
  await env.APP_DB.prepare("CREATE TABLE ci_isolation (id TEXT PRIMARY KEY, marker TEXT)").run();
  await env.APP_DB.prepare("INSERT INTO ci_isolation VALUES ('same-key', ?)").bind(marker).run();
  const stub = env.GAME_ROOM.getByName("ci-isolation-same-object");
  await runInDurableObject(stub, async (_instance, state) => {
    await state.storage.put("ci-isolation", marker);
  });
  await env.OBJECT_STORAGE.put("ci-isolation", marker);
  // 両プロセスの書込みが終わるまで待ち、実時間sleepで並行を推定しません。
  const url = (env as typeof env & { CI_ISOLATION_BARRIER: string }).CI_ISOLATION_BARRIER;
  expect((await fetch(url, { method: "POST" })).status).toBe(204);
  expect(await env.APP_DB.prepare("SELECT marker FROM ci_isolation").first("marker")).toBe(marker);
  expect(
    await runInDurableObject(stub, (_instance, state) => state.storage.get("ci-isolation")),
  ).toBe(marker);
  expect(await (await env.OBJECT_STORAGE.get("ci-isolation"))!.text()).toBe(marker);
});
