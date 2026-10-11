/* eslint-disable react/globals -- hookの値をテストへ取り出すために使用します。 */
import { expect, spyOn, test } from "bun:test";
import { StrictMode } from "react";
import { createMemoryRouter, Outlet, RouterProvider, useLoaderData } from "react-router";
import { gameIds, type GameId } from "@tetraboard/protocol/games";
import { reversiArchives } from "../../../test-fixtures/matches";
import { AccountLayout } from "../src/features/account/AccountSession";
import { ProfilePage, LoginPage } from "../src/features/account/AccountPages";
import { useAccount } from "../src/features/account/useAccount";
import { useFormationStats } from "../src/features/account/useFormationStats";
import { createAccountSelection } from "../src/features/account/useAccountSelection";
import { MatchReplayErrorPage } from "../src/features/room/MatchReplayPage";
import { matchReplayLoader } from "../src/features/room/matchReplayLoader";
import { profile } from "../test/fixtures/account";
import { match } from "../test/fixtures/matchSummary";
import { act, clock, enter, flush, press, render, requests, rerender } from "./harness";

import * as accountApi from "../src/features/account/accountApi";

const sessions = () => requests.filter((r) => r.url === "/api/account/session");
const statsRequests = () => requests.filter((r) => r.url.startsWith("/api/account/stats"));
const historyRequests = () => requests.filter((r) => r.url.startsWith("/api/account/matches?"));
const replayRequests = () => requests.filter((r) => r.url.startsWith("/api/account/matches/"));
const stats = {
  singles: { total: 12, first: 4, second: 2, third: 6, fourth: 0 },
  doubles: { total: 6, wins: 3, losses: 2, draws: 1 },
};
function LoadedReplay() {
  const data = useLoaderData();
  return <span>復元済み棋譜 {data.match.id}</span>;
}
function mount({
  game = "four-reversi",
  strict = false,
  entry = "/account",
}: {
  game?: GameId;
  strict?: boolean;
  entry?: string;
} = {}) {
  let account!: ReturnType<typeof useAccount>;
  let formations!: ReturnType<typeof useFormationStats>;
  function ProbeLayout() {
    account = useAccount();
    return <Outlet />;
  }
  function Formations() {
    formations = useFormationStats(true);
    return <span>{formations.error}</span>;
  }
  const router = createMemoryRouter(
    [
      {
        element: <AccountLayout />,
        children: [
          {
            element: <ProbeLayout />,
            children: [
              { path: "/account", element: <ProfilePage /> },
              { path: "/login", element: <LoginPage /> },
              { path: "/outside", element: <span>公開画面</span> },
              { path: "/formations", element: <Formations /> },
              {
                path: "/account/matches/:matchId",
                element: <LoadedReplay />,
                loader: matchReplayLoader,
                errorElement: <MatchReplayErrorPage />,
                hydrateFallbackElement: <span>棋譜を読み込んでいます</span>,
              },
            ],
          },
        ],
      },
    ],
    {
      initialEntries: [
        { pathname: entry, state: { accountSelection: createAccountSelection(game) } },
      ],
    },
  );
  const content = strict ? (
    <StrictMode>
      <RouterProvider router={router} />
    </StrictMode>
  ) : (
    <RouterProvider router={router} />
  );
  const view = render(content);
  return {
    view,
    router,
    get account() {
      return account;
    },
    get formations() {
      return formations;
    },
    unmount: () => rerender(view, null),
  };
}
async function signIn(m: ReturnType<typeof mount>) {
  sessions().at(-1)!.respond({ user: profile });
  await flush();
  clock.advance(0);
  expect(m.account.user).toEqual(profile);
}
async function seed() {
  statsRequests().at(-1)!.respond(stats);
  historyRequests()
    .at(-1)!
    .respond({ matches: [match(1)], nextCursor: "next" });
  await flush();
}
const card = (view: HTMLElement, id: string) =>
  view.querySelector<HTMLElement>(`[data-testid="${id}"]`)!;

test.each([...gameIds])(
  "%s: 初回401を同時に受けても一度だけ確認し、失効案内とヘッダーを同期",
  async (game) => {
    const m = mount({ game });
    await signIn(m);
    statsRequests()[0]!.respond({}, 401);
    historyRequests()[0]!.respond({}, 401);
    await flush();
    expect(sessions()).toHaveLength(2);
    expect(m.account.user).toEqual(profile);
    sessions()[1]!.respond({ user: null });
    await flush();
    expect(m.account.user).toBeNull();
    expect(m.router.state.location.pathname).toBe("/login");
    expect(m.view.querySelector('[aria-label$="のアカウントメニュー"]')).toBeNull();
    expect(m.view.textContent).toContain(
      "ログイン状態が失われました。もう一度ログインしてください。",
    );
  },
);

test("同じアカウントで有効なら各取得を一度だけ再取得し、再401でループしない", async () => {
  const m = mount();
  await signIn(m);
  statsRequests()[0]!.respond({}, 401);
  historyRequests()[0]!.respond({}, 401);
  await flush();
  sessions()[1]!.respond({ user: profile });
  await flush();
  expect(statsRequests()).toHaveLength(2);
  expect(historyRequests()).toHaveLength(2);
  statsRequests()[1]!.respond({}, 401);
  historyRequests()[1]!.respond({}, 401);
  await flush();
  clock.advance(0);
  expect(sessions()).toHaveLength(2);
  expect(statsRequests()).toHaveLength(2);
  expect(m.view.textContent).toContain("戦績を取得できませんでした。");
  press(card(m.view, "account-profile-card"), "再試行");
  statsRequests()[2]!.respond(stats);
  await flush();
  expect(m.view.textContent).toContain("対局数12");
});

test("追加履歴の401は同じcursorで再取得し、一覧と重複排除を保持", async () => {
  const m = mount();
  await signIn(m);
  await seed();
  press(card(m.view, "account-replay-card"), "もっと見る");
  const more = historyRequests().at(-1)!;
  more.respond({}, 401);
  await flush();
  sessions()[1]!.respond({ user: profile });
  await flush();
  expect(historyRequests().at(-1)!.url).toBe(more.url);
  historyRequests()
    .at(-1)!
    .respond({ matches: [match(1), match(2)], nextCursor: null });
  await flush();
  expect(m.view.querySelectorAll('a[href^="/account/matches/"]')).toHaveLength(2);
});

test("更新と手動再試行の401でも失効確認からログインへ誘導", async () => {
  const m = mount();
  await signIn(m);
  await seed();
  press(card(m.view, "account-profile-card"), "更新");
  statsRequests().at(-1)!.respond({}, 503);
  await flush();
  press(card(m.view, "account-profile-card"), "再試行");
  statsRequests().at(-1)!.respond({}, 401);
  await flush();
  sessions()[1]!.respond({ user: null });
  await flush();
  expect(m.router.state.location.pathname).toBe("/login");
});

test("画面内往復後の401も再確認し、初回のログイン状態を残さない", async () => {
  const m = mount();
  await signIn(m);
  await seed();
  act(() => {
    void m.router.navigate("/outside");
  });
  await flush();
  act(() => {
    void m.router.navigate("/account");
  });
  await flush();
  clock.advance(0);
  historyRequests().at(-1)!.respond({}, 401);
  await flush();
  sessions()[1]!.respond({ user: null });
  await flush();
  expect(m.router.state.location.pathname).toBe("/login");
});

test("戦法別戦績の401は同じ認証確認を利用し、有効なら再取得", async () => {
  const m = mount();
  await signIn(m);
  await seed();
  act(() => {
    void m.router.navigate("/formations");
  });
  await flush();
  clock.advance(0);
  const formations = () =>
    requests.filter((r) => r.url === "/api/account/four-shogi/formation-stats");
  formations()[0]!.respond({}, 401);
  await flush();
  sessions()[1]!.respond({ user: profile });
  await flush();
  formations()[1]!.respond([]);
  await flush();
  expect(m.formations.stats).toEqual([]);
  expect(m.formations.error).toBeNull();
});

test.each(["503", "offline", "timeout"])(
  "401後の確認失敗(%s)はプロフィール・画像と名前の下書き・既存履歴を保持",
  async (failure) => {
    const m = mount();
    await signIn(m);
    await seed();
    press(m.view, "プロフィールを編集");
    await flush();
    const input =
      document.querySelector<HTMLInputElement>('input[name="name"]') ??
      document.querySelector<HTMLInputElement>('[role="dialog"] input');
    enter(input!, "編集中");
    const imageInput = document.querySelector<HTMLInputElement>(
      '[role="dialog"] input[type="file"]',
    )!;
    Object.defineProperty(imageInput, "files", {
      configurable: true,
      value: [new File(["image"], "image.png", { type: "image/png" })],
    });
    const convert = spyOn(accountApi, "convertAvatar").mockResolvedValue(
      new Blob(["webp"], { type: "image/webp" }),
    );
    try {
      act(() => imageInput.dispatchEvent(new Event("change", { bubbles: true })));
      await flush();
    } finally {
      convert.mockRestore();
    }
    expect(document.querySelector('[role="dialog"]')!.textContent).toContain("アイコンを削除");
    press(card(m.view, "account-replay-card"), "更新");
    historyRequests().at(-1)!.respond({}, 401);
    await flush();
    if (failure === "503") sessions()[1]!.respond({}, 503);
    else if (failure === "offline") sessions()[1]!.reject(new TypeError("offline"));
    else clock.advance(10000);
    await flush();
    expect(m.account.user).toEqual(profile);
    expect(m.account.error).not.toBeNull();
    expect(input!.value).toBe("編集中");
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    press(dialog, "保存");
    await flush();
    const save = requests.find((r) => r.url === "/api/account/profile")!;
    const draft = save.init.body as FormData;
    expect(draft.get("name")).toBe("編集中");
    expect(draft.get("avatarAction")).toBe("replace");
    expect((draft.get("avatar") as File).type).toBe("image/webp");
    save.respond({ message: "保存失敗" }, 503);
    await flush();
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(m.view.querySelector(`a[href="/account/matches/${match(1).id}"]`)).not.toBeNull();
    if (failure === "timeout") {
      expect(sessions()[1]!.init.signal?.aborted).toBe(true);
      sessions()[1]!.respond({ user: null });
      await flush();
      expect(m.account.user).toEqual(profile);
    }
  },
);

test("通常の503・オフラインはセッション再確認を起動せず取得済みデータを保持", async () => {
  const m = mount();
  await signIn(m);
  await seed();
  press(card(m.view, "account-profile-card"), "更新");
  press(card(m.view, "account-replay-card"), "更新");
  statsRequests().at(-1)!.respond({}, 503);
  historyRequests().at(-1)!.reject(new TypeError("offline"));
  await flush();
  expect(sessions()).toHaveLength(1);
  expect(m.account.user).toEqual(profile);
  expect(m.view.textContent).toContain("対局数12");
});

test.each([200, 401])(
  "別アカウントへの切替後、古い%i応答でキャッシュや認証を上書きしない",
  async (status) => {
    const m = mount();
    await signIn(m);
    const oldStats = statsRequests()[0]!;
    const oldHistory = historyRequests()[0]!;
    const other = {
      ...profile,
      name: "別ユーザー",
      username: "another",
      profileId: "99999999-9999-4999-8999-999999999999",
    };
    act(() => m.account.update(other));
    await flush();
    clock.advance(0);
    expect(oldStats.init.signal?.aborted).toBe(true);
    oldStats.respond(status === 200 ? stats : {}, status);
    oldHistory.respond(status === 200 ? { matches: [match(1)], nextCursor: null } : {}, status);
    await flush();
    expect(m.account.user).toEqual(other);
    expect(sessions()).toHaveLength(1);
    expect(m.view.textContent).not.toContain("対局数12");
    expect(m.view.querySelector(`a[href="/account/matches/${match(1).id}"]`)).toBeNull();
  },
);

test("進行中の通常確認を共有し、認証更新後の古い確認応答を破棄", async () => {
  const m = mount();
  await signIn(m);
  act(() => window.dispatchEvent(new Event("focus")));
  statsRequests()[0]!.respond({}, 401);
  await flush();
  expect(sessions()).toHaveLength(2);
  const other = { ...profile, username: "another", name: "別ユーザー" };
  act(() => m.account.update(other));
  await flush();
  sessions()[1]!.respond({ user: null });
  await flush();
  expect(m.account.user).toEqual(other);
  expect(m.router.state.location.pathname).toBe("/account");
});

test("取得済みの戦績・履歴・編集ダイアログは別アカウントへ引き継がない", async () => {
  const m = mount();
  await signIn(m);
  await seed();
  press(m.view, "プロフィールを編集");
  await flush();
  const other = { ...profile, username: "other", name: "別ユーザー" };
  act(() => m.account.update(other));
  await flush();
  clock.advance(0);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(m.view.textContent).not.toContain("対局数12");
  expect(m.view.querySelector(`a[href="/account/matches/${match(1).id}"]`)).toBeNull();
  expect(statsRequests()).toHaveLength(2);
  expect(historyRequests()).toHaveLength(2);
});

test("正常な再確認後の旧401は再確認を起動せず、未取得データを現行世代で取得し直す", async () => {
  const m = mount();
  await signIn(m);
  const old = statsRequests()[0]!;
  act(() => window.dispatchEvent(new Event("focus")));
  sessions()[1]!.respond({ user: profile });
  await flush();
  old.respond({}, 401);
  await flush();
  clock.advance(0);
  expect(sessions()).toHaveLength(2);
  expect(statsRequests()).toHaveLength(2);
  statsRequests()[1]!.respond(stats);
  await flush();
  expect(m.view.textContent).toContain("対局数12");
});

test("初回失敗後の更新が認証世代変更で古くなっても、空表示で停止せず再取得", async () => {
  const m = mount();
  await signIn(m);
  statsRequests()[0]!.respond({}, 503);
  await flush();
  press(card(m.view, "account-profile-card"), "更新");
  const old = statsRequests()[1]!;
  act(() => window.dispatchEvent(new Event("focus")));
  sessions()[1]!.respond({ user: profile });
  await flush();
  old.respond(stats);
  await flush();
  clock.advance(0);
  expect(statsRequests()).toHaveLength(3);
  statsRequests()[2]!.respond(stats);
  await flush();
  expect(m.view.textContent).toContain("対局数12");
});

test("画面離脱後の401と認証確認中のunmountは新しい画面へ影響しない", async () => {
  const m = mount();
  await signIn(m);
  const old = statsRequests()[0]!;
  act(() => {
    void m.router.navigate("/outside");
  });
  await flush();
  old.respond({}, 401);
  await flush();
  expect(sessions()).toHaveLength(1);
  act(() => window.dispatchEvent(new Event("focus")));
  const pending = sessions()[1]!;
  m.unmount();
  expect(pending.init.signal?.aborted).toBe(true);
  pending.respond({ user: null });
  await flush();
});

test("本人棋譜の確認503は失効扱いせず、手動再試行で取得へ復帰", async () => {
  const m = mount();
  await signIn(m);
  await seed();
  const detail = reversiArchives[0]!.detail;
  act(() => {
    void m.router.navigate(`/account/matches/${detail.id}`);
  });
  await flush();
  replayRequests()[0]!.respond({}, 401);
  await flush();
  sessions()[1]!.respond({}, 503);
  await flush();
  expect(m.account.user).toEqual(profile);
  expect(m.router.state.location.pathname).toBe(`/account/matches/${detail.id}`);
  expect(m.view.textContent).toContain("ログイン状態を確認できません。");
  press(m.view, "再試行");
  await flush();
  sessions()[2]!.respond({ user: profile });
  await flush();
  replayRequests()[1]!.respond({ match: detail });
  await flush();
  expect(m.view.textContent).toContain("復元済み棋譜");
});

test("unmountとStrictModeの旧401・旧セッション応答は認証を変更しない", async () => {
  const m = mount({ strict: true });
  await signIn(m);
  expect(sessions()[0]!.init.signal?.aborted).toBe(true);
  sessions()[0]!.respond({ user: null });
  await flush();
  expect(m.account.user).toEqual(profile);
  const old = statsRequests()[0]!;
  m.unmount();
  old.respond({}, 401);
  await flush();
  expect(sessions()).toHaveLength(2);
});

test("本人棋譜の401は失効確認後にログインへ進み、マイページへ戻されない", async () => {
  const m = mount();
  await signIn(m);
  await seed();
  act(() => {
    void m.router.navigate(`/account/matches/${match(1).id}`);
  });
  await flush();
  replayRequests()[0]!.respond({}, 401);
  await flush();
  sessions()[1]!.respond({ user: null });
  await flush();
  expect(m.router.state.location.pathname).toBe("/login");
  expect(m.view.textContent).toContain("ログイン状態が失われました。");
});

test("本人棋譜は有効なら一度再検証し、再401でもループせず手動再試行できる", async () => {
  const m = mount();
  await signIn(m);
  await seed();
  const detail = reversiArchives[0]!.detail;
  act(() => {
    void m.router.navigate(`/account/matches/${detail.id}`);
  });
  await flush();
  replayRequests()[0]!.respond({}, 401);
  await flush();
  sessions()[1]!.respond({ user: profile });
  await flush();
  replayRequests()[1]!.respond({}, 401);
  await flush();
  expect(sessions()).toHaveLength(2);
  expect(replayRequests()).toHaveLength(2);
  expect(m.view.textContent).toContain("棋譜を取得できませんでした。");
  press(m.view, "再試行");
  await flush();
  replayRequests()[2]!.respond({ match: detail });
  await flush();
  expect(m.view.textContent).toContain("復元済み棋譜");
});

test("本人棋譜への直接アクセスで未認証を確認した場合は通常のログイン案内", async () => {
  const m = mount({ entry: `/account/matches/${match(1).id}` });
  replayRequests()[0]!.respond({}, 401);
  await flush();
  sessions().at(-1)!.respond({ user: null });
  await flush();
  expect(m.router.state.location.pathname).toBe("/login");
  expect(m.view.textContent).not.toContain("ログイン状態が失われました。");
});
