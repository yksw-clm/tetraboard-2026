import { expect, test } from "bun:test";
import { createBackground } from "../src/backgroundService";
import { requestFor, responseFor, continuousRequestFor, progressFor, settle } from "./fixtures";
import type { NativeResponse, ServiceCommand } from "../src/serviceProtocol";
function fixture() {
  const saved: Record<string, unknown> = { token: "local-test-token-with-at-least-32-characters" },
    session: Record<string, unknown> = {},
    revoked: number[] = [],
    requests: { url: string; init?: RequestInit }[] = [];
  const area = (data: Record<string, unknown>) => ({
    get: async (key: string) => ({ [key]: data[key] }),
    set: async (value: object) => {
      Object.assign(data, value);
    },
    remove: async (key: string) => {
      delete data[key];
    },
  });
  let access = "";
  const api = {
    storage: {
      local: {
        ...area(saved),
        setAccessLevel: async (value: { accessLevel: string }) => {
          access = value.accessLevel;
        },
      },
      session: area(session),
    },
    tabs: {
      sendMessage: async (id: number) => {
        revoked.push(id);
      },
      onRemoved: { addListener: () => {} },
    },
  } as unknown as typeof chrome;
  let hold = false;
  let activeRequest: ReturnType<typeof continuousRequestFor> | null = null;
  const responses: ((r: Response) => void)[] = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), init });
    if (init?.method === "POST") {
      if (hold) return new Promise<Response>((resolve) => responses.push(resolve));
      const request = JSON.parse(String(init.body));
      if (request.api_version === 2) {
        activeRequest = request;
        return Response.json(progressFor(request, 0), { status: 202 });
      }
      return Response.json(responseFor(request));
    }
    if (String(url).includes("/v2/analysis/") && init?.method !== "DELETE" && activeRequest)
      return Response.json(progressFor(activeRequest));
    return init?.method === "DELETE"
      ? new Response(null, { status: 204 })
      : Response.json({
          status: "ok",
          analysis_versions: [1, 2],
          games: ["four-reversi", "four-shogi"],
        });
  }) as typeof fetch;
  return {
    api,
    requests,
    revoked,
    session,
    saved,
    responses,
    get access() {
      return access;
    },
    set hold(v: boolean) {
      hold = v;
    },
    create: (native?: (command: ServiceCommand) => Promise<NativeResponse>) =>
      createBackground(api, fetcher, native),
  };
}
const sender = (id: number, url = "https://tetraboard.net/games/four-reversi", frameId = 0) =>
  ({ tab: { id }, url, frameId }) as chrome.runtime.MessageSender;
test("無効なタブでもAIを操作でき、Native tokenは信頼された保存領域だけへ渡す", async () => {
  const f = fixture();
  const calls: ServiceCommand[] = [];
  const token = "a".repeat(64);
  const handle = f.create(async (command) => {
    calls.push(command);
    return { id: crypto.randomUUID(), protocol_version: 1, ok: true, state: "running", token };
  });
  const reply = await handle({ type: "service", command: "start" }, sender(1));
  expect(reply).toEqual({ ok: true, data: { state: "running" } });
  expect(f.saved.token).toBe(token);
  expect(f.access).toBe("TRUSTED_CONTEXTS");
  expect(f.session.activeTabId).toBeUndefined();
  expect(calls).toEqual(["start"]);
  for (const s of [
    sender(1, "https://evil.test/"),
    sender(1, "https://tetraboard.net/rooms/12345", 1),
  ])
    await expect(handle({ type: "service", command: "stop" }, s)).rejects.toThrow();
  await expect(handle({ type: "service", command: "exec" }, sender(1))).rejects.toThrow();
  expect(calls).toEqual(["start"]);
});
test("AI停止前に探索を取り消し、別タブの候補を破棄する", async () => {
  const f = fixture();
  const calls: ServiceCommand[] = [];
  const handle = f.create(async (command) => {
    expect(f.requests.at(-1)?.init?.method).toBe("DELETE");
    calls.push(command);
    return { id: crypto.randomUUID(), protocol_version: 1, ok: true, state: "stopped" };
  });
  await handle({ type: "enable" }, sender(1));
  await handle({ type: "start", request: continuousRequestFor() }, sender(1));
  await handle({ type: "service", command: "stop" }, sender(2));
  expect(calls).toEqual(["stop"]);
  expect(f.revoked).toEqual([1]);
  expect(f.session.activeAnalysis).toBeUndefined();
});
test("手動サービスのtokenをNativeの状態取得で上書きしない", async () => {
  const f = fixture(),
    token = f.saved.token;
  const handle = f.create(async () => ({
    id: crypto.randomUUID(),
    protocol_version: 1,
    ok: true,
    state: "external",
  }));
  expect(await handle({ type: "service", command: "status" }, sender(1))).toEqual({
    ok: true,
    data: { state: "external" },
  });
  expect(f.saved.token).toBe(token);
});
test("SPAの初期URLからでも本人タブを有効化し、最後のタブだけに解析を許す", async () => {
  const f = fixture(),
    handle = f.create();
  await handle({ type: "enable" }, sender(1));
  await handle({ type: "enable" }, sender(2));
  expect(f.revoked).toEqual([1]);
  await expect(handle({ type: "analyze", request: requestFor() }, sender(1))).rejects.toThrow(
    "無効",
  );
  const reply = await handle({ type: "analyze", request: requestFor() }, sender(2));
  expect(reply).toMatchObject({ ok: true });
  expect(f.access).toBe("TRUSTED_CONTEXTS");
  expect(JSON.stringify(reply)).not.toContain("local-test-token");
  expect(f.requests.every((r) => r.url.startsWith("http://127.0.0.1:3002/"))).toBe(true);
});
test("異なるホスト・子フレーム・不正なprofileを解析へ渡さない", async () => {
  const f = fixture(),
    handle = f.create();
  await expect(
    handle({ type: "enable" }, sender(1, "https://evil.test/rooms/12345")),
  ).rejects.toThrow();
  await expect(
    handle({ type: "enable" }, sender(1, "https://tetraboard.net/rooms/12345", 1)),
  ).rejects.toThrow();
  await handle({ type: "enable" }, sender(1));
  await expect(
    handle({ type: "analyze", request: { ...requestFor(), profile_id: "lv6-v1" } }, sender(1)),
  ).rejects.toThrow();
  expect(f.requests).toHaveLength(0);
});
test("旧解析の取消完了後に新解析を開始する", async () => {
  const f = fixture(),
    handle = f.create();
  await handle({ type: "enable" }, sender(1));
  f.hold = true;
  const firstRequest = requestFor(),
    secondRequest = { ...requestFor(), profile_id: "lv6-candidate-a-v1" as const };
  const first = handle({ type: "analyze", request: firstRequest }, sender(1));
  await settle();
  const second = handle({ type: "analyze", request: secondRequest }, sender(1));
  await settle();
  expect(f.requests.map((r) => r.init?.method)).toEqual(["POST", "DELETE", "POST"]);
  expect(f.requests[1].url).toEndWith(firstRequest.request_id);
  expect(JSON.parse(String(f.requests[2].init?.body)).profile_id).toBe("lv6-candidate-a-v1");
  f.responses[0](Response.json(responseFor(firstRequest)));
  f.responses[1](Response.json(responseFor(secondRequest)));
  await Promise.all([first, second]);
});
test("service workerを再生成してもactiveTabを維持し、別タブを拒否する", async () => {
  const f = fixture();
  await f.create()({ type: "enable" }, sender(1));
  const restarted = f.create();
  await expect(restarted({ type: "health" }, sender(2))).rejects.toThrow("無効");
  expect(await restarted({ type: "health" }, sender(1))).toMatchObject({ ok: true });
  await restarted({ type: "disable" }, sender(1));
  expect(f.session.activeTabId).toBeUndefined();
});

test("継続探索はworker再生成後も進捗取得・取消でき、別タブへ引き継ぐ", async () => {
  const f = fixture();
  let handle = f.create();
  await handle({ type: "enable" }, sender(1));
  const request = continuousRequestFor();
  expect(await handle({ type: "start", request }, sender(1))).toMatchObject({ ok: true });
  handle = f.create();
  expect(await handle({ type: "poll", requestId: request.request_id }, sender(1))).toMatchObject({
    ok: true,
  });
  await expect(
    handle({ type: "poll", requestId: request.request_id }, sender(2)),
  ).rejects.toThrow();
  await handle({ type: "enable" }, sender(2));
  expect(f.requests.at(-1)?.url).toEndWith(`/v2/analysis/${request.request_id}`);
  expect(f.requests.at(-1)?.init?.method).toBe("DELETE");
  expect(f.session.activeAnalysis).toBeUndefined();
  expect(f.revoked).toEqual([1]);
  expect(JSON.stringify(f.session)).not.toContain("local-test-token");
});

test("旧サービスのhealthには更新案内を返す", async () => {
  const f = fixture();
  const handle = createBackground(f.api, async () =>
    Response.json({ status: "ok", api_version: 1 }),
  );
  await handle({ type: "enable" }, sender(1));
  await expect(handle({ type: "health" }, sender(1))).rejects.toThrow("更新が必要");
});
