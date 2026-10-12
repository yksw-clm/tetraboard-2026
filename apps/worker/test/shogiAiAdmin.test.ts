import { env } from "cloudflare:workers";
import { afterEach, expect, test, vi } from "vitest";
import { accountFixture, origin } from "./accountFixtures";
import worker from "../src/worker";
import { readAiResponse } from "../src/admin/shogiAiRoutes";
import { signAiRequest } from "@tetraboard/protocol/shogi-ai";
import { aiStatusFixture } from "../../../test-support/shogiAi";
import { AcceptedGameRequest } from "./acceptedGameRequest";
afterEach(() => vi.restoreAllMocks());
const context = { waitUntil: () => {} } as unknown as ExecutionContext;
test("管理者だけが監視APIへ接続でき、秘密値を返さず署名した固定接続先を使います", async () => {
  const owner = await accountFixture(),
    other = await accountFixture();
  const bindings = {
    ...env,
    ADMIN_ACCOUNT_IDS: JSON.stringify([owner.id]),
    SHOGI_AI_API_URL: "https://ai.example.test",
    SHOGI_AI_MONITOR_KEY: "monitor-test-key-at-least-32-characters",
  };
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input),
      headers = new Headers(init?.headers);
    expect(url).toBe("https://ai.example.test/v1/admin/status");
    expect(init?.redirect).toBe("manual");
    expect(headers.get("x-ai-signature")).toBe(
      await signAiRequest(
        bindings.SHOGI_AI_MONITOR_KEY,
        "GET",
        "/v1/admin/status",
        "",
        Number(headers.get("x-ai-at")),
        headers.get("x-ai-nonce")!,
      ),
    );
    return Response.json(aiStatusFixture());
  });
  const call = (cookie?: string) =>
    worker.fetch(
      new AcceptedGameRequest(origin + "/api/admin/four-shogi-ai/status", {
        headers: cookie ? { Cookie: cookie } : {},
      }),
      bindings,
      context,
    );
  expect((await call()).status).toBe(401);
  expect((await call(other.cookie)).status).toBe(403);
  expect(fetchMock).not.toHaveBeenCalled();
  const allowed = await call(owner.cookie);
  expect(allowed.status).toBe(200);
  expect(allowed.headers.get("Cache-Control")).toBe("no-store");
  expect(JSON.stringify(await allowed.json())).not.toContain(bindings.SHOGI_AI_MONITOR_KEY);
  fetchMock.mockResolvedValueOnce(
    new Response(null, { status: 302, headers: { Location: "https://other.example.test" } }),
  );
  const beforeRedirect = fetchMock.mock.calls.length;
  expect((await call(owner.cookie)).status).toBe(503);
  expect(fetchMock.mock.calls.length).toBe(beforeRedirect + 1);
  fetchMock.mockResolvedValueOnce(Response.json({ schemaVersion: 99 }));
  expect((await call(owner.cookie)).status).toBe(503);
  fetchMock.mockRejectedValueOnce(new Error("network"));
  expect((await call(owner.cookie)).status).toBe(503);
});
test("未設定とHTTP外部URLを拒否し、不正な検索と巨大な応答を拒否します", async () => {
  const owner = await accountFixture(),
    bindings = { ...env, ADMIN_ACCOUNT_IDS: JSON.stringify([owner.id]) };
  const fetchMock = vi.spyOn(globalThis, "fetch");
  for (const extras of [
    {},
    { SHOGI_AI_API_URL: "http://unsafe.example.test", SHOGI_AI_MONITOR_KEY: "x".repeat(64) },
  ]) {
    const response = await worker.fetch(
      new AcceptedGameRequest(origin + "/api/admin/four-shogi-ai/status", {
        headers: { Cookie: owner.cookie },
      }),
      { ...bindings, ...extras },
      context,
    );
    expect(response.status).toBe(503);
  }
  expect(fetchMock).not.toHaveBeenCalled();
  const response = await worker.fetch(
    new AcceptedGameRequest(origin + "/api/admin/four-shogi-ai/runs?profileId=invalid", {
      headers: { Cookie: owner.cookie },
    }),
    bindings,
    context,
  );
  expect(response.status).toBe(400);
  await expect(readAiResponse(new Response("x".repeat(256 * 1024 + 1)))).rejects.toThrow("large");
});
