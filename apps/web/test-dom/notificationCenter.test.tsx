import { expect, test } from "bun:test";
import { StrictMode } from "react";
import { Routes, Route } from "react-router";
import { AppHeader } from "../src/shared/ui/AppHeader";
import { NotificationProvider } from "../src/features/notifications/NotificationProvider";
import { UpdateDetailPage } from "../src/features/updates/UpdatesPage";
import { useNotificationCenter } from "../src/features/notifications/NotificationContext";
import { profile } from "../test/fixtures/account";
import type { Notification } from "@tetraboard/protocol";
import { act, clock, flush, press, render, rerender, requests, wrap } from "./harness";
const announcement = (id = 1): Notification => ({
  id,
  createdAtMs: 1780000000000,
  kind: "announcement",
  read: false,
  legacy: false,
  announcement: {
    id: `article-${id}`,
    title: `更新情報${id}`,
    body: "お知らせの本文",
    date: "2026-11-07",
  },
});
const page = (
  notifications: Notification[],
  nextCursor: string | null = null,
  upperBound = notifications[0]?.id ?? 0,
) => ({ notifications, nextCursor, upperBound });
function Header() {
  return <AppHeader homeTo="/" homeLabel="ホーム" />;
}
function mounted(user: typeof profile | null = profile) {
  return render(
    wrap(user)(
      <NotificationProvider>
        <Header />
      </NotificationProvider>,
    ),
  );
}
async function respond(index: number, body: unknown, status = 200) {
  requests[index]!.respond(body, status);
  await flush();
}
function bell() {
  return document.querySelector<HTMLButtonElement>(
    'button[aria-haspopup="dialog"][aria-label^="お知らせ"]',
  )!;
}
function dialog() {
  return document.querySelector<HTMLElement>('[role="dialog"]')!;
}

test("共通ヘッダーの設定直前にベルを置き、開いただけでは既読にしない", async () => {
  mounted();
  expect(requests[0]!.url).toBe("/api/account/notifications/unread");
  await respond(0, { hasUnread: true, upperBound: 1 });
  expect(bell().getAttribute("aria-label")).toBe("お知らせ（未読あり）");
  expect(bell().nextElementSibling?.getAttribute("aria-label")).toBe("表示・サウンド設定");
  act(() => bell().click());
  await flush();
  await respond(1, page([announcement()]));
  expect(dialog().textContent).toContain("更新情報1");
  expect(dialog().textContent).toContain("未読");
  expect(dialog().textContent).toContain("運営からのお知らせ");
  expect(requests.some((r) => r.url === "/api/account/notifications/read")).toBe(false);
  const refresh = dialog().querySelector<HTMLButtonElement>('[aria-label="お知らせを更新"]')!;
  expect(refresh.textContent).toBe("");
  await respond(2, { hasUnread: true, upperBound: 1 });
  act(() => refresh.click());
  await flush();
  expect(requests[3]!.url).toBe("/api/notifications");
  expect(refresh.disabled).toBe(true);
  await respond(3, page([announcement()]));
  expect(refresh.disabled).toBe(false);
});

test("詳細取得・描画が成功してから既読を記録し、一覧に戻って保持する", async () => {
  mounted();
  await respond(0, { hasUnread: true, upperBound: 1 });
  act(() => bell().click());
  await flush();
  await respond(1, page([announcement()]));
  await respond(2, { hasUnread: true, upperBound: 1 });
  const row = [...dialog().querySelectorAll("button")].find((b) =>
    b.textContent?.includes("更新情報1"),
  )!;
  act(() => row.click());
  await flush();
  expect(requests[3]!.url).toBe("/api/notifications/1");
  expect(requests.some((r) => r.url.endsWith("/read"))).toBe(false);
  await respond(3, announcement());
  expect(dialog().textContent).toContain("お知らせの本文");
  expect(requests[4]!.url).toBe("/api/account/notifications/read");
  expect(JSON.parse(String(requests[4]!.init.body))).toEqual({ id: 1 });
  await respond(4, { ok: true });
  await respond(5, { hasUnread: false, upperBound: 1 });
  const back = dialog().querySelector<HTMLButtonElement>('[aria-label="一覧に戻る"]')!;
  expect(back.textContent).toBe("");
  act(() => back.click());
  await flush();
  act(() => clock.advance(20));
  expect(document.activeElement?.textContent).toContain("更新情報1");
  expect(dialog().textContent).toContain("更新情報1");
  expect(dialog().textContent).not.toContain("未読");
  act(() => dialog().querySelector<HTMLButtonElement>('[aria-label="閉じる"]')!.click());
  await flush();
  act(() => clock.advance(20));
  expect(document.activeElement).toBe(bell());
});

test("追加取得失敗でも既存項目を残し、再試行とまとめて既読に取得済み上限を使う", async () => {
  mounted();
  await respond(0, { hasUnread: true, upperBound: 30 });
  act(() => bell().click());
  await flush();
  await respond(1, page([announcement(30)], "30", 30));
  await respond(2, { hasUnread: true, upperBound: 30 });
  press(dialog(), "もっと見る");
  await flush();
  await respond(3, {}, 503);
  expect(dialog().textContent).toContain("更新情報30");
  expect(dialog().textContent).toContain("取得できません");
  press(dialog(), "再試行");
  await flush();
  expect(requests[4]!.url).toBe("/api/notifications?cursor=30");
  await respond(4, page([announcement(29)], null, 31));
  press(dialog(), "すべて既読にする");
  await flush();
  expect(JSON.parse(String(requests[5]!.init.body))).toEqual({ through: 31 });
  await respond(5, { ok: true });
  await respond(6, { hasUnread: true, upperBound: 32 });
  expect(bell().getAttribute("aria-label")).toContain("未読あり");
  expect(dialog().textContent).not.toContain("未読");
});

test("表示成功前の詳細失敗では既読にせず、更新失敗でも赤丸を維持する", async () => {
  mounted();
  await respond(0, { hasUnread: true, upperBound: 1 });
  act(() => bell().click());
  await flush();
  await respond(1, page([announcement()]));
  await respond(2, {}, 503);
  const row = [...dialog().querySelectorAll("button")].find((b) =>
    b.textContent?.includes("更新情報1"),
  )!;
  act(() => row.click());
  await flush();
  await respond(3, {}, 404);
  expect(requests.some((r) => r.url.endsWith("/read"))).toBe(false);
  expect(dialog().textContent).toContain("詳細を取得できません");
  expect(bell().getAttribute("aria-label")).toContain("未読あり");
});

test("匿名は初回基準と既読をブラウザに保存し、別タブと同期する", async () => {
  mounted(null);
  await respond(0, page([announcement(5)]));
  expect(bell().getAttribute("aria-label")).toBe("お知らせ");
  act(() => clock.advance(30_000));
  await flush();
  await respond(1, page([announcement(6), announcement(5)]));
  expect(bell().getAttribute("aria-label")).toContain("未読あり");
  localStorage.setItem("tetraboard:notification-reads", JSON.stringify({ through: 6, ids: [] }));
  act(() => window.dispatchEvent(new Event("storage")));
  await flush();
  await respond(2, page([announcement(6)]));
  expect(bell().getAttribute("aria-label")).toBe("お知らせ");
});

test("30秒の更新は非表示中に停止し、表示復帰時に取得する", async () => {
  mounted();
  await respond(0, { hasUnread: false, upperBound: 0 });
  const descriptor = Object.getOwnPropertyDescriptor(document, "visibilityState");
  try {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    act(() => clock.advance(60_000));
    await flush();
    expect(requests.length).toBe(1);
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    await flush();
    expect(requests.length).toBe(2);
  } finally {
    if (descriptor) Object.defineProperty(document, "visibilityState", descriptor);
    else Reflect.deleteProperty(document, "visibilityState");
  }
});

test("本人切替では詳細と赤丸を即時に隠し、古い応答を破棄する", async () => {
  const view = mounted();
  await respond(0, { hasUnread: true, upperBound: 1 });
  act(() => bell().click());
  await flush();
  await respond(1, page([announcement()]));
  const old = requests[2]!;
  rerender(
    view,
    wrap(null)(
      <NotificationProvider>
        <Header />
      </NotificationProvider>,
    ),
  );
  await flush();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(bell().getAttribute("aria-label")).toBe("お知らせ");
  old.respond({ hasUnread: true, upperBound: 1 });
  await flush();
  expect(bell().getAttribute("aria-label")).toBe("お知らせ");
  expect(old.init.signal?.aborted).toBe(true);
});

test("記事詳細の直接閲覧も表示成功後に既読にする", async () => {
  render(
    wrap(
      profile,
      "/updates/article-1",
    )(
      <NotificationProvider>
        <Routes>
          <Route path="/updates/:id" element={<UpdateDetailPage />} />
        </Routes>
      </NotificationProvider>,
    ),
  );
  const detailIndex = requests.findIndex((r) => r.url === "/api/announcements/article-1");
  await respond(detailIndex, {
    id: "article-1",
    title: "記事",
    body: "本文",
    date: "2026-11-07",
    kind: "feature",
  });
  const lookup = requests.findIndex((r) => r.url === "/api/notifications?announcementId=article-1");
  expect(lookup).toBeGreaterThan(-1);
  await respond(lookup, page([announcement()]));
  expect(requests.some((r) => r.url === "/api/account/notifications/read")).toBe(true);
});

test("StrictModeでも通知の取得を継続でき、トーストのshown APIは呼ばない", async () => {
  function Probe() {
    const center = useNotificationCenter();
    return <button onClick={() => void center?.refresh()}>取得</button>;
  }
  const view = render(
    wrap(profile)(
      <StrictMode>
        <NotificationProvider>
          <Probe />
        </NotificationProvider>
      </StrictMode>,
    ),
  );
  await flush();
  press(view, "取得");
  await flush();
  expect(requests[0]!.init.signal?.aborted).toBe(false);
  await respond(0, { hasUnread: false, upperBound: 0 });
  expect(requests.some((r) => r.url.includes("badge-notifications"))).toBe(false);
});

test("匿名の保存失敗では画面内で既読を維持し、保存できない旨を案内する", async () => {
  const original = localStorage.setItem;
  Object.defineProperty(localStorage, "setItem", {
    configurable: true,
    value: () => {
      throw new Error("denied");
    },
  });
  try {
    mounted(null);
    await respond(0, page([announcement(5)]));
    act(() => bell().click());
    await flush();
    await respond(1, page([announcement(5)]));
    await respond(2, page([announcement(5)]));
    expect(dialog().textContent).toContain("再読み込み後は保持されない");
    expect(dialog().textContent).not.toContain("未読");
  } finally {
    Object.defineProperty(localStorage, "setItem", { configurable: true, value: original });
  }
});
