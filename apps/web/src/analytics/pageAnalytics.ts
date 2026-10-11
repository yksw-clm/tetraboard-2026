import {
  analyticsEnabled,
  analyticsPreferenceStorageKey,
  syncAnalyticsPreference,
} from "./preference";
import { gameIds } from "@tetraboard/protocol/games";
import type { router as appRouter } from "../app/router";
import { createUuid } from "../shared/createUuid";
export { createUuid as randomAnalyticsId } from "../shared/createUuid";
export const analyticsCookie = "tetraboard-2026.analytics";
export function ensureAnalyticsCookie() {
  if (!analyticsEnabled()) return false;
  try {
    const existing = document.cookie
      .split(";")
      .map((value) => value.trim())
      .find((value) => value.startsWith(`${analyticsCookie}=`));
    if (!existing)
      document.cookie = `${analyticsCookie}=${createUuid()}; Path=/; Max-Age=31536000; SameSite=Lax${location.protocol === "https:" ? "; Secure" : ""}`;
    return document.cookie.includes(`${analyticsCookie}=`);
  } catch {
    return false;
  }
}
export function splitVisibleTime(days: Map<string, number>, from: number, to: number) {
  for (let at = from; at < to;) {
    const day = new Date(at + 32400000).toISOString().slice(0, 10);
    const end = Math.min(to, Date.parse(`${day}T00:00:00+09:00`) + 86400000);
    days.set(day, (days.get(day) ?? 0) + end - at);
    at = end;
  }
}
function trackPage(page: string, game: string | null) {
  const id = createUuid();
  const days = new Map<string, number>();
  let alive = true;
  let since: number | null = null;
  let release: (() => void) | null = null;
  let requesting = false;
  let registered = false;
  const visitorAtStart = () =>
    document.cookie
      .split(";")
      .find((v) => v.trim().startsWith(`${analyticsCookie}=`))
      ?.trim();
  const visitor = visitorAtStart();
  const permitted = () => analyticsEnabled() && visitor === visitorAtStart();
  const created = fetch("/api/analytics/pageviews", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, page, game }),
    keepalive: true,
  })
    .then((r) => {
      registered = r.ok;
      return registered;
    })
    .catch(() => false);
  function accountTime() {
    const now = Date.now();
    if (since !== null) splitVisibleTime(days, since, now);
    since = since === null ? null : now;
  }
  function flush() {
    if (!permitted()) return;
    accountTime();
    if (!days.size) return;
    const data = {
      id,
      days: [...days]
        .slice(-32)
        .map(([day, milliseconds]) => ({ day, milliseconds: Math.floor(milliseconds) })),
    };
    const send = () =>
      fetch("/api/analytics/dwell", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
        keepalive: true,
      }).catch(() => undefined);
    // 離脱時も、登録済みのビューはその場でkeepaliveリクエストを開始します。
    if (registered) void send();
    else
      void created.then((ok) => {
        if (ok && permitted()) return send();
      });
  }
  function relinquish() {
    if (since !== null) flush();
    since = null;
    release?.();
    release = null;
  }
  function update() {
    if (!permitted()) {
      relinquish();
      if (alive && analyticsEnabled()) window.dispatchEvent(new Event("analytics-choice"));
      return;
    }
    if (!alive || document.visibilityState !== "visible" || !document.hasFocus()) {
      relinquish();
      return;
    }
    if (since !== null || requesting) return;
    if (!navigator.locks) {
      since = Date.now();
      return;
    }
    requesting = true;
    void navigator.locks
      .request("tetraboard-visible-analytics", { ifAvailable: true }, async (lock) => {
        requesting = false;
        if (
          !lock ||
          !alive ||
          !permitted() ||
          document.visibilityState !== "visible" ||
          !document.hasFocus()
        )
          return;
        since = Date.now();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      })
      .catch(() => {
        requesting = false;
      });
  }
  const heartbeat = window.setInterval(() => {
    if (since !== null) flush();
  }, 30000);
  const lease = window.setInterval(update, 1000);
  document.addEventListener("visibilitychange", update);
  window.addEventListener("focus", update);
  window.addEventListener("blur", update);
  window.addEventListener("pagehide", relinquish);
  window.addEventListener("pageshow", update);
  update();
  return () => {
    alive = false;
    relinquish();
    clearInterval(heartbeat);
    clearInterval(lease);
    document.removeEventListener("visibilitychange", update);
    window.removeEventListener("focus", update);
    window.removeEventListener("blur", update);
    window.removeEventListener("pagehide", relinquish);
    window.removeEventListener("pageshow", update);
  };
}
export function startWebAnalytics(router: typeof appRouter) {
  let previous = "";
  let stop: (() => void) | undefined;
  function changed(state: typeof router.state) {
    if (!state.initialized || state.navigation.state !== "idle" || state.location.key === previous)
      return;
    previous = state.location.key;
    stop?.();
    stop = undefined;
    const path = state.location.pathname;
    if (
      !analyticsEnabled() ||
      ["/privacy", "/terms"].includes(path) ||
      path === "/" ||
      /^\/admin(?:\/|$)/.test(path) ||
      !ensureAnalyticsCookie()
    )
      return;
    const data = Object.values(state.loaderData) as {
      room?: { settings: { game: string } };
      match?: { settings: { game: string } };
    }[];
    const detail = data.find((value) => value?.room || value?.match);
    const game =
      gameIds.find((id) => path.includes(id)) ??
      detail?.room?.settings.game ??
      detail?.match?.settings.game ??
      null;
    const page = path.startsWith("/games/")
      ? "lobby"
      : path.startsWith("/rooms/")
        ? "room"
        : path.startsWith("/account/matches/") || path.startsWith("/matches/")
          ? "replay"
          : path === "/account/setup"
            ? "setup"
            : path === "/login"
              ? "login"
              : path === "/account"
                ? "account"
                : "other";
    // 取得失敗時には、ゲームが不明なルームや棋譜をゲーム別の訪問に混ぜません。
    if (["room", "replay"].includes(page) && !game) return;
    stop = trackPage(page, game);
  }
  window.addEventListener("analytics-choice", () => {
    previous = "";
    changed(router.state);
  });
  window.addEventListener("storage", (event) => {
    if (event.key !== analyticsPreferenceStorageKey) return;
    syncAnalyticsPreference();
    previous = "";
    changed(router.state);
  });
  router.subscribe(changed);
  changed(router.state);
}
