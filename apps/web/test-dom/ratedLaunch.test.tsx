import { beforeEach, expect, spyOn, test } from "bun:test";
import { StrictMode, type ReactNode } from "react";
import { createMemoryRouter, RouterProvider, useLocation } from "react-router";
import type { AccountProfile, RatedMatchmakingGame } from "@tetraboard/protocol";
import type { LobbyGameRatings } from "@tetraboard/protocol/general-lobby";
import { AccountContext } from "../src/features/account/useAccount";
import { RegistrationCompletion } from "../src/features/account/RegistrationCompletion";
import { readRegistrationReturn } from "../src/features/account/registrationReturn";
import { RatedLaunchAnnouncement } from "../src/features/matchmaking/RatedLaunchAnnouncement";
import { ratedLaunchGames, ratedLaunchSeenKey } from "../src/features/matchmaking/ratedLaunch";
import { lastLobbyGame } from "../src/shared/lastLobbyGame";
import { AppDialog } from "../src/shared/ui/AppDialog";
import { GeneralLobbyPage } from "../src/features/lobby/GeneralLobbyPage";
import { FourShogiLobbyPage } from "../src/features/lobby/FourShogiLobbyPage";
import { FourReversiLobbyPage } from "../src/features/lobby/FourReversiLobbyPage";
import { ShogiLobbyPage } from "../src/features/lobby/ShogiLobbyPage";
import { ReversiLobbyPage } from "../src/features/lobby/ReversiLobbyPage";
import { GomokuLobbyPage } from "../src/features/lobby/GomokuLobbyPage";
import { FourGomokuLobbyPage } from "../src/features/lobby/FourGomokuLobbyPage";
import { profile } from "../test/fixtures/account";
import { guestProfile } from "./guestAccountFixtures";
import { act, clock, flush, press, render, rerender, requests, wrap } from "./harness";
const path = "/api/lobby/game-ratings";
const latest = () => requests.filter((r) => r.url === path).at(-1)!;
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')!;
const seen = () => localStorage.getItem(ratedLaunchSeenKey);
function visibility(value: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { configurable: true, value });
  act(() => document.dispatchEvent(new Event("visibilitychange")));
}
function data(user: AccountProfile | null = null): LobbyGameRatings {
  return {
    viewer:
      user && !user.isGuest ? { profileId: user.profileId ?? null, username: user.username } : null,
    games: Object.fromEntries(
      ratedLaunchGames.map((game) => [game, { enabled: true, summary: null }]),
    ) as LobbyGameRatings["games"],
  };
}
function session(user: AccountProfile | null, child: ReactNode) {
  return (
    <AccountContext.Provider
      value={{ user, loading: false, error: null, refresh: async () => {}, update() {} }}
    >
      {child}
    </AccountContext.Provider>
  );
}
function LocationView() {
  const location = useLocation();
  return <output>{location.pathname + location.search}</output>;
}
async function open(user: AccountProfile | null = null, game?: RatedMatchmakingGame) {
  const view = render(
    wrap(user)(
      <>
        <RatedLaunchAnnouncement game={game} />
        <LocationView />
      </>,
    ),
  );
  clock.advance(0);
  latest().respond(data(user));
  await flush();
  clock.advance(0);
  await flush();
  expect(dialog()).not.toBeNull();
  return view;
}
beforeEach(() => {
  localStorage.removeItem(ratedLaunchSeenKey);
  visibility("visible");
  lastLobbyGame.visit("/games/four-reversi");
});
for (const [name, Page] of [
  ["総合", GeneralLobbyPage],
  ["four-shogi", FourShogiLobbyPage],
  ["four-reversi", FourReversiLobbyPage],
  ["shogi", ShogiLobbyPage],
  ["reversi", ReversiLobbyPage],
] as const) {
  test(`${name}の実ロビーで表示し、総合は既存の取得を共用する`, async () => {
    const router = createMemoryRouter([{ path: "*", element: session(null, <Page />) }], {
      initialEntries: [name === "総合" ? "/" : `/games/${name}`],
    });
    render(<RouterProvider router={router} />);
    clock.advance(0);
    expect(requests.filter((r) => r.url === path)).toHaveLength(1);
    latest().respond(data());
    await flush();
    clock.advance(0);
    await flush();
    expect(dialog().textContent).toContain("レート戦が開幕しました！");
    expect(dialog().textContent).toContain("認定戦5局");
    expect(seen()).toBe("1");
    expect([...dialog().querySelectorAll("[aria-pressed]")].map((b) => b.textContent)).toEqual([
      "四人将棋",
      "四人リバーシ",
      "将棋",
      "リバーシ",
    ]);
    expect(dialog().querySelector('[aria-pressed="true"]')).not.toBeNull();
  });
}
for (const [name, Page] of [
  ["gomoku", GomokuLobbyPage],
  ["four-gomoku", FourGomokuLobbyPage],
] as const) {
  test(`${name}では取得・既読化しない`, () => {
    const router = createMemoryRouter([{ path: "*", element: session(null, <Page />) }], {
      initialEntries: [`/games/${name}`],
    });
    render(<RouterProvider router={router} />);
    clock.advance(0);
    expect(requests.some((r) => r.url === path)).toBe(false);
    expect(seen()).toBeNull();
  });
}
for (const user of [null, guestProfile(), profile]) {
  test(`${user?.isGuest ? "ゲスト" : user ? "登録者" : "未ログイン"}の文言と操作`, async () => {
    await open(user);
    expect(dialog().textContent).toContain(
      user && !user.isGuest
        ? "さっそくレート戦に参加しましょう！"
        : "アカウントを連携して、レート戦に参加しましょう！",
    );
    expect(Boolean(dialog().textContent?.includes("Googleで続ける"))).toBe(
      !user || Boolean(user.isGuest),
    );
    expect(requests.some((r) => r.url.includes("/join"))).toBe(false);
  });
}
test("ゲーム移動・認証切替・再マウントで既読を引き継ぎ追加取得しない", async () => {
  const view = await open();
  press(dialog(), "あとで");
  await flush();
  const count = requests.length;
  rerender(view, wrap(profile)(<RatedLaunchAnnouncement game="shogi" />));
  clock.advance(0);
  expect(dialog()).toBeNull();
  expect(requests.length).toBe(count);
  render(wrap(guestProfile())(<RatedLaunchAnnouncement game="reversi" />));
  clock.advance(0);
  expect(requests.length).toBe(count);
});
test("StrictModeでも1つだけ表示し、×で閉じても再表示しない", async () => {
  const view = render(
    wrap()(
      <StrictMode>
        <RatedLaunchAnnouncement />
      </StrictMode>,
    ),
  );
  clock.advance(0);
  latest().respond(data());
  await flush();
  clock.advance(0);
  await flush();
  expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
  act(() => dialog().querySelector<HTMLButtonElement>('[aria-label="閉じる"]')!.click());
  await flush();
  expect(dialog()).toBeNull();
  rerender(view, wrap()(<RatedLaunchAnnouncement />));
  clock.advance(0);
  expect(dialog()).toBeNull();
});
test("Escapeでも既読を保持する", async () => {
  await open();
  act(() => dialog().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  await flush();
  expect(dialog()).toBeNull();
  expect(seen()).toBe("1");
});
test("停止・取得失敗では既読化せず、復帰時の再取得で表示する", async () => {
  render(wrap()(<RatedLaunchAnnouncement game="shogi" />));
  clock.advance(0);
  const stopped = data();
  stopped.games.shogi.enabled = false;
  latest().respond(stopped);
  await flush();
  clock.advance(0);
  expect(dialog()).toBeNull();
  expect(seen()).toBeNull();
  visibility("hidden");
  visibility("visible");
  latest().respond({}, 503);
  await flush();
  clock.advance(0);
  expect(seen()).toBeNull();
  visibility("hidden");
  visibility("visible");
  latest().respond(data());
  await flush();
  clock.advance(0);
  await flush();
  expect(dialog()).not.toBeNull();
});
test("非表示では取得・表示せず、復帰後に確認する", async () => {
  visibility("hidden");
  render(wrap()(<RatedLaunchAnnouncement />));
  clock.advance(0);
  expect(requests).toHaveLength(0);
  visibility("visible");
  latest().respond(data());
  await flush();
  clock.advance(0);
  await flush();
  expect(seen()).toBe("1");
});
for (const event of ["pointerdown", "keydown", "wheel"] as const) {
  test(`${event}操作は遅延応答の案内より優先する`, async () => {
    render(wrap()(<RatedLaunchAnnouncement />));
    clock.advance(0);
    const pending = latest();
    act(() => document.body.dispatchEvent(new Event(event, { bubbles: true })));
    pending.respond(data());
    await flush();
    clock.advance(0);
    expect(dialog()).toBeNull();
    expect(seen()).toBeNull();
  });
}
for (const entry of [
  "/?matchmaking=1",
  { pathname: "/", state: { roomEntryIntent: "create" } },
  { pathname: "/", state: { registrationReturn: { path: "/" } } },
  "/?guestMerge=1",
]) {
  test(`目的付き遷移を優先 ${JSON.stringify(entry)}`, () => {
    render(wrap(null, entry)(<RatedLaunchAnnouncement />));
    clock.advance(0);
    expect(requests).toHaveLength(0);
    expect(seen()).toBeNull();
  });
}
test("他のダイアログが先に開いた訪問は見送る", async () => {
  const view = render(wrap()(<RatedLaunchAnnouncement />));
  clock.advance(0);
  const pending = latest();
  rerender(
    view,
    wrap()(
      <>
        <RatedLaunchAnnouncement />
        <AppDialog title="既存の操作" onClose={() => {}}>
          内容
        </AppDialog>
      </>,
    ),
  );
  await flush();
  pending.respond(data());
  await flush();
  clock.advance(0);
  expect(dialog().textContent).toContain("既存の操作");
  expect(seen()).toBeNull();
});
test("別タブが既読にしたら待機中の案内を出さない", async () => {
  render(wrap()(<RatedLaunchAnnouncement />));
  clock.advance(0);
  const pending = latest();
  localStorage.setItem(ratedLaunchSeenKey, "1");
  const event = new Event("storage");
  Object.defineProperty(event, "key", { value: ratedLaunchSeenKey });
  act(() => window.dispatchEvent(event));
  pending.respond(data());
  await flush();
  clock.advance(0);
  expect(dialog()).toBeNull();
});
for (const method of ["getItem", "setItem"] as const) {
  test(`保存の${method}が失敗する環境は自動表示しない`, async () => {
    const original = localStorage[method];
    Object.defineProperty(localStorage, method, {
      configurable: true,
      value: () => {
        throw new Error("denied");
      },
    });
    try {
      render(wrap()(<RatedLaunchAnnouncement />));
      clock.advance(0);
      if (latest()) {
        latest().respond(data());
        await flush();
        clock.advance(0);
      }
      expect(dialog()).toBeNull();
    } finally {
      Object.defineProperty(localStorage, method, { configurable: true, value: original });
    }
  });
}
test("破棄後は取得応答・タイマーから表示しない", async () => {
  const view = render(wrap()(<RatedLaunchAnnouncement />));
  clock.advance(0);
  const pending = latest();
  rerender(view, <p>移動済み</p>);
  pending.respond(data());
  await flush();
  clock.advance(1000);
  expect(dialog()).toBeNull();
  expect(seen()).toBeNull();
});
test("受付中だけを並べ、直近が停止中なら先頭を初期選択する", async () => {
  render(wrap()(<RatedLaunchAnnouncement />));
  clock.advance(0);
  const result = data();
  result.games["four-reversi"].enabled = false;
  latest().respond(result);
  await flush();
  clock.advance(0);
  await flush();
  expect([...dialog().querySelectorAll("[aria-pressed]")].map((b) => b.textContent)).toEqual([
    "四人将棋",
    "将棋",
    "リバーシ",
  ]);
  expect(dialog().querySelector('[aria-pressed="true"]')?.textContent).toBe("四人将棋");
});
test("登録者は選択ゲームの参加画面へ進み、検索を自動開始しない", async () => {
  const view = await open(profile, "shogi");
  expect(dialog().querySelector('[aria-pressed="true"]')?.textContent).toBe("将棋");
  press(dialog(), "リバーシ");
  press(dialog(), "レート戦に参加する");
  await flush();
  expect(view.querySelector("output")?.textContent).toBe("/games/reversi?matchmaking=1");
  expect(requests.some((r) => r.url.includes("/join"))).toBe(false);
});
test("プロフィール未完了は初回設定へ進む", async () => {
  const view = await open({ ...profile, profileCompleted: false });
  press(dialog(), "レート戦に参加する");
  await flush();
  expect(view.querySelector("output")?.textContent).toBe("/account/setup");
});
for (const provider of ["google", "discord"] as const) {
  test(`${provider}直接連携・失敗・再試行と設定完了後の復帰`, async () => {
    const assign = spyOn(window.location, "assign").mockImplementation(() => {});
    try {
      await open(guestProfile(), "shogi");
      const label = provider === "google" ? "Googleで続ける" : "Discordで続ける";
      press(dialog(), "リバーシ");
      press(dialog(), label);
      press(dialog(), label);
      await flush();
      const oauth = () => requests.filter((r) => r.url === "/api/auth/sign-in/social");
      expect(oauth()).toHaveLength(1);
      expect(JSON.parse(String(oauth()[0]!.init.body))).toMatchObject({
        provider,
        analytics: { entry: "rated-match", game: "reversi" },
      });
      expect(readRegistrationReturn()).toMatchObject({
        path: "/games/reversi?matchmaking=1",
        oauthStarted: true,
      });
      for (const button of dialog().querySelectorAll("button")) expect(button.disabled).toBe(true);
      oauth()[0]!.respond({ message: "接続失敗" }, 503);
      await flush();
      expect(dialog().querySelector('[role="alert"]')?.textContent).toContain("接続失敗");
      press(dialog(), label);
      const url =
        provider === "google"
          ? "https://accounts.google.com/o/oauth2/auth"
          : "https://discord.com/oauth2/authorize";
      oauth()[1]!.respond({ url });
      await flush();
      expect(assign).toHaveBeenCalledWith(url);
      const node = (enabled: boolean) =>
        wrap(
          profile,
          "/account/setup",
        )(
          <>
            <RegistrationCompletion enabled={enabled}>
              <p>初回設定</p>
            </RegistrationCompletion>
            <LocationView />
          </>,
        );
      const view = render(node(false));
      expect(view.querySelector("output")?.textContent).toBe("/account/setup");
      rerender(view, node(true));
      await flush();
      expect(view.querySelector("output")?.textContent).toBe("/games/reversi?matchmaking=1");
      expect(seen()).toBe("1");
    } finally {
      assign.mockRestore();
    }
  });
}

test("認証の読み込み・失敗中は表示せず、確認できた状態でだけ文言を確定する", async () => {
  const content = (loading: boolean, error: string | null) => (
    <AccountContext.Provider
      value={{ user: profile, loading, error, refresh: async () => {}, update() {} }}
    >
      <RatedLaunchAnnouncement />
    </AccountContext.Provider>
  );
  const view = render(wrap()(content(true, null)));
  clock.advance(0);
  expect(requests).toHaveLength(0);
  rerender(view, wrap()(content(false, "確認失敗")));
  clock.advance(0);
  expect(seen()).toBeNull();
  expect(requests).toHaveLength(0);
  rerender(view, wrap()(content(false, null)));
  clock.advance(0);
  latest().respond(data(profile));
  await flush();
  clock.advance(0);
  await flush();
  expect(dialog().textContent).toContain("さっそくレート戦に参加しましょう！");
});
test("全ゲーム停止中は既読にせず、総合ロビーで受付再開を確認したら表示する", async () => {
  render(wrap()(<RatedLaunchAnnouncement />));
  clock.advance(0);
  const stopped = data();
  for (const game of ratedLaunchGames) stopped.games[game].enabled = false;
  latest().respond(stopped);
  await flush();
  clock.advance(0);
  expect(dialog()).toBeNull();
  expect(seen()).toBeNull();
  visibility("hidden");
  visibility("visible");
  latest().respond(data());
  await flush();
  clock.advance(0);
  await flush();
  expect(dialog()).not.toBeNull();
});
