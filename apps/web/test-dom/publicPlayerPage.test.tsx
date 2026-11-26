import { expect, test } from "bun:test";
import { createMemoryRouter, RouterProvider } from "react-router";
import { type GameId, gameCatalog, gameIds } from "@tetraboard/protocol/games";
import { type MatchSummary } from "@tetraboard/protocol";
import { AccountLayout } from "../src/features/account/AccountSession";
import { PlayerProfileProvider } from "../src/features/players/PlayerProfileProvider";
import { PlayerProfileTrigger } from "../src/features/players/PlayerProfileTrigger";
import { PublicPlayerPage } from "../src/features/players/PublicPlayerPage";
import { startPageMetadata } from "../src/seo/pageMetadata";
import { match } from "../test/fixtures/matchSummary";
import { profile as signedIn } from "../test/fixtures/account";
import { act, flush, press, render, requests } from "./harness";

const playerId = "10000000-0000-4000-8000-000000000001";
const otherId = "20000000-0000-4000-8000-000000000002";
const pagePath = `/players/${playerId}`;
const otherPath = `/players/${otherId}`;
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
    username: "public_player",
    avatarUrl: null,
    profileMessage: "対局よろしくお願いします",
    favoriteGames: ["reversi"],
    stats: gameCatalog[game].hasModes
      ? { singles: { total: 3, first: 1 }, doubles: { total: 4, wins: 2 } }
      : zero,
    rating: { timing: "current", status: "placement" },
  };
}
const profiles = () => requests.filter((request) => request.url.startsWith("/api/player-profile?"));
const histories = () => requests.filter((request) => request.url.startsWith("/api/players/"));

function open(initialEntry = pagePath) {
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
          { path: "/players/:profileId", element: <PublicPlayerPage /> },
          { path: "/matches/:matchId", element: <p>公開棋譜の画面</p> },
          { path: "/account/setup", element: <p>初回設定の画面</p> },
        ],
      },
    ],
    { initialEntries: [initialEntry] },
  );
  const view = render(<RouterProvider router={router} />);
  return { view, router };
}

test("未ログインでカード内の名前リンクから四人将棋ダブルスを開き、棋譜を往復しても選択と公開IDを保つ", async () => {
  const { view, router } = open("/lobby");
  requests.find((request) => request.url === "/api/account/session")!.respond({ user: null });
  press(view, "カードの名前");
  await flush();
  profiles()[0]!.respond({
    ...player("four-shogi"),
    rating: { timing: "before", status: "rated", rating: 1480 },
  });
  await flush();
  const link = document.querySelector<HTMLAnchorElement>(`a[href^="${pagePath}?"]`)!;
  expect(link.textContent).toBe("公開プレイヤー");
  act(() => link.click());
  await flush();
  expect(router.state.location.search).toBe("?game=four-shogi&mode=doubles");
  expect(profiles()[1]!.url).toBe(
    `/api/player-profile?source=profile&profileId=${playerId}&game=four-shogi&includeBadges=1&includeStats=1&includeDetails=1&includeRating=1`,
  );
  profiles()[1]!.respond(player("four-shogi"));
  histories()[0]!.respond({ matches: [] });
  await flush();
  expect(view.querySelector('button[aria-pressed="true"]')?.textContent).toBe("四人将棋");
  expect(view.textContent).toContain("4局 2勝 (.500)");
  expect(view.textContent).toContain("対人戦のみ集計");
  expect(view.textContent).toContain("現在のレート 認定中");
  expect(view.textContent).not.toContain("1480");
  expect(view.textContent).toContain("対局よろしくお願いします");
  expect(view.querySelector('[aria-label="お気に入りゲーム"]')?.textContent).toContain("リバーシ");

  press(view, "リバーシ");
  await flush();
  expect(router.state.location.search).toBe("?game=reversi");
  expect(histories().at(-1)!.url).toBe(`/api${pagePath}/matches?game=reversi`);
  profiles().at(-1)!.respond(player("reversi"));
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
  expect(router.state.location.pathname).toBe(pagePath);
  expect(router.state.location.search).toBe("?game=reversi");
  profiles()
    .at(-1)!
    .respond({ ...player("reversi"), username: "renamed_player" });
  histories()
    .at(-1)!
    .respond({ matches: [reversiMatch] });
  await flush();
  expect(view.textContent).toContain("@renamed_player");
  expect(view.querySelector('button[aria-pressed="true"]')?.textContent).toBe("リバーシ");
  expect(requests.every((request) => !request.init.method || request.init.method === "GET")).toBe(
    true,
  );
});

test("直リンクの既定、6ゲーム、四人ゲームのモード切替と初回設定前の閲覧", async () => {
  const { view, router } = open();
  const stop = startPageMetadata(router);
  try {
    expect(document.querySelector('meta[name="robots"]')?.getAttribute("content")).toBe(
      "noindex,follow",
    );
    requests
      .find((request) => request.url === "/api/account/session")!
      .respond({
        user: { ...signedIn, name: "", username: null, profileCompleted: false },
      });
    profiles()[0]!.respond(player("four-reversi"));
    histories()[0]!.respond({ matches: [] });
    await flush();
    expect(router.state.location.pathname).toBe(pagePath);
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
      expect(histories().at(-1)!.url).toEndWith(router.state.location.search);
      expect(profiles().at(-1)!.url).toContain(`&game=${game}&`);
      profiles().at(-1)!.respond(player(game));
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

test("取得失敗と空一覧を区別し、失敗した欄だけ再試行し、閲覧不可で表示済みの棋譜を消す", async () => {
  const { view } = open();
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
  press(view, "再試行");
  await flush();
  expect(profiles()).toHaveLength(2);
  expect(histories()).toHaveLength(3);
  profiles()[1]!.respond({}, 404);
  await flush();
  expect(view.textContent).toContain("プロフィールを表示できません。");
  expect(view.querySelector(`a[href="/matches/${saved.id}"]`)).toBeNull();
});

test("棋譜が404になったプレイヤーは別モードへ戻って再取得が失敗しても再表示しない", async () => {
  const { view, router } = open(`${pagePath}?game=four-reversi&mode=singles`);
  const saved = match(1);
  profiles()[0]!.respond(player("four-reversi"));
  histories()[0]!.respond({ matches: [saved] });
  await flush();
  expect(view.textContent).toContain("@public_player");
  expect(view.textContent).toContain("3局 1優勝 (.333)");
  expect(view.querySelector(`a[href="/matches/${saved.id}"]`)).not.toBeNull();

  press(view, "ダブルス");
  await flush();
  histories()[1]!.respond({}, 404);
  await flush();
  expect(view.textContent).toContain("プロフィールを表示できません。");

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

  await act(async () => router.navigate(otherPath));
  profiles()
    .at(-1)!
    .respond({ ...player("four-reversi", otherId), name: "別のプレイヤー" });
  histories().at(-1)!.respond({ matches: [] });
  await flush();
  expect(view.querySelector("h1")?.textContent).toBe("別のプレイヤー");
  await act(async () => router.navigate(-1));
  expect(view.textContent).toContain("プロフィールを表示できません。");
  expect(view.textContent).not.toContain("別のプレイヤー");
});

test("別ゲーム・別人へ移動すると旧応答を破棄し、現行の棋譜側の404でプロフィールを消す", async () => {
  const { view, router } = open();
  const firstProfile = profiles()[0]!;
  const firstHistory = histories()[0]!;
  press(view, "リバーシ");
  await flush();
  const secondProfile = profiles()[1]!;
  const secondHistory = histories()[1]!;
  expect(firstProfile.init.signal?.aborted).toBe(true);
  expect(firstHistory.init.signal?.aborted).toBe(true);
  firstProfile.respond({ ...player("four-reversi"), name: "前のゲーム" });
  firstHistory.respond({}, 404);
  await flush();
  expect(view.textContent).not.toContain("前のゲーム");
  expect(view.textContent).not.toContain("プロフィールを表示できません。");

  await act(async () => router.navigate(`${otherPath}?game=reversi`));
  expect(secondProfile.init.signal?.aborted).toBe(true);
  expect(secondHistory.init.signal?.aborted).toBe(true);
  profiles()[2]!.respond({ ...player("reversi", otherId), name: "別のプレイヤー" });
  secondProfile.respond({ ...player("reversi"), name: "前のプレイヤー" });
  secondHistory.respond({ matches: [reversiMatch] });
  await flush();
  expect(view.querySelector("h1")?.textContent).toBe("別のプレイヤー");
  expect(view.textContent).not.toContain("前のプレイヤー");
  expect(view.querySelector("article")).toBeNull();
  histories()[2]!.respond({}, 404);
  await flush();
  expect(view.textContent).not.toContain("別のプレイヤー");
  expect(view.textContent).toContain("プロフィールを表示できません。");
});
