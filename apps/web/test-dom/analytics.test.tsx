import { afterEach, expect, test } from "bun:test";
import { analyticsCookie, startWebAnalytics } from "../src/analytics/pageAnalytics";
import { clock, flush, requests } from "./harness";

const stops: (() => void)[] = [];
afterEach(() => {
  stops.splice(0).forEach((stop) => stop());
});
function visibility(value: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { configurable: true, value });
  document.dispatchEvent(new Event("visibilitychange"));
}
function router(pathname: string) {
  const state = {
    initialized: true,
    navigation: { state: "idle" },
    location: { key: crypto.randomUUID(), pathname, search: "?invite=SECRET&token=SECRET" },
    loaderData: { room: { room: { settings: { game: "four-shogi" } } } },
  };
  let notify: ((nextState: typeof state) => void) | undefined;
  const fake = {
    state,
    subscribe(fn: typeof notify) {
      notify = fn;
    },
  };
  function navigate(path: string) {
    state.location = { ...state.location, key: crypto.randomUUID(), pathname: path };
    notify?.(state);
  }
  stops.push(() => navigate("/privacy"));
  startWebAnalytics(fake as unknown as Parameters<typeof startWebAnalytics>[0]);
  return { navigate, sameLocation: () => notify?.(state) };
}
function foreground() {
  visibility("visible");
  Object.defineProperty(document, "hasFocus", { configurable: true, value: () => true });
}
test("計測は許可した付加情報とpage/gameを送りCookieを再利用し、同一履歴keyは重複しない", async () => {
  foreground();
  const r = router("/rooms/12345");
  expect(JSON.parse(String(requests[0]!.init.body))).toMatchObject({
    page: "room",
    game: "four-shogi",
  });
  expect(requests[0]!.init.keepalive).toBe(true);
  expect(requests[0]!.init.body).not.toContain("SECRET");
  expect(document.cookie).toContain(analyticsCookie);
  const first = JSON.parse(String(requests[0]!.init.body)),
    cookie = document.cookie;
  requests[0]!.respond(null, 204);
  await flush();
  r.sameLocation();
  expect(requests).toHaveLength(1);
  r.navigate("/games/four-reversi");
  expect(JSON.parse(String(requests.at(-1)!.init.body))).toMatchObject({
    page: "lobby",
    game: "four-reversi",
  });
  expect(JSON.parse(String(requests.at(-1)!.init.body)).id).not.toBe(first.id);
  expect(document.cookie).toBe(cookie);
});
test("旧Workerへのロールバック時は同じ閲覧IDの旧形式で一度だけ再試行する", async () => {
  foreground();
  const r = router("/games/four-shogi");
  const first = JSON.parse(String(requests[0]!.init.body));
  expect(first.acquisition).toBeDefined();
  requests[0]!.respond({}, 400);
  await flush();
  expect(requests).toHaveLength(2);
  expect(JSON.parse(String(requests[1]!.init.body))).toEqual({
    id: first.id,
    page: first.page,
    game: first.game,
  });
  requests[1]!.respond(null, 204);
  await flush();
  clock.advance(30000);
  expect(requests.at(-1)!.url).toContain("dwell");
  r.navigate("/privacy");
});
test("documentの外部参照元をSPA内の次の閲覧へ持ち越さず、ストレージへ識別子を追加しない", async () => {
  foreground();
  const descriptor = Object.getOwnPropertyDescriptor(document, "referrer");
  Object.defineProperty(document, "referrer", {
    configurable: true,
    value: "https://www.google.com/search?q=SECRET",
  });
  const localKeys = Object.keys(localStorage),
    sessionKeys = Object.keys(sessionStorage);
  try {
    const r = router("/games/four-shogi");
    expect(JSON.parse(String(requests[0]!.init.body)).acquisition.referrer).toBe("www.google.com");
    requests[0]!.respond(null, 204);
    await flush();
    r.navigate("/games/four-reversi");
    expect(JSON.parse(String(requests.at(-1)!.init.body)).acquisition.referrer).toBe("internal");
    expect(Object.keys(localStorage)).toEqual(localKeys);
    expect(Object.keys(sessionStorage)).toEqual(sessionKeys);
  } finally {
    if (descriptor) Object.defineProperty(document, "referrer", descriptor);
    else Reflect.deleteProperty(document, "referrer");
  }
});
test("30秒heartbeatと離脱時keepaliveを送り、非表示中の時間を加算しない", async () => {
  foreground();
  const locks = Object.getOwnPropertyDescriptor(navigator, "locks");
  Object.defineProperty(navigator, "locks", { configurable: true, value: undefined });
  try {
    const r = router("/games/four-shogi");
    requests[0]!.respond(null, 204);
    await flush();
    clock.advance(29999);
    expect(requests).toHaveLength(1);
    clock.advance(1);
    expect(JSON.parse(String(requests[1]!.init.body)).days[0].milliseconds).toBe(30000);
    visibility("hidden");
    const count = requests.length;
    clock.advance(60000);
    expect(requests).toHaveLength(count);
    visibility("visible");
    clock.advance(2000);
    r.navigate("/privacy");
    expect(JSON.parse(String(requests.at(-1)!.init.body)).days[0].milliseconds).toBe(32000);
    expect(requests.at(-1)!.init.keepalive).toBe(true);
  } finally {
    if (locks) Object.defineProperty(navigator, "locks", locks);
    else Reflect.deleteProperty(navigator, "locks");
  }
});
test("偽のLock主体間で滞在時間を排他し、終了後に次の主体が引き継ぐ", async () => {
  foreground();
  let held = false;
  const descriptor = Object.getOwnPropertyDescriptor(navigator, "locks");
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: {
      request: async (
        _name: string,
        options: { ifAvailable: boolean },
        callback: (lock: object | null) => Promise<void>,
      ) => {
        expect(options.ifAvailable).toBe(true);
        if (held) return callback(null);
        held = true;
        try {
          await callback({});
        } finally {
          held = false;
        }
      },
    },
  });
  try {
    const first = router("/games/four-shogi"),
      second = router("/games/four-shogi");
    requests[0]!.respond(null, 204);
    requests[1]!.respond(null, 204);
    await flush();
    clock.advance(30000);
    expect(requests.filter((r) => r.url.endsWith("dwell"))).toHaveLength(1);
    first.navigate("/privacy");
    await flush();
    clock.advance(1000);
    await flush();
    clock.advance(30000);
    second.navigate("/privacy");
    await flush();
    expect(requests.filter((r) => r.url.endsWith("dwell")).at(-1)!.init.body).toContain("30000");
  } finally {
    if (descriptor) Object.defineProperty(navigator, "locks", descriptor);
    else Reflect.deleteProperty(navigator, "locks");
  }
});
test("計測API失敗は例外にせず、view登録前にdwellを送信しない", async () => {
  foreground();
  const r = router("/games/four-reversi");
  clock.advance(30000);
  expect(requests).toHaveLength(1);
  requests[0]!.respond({}, 503);
  await flush();
  expect(requests).toHaveLength(1);
  r.navigate("/privacy");
  await flush();
  expect(requests).toHaveLength(1);
});

test("旧選択Cookieが残っていても計測し、規約ページだけでは計測IDを発行しない", async () => {
  foreground();
  document.cookie = "tetraboard-2026.analytics-choice=off; Path=/";
  document.cookie =
    "tetraboard-2026.analytics=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT";
  const r = router("/privacy");
  expect(requests).toHaveLength(0);
  expect(document.cookie).not.toContain(`${analyticsCookie}=`);
  r.navigate("/terms");
  expect(requests).toHaveLength(0);
  r.navigate("/games/four-reversi");
  expect(requests).toHaveLength(1);
  expect(document.cookie).toContain(`${analyticsCookie}=`);
  requests[0]!.respond(null, 204);
  await flush();
  clock.advance(30000);
  expect(JSON.parse(String(requests.at(-1)!.init.body)).days[0].milliseconds).toBe(30000);
  r.navigate("/privacy");
  document.cookie =
    "tetraboard-2026.analytics-choice=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT";
});

test("総合ロビーはサービス全体の閲覧として計測し、ゲームを指定しない", () => {
  foreground();
  router("/");
  expect(JSON.parse(String(requests[0]!.init.body))).toMatchObject({
    page: "general-lobby",
    game: null,
  });
});
