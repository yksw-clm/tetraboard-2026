import { expect, test } from "bun:test";
import { Route, Routes } from "react-router";
import { AppHeader } from "../src/shared/ui/AppHeader";
import { AccountMenu } from "../src/features/account/AccountMenu";
import { AccountLayout } from "../src/features/account/AccountSession";
import { LobbyAnnouncement } from "../src/features/lobby/LobbyAnnouncement";
import { LobbyFooter } from "../src/features/lobby/LobbyFooter";
import { UpdatesPage, UpdateDetailPage } from "../src/features/updates/UpdatesPage";
import { profile } from "../test/fixtures/account";
import { guestProfile } from "./guestAccountFixtures";
import { act, flush, press, render, rerender, requests, wrap } from "./harness";
const summary = {
  id: "feedback",
  title: "CPUを強くしました",
  summary: "説明の最初の行",
  date: "2026-10-08",
  kind: "improvement",
};

test("共通ヘッダーは新ナビを表示し、お知らせはフッターから未認証・ゲスト・登録者が開ける", async () => {
  for (const user of [null, guestProfile(), profile]) {
    const view = render(
      wrap(user)(
        <Routes>
          <Route
            path="/"
            element={
              <>
                <AppHeader homeTo="/" homeLabel="ロビーへ">
                  <AccountMenu />
                </AppHeader>
                <LobbyFooter>{null}</LobbyFooter>
              </>
            }
          />
          <Route path="/updates" element={<h1>お知らせ一覧</h1>} />
        </Routes>,
      ),
    );
    expect(view.querySelector('header a[href="/updates"]')).toBeNull();
    expect(
      view.querySelector('[aria-label="メインナビゲーション"] a[href="/how-to-play"]'),
    ).not.toBeNull();
    expect(view.textContent).toContain(user?.name ?? "登録・ログイン");
    const updates = view.querySelector<HTMLAnchorElement>('footer a[href="/updates"]')!;
    expect(updates.textContent).toBe("お知らせ");
    act(() => updates.click());
    await flush();
    expect(view.querySelector("h1")!.textContent).toBe("お知らせ一覧");
  }
});
test("ロビーは取得中・空・失敗で枠を出さず、ゲーム切替後の旧応答を捨てる", async () => {
  const view = render(wrap()(<LobbyAnnouncement game="four-reversi" />));
  expect(view.querySelector("section")).toBeNull();
  requests[0]!.respond({ announcement: summary });
  await flush();
  expect(view.textContent).toContain(summary.title);
  expect(view.textContent).toContain(summary.summary);
  expect(view.textContent).not.toContain(summary.date);
  expect(view.querySelector("a")!.getAttribute("href")).toBe("/updates/feedback");
  rerender(view, wrap()(<LobbyAnnouncement game="four-shogi" />));
  expect(view.querySelector("section")).toBeNull();
  requests[1]!.respond({ announcement: null });
  await flush();
  expect(view.querySelector("section")).toBeNull();
  rerender(view, wrap()(<LobbyAnnouncement game="four-reversi" />));
  rerender(view, wrap()(<LobbyAnnouncement game="four-shogi" />));
  requests[2]!.respond({ announcement: summary });
  await flush();
  expect(view.querySelector("section")).toBeNull();
  requests[3]!.respond({}, 503);
  await flush();
  expect(view.querySelector("section")).toBeNull();
});
test("一覧の失敗・再試行・記事リンク・カーソル、空一覧を表示する", async () => {
  const view = render(
    wrap()(
      <Routes>
        <Route path="*" element={<UpdatesPage />} />
      </Routes>,
    ),
  );
  requests[0]!.respond({}, 503);
  await flush();
  expect(view.querySelector('[role="alert"]')).not.toBeNull();
  press(view, "再試行");
  expect(view.querySelector('[data-slot="pending-spinner"]')).not.toBeNull();
  press(view, "再試行");
  expect(requests).toHaveLength(2);
  requests[1]!.respond({ announcements: [summary], nextCursor: "next+cursor" });
  await flush();
  expect(view.textContent).toContain("改善");
  expect(view.textContent).toContain(summary.title);
  const next = [...view.querySelectorAll("a")].find((a) => a.textContent === "もっと見る")!;
  expect(next.getAttribute("href")).toBe("/updates?cursor=next%2Bcursor");
  act(() => next.click());
  expect(requests[2]!.url).toBe("/api/announcements?cursor=next%2Bcursor");
  requests[2]!.respond({ announcements: [], nextCursor: null });
  await flush();
  expect(view.textContent).toContain("お知らせはまだありません");
});
test("詳細は改行付きプレーンテキストと一覧導線を表示する", async () => {
  const node = (entry: string) =>
    wrap(
      null,
      entry,
    )(
      <Routes>
        <Route path="/updates/:id" element={<UpdateDetailPage />} />
      </Routes>,
    );
  const view = render(node("/updates/feedback"));
  requests[0]!.respond({
    id: summary.id,
    title: summary.title,
    date: summary.date,
    kind: summary.kind,
    body: "一行目\n<script>危険</script>\n三行目",
  });
  await flush();
  expect(view.querySelector("script")).toBeNull();
  expect(view.textContent).toContain("一行目\n<script>危険</script>\n三行目");
  expect([...view.querySelectorAll("a")].some((a) => a.textContent === "お知らせ一覧へ")).toBe(
    true,
  );
});
test("プロフィール未設定でも詳細を閲覧でき、非公開404で設定画面へ送らない", async () => {
  const view = render(
    wrap(
      null,
      "/updates/feedback",
    )(
      <Routes>
        <Route element={<AccountLayout />}>
          <Route path="/updates/:id" element={<UpdateDetailPage />} />
          <Route path="/account/setup" element={<p>プロフィール設定</p>} />
        </Route>
      </Routes>,
    ),
  );
  requests
    .find((r) => r.url === "/api/account/me")
    ?.respond({ user: { ...profile, profileCompleted: false } });
  // AccountLayoutの実際の認証APIへ応答します。
  requests
    .find((r) => r.url !== "/api/announcements/feedback")!
    .respond({ user: { ...profile, profileCompleted: false } });
  requests.find((r) => r.url === "/api/announcements/feedback")!.respond({}, 404);
  await flush();
  expect(view.textContent).toContain("お知らせが見つかりません");
  expect(view.textContent).not.toContain("プロフィール設定");
});
