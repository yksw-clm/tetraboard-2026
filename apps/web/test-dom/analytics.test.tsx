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
  stops.push(() => navigate("/"));
  startWebAnalytics(fake as unknown as Parameters<typeof startWebAnalytics>[0]);
  return { navigate, sameLocation: () => notify?.(state) };
}
function foreground() {
  visibility("visible");
  Object.defineProperty(document, "hasFocus", { configurable: true, value: () => true });
}
test("計測はpage/gameだけを送りCookieを再利用し、同一履歴keyは重複せず遷移でview IDを変える", async () => {
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
    r.navigate("/");
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
    first.navigate("/");
    await flush();
    clock.advance(1000);
    await flush();
    clock.advance(30000);
    second.navigate("/");
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
  r.navigate("/");
  await flush();
  expect(requests).toHaveLength(1);
});
