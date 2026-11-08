import { expect, test } from "bun:test";
import { createBackground } from "../src/backgroundService";
import { requestFor, responseFor, settle } from "./fixtures";
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
  const responses: ((r: Response) => void)[] = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), init });
    if (init?.method === "POST") {
      if (hold) return new Promise<Response>((resolve) => responses.push(resolve));
      return Response.json(responseFor(JSON.parse(String(init.body))));
    }
    return init?.method === "DELETE"
      ? new Response(null, { status: 204 })
      : Response.json({ status: "ok" });
  }) as typeof fetch;
  return {
    api,
    requests,
    revoked,
    session,
    responses,
    get access() {
      return access;
    },
    set hold(v: boolean) {
      hold = v;
    },
    create: () => createBackground(api, fetcher),
  };
}
const sender = (id: number, url = "https://tetraboard.net/games/four-reversi", frameId = 0) =>
  ({ tab: { id }, url, frameId }) as chrome.runtime.MessageSender;
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
    secondRequest = requestFor();
  const first = handle({ type: "analyze", request: firstRequest }, sender(1));
  await settle();
  const second = handle({ type: "analyze", request: secondRequest }, sender(1));
  await settle();
  expect(f.requests.map((r) => r.init?.method)).toEqual(["POST", "DELETE", "POST"]);
  expect(f.requests[1].url).toEndWith(firstRequest.request_id);
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
