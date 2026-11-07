import { expect, test } from "bun:test";
import { StrictMode, type ReactNode } from "react";
import { MemoryRouter, Routes, Route } from "react-router";
import { AppHeader } from "../src/shared/ui/AppHeader";
import { NotificationProvider } from "../src/features/notifications/NotificationProvider";
import { UpdateDetailPage } from "../src/features/updates/UpdatesPage";
import { useNotificationCenter } from "../src/features/notifications/NotificationContext";
import { AccountContext } from "../src/features/account/useAccount";
import { saveAnonymousReads } from "../src/features/notifications/anonymousReads";
import { accountPrivacyEvent } from "../src/features/account/accountPrivacy";
import { profile } from "../test/fixtures/account";
import type { AccountProfile, Notification } from "@tetraboard/protocol";
import {
  act,
  clock,
  flush,
  press,
  render,
  rerender,
  requests,
  wrap,
  type Request,
} from "./harness";

const listUrl = "/api/notifications";
const unreadUrl = "/api/account/notifications/unread";
const readUrl = "/api/account/notifications/read";
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
const award = (id = 1): Notification => ({
  id,
  createdAtMs: 1780000000000,
  kind: "tournament",
  read: false,
  legacy: false,
  tournament: { id, name: `本人限定大会${id}`, rank: 1, tied: false },
});
const page = (
  notifications: Notification[],
  nextCursor: string | null = null,
  upperBound = notifications[0]?.id ?? 0,
) => ({ notifications, nextCursor, upperBound });
const handled = new WeakSet<Request>();
function take(url: string) {
  const request = requests.find((r) => r.url === url && !handled.has(r));
  if (!request)
    throw new Error(
      `Missing pending request: ${url}; got ${requests.map((r) => r.url).join(", ")}`,
    );
  handled.add(request);
  return request;
}
async function reply(url: string, body: unknown, status = 200) {
  take(url).respond(body, status);
  await flush();
}
function Header() {
  return <AppHeader homeTo="/" homeLabel="ホーム" />;
}
function mounted(user: AccountProfile | null = profile) {
  return render(
    wrap(user)(
      <NotificationProvider>
        <Header />
      </NotificationProvider>,
    ),
  );
}
function bell() {
  return document.querySelector<HTMLButtonElement>(
    'button[aria-haspopup="dialog"][aria-label^="お知らせ"]',
  )!;
}
function dialog() {
  return document.querySelector<HTMLElement>('[role="dialog"]')!;
}
async function openList() {
  act(() => bell().click());
  await flush();
}
async function closeList() {
  act(() => dialog().querySelector<HTMLButtonElement>('[aria-label="閉じる"]')!.click());
  await flush();
  act(() => clock.advance(20));
}
function select(id = 1) {
  act(() => dialog().querySelector<HTMLButtonElement>(`[data-notification-id="${id}"]`)!.click());
}
async function warm(
  entries = [announcement()],
  cursor: string | null = null,
  upperBound = entries[0]?.id ?? 0,
) {
  const view = mounted();
  await reply(unreadUrl, { hasUnread: entries.some((n) => !n.read), upperBound });
  await reply(listUrl, page(entries, cursor, upperBound));
  return view;
}
async function settleOpen(
  entries = [announcement()],
  cursor: string | null = null,
  upperBound = entries[0]?.id ?? 0,
) {
  await reply(listUrl, page(entries, cursor, upperBound));
  await reply(unreadUrl, { hasUnread: entries.some((n) => !n.read), upperBound });
}

test("先読み済みなら開いた瞬間から一覧を表示し、再表示時も通信の完了を待たせない", async () => {
  await warm();
  expect(requests.filter((r) => r.url === listUrl)).toHaveLength(1);
  expect(requests.some((r) => r.url === readUrl)).toBe(false);
  act(() => bell().click());
  expect(dialog().textContent).toContain("更新情報1");
  expect(dialog().textContent).not.toContain("お知らせを読み込んでいます");
  expect(dialog().textContent).toContain("運営からのお知らせ");
  expect(bell().nextElementSibling?.getAttribute("aria-label")).toBe("表示・サウンド設定");
  const refresh = dialog().querySelector<HTMLButtonElement>('[aria-label="お知らせを更新"]')!;
  expect(refresh.textContent).toBe("");
  expect(refresh.disabled).toBe(false);
  await flush();
  await settleOpen();
  await closeList();
  expect(document.activeElement).toBe(bell());
  act(() => bell().click());
  expect(dialog().textContent).toContain("更新情報1");
  expect(dialog().textContent).not.toContain("お知らせを読み込んでいます");
  expect(requests.some((r) => r.url === readUrl)).toBe(false);
});

test("先読み途中で開いた操作と更新を同じ取得にまとめ、完了後に表示する", async () => {
  mounted();
  await reply(unreadUrl, { hasUnread: true, upperBound: 1 });
  const fetching = take(listUrl);
  await openList();
  expect(dialog().textContent).toContain("お知らせを読み込んでいます");
  expect(requests.filter((r) => r.url === listUrl)).toHaveLength(1);
  fetching.respond(page([announcement()]));
  await flush();
  expect(dialog().textContent).toContain("更新情報1");
  expect(dialog().textContent).not.toContain("お知らせを読み込んでいます");
});

test("裏の再取得中も詳細をすぐ開け、一覧の本文を使ってから既読を記録する", async () => {
  await warm();
  await openList();
  const background = take(listUrl);
  const oldStatus = take(unreadUrl);
  select();
  expect(dialog().textContent).toContain("お知らせの本文");
  expect(requests.some((r) => /^\/api\/notifications\/\d+$/.test(r.url))).toBe(false);
  await flush();
  const read = take(readUrl);
  expect(JSON.parse(String(read.init.body))).toEqual({ id: 1 });
  read.respond({ ok: true });
  await flush();
  await reply(unreadUrl, { hasUnread: false, upperBound: 1 });
  // 読む前に開始した取得が最後に返っても、既読を巻き戻しません。
  background.respond(page([announcement()]));
  oldStatus.respond({ hasUnread: true, upperBound: 1 });
  await flush();
  const back = dialog().querySelector<HTMLButtonElement>('[aria-label="一覧に戻る"]')!;
  expect(back.textContent).toBe("");
  act(() => back.click());
  await flush();
  act(() => clock.advance(20));
  expect(document.activeElement?.textContent).toContain("更新情報1");
  expect(dialog().textContent).not.toContain("未読");
  await closeList();
  await openList();
  expect(dialog().textContent).toContain("更新情報1");
  expect(dialog().textContent).not.toContain("未読");
  expect(bell().getAttribute("aria-label")).toBe("お知らせ");
});

test("更新失敗ではキャッシュを残して再試行でき、再表示にも古い一覧を使える", async () => {
  await warm();
  await openList();
  const refresh = dialog().querySelector<HTMLButtonElement>('[aria-label="お知らせを更新"]')!;
  const count = requests.filter((r) => r.url === listUrl).length;
  act(() => refresh.click());
  await flush();
  expect(refresh.disabled).toBe(true);
  expect(requests.filter((r) => r.url === listUrl)).toHaveLength(count);
  await reply(listUrl, {}, 503);
  await reply(unreadUrl, {}, 503);
  expect(dialog().textContent).toContain("更新情報1");
  expect(dialog().textContent).toContain("取得できません");
  expect(bell().getAttribute("aria-label")).toContain("未読あり");
  press(dialog(), "再試行");
  await flush();
  await reply(listUrl, page([announcement(2), announcement()]));
  expect(dialog().textContent).toContain("更新情報2");
  await closeList();
  act(() => bell().click());
  expect(dialog().textContent).toContain("更新情報2");
});

test("先読み失敗は空一覧と区別し、開いた後に再取得して復旧できる", async () => {
  mounted();
  await reply(unreadUrl, { hasUnread: true, upperBound: 1 });
  await reply(listUrl, {}, 503);
  await openList();
  expect(dialog().textContent).toContain("お知らせを読み込んでいます");
  expect(dialog().textContent).not.toContain("お知らせはありません");
  await reply(listUrl, {}, 503);
  expect(dialog().textContent).toContain("取得できません");
  press(dialog(), "再試行");
  await flush();
  await reply(listUrl, page([]));
  expect(dialog().textContent).toContain("お知らせはありません");
});

test("30秒の未読確認は変更がない間は一覧を再取得せず、新着時に先読みを更新する", async () => {
  await warm();
  act(() => clock.advance(30_000));
  await flush();
  await reply(unreadUrl, { hasUnread: true, upperBound: 1 });
  expect(requests.filter((r) => r.url === listUrl)).toHaveLength(1);
  act(() => clock.advance(30_000));
  await flush();
  await reply(unreadUrl, { hasUnread: true, upperBound: 2 });
  await reply(listUrl, page([announcement(2), announcement()]));
  act(() => bell().click());
  expect(dialog().textContent).toContain("更新情報2");
});

test("追加取得失敗でも既存項目を残し、まとめて既読は取得済み上限より後の新着を残す", async () => {
  await warm([announcement(30)], "30", 30);
  await openList();
  await settleOpen([announcement(30)], "30", 30);
  press(dialog(), "もっと見る");
  await flush();
  await reply(`${listUrl}?cursor=30`, {}, 503);
  expect(dialog().textContent).toContain("更新情報30");
  press(dialog(), "再試行");
  await flush();
  await reply(`${listUrl}?cursor=30`, page([announcement(29)], null, 31));
  press(dialog(), "すべて既読にする");
  await flush();
  const readAll = take("/api/account/notifications/read-all");
  expect(JSON.parse(String(readAll.init.body))).toEqual({ through: 31 });
  readAll.respond({ ok: true });
  await flush();
  await reply(unreadUrl, { hasUnread: true, upperBound: 32 });
  await reply(listUrl, page([announcement(32), { ...announcement(30), read: true }]));
  expect(bell().getAttribute("aria-label")).toContain("未読あり");
  expect(dialog().textContent).not.toContain("未読");
  await closeList();
  await openList();
  expect(dialog().textContent).toContain("更新情報32");
  expect(dialog().textContent).toContain("未読");
});

test("未読確認と一覧の応答が競合しても、先読み自体では既読にしない", async () => {
  mounted();
  await reply(unreadUrl, { hasUnread: false, upperBound: 1 });
  await reply(listUrl, page([announcement()]));
  await openList();
  expect(dialog().textContent).toContain("未読");
  expect(requests.some((r) => r.url === readUrl || r.url.endsWith("read-all"))).toBe(false);
});

test("非公開になった通知は再取得で除外し、既読保存で404になった内容も残さない", async () => {
  await warm();
  await openList();
  const background = take(listUrl);
  select();
  await flush();
  await reply(readUrl, {}, 404);
  expect(dialog().textContent).toContain("現在表示できません");
  expect(dialog().textContent).not.toContain("お知らせの本文");
  background.respond(page([announcement()]));
  await flush();
  act(() => dialog().querySelector<HTMLButtonElement>('[aria-label="一覧に戻る"]')!.click());
  await flush();
  expect(dialog().textContent).not.toContain("更新情報1");
  await closeList();
  await openList();
  expect(dialog().textContent).not.toContain("更新情報1");
  await reply(listUrl, page([]));
  expect(dialog().textContent).toContain("お知らせはありません");
});

function authShell(
  user: AccountProfile | null,
  loading: boolean,
  generation: number,
  children: ReactNode = <Header />,
) {
  return (
    <MemoryRouter>
      <AccountContext.Provider
        value={{
          user,
          loading,
          generation,
          error: null,
          refresh: async () => {},
          update: () => {},
        }}
      >
        <NotificationProvider>{children}</NotificationProvider>
      </AccountContext.Provider>
    </MemoryRouter>
  );
}

test("同じ本人の認証再確認・画面遷移ではキャッシュを保ち、確認中は個別内容を隠す", async () => {
  const guest = { ...profile, profileId: "a29c05fc-e691-4a92-9875-055bb4d658da", isGuest: true };
  const registered = { ...guest, username: "registered", isGuest: false };
  const view = render(authShell(guest, false, 1));
  await reply(unreadUrl, { hasUnread: true, upperBound: 1 });
  await reply(listUrl, page([award()]));
  rerender(view, authShell(guest, true, 1));
  await flush();
  expect(bell().disabled).toBe(true);
  rerender(view, authShell(registered, false, 2));
  await flush();
  await reply(unreadUrl, { hasUnread: true, upperBound: 1 });
  expect(requests.filter((r) => r.url === listUrl)).toHaveLength(1);
  rerender(view, authShell(registered, false, 2, <p>対局画面</p>));
  await flush();
  const count = requests.length;
  act(() => clock.advance(30_000));
  await flush();
  expect(requests.length).toBe(count);
  rerender(view, authShell(registered, false, 2));
  await flush();
  act(() => bell().click());
  expect(dialog().textContent).toContain("本人限定大会1");
});

test("別アカウントとログアウトではキャッシュと詳細を直ちに隠し、旧本人の応答を無視する", async () => {
  const view = await warm([award()]);
  await openList();
  const old = take(listUrl);
  const oldStatus = take(unreadUrl);
  select();
  await flush();
  const other = { ...profile, username: "other-account" };
  rerender(
    view,
    wrap(other)(
      <NotificationProvider>
        <Header />
      </NotificationProvider>,
    ),
  );
  await flush();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  await reply(unreadUrl, { hasUnread: true, upperBound: 2 });
  const next = take(listUrl);
  next.respond(page([award(2)]));
  await flush();
  old.respond(page([award()]));
  oldStatus.respond({ hasUnread: true, upperBound: 1 });
  await flush();
  act(() => bell().click());
  expect(dialog().textContent).toContain("本人限定大会2");
  expect(dialog().textContent).not.toContain("本人限定大会1");
  expect(old.init.signal?.aborted).toBe(true);
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
  act(() => bell().click());
  expect(dialog().textContent).not.toContain("本人限定大会2");
});

test("匿名も初回基準と先読みを共用し、別タブの既読を反映する", async () => {
  mounted(null);
  await reply(listUrl, page([announcement(5)]));
  expect(bell().getAttribute("aria-label")).toBe("お知らせ");
  act(() => bell().click());
  expect(dialog().textContent).toContain("更新情報5");
  await flush();
  await reply(listUrl, page([announcement(5)]));
  await closeList();
  act(() => clock.advance(30_000));
  await flush();
  await reply(listUrl, page([announcement(6), announcement(5)]));
  expect(bell().getAttribute("aria-label")).toContain("未読あり");
  localStorage.setItem("tetraboard:notification-reads", JSON.stringify({ through: 6, ids: [] }));
  act(() => window.dispatchEvent(new Event("storage")));
  await flush();
  await reply(listUrl, page([announcement(6)]));
  expect(bell().getAttribute("aria-label")).toBe("お知らせ");
  expect(requests.some((r) => r.url === unreadUrl)).toBe(false);
});

test("本人切替直後の取得失敗で、前の本人の未読表示やキャッシュを復活させない", async () => {
  const view = await warm([award()]);
  rerender(view, authShell({ ...profile, username: "another-person" }, false, 2));
  await flush();
  await reply(unreadUrl, {}, 503);
  await reply(listUrl, {}, 503);
  expect(bell().getAttribute("aria-label")).toBe("お知らせ");
  await openList();
  expect(dialog().textContent).not.toContain("本人限定大会1");
  expect(dialog().textContent).toContain("読み込んでいます");
});

test("非表示中は更新を止め、表示復帰時に未読を確認する", async () => {
  await warm();
  const descriptor = Object.getOwnPropertyDescriptor(document, "visibilityState");
  try {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    const count = requests.length;
    act(() => clock.advance(60_000));
    await flush();
    expect(requests.length).toBe(count);
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    await flush();
    await reply(unreadUrl, { hasUnread: true, upperBound: 1 });
    expect(requests.filter((r) => r.url === listUrl)).toHaveLength(1);
  } finally {
    if (descriptor) Object.defineProperty(document, "visibilityState", descriptor);
    else Reflect.deleteProperty(document, "visibilityState");
  }
});

test("記事詳細の直接閲覧は取得済み本文の確認後に既読にし、キャッシュにない記事は照会する", async () => {
  render(
    wrap(
      profile,
      "/updates/article-2",
    )(
      <NotificationProvider>
        <Routes>
          <Route path="/updates/:id" element={<UpdateDetailPage />} />
        </Routes>
      </NotificationProvider>,
    ),
  );
  await reply(unreadUrl, { hasUnread: true, upperBound: 2 });
  await reply(listUrl, page([announcement()]));
  await reply("/api/announcements/article-2", {
    id: "article-2",
    title: "記事",
    body: "本文",
    date: "2026-11-07",
    kind: "feature",
  });
  await reply(`${listUrl}?announcementId=article-2`, page([announcement(2)]));
  const read = take(readUrl);
  expect(JSON.parse(String(read.init.body))).toEqual({ id: 2 });
});

test("先読み済みの記事を直接開いても本文の表示前には既読にせず、通知の再照会を省く", async () => {
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
  await reply(unreadUrl, { hasUnread: true, upperBound: 1 });
  await reply(listUrl, page([announcement()]));
  expect(requests.some((r) => r.url === readUrl)).toBe(false);
  await reply("/api/announcements/article-1", {
    id: "article-1",
    title: "記事",
    body: "本文",
    date: "2026-11-07",
    kind: "feature",
  });
  expect(requests.some((r) => r.url.includes("announcementId="))).toBe(false);
  expect(JSON.parse(String(take(readUrl).init.body))).toEqual({ id: 1 });
});

test("認証切れの更新は本人再確認へつなぎ、再確認中はキャッシュを表示しない", async () => {
  const view = await warm([award()]);
  let checks = 0;
  const check = () => checks++;
  window.addEventListener(accountPrivacyEvent, check);
  try {
    await openList();
    await reply(listUrl, {}, 401);
    expect(checks).toBe(1);
    rerender(view, authShell(profile, true, 1));
    await flush();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(bell().disabled).toBe(true);
    expect(document.body.textContent).not.toContain("本人限定大会1");
  } finally {
    window.removeEventListener(accountPrivacyEvent, check);
  }
});

test("StrictModeでも先読みと操作の取得を共用し、バッジtoastを消費しない", async () => {
  function Probe() {
    const center = useNotificationCenter();
    return <button onClick={() => void center?.refresh()}>取得</button>;
  }
  const view = render(
    wrap(profile)(
      <StrictMode>
        <NotificationProvider>
          <Header />
          <Probe />
        </NotificationProvider>
      </StrictMode>,
    ),
  );
  await flush();
  press(view, "取得");
  await flush();
  expect(requests.filter((r) => r.url === listUrl)).toHaveLength(1);
  expect(requests.filter((r) => r.url === unreadUrl)).toHaveLength(1);
  await reply(unreadUrl, { hasUnread: true, upperBound: 1 });
  await reply(listUrl, page([announcement()]));
  act(() => bell().click());
  expect(dialog().textContent).toContain("更新情報1");
  expect(requests.some((r) => r.url.includes("badge-notifications"))).toBe(false);
});

test("匿名の保存失敗でも画面内で先読みと既読を保ち、保存できない旨を案内する", async () => {
  const original = localStorage.setItem;
  Object.defineProperty(localStorage, "setItem", {
    configurable: true,
    value: () => {
      throw new Error("denied");
    },
  });
  try {
    mounted(null);
    await reply(listUrl, page([announcement(5)]));
    await openList();
    await reply(listUrl, page([announcement(5)]));
    expect(dialog().textContent).toContain("再読み込み後は保持されない");
    expect(dialog().textContent).not.toContain("未読");
  } finally {
    Object.defineProperty(localStorage, "setItem", { configurable: true, value: original });
    saveAnonymousReads({ through: 0, ids: [] });
  }
});
