import { expect, test } from "bun:test";
import { createMemoryRouter, NavigationType, RouterProvider } from "react-router";
import { type GameId, gameCatalog, gameIds } from "@tetraboard/protocol/games";
import { type MatchSummary } from "@tetraboard/protocol";
import { AccountLayout } from "../src/features/account/AccountSession";
import { BoardAuthor } from "../src/features/board/BoardAuthor";
import { PlayerProfileProvider } from "../src/features/players/PlayerProfileProvider";
import { PlayerProfileTrigger } from "../src/features/players/PlayerProfileTrigger";
import { PublicPlayerPage } from "../src/features/players/PublicPlayerPage";
import { startPageMetadata } from "../src/seo/pageMetadata";
import { match } from "../test/fixtures/matchSummary";
import { profile as signedIn } from "../test/fixtures/account";
import { act, flush, press, render, requests } from "./harness";

const playerId = "10000000-0000-4000-8000-000000000001";
const otherId = "20000000-0000-4000-8000-000000000002";
const viewerId = "40000000-0000-4000-8000-000000000004";
const pagePath = `/players/${playerId}`;
const otherPath = `/players/${otherId}`;
const usernamePath = "/users/@public_player";
const otherUsernamePath = "/users/@other_player";
const boardSource = "/posts/1001?from=timeline#reply-1002";
const zero = { total: 0, wins: 0, losses: 0, draws: 0 };
const reversiMatch: MatchSummary = {
  game: "reversi",
  id: "30000000-0000-4000-8000-000000000003",
  startedAtMs: 1_700_000_000_000,
  endedAtMs: 1_700_000_000_500,
  participants: [
    {
      id: playerId,
      kind: "human",
      name: "公開プレイヤー",
      color: "black",
      seat: 0,
      avatarUrl: null,
    },
    { id: otherId, kind: "cpu", name: "CPU Lv1", color: "white", seat: 1, level: 1 },
  ],
  result: { reason: "board_full", winner: null, stoneCounts: { black: 32, white: 32 } },
};

function player(game: GameId, profileId = playerId) {
  return {
    kind: "account",
    profileId,
    game,
    name: "公開プレイヤー",
    username: profileId === otherId ? "other_player" : "public_player",
    avatarUrl: null,
    profileMessage: "対局よろしくお願いします",
    favoriteGames: ["reversi"],
    stats: gameCatalog[game].hasModes
      ? { singles: { total: 3, first: 1 }, doubles: { total: 4, wins: 2 } }
      : zero,
  };
}
const legacyPlayer = (game: GameId, profileId = playerId) => ({
  ...player(game, profileId),
  username: null,
});
const profiles = () => requests.filter((request) => request.url.startsWith("/api/player-profile?"));
const histories = () =>
  requests.filter(({ url }) => url.startsWith("/api/players/") && url.includes("/matches?"));
const session = () => requests.findLast((request) => request.url === "/api/account/session")!;
const ratings = () =>
  requests.filter(({ url }) => url.startsWith("/api/players/") && url.endsWith("/game-ratings"));
const games = {
  "four-reversi": { status: "rated", rating: 1620 },
  "four-shogi": { status: "placement", games: 2 },
  reversi: { status: "rated", rating: 1501 },
  shogi: { status: "placement", games: 0 },
};
const gameButtons = (view: HTMLElement) => [
  ...view.querySelectorAll<HTMLButtonElement>('[aria-label="プロフィールのゲーム"] button'),
];
const gameButton = (view: HTMLElement, game: GameId) =>
  gameButtons(view).find((button) => button.textContent?.startsWith(gameCatalog[game].name))!;

function open(initialEntry = pagePath, sameUrlLink = false) {
  const author = {
    name: "掲示板の投稿者",
    avatarUrl: null,
    profileTarget: { source: "profile" as const, profileId: playerId },
  };
  const publicAuthor = { ...author, username: "public_player" };
  const router = createMemoryRouter(
    [
      {
        element: (
          <PlayerProfileProvider>
            <AccountLayout />
          </PlayerProfileProvider>
        ),
        children: [
          {
            path: "/lobby",
            element: (
              <PlayerProfileTrigger
                target={{ source: "profile", profileId: playerId }}
                game="four-shogi"
                mode="doubles"
                label="カードの名前"
              >
                カードの名前
              </PlayerProfileTrigger>
            ),
          },
          {
            path: "/posts/:id",
            element: (
              <>
                <BoardAuthor author={author} game="four-shogi" />
                <BoardAuthor author={publicAuthor} game="four-shogi" />
              </>
            ),
          },
          { path: "/players/:profileId", element: <PublicPlayerPage /> },
          {
            path: "/users/:handle",
            element: (
              <>
                <PublicPlayerPage />
                {sameUrlLink && <BoardAuthor author={publicAuthor} game="four-shogi" />}
              </>
            ),
          },
          { path: "/matches/:matchId", element: <p>公開棋譜の画面</p> },
          { path: "/account", element: <p>マイページ</p> },
          { path: "/account/setup", element: <p>初回設定の画面</p> },
        ],
      },
    ],
    { initialEntries: [initialEntry] },
  );
  const view = render(<RouterProvider router={router} />);
  return { view, router };
}

const backButton = (view: HTMLElement) =>
  [...view.querySelectorAll("main button")].find((button) => button.textContent === "戻る");

test.each(["/lobby", boardSource, `${usernamePath}?game=four-shogi&mode=singles`])(
  "%s から通常の公開IDを開くと現在の所有者を表示する",
  async (source) => {
    const { view, router } = open(source);
    const direct = source.startsWith(usernamePath);
    session().respond({ user: { ...signedIn, profileId: playerId } });
    await flush();
    if (source === "/lobby") {
      press(view, "カードの名前");
      await flush();
      profiles()[0]!.respond(player("four-shogi"));
      await flush();
    }
    if (!direct) {
      act(() => document.querySelector<HTMLAnchorElement>(`a[href^="${usernamePath}?"]`)!.click());
      await flush();
    }

    const currentOwner = {
      ...player("four-shogi", otherId),
      username: "public_player",
      name: "現在の所有者",
    };
    profiles().at(-1)!.respond(currentOwner);
    await flush();
    expect(view.querySelector("h1")?.textContent).toBe(currentOwner.name);
    expect(histories()[0]!.url).toStartWith(`/api${otherPath}/matches?`);
    expect(ratings()[0]!.url).toBe(`/api${otherPath}/game-ratings`);
    if (direct) {
      expect(backButton(view)).toBeUndefined();
    } else {
      press(view, "戻る");
      await flush();
      const { pathname, search, hash } = router.state.location;
      expect(pathname + search + hash).toBe(source);
    }
  },
);

test("ロビーの名前リンクから開き、モード・ゲーム切替後も元のURLと履歴stateへ戻る", async () => {
  const source = "/lobby?lobbyTab=rankings#ranking";
  const { view, router } = open(source);
  session().respond({ user: null });
  await flush();
  const sourceState = { restore: "rankings" };
  await act(async () => router.navigate(source, { replace: true, state: sourceState }));

  press(view, "カードの名前");
  await flush();
  profiles()[0]!.respond(player("four-shogi"));
  await flush();
  act(() => document.querySelector<HTMLAnchorElement>(`a[href^="${usernamePath}?"]`)!.click());
  await flush();
  expect(router.state.historyAction).toBe(NavigationType.Push);
  profiles()[1]!.respond(player("four-shogi"));
  await flush();
  expect(backButton(view)).toBe(view.querySelector("main")!.firstElementChild!);
  press(view, "シングルス");
  await flush();
  expect(router.state.historyAction).toBe(NavigationType.Push);
  press(view, "シングルス");
  press(view, "リバーシ");
  await flush();
  expect(router.state.historyAction).toBe(NavigationType.Push);
  press(view, "リバーシ");
  await flush();
  expect(router.state.location.search).toBe("?game=reversi");
  await act(async () => router.navigate(-1));
  expect(router.state.location.search).toBe("?game=four-shogi&mode=singles");
  await act(async () => router.navigate(-1));
  expect(router.state.location.search).toBe("?game=four-shogi&mode=doubles");
  await act(async () => router.navigate(1));
  expect(router.state.location.search).toBe("?game=four-shogi&mode=singles");
  await act(async () => router.navigate(1));
  expect(router.state.location.search).toBe("?game=reversi");
  press(view, "戻る");
  await flush();
  expect(router.state.historyAction).toBe(NavigationType.Pop);
  expect(router.state.location).toMatchObject({
    pathname: "/lobby",
    search: "?lobbyTab=rankings",
    hash: "#ranking",
    state: sourceState,
  });
  await act(async () => router.navigate(1));
  expect(router.state.location.search).toBe("?game=four-shogi&mode=doubles");
  expect(backButton(view)).toBeDefined();
});

test("投稿者リンクは旧URLと同じURLの置換後も本人照合と掲示板への戻り先を保つ", async () => {
  const { view, router } = open(boardSource, true);
  session().respond({ user: null });
  await flush();
  const clickAuthor = (path: string) =>
    act(() => view.querySelector<HTMLAnchorElement>(`a[href^="${path}?"]`)!.click());
  clickAuthor(pagePath);
  await flush();
  expect(router.state.location.pathname).toBe(pagePath);
  expect(router.state.location.state?.expectedProfileId).toBeUndefined();
  profiles()[0]!.respond(player("four-shogi"));
  await flush();
  expect(router.state.location.pathname).toBe(usernamePath);
  expect(router.state.historyAction).toBe(NavigationType.Replace);
  expect(router.state.location.state.expectedProfileId).toBe(playerId);
  profiles()[1]!.respond(player("four-shogi"));
  await flush();
  press(view, "ダブルス");
  await flush();
  press(view, "シングルス");
  await flush();
  clickAuthor(usernamePath);
  await flush();
  expect(router.state.historyAction).toBe(NavigationType.Replace);
  expect(router.state.location.state.expectedProfileId).toBe(playerId);
  press(view, "リバーシ");
  await flush();
  profiles()
    .at(-1)!
    .respond({ ...player("reversi", otherId), username: "public_player" });
  await flush();
  expect(view.textContent).toContain("プロフィールを表示できません。");
  press(view, "戻る");
  await flush();
  expect(router.state.location).toMatchObject({
    pathname: "/posts/1001",
    search: "?from=timeline",
    hash: "#reply-1002",
  });
});

test("共有URLで直接開き、同じURLへのリンクで履歴を置き換えても戻るは表示しない", async () => {
  const { view, router } = open(`${usernamePath}?game=four-shogi&mode=singles`, true);
  session().respond({ user: null });
  await flush();
  profiles()[0]!.respond(player("four-shogi"));
  await flush();
  expect(backButton(view)).toBeUndefined();
  act(() => view.querySelector<HTMLAnchorElement>(`a[href^="${usernamePath}?"]`)!.click());
  await flush();
  expect(router.state.historyAction).toBe(NavigationType.Replace);
  press(view, "ダブルス");
  await flush();
  expect(backButton(view)).toBeUndefined();
});

test("本人のカード内の名前リンクは再確認中でもマイページへ移動し、戻るとロビーを開く", async () => {
  const { view, router } = open("/lobby");
  session().respond({ user: { ...signedIn, profileId: playerId } });
  await flush();
  press(view, "カードの名前");
  await flush();
  profiles()[0]!.respond(player("four-shogi"));
  await flush();

  act(() => window.dispatchEvent(new Event("focus")));
  act(() => document.querySelector<HTMLAnchorElement>(`a[href^="${usernamePath}?"]`)!.click());
  await flush();
  expect(router.state.location.pathname).toBe(usernamePath);
  expect(backButton(view)).toBeUndefined();
  profiles()[1]!.respond(player("four-shogi"));
  await flush();
  expect(router.state.historyAction).toBe(NavigationType.Replace);
  expect(router.state.location.pathname).toBe("/account");
  expect(router.state.location.search).toBe("");
  expect(router.state.location.state.accountSelection).toMatchObject({
    game: "four-shogi",
    modes: { "four-shogi": "doubles" },
  });
  expect(view.textContent).toContain("マイページ");
  expect(backButton(view)).toBeUndefined();
  expect(profiles()).toHaveLength(2);
  expect(histories()).toHaveLength(0);
  expect(ratings()).toHaveLength(0);

  await act(async () => router.navigate(-1));
  expect(router.state.location.pathname).toBe("/lobby");
});

test("直アクセスでは本人の確認を待ち、公開プロフィールと棋譜を読み込まずにマイページへ移動する", async () => {
  const { view, router } = open(`${pagePath}?game=reversi&mode=doubles`);
  await flush();
  expect(router.state.location.pathname).toBe(pagePath);
  expect(view.textContent).toContain("ログイン状態を確認しています…");
  expect(view.querySelector("h1")).toBeNull();
  expect(view.querySelector('[aria-labelledby="public-player-matches"]')).toBeNull();

  session().respond({ user: { ...signedIn, profileId: playerId, isGuest: true } });
  await flush();
  expect(router.state.historyAction).toBe(NavigationType.Replace);
  expect(router.state.location.pathname).toBe("/account");
  expect(router.state.location.state.accountSelection).toMatchObject({
    game: "reversi",
    modes: { reversi: "singles" },
  });
  expect(view.textContent).toContain("マイページ");
  expect(profiles()).toHaveLength(0);
  expect(histories()).toHaveLength(0);
  expect(ratings()).toHaveLength(0);
});

test.each([
  ["未ログイン", null],
  ["別アカウント", { ...signedIn, profileId: otherId }],
] as const)(
  "%sで再確認中も公開ページを保持し、本人と判明したらマイページへ移動する",
  async (_, user) => {
    const { view, router } = open(`${usernamePath}?game=reversi`);
    session().respond({ user });
    await flush();
    profiles()[0]!.respond(player("reversi"));
    await flush();
    histories()[0]!.respond({ matches: [reversiMatch] });
    await flush();

    act(() => window.dispatchEvent(new Event("focus")));
    const replayLink = `a[href="/matches/${reversiMatch.id}"]`;
    expect(view.querySelector("h1")?.textContent).toBe("公開プレイヤー");
    expect(view.querySelector(replayLink)).not.toBeNull();
    session().respond({ user });
    await flush();
    expect(router.state.location.pathname).toBe(usernamePath);
    expect(view.querySelector(replayLink)).not.toBeNull();
    expect(profiles()).toHaveLength(1);
    expect(histories()).toHaveLength(1);
    expect(ratings()).toHaveLength(1);

    act(() => window.dispatchEvent(new Event("focus")));
    session().respond({ user: { ...signedIn, profileId: playerId } });
    await flush();
    expect(router.state.historyAction).toBe(NavigationType.Replace);
    expect(router.state.location.pathname).toBe("/account");
    expect(view.querySelector(replayLink)).toBeNull();
    expect(profiles()).toHaveLength(1);
    expect(histories()).toHaveLength(1);
    expect(ratings()).toHaveLength(1);
  },
);

test("未ログインでカード内の名前リンクから四人将棋ダブルスを開き、棋譜を往復しても選択と公開IDを保つ", async () => {
  const { view, router } = open("/lobby");
  session().respond({ user: null });
  press(view, "カードの名前");
  await flush();
  profiles()[0]!.respond({
    ...player("four-shogi"),
    rating: { timing: "before", status: "rated", rating: 1480 },
  });
  await flush();
  const link = document.querySelector<HTMLAnchorElement>(`a[href^="${usernamePath}?"]`)!;
  expect(link.textContent).toBe("公開プレイヤー");
  act(() => link.click());
  await flush();
  expect(router.state.location.search).toBe("?game=four-shogi&mode=doubles");
  expect(profiles()[1]!.url).toBe(
    "/api/player-profile?source=username&username=public_player&game=four-shogi&includeBadges=1&includeStats=1&includeDetails=1",
  );
  profiles()[1]!.respond(player("four-shogi"));
  await flush();
  histories()[0]!.respond({ matches: [] });
  await flush();
  expect(view.querySelector('button[aria-pressed="true"]')?.textContent).toBe("四人将棋");
  expect(view.textContent).toContain("4局 2勝 (.500)");
  expect(view.textContent).toContain("対人戦のみ集計");
  expect(view.textContent).not.toContain("現在のレート");
  expect(view.textContent).not.toContain("1480");
  expect(view.textContent).toContain("対局よろしくお願いします");
  expect(view.querySelector('[aria-label="お気に入りゲーム"]')?.textContent).toContain("リバーシ");

  press(view, "リバーシ");
  await flush();
  expect(router.state.location.search).toBe("?game=reversi");
  profiles().at(-1)!.respond(player("reversi"));
  await flush();
  expect(histories().at(-1)!.url).toBe(`/api${pagePath}/matches?game=reversi`);
  histories()
    .at(-1)!
    .respond({ matches: [reversiMatch] });
  await flush();
  expect(view.textContent).toContain("0局 0勝0敗0分 (.000)");
  expect(view.textContent).toContain("対人戦/レート戦を集計");
  expect(view.textContent).toContain("CPUあり");
  expect(view.querySelector('[aria-label="プロフィールの対局モード"]')).toBeNull();

  act(() =>
    view.querySelector<HTMLAnchorElement>(`a[href="/matches/${reversiMatch.id}"]`)!.click(),
  );
  await flush();
  expect(view.textContent).toContain("公開棋譜の画面");
  await act(async () => router.navigate(-1));
  expect(router.state.location.pathname).toBe(usernamePath);
  expect(router.state.location.search).toBe("?game=reversi");
  profiles().at(-1)!.respond(player("reversi"));
  await flush();
  histories()
    .at(-1)!
    .respond({ matches: [reversiMatch] });
  await flush();
  expect(view.textContent).toContain("@public_player");
  expect(view.querySelector('button[aria-pressed="true"]')?.textContent).toBe("リバーシ");
  expect(requests.every((request) => !request.init.method || request.init.method === "GET")).toBe(
    true,
  );
});

test("ゲームを切り替えてもヘッダーロゴは標準テーマで、本文だけがゲームテーマに切り替わる", async () => {
  const { view } = open();
  session().respond({ user: null });
  await flush();
  const logo = view.querySelector('header a[aria-label="TetraBoard ロビー"] .text-brand')!;
  const main = view.querySelector("main")!;
  const gameTheme = '[class*="game-theme-"]';
  expect(logo.closest(gameTheme)?.className).toBeUndefined();
  expect(main.closest(gameTheme)?.className).toBeUndefined();

  press(view, "四人将棋");
  await flush();
  expect(logo.closest(gameTheme)?.className).toBeUndefined();
  expect(main.closest(gameTheme)?.classList.contains("game-theme-four-shogi")).toBe(true);

  press(view, "四人リバーシ");
  await flush();
  expect(logo.closest(gameTheme)?.className).toBeUndefined();
  expect(main.closest(gameTheme)?.className).toBeUndefined();
});

test("直リンクの既定、6ゲーム、四人ゲームのモード切替と初回設定前の閲覧", async () => {
  const { view, router } = open(usernamePath);
  const stop = startPageMetadata(router);
  try {
    expect(document.title).toBe("プレイヤーページ | TetraBoard");
    expect(document.querySelector('meta[name="robots"]')?.getAttribute("content")).toBe(
      "noindex,follow",
    );
    session().respond({
      user: { ...signedIn, profileId: otherId, name: "", username: null, profileCompleted: false },
    });
    await flush();
    profiles()[0]!.respond(player("four-reversi"));
    await flush();
    histories()[0]!.respond({ matches: [] });
    await flush();
    expect(router.state.location.pathname).toBe(usernamePath);
    expect(histories()[0]!.url).toEndWith("?game=four-reversi&mode=singles");
    expect(view.querySelector("h1")?.textContent).toBe("公開プレイヤー");
    expect(view.textContent).toContain("3局 1優勝 (.333)");
    expect(view.querySelectorAll('[aria-label="プロフィールのゲーム"] button')).toHaveLength(6);
    press(view, "ダブルス");
    await flush();
    expect(profiles()).toHaveLength(1);
    expect(view.textContent).toContain("4局 2勝 (.500)");
    expect(histories()[1]!.url).toEndWith("?game=four-reversi&mode=doubles");
    histories()[1]!.respond({ matches: [] });
    await act(async () => router.navigate(-1));
    expect(router.state.location.search).toBe("");
    expect(view.textContent).toContain("3局 1優勝 (.333)");

    for (const game of gameIds.filter((id) => id !== "four-reversi")) {
      press(view, gameCatalog[game].name);
      await flush();
      const mode = gameCatalog[game].hasModes ? "&mode=singles" : "";
      expect(router.state.location.search).toBe(`?game=${game}${mode}`);
      expect(profiles().at(-1)!.url).toContain(`&game=${game}&`);
      profiles().at(-1)!.respond(player(game));
      await flush();
      expect(histories().at(-1)!.url).toEndWith(router.state.location.search);
      histories().at(-1)!.respond({ matches: [] });
      await flush();
      expect(Boolean(view.querySelector('[aria-label="プロフィールの対局モード"]'))).toBe(
        Boolean(mode),
      );
    }
  } finally {
    stop();
  }
});

test("公開レートは対象UUIDの全ゲームを一度で取得し、閲覧者やゲーム・モードによって変わらない", async () => {
  const { view, router } = open(usernamePath);
  session().respond({ user: { ...signedIn, profileId: viewerId } });
  await flush();
  expect(ratings()).toHaveLength(0);
  expect(histories()).toHaveLength(0);
  profiles()[0]!.respond({
    ...player("four-reversi"),
    rating: { timing: "current", status: "rated", rating: 1620 },
  });
  await flush();
  expect(ratings()[0]!.url).toBe(`/api${pagePath}/game-ratings`);
  expect(ratings()[0]!.init.cache).toBe("no-store");
  ratings()[0]!.respond({ profileId: playerId, games });
  await flush();
  expect(gameButton(view, "four-reversi").querySelector("strong")?.textContent).toBe("1620");
  expect(gameButton(view, "four-shogi").querySelector("strong")?.textContent).toBe("認定戦 2/5");
  expect(gameButton(view, "reversi").querySelector("strong")?.textContent).toBe("1501");
  expect(gameButton(view, "shogi").querySelector("strong")?.textContent).toBe("認定戦 0/5");
  expect(gameButton(view, "gomoku").querySelector("strong")).toBeNull();
  expect(gameButton(view, "four-gomoku").querySelector("strong")).toBeNull();
  const stats = view.querySelector('[aria-labelledby="public-player-stats"]')!;
  expect(stats.textContent).toContain("3局 1優勝 (.333)");
  expect(stats.textContent).not.toContain("1620");
  press(view, "ダブルス");
  await flush();
  expect(stats.textContent).toContain("4局 2勝 (.500)");
  expect(gameButton(view, "shogi").querySelector("strong")?.textContent).toBe("認定戦 0/5");
  act(() => gameButton(view, "reversi").click());
  await flush();
  expect(router.state.location.search).toBe("?game=reversi");
  expect(gameButtons(view).every((button) => !button.querySelector("strong"))).toBe(true);
  expect(profiles()).toHaveLength(2);
  expect(ratings()).toHaveLength(1);
  expect(requests.some((request) => request.url === "/api/lobby/game-ratings")).toBe(false);
  profiles()[1]!.respond(player("reversi"));
  await flush();
  expect(gameButton(view, "shogi").querySelector("strong")?.textContent).toBe("認定戦 0/5");
  expect(ratings()).toHaveLength(1);

  act(() => gameButton(view, "four-shogi").click());
  await flush();
  expect(gameButtons(view).every((button) => !button.querySelector("strong"))).toBe(true);
  profiles()[2]!.respond({
    ...player("four-shogi", otherId),
    username: "public_player",
    name: "現在の所有者",
  });
  await flush();
  expect(gameButtons(view).every((button) => !button.querySelector("strong"))).toBe(true);
  expect(view.querySelector("h1")?.textContent).toBe("現在の所有者");
  expect(histories().at(-1)!.url).toBe(`/api${otherPath}/matches?game=four-shogi&mode=singles`);
  expect(ratings()[1]!.url).toBe(`/api${otherPath}/game-ratings`);
  ratings()[1]!.respond({
    profileId: otherId,
    games: { ...games, reversi: { status: "rated", rating: 1740 } },
  });
  await flush();
  expect(gameButton(view, "reversi").querySelector("strong")?.textContent).toBe("1740");

  await act(async () => router.navigate(otherPath));
  expect(gameButtons(view).every((button) => !button.querySelector("strong"))).toBe(true);
  profiles()
    .at(-1)!
    .respond({ ...player("four-reversi", otherId), isGuest: true });
  ratings().at(-1)!.respond({ profileId: otherId, games: null });
  await flush();
  expect(gameButtons(view).every((button) => !button.querySelector("strong"))).toBe(true);
});

test("別UUIDのレートが先着してもプロフィール確認前後やゲーム切替中に表示しない", async () => {
  const { view } = open();
  session().respond({ user: null });
  await flush();
  ratings()[0]!.respond({ profileId: otherId, games });
  await flush();
  expect(gameButtons(view).every((button) => !button.querySelector("strong"))).toBe(true);
  profiles()[0]!.respond(legacyPlayer("four-reversi"));
  await flush();
  expect(view.textContent).toContain("3局 1優勝 (.333)");
  expect(gameButtons(view).every((button) => !button.querySelector("strong"))).toBe(true);
  press(view, "リバーシ");
  await flush();
  expect(gameButtons(view).every((button) => !button.querySelector("strong"))).toBe(true);
});

test("レート取得の全体失敗・ゲーム別失敗を認定0局と区別し、旧プレイヤーの応答を破棄する", async () => {
  const { view, router } = open();
  session().respond({ user: null });
  await flush();
  profiles()[0]!.respond(legacyPlayer("four-reversi"));
  ratings()[0]!.respond({}, 503);
  await flush();
  expect(view.textContent).toContain("3局 1優勝 (.333)");
  expect(gameButtons(view).every((button) => !button.querySelector("strong"))).toBe(true);

  await act(async () => router.navigate(otherPath));
  const previous = ratings().at(-1)!;
  await act(async () => router.navigate(pagePath));
  expect(previous.init.signal?.aborted).toBe(true);
  previous.respond({ profileId: otherId, games });
  await flush();
  expect(gameButtons(view).every((button) => !button.querySelector("strong"))).toBe(true);
  profiles().at(-1)!.respond(legacyPlayer("four-reversi"));
  ratings()
    .at(-1)!
    .respond({ profileId: playerId, games: { ...games, reversi: { status: "error" } } });
  await flush();
  expect(gameButton(view, "reversi").querySelector("strong")).toBeNull();
  expect(gameButton(view, "shogi").querySelector("strong")?.textContent).toBe("認定戦 0/5");
  press(view, "リバーシ");
  await flush();
  profiles().at(-1)!.respond({}, 503);
  await flush();
  expect(view.textContent).toContain("プレイヤー情報を取得できませんでした。");
  expect(gameButtons(view).every((button) => !button.querySelector("strong"))).toBe(true);
});

test("レートAPIだけが404のときは取得済みの公開プロフィールと棋譜を維持する", async () => {
  const { view } = open(`${pagePath}?game=reversi`);
  session().respond({ user: null });
  await flush();
  profiles()[0]!.respond(legacyPlayer("reversi"));
  histories()[0]!.respond({ matches: [reversiMatch] });
  await flush();
  ratings()[0]!.respond({}, 404);
  await flush();
  expect(view.querySelector("h1")?.textContent).toBe("公開プレイヤー");
  expect(view.querySelector(`a[href="/matches/${reversiMatch.id}"]`)).not.toBeNull();
  expect(gameButtons(view)).toHaveLength(6);
  expect(gameButtons(view).every((button) => !button.querySelector("strong"))).toBe(true);
});

test("取得失敗と空一覧を区別し、失敗した欄だけ再試行し、閲覧不可で表示済みの棋譜を消す", async () => {
  const { view } = open();
  session().respond({}, 503);
  await flush();
  profiles()[0]!.respond({}, 503);
  histories()[0]!.reject(new Error("オフライン"));
  await flush();
  expect(view.textContent).toContain("プレイヤー情報を取得できませんでした。");
  expect(view.textContent).toContain("公開棋譜を取得できませんでした。");
  expect(view.textContent).not.toContain("公開棋譜はありません。");
  const history = view.querySelector<HTMLElement>('[aria-labelledby="public-player-matches"]')!;
  press(history, "再試行");
  await flush();
  expect(profiles()).toHaveLength(1);
  histories()[1]!.respond({ matches: [] });
  await flush();
  expect(history.textContent).toContain("公開棋譜はありません。");

  press(view, "ダブルス");
  await flush();
  const saved = match(1, "doubles");
  histories()[2]!.respond({ matches: [saved] });
  await flush();
  expect(view.querySelector(`a[href="/matches/${saved.id}"]`)).not.toBeNull();
  press(view.querySelector("main")!, "再試行");
  await flush();
  expect(profiles()).toHaveLength(2);
  expect(histories()).toHaveLength(3);
  profiles()[1]!.respond({}, 404);
  await flush();
  expect(view.textContent).toContain("プロフィールを表示できません。");
  expect(view.querySelector(`a[href="/matches/${saved.id}"]`)).toBeNull();
});

test("棋譜が404になったプレイヤーは別モードへ戻って再取得が失敗しても再表示しない", async () => {
  const { view, router } = open(`${usernamePath}?game=four-reversi&mode=singles`);
  session().respond({ user: null });
  await flush();
  const saved = match(1);
  profiles()[0]!.respond(player("four-reversi"));
  await flush();
  histories()[0]!.respond({ matches: [saved] });
  ratings()[0]!.respond({ profileId: playerId, games });
  await flush();
  expect(view.textContent).toContain("@public_player");
  expect(view.textContent).toContain("3局 1優勝 (.333)");
  expect(gameButton(view, "four-reversi").querySelector("strong")?.textContent).toBe("1620");
  expect(view.querySelector(`a[href="/matches/${saved.id}"]`)).not.toBeNull();

  press(view, "ダブルス");
  await flush();
  histories()[1]!.respond({}, 404);
  await flush();
  expect(view.textContent).toContain("プロフィールを表示できません。");
  expect(gameButtons(view)).toHaveLength(0);

  const requestCount = requests.length;
  await act(async () => router.navigate(-1));
  expect(router.state.location.search).toBe("?game=four-reversi&mode=singles");
  const beforeResponse = view.textContent;
  for (const request of requests.slice(requestCount)) request.respond({}, 503);
  await flush();
  expect(beforeResponse).not.toContain("@public_player");
  expect(view.textContent).toContain("プロフィールを表示できません。");
  expect(view.textContent).not.toContain("公開プレイヤー");
  expect(view.textContent).not.toContain("3局 1優勝 (.333)");
  expect(view.querySelector(`a[href="/matches/${saved.id}"]`)).toBeNull();
  expect(histories()).toHaveLength(2);

  await act(async () => router.navigate(otherUsernamePath));
  profiles()
    .at(-1)!
    .respond({ ...player("four-reversi", otherId), name: "別のプレイヤー" });
  await flush();
  histories().at(-1)!.respond({ matches: [] });
  await flush();
  expect(view.querySelector("h1")?.textContent).toBe("別のプレイヤー");
  await act(async () => router.navigate(-1));
  expect(view.textContent).toContain("プロフィールを表示できません。");
  expect(view.textContent).not.toContain("別のプレイヤー");
});

test("別ゲーム・別人へ移動すると旧応答を破棄し、現行の棋譜側の404でプロフィールを消す", async () => {
  const { view, router } = open(usernamePath);
  session().respond({ user: null });
  await flush();
  profiles()[0]!.respond(player("four-reversi"));
  await flush();
  const firstHistory = histories()[0]!;
  const firstRatings = ratings()[0]!;
  press(view, "リバーシ");
  await flush();
  const secondProfile = profiles()[1]!;
  expect(firstHistory.init.signal?.aborted).toBe(true);
  firstHistory.respond({}, 404);
  await flush();
  expect(view.textContent).not.toContain("プロフィールを表示できません。");

  await act(async () => router.navigate(`${otherUsernamePath}?game=reversi`));
  expect(secondProfile.init.signal?.aborted).toBe(true);
  expect(firstRatings.init.signal?.aborted).toBe(true);
  expect(histories()).toHaveLength(1);
  profiles()[2]!.respond({ ...player("reversi", otherId), name: "別のプレイヤー" });
  secondProfile.respond({ ...player("reversi"), name: "前のプレイヤー" });
  firstRatings.respond({ profileId: playerId, games });
  await flush();
  expect(view.querySelector("h1")?.textContent).toBe("別のプレイヤー");
  expect(view.textContent).not.toContain("前のプレイヤー");
  expect(view.querySelector("article")).toBeNull();
  expect(gameButtons(view).every((button) => !button.querySelector("strong"))).toBe(true);
  expect(histories()[1]!.url).toBe(`/api${otherPath}/matches?game=reversi`);
  expect(ratings()[1]!.url).toBe(`/api${otherPath}/game-ratings`);
  histories()[1]!.respond({}, 404);
  await flush();
  expect(view.textContent).not.toContain("別のプレイヤー");
  expect(view.textContent).toContain("プロフィールを表示できません。");
});

test("以前のUUIDリンクは現在の公開IDに履歴置換し、ゲームとモードを引き継ぐ", async () => {
  const { view, router } = open("/lobby");
  session().respond({ user: null });
  await flush();
  const selection = "?game=four-shogi&mode=doubles";
  await act(async () => router.navigate(pagePath + selection));
  profiles()[0]!.respond({ ...player("four-shogi"), username: "renamed_player" });
  await flush();
  expect(router.state.historyAction).toBe(NavigationType.Replace);
  expect(router.state.location.pathname).toBe("/users/@renamed_player");
  expect(router.state.location.search).toBe(selection);
  expect(router.state.location.state).toEqual({ expectedProfileId: playerId });
  profiles()[1]!.respond({ ...player("four-shogi"), username: "renamed_player" });
  await flush();
  expect(view.textContent).toContain("@renamed_player");
  expect(view.textContent).toContain("4局 2勝 (.500)");
  expect(backButton(view)).toBeUndefined();
  await act(async () => router.navigate(-1));
  expect(router.state.location.pathname).toBe("/lobby");
});

test("統合元の旧UUIDから転送された公開IDが別人に移っていたら、本文・棋譜・レートと本人遷移を拒む", async () => {
  const formerGuestId = "50000000-0000-4000-8000-000000000005";
  const { view, router } = open(`/players/${formerGuestId}?game=four-shogi&mode=doubles`);
  session().respond({ user: { ...signedIn, profileId: otherId } });
  await flush();
  profiles()[0]!.respond(player("four-shogi"));
  await flush();
  expect(router.state.location.pathname).toBe(usernamePath);
  expect(router.state.location.state).toEqual({ expectedProfileId: playerId });
  profiles()[1]!.respond({
    ...player("four-shogi", otherId),
    name: "再割り当て後の本人",
    username: "public_player",
  });
  await flush();
  expect(router.state.location.pathname).toBe(usernamePath);
  expect(view.textContent).toContain("プロフィールを表示できません。");
  expect(view.textContent).not.toContain("再割り当て後の本人");
  expect(gameButtons(view)).toHaveLength(0);
  expect(histories().some(({ url }) => url.includes(otherId))).toBe(false);
  expect(ratings().some(({ url }) => url.includes(otherId))).toBe(false);
});

test("旧UUIDからの照合を公開IDの大小文字の正規化とゲーム・モード変更後も維持する", async () => {
  const { view, router } = open();
  session().respond({ user: null });
  await flush();
  profiles()[0]!.respond(player("four-reversi"));
  await flush();
  profiles()[1]!.respond(player("four-reversi"));
  await flush();
  const state = { expectedProfileId: playerId };
  await act(async () =>
    router.navigate("/users/@PUBLIC_PLAYER?game=four-reversi&mode=singles", {
      state,
      replace: true,
    }),
  );
  expect(router.state.location.pathname).toBe(usernamePath);
  expect(router.state.location.state).toEqual(state);
  press(view, "ダブルス");
  await flush();
  expect(router.state.location.search).toBe("?game=four-reversi&mode=doubles");
  expect(router.state.location.state).toEqual(state);
  press(view, "リバーシ");
  await flush();
  expect(router.state.location.state).toEqual(state);
  profiles()[2]!.respond({ ...player("reversi", otherId), username: "public_player" });
  await flush();
  expect(view.textContent).toContain("プロフィールを表示できません。");
  expect(histories().some(({ url }) => url.includes(otherId))).toBe(false);
  expect(ratings().some(({ url }) => url.includes(otherId))).toBe(false);
});

test("ゲストのUUIDリンクは公開ページのまま戦績と棋譜を表示する", async () => {
  const { view, router } = open();
  session().respond({ user: null });
  await flush();
  profiles()[0]!.respond({ ...player("four-reversi"), isGuest: true });
  histories()[0]!.respond({ matches: [] });
  await flush();
  expect(router.state.location.pathname).toBe(pagePath);
  expect(view.textContent).toContain("@public_playerゲスト");
  expect(view.textContent).toContain("3局 1優勝 (.333)");
  expect(view.textContent).toContain("このゲーム・モードの公開棋譜はありません。");
});

test.each(["/users/@ab", "/users/@%2Fabc", "/users/@unknown"])(
  "無効または非公開の公開ページ %s ではプロフィールと棋譜を表示しない",
  async (path) => {
    const { view } = open(path);
    session().respond({ user: null });
    await flush();
    if (path === "/users/@unknown") profiles()[0]!.respond({}, 404);
    else expect(profiles()).toHaveLength(0);
    await flush();
    expect(view.textContent).toContain("プロフィールを表示できません。");
    expect(histories()).toHaveLength(0);
    expect(ratings()).toHaveLength(0);
  },
);
