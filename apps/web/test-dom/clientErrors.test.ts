import { afterEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { startClientErrors } from "../src/shared/clientErrors";

const windows: Window[] = [];
afterEach(async () => {
  await Promise.all(windows.splice(0).map((target) => target.happyDOM.close()));
});

function browser(path = "/") {
  const target = new Window({ url: `https://tetraboard.test${path}` });
  windows.push(target);
  const beacon = mock((_url: string, _body: Blob) => true);
  const fetch = mock((_url: string, _init: RequestInit) =>
    Promise.resolve(new Response(null, { status: 204 })),
  );
  Object.defineProperty(target.navigator, "sendBeacon", { configurable: true, value: beacon });
  Object.defineProperty(target, "fetch", { configurable: true, value: fetch });
  let now = 0;
  Object.defineProperty(target.performance, "now", { value: () => now });
  const start = () => startClientErrors(target as unknown as globalThis.Window);
  start();
  return {
    target,
    beacon,
    fetch,
    start,
    advance(ms: number) {
      now += ms;
    },
    error(message: string, name = "TypeError", filename = "https://tetraboard.test/assets/app.js") {
      target.dispatchEvent(
        new target.ErrorEvent("error", {
          message,
          filename,
          error: { name, message, stack: "STACK username chat invite-token" },
        }),
      );
    },
    reject(reason: unknown) {
      const event = new target.Event("unhandledrejection");
      Object.defineProperty(event, "reason", { value: reason });
      target.dispatchEvent(event);
    },
    async payload(index = 0) {
      return JSON.parse(await beacon.mock.calls[index]![1].text());
    },
  };
}

test.each([
  ["/", "general-lobby"],
  ["/games/four-reversi", "lobby"],
  ["/rooms/12345", "room"],
  ["/matches/example", "replay"],
  ["/account/matches/example", "replay"],
  ["/account/setup", "setup"],
  ["/login", "login"],
  ["/account", "account"],
  ["/feedback", "other"],
  ["/games", "other"],
  ["/account/setup/", "other"],
])("%s のエラーには画面の種類 %s だけを付ける", async (path, page) => {
  const client = browser(`${path}?invite=SECRET#SECRET`);
  client.error("Cannot read property");
  expect(client.beacon.mock.calls[0]![0]).toBe("/api/client-errors");
  expect(client.beacon.mock.calls[0]![1].type.split(";")[0]).toBe("application/json");
  expect(await client.payload()).toEqual({
    page,
    kind: "TypeError",
    message: "Cannot read property",
  });
});

test.each([
  ["Failed https://example.org/app.js?token=SECRET#SECRET", "Failed https://example.org/app.js"],
  [
    "(http://example.org/a#SECRET) and https://example.org/b?q=SECRET",
    "(http://example.org/a and https://example.org/b",
  ],
  ["'//example.org/a?invite=SECRET'", "'//example.org/a'"],
  ["https://example.org/a#SECRET?token=SECRET", "https://example.org/a"],
  ["https://example.org/a?token=[SECRET](SECRET)", "https://example.org/a"],
])("メッセージのURLからクエリとフラグメントを除く: %s", async (message, expected) => {
  const client = browser();
  client.error(message);
  expect((await client.payload()).message).toBe(expected);
});

test("URLの秘密値を除いてから先頭200文字にし、スタックを送らない", async () => {
  const client = browser();
  const prefix = "Failed https://example.org/a";
  client.error(`${prefix}?token=${"SECRET".repeat(100)} ${"あ😀".repeat(200)}`);
  const data = await client.payload();
  expect(data.message).toBe(
    Array.from(`${prefix} ${"あ😀".repeat(200)}`)
      .slice(0, 200)
      .join(""),
  );
  expect(Array.from(data.message)).toHaveLength(200);
  expect(JSON.stringify(data)).not.toMatch(/SECRET|STACK|username|chat|invite-token/);
});

test("名前がない例外はError、Promiseの拒否は理由のmessageだけを送る", async () => {
  const client = browser();
  client.error("no name", "");
  client.reject(new Error("rejected https://example.org/a?token=SECRET#SECRET"));
  client.reject("string rejection");
  client.reject({ username: "SECRET", chat: "SECRET", token: "SECRET" });
  expect(await client.payload()).toEqual({
    page: "general-lobby",
    kind: "Error",
    message: "no name",
  });
  expect(await client.payload(1)).toEqual({
    page: "general-lobby",
    kind: "UnhandledRejection",
    message: "rejected https://example.org/a",
  });
  expect((await client.payload(2)).message).toBe("string rejection");
  expect((await client.payload(3)).message).toBe("");
});

test("直近1分で10件に抑え、期限を過ぎた分だけ送信枠を戻す", () => {
  const client = browser();
  client.error("first");
  client.advance(1000);
  for (let i = 0; i < 9; i++) client.error(`error ${i}`);
  client.error("limited");
  client.advance(58999);
  client.error("limited");
  expect(client.beacon).toHaveBeenCalledTimes(10);
  client.advance(1);
  client.error("limited");
  client.error("next");
  expect(client.beacon).toHaveBeenCalledTimes(11);
  client.advance(1000);
  client.error("next");
  expect(client.beacon).toHaveBeenCalledTimes(12);
});

test("同じkindと送信メッセージは画面遷移や1分経過後も再送しない", async () => {
  const client = browser();
  client.start();
  client.error("Failed https://example.org/a?token=one");
  client.error("Failed https://example.org/a?token=two");
  client.advance(60000);
  client.target.location.pathname = "/account";
  client.error("Failed https://example.org/a?token=three");
  client.error("Failed https://example.org/a?token=four", "RangeError");
  expect(client.beacon).toHaveBeenCalledTimes(2);
  expect((await client.payload(1)).page).toBe("account");
});

test("外部スクリプト・拡張機能・Script error.は送らず、送信枠も消費しない", () => {
  const client = browser();
  for (const filename of [
    "https://example.org/app.js",
    "https://tetraboard.test.example.org/app.js",
    "http://tetraboard.test/app.js",
    "chrome-extension://id/app.js",
    "moz-extension://id/app.js",
    "invalid URL",
  ])
    client.error("external", "Error", filename);
  client.error("Script error.");
  client.reject("Script error.");
  expect(client.beacon).not.toHaveBeenCalled();
  for (let i = 0; i < 10; i++) client.error(`own ${i}`);
  expect(client.beacon).toHaveBeenCalledTimes(10);
});

test("sendBeaconがなければPOSTとkeepaliveで送り、失敗を未処理にしない", async () => {
  const client = browser("/rooms/12345");
  Object.defineProperty(client.target.navigator, "sendBeacon", { value: undefined });
  client.fetch.mockImplementationOnce(() => Promise.reject(new Error("offline")));
  expect(() => client.error("first")).not.toThrow();
  await Promise.resolve();
  expect(client.fetch.mock.calls[0]).toEqual([
    "/api/client-errors",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      keepalive: true,
      body: JSON.stringify({ page: "room", kind: "TypeError", message: "first" }),
    },
  ]);
  client.fetch.mockImplementationOnce(() => {
    throw new Error("blocked");
  });
  expect(() => client.error("second")).not.toThrow();
  expect(client.beacon).not.toHaveBeenCalled();
});

test("sendBeaconの失敗やfalseは無視し、同じエラーを再送しない", () => {
  const client = browser();
  client.beacon.mockImplementationOnce(() => {
    throw new Error("blocked");
  });
  expect(() => client.error("first")).not.toThrow();
  client.error("first");
  client.beacon.mockImplementationOnce(() => false);
  expect(() => client.reject("second")).not.toThrow();
  expect(client.beacon).toHaveBeenCalledTimes(2);
  expect(client.fetch).not.toHaveBeenCalled();
});
