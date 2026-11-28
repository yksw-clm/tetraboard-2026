import { expect, test } from "bun:test";
import type { ComponentProps } from "react";
import { gameCatalog, gameIds, type GameId } from "@tetraboard/protocol/games";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router";
import { AccountContext } from "../src/features/account/useAccount";
import { ActiveTournamentProvider } from "../src/features/tournaments/ActiveTournamentProvider";
import { ActiveTournamentsContext } from "../src/features/tournaments/useActiveTournaments";
import type { TournamentPublic } from "@tetraboard/protocol";
import { tournamentDate } from "@tetraboard/protocol/tournament-pages";
import { LobbyView } from "../src/features/lobby/LobbyView";
import { BoardTimelinePage } from "../src/features/board/BoardPages";
import { profile } from "../test/fixtures/account";
import { act, clock, flush, mockMobileLobby, press, render, requests, wrap } from "./harness";

function lobbyProps(game: GameId): ComponentProps<typeof LobbyView> {
  return {
    game,
    name: "",
    roomCode: "",
    mode: "singles",
    cpuLevel: 1,
    timeControl: { mainTimeMs: 60000, byoyomiMs: 0 },
    isSubmitting: null,
    message: null,
    renderRooms: () => null,
    onNameChange() {},
    onRoomCodeChange() {},
    onModeChange() {},
    onCpuLevelChange() {},
    onTimeControlChange() {},
    onClearMessage() {},
  };
}

function tournament(id: number, status: "active" | "upcoming"): TournamentPublic {
  const startsAtMs = Date.now() + (status === "active" ? -3600000 : 7200000);
  return {
    id,
    name: status === "active" ? "開催中の四人将棋大会" : "次回の四人将棋大会",
    description: "公開大会のご案内",
    rulesDescription: "四人将棋シングルス",
    startsAtMs,
    endsAtMs: startsAtMs + 7200000,
    status,
    entryCount: status === "active" ? 13 : 7,
    waitingCount: 0,
    playingCount: 0,
    pendingCount: 0,
    completedCount: 0,
    ruleVersion: 1,
    finalizedAtMs: null,
  };
}

function tournamentRequest(game: GameId | "all") {
  const matches = requests.filter(
    (request) => new URL(request.url, "http://localhost").pathname === "/api/tournaments/lobby",
  );
  expect(matches).toHaveLength(1);
  const request = matches[0]!;
  const query = new URL(request.url, "http://localhost").searchParams;
  expect(query.get("view")).toBe("sections");
  expect(query.get("game")).toBe(game);
  return request;
}

test.each([...gameIds])(
  "%sのロビーはゲームを指定して大会を取得し、対象0件ならセクションを置かない",
  async (game) => {
    const view = render(
      wrap(null, gameCatalog[game].lobbyPath)(<LobbyView {...lobbyProps(game)} />),
    );
    const main = view.querySelector("main")!;
    const actions = main.querySelectorAll('section[aria-label="対局を始める"]');
    expect(actions).toHaveLength(1);
    const loading = [...main.querySelectorAll('[role="status"]')].find(
      (status) => status.textContent === "大会の情報を読み込んでいます…",
    );
    if (["four-shogi", "four-reversi", "four-gomoku"].includes(game)) {
      expect(loading).toBeDefined();
      expect(loading!.parentElement!.querySelector(".skeleton")).not.toBeNull();
    } else expect(loading).toBeUndefined();
    clock.advance(0);
    tournamentRequest(game).respond({ current: [], upcoming: [], serverTimeMs: Date.now() });
    await flush();
    expect(main.querySelector('section[aria-label="対局を始める"]')).toBe(actions[0]!);
    expect(main.textContent).not.toContain("大会の情報を読み込んでいます…");
    expect([...main.querySelectorAll("h2")].map((heading) => heading.textContent)).not.toContain(
      "大会",
    );
    expect([...main.querySelectorAll("h2")].map((heading) => heading.textContent)).not.toContain(
      "次回の大会",
    );
  },
);

test("四人将棋ロビーは対局操作・お知らせ・大会・次回の大会の順で表示する", async () => {
  const game = "four-shogi";
  const view = render(wrap(null, gameCatalog[game].lobbyPath)(<LobbyView {...lobbyProps(game)} />));
  clock.advance(0);
  requests
    .find((request) => request.url === "/api/announcements/lobby?game=four-shogi")!
    .respond({
      announcement: {
        id: "tournament-notice",
        title: "大会のお知らせ",
        summary: "四人将棋大会を開催します。",
        date: "2026-10-27",
        kind: "improvement",
      },
    });
  const current = tournament(11, "active");
  const upcoming = tournament(12, "upcoming");
  tournamentRequest(game).respond({
    current: [current],
    upcoming: [upcoming],
    serverTimeMs: Date.now(),
  });
  await flush();
  const announcement = view.querySelector('section[aria-label="ロビーのお知らせ"]')!;
  const headings = [...view.querySelectorAll("main h2")];
  const currentHeading = headings.find((heading) => heading.textContent === "大会")!;
  const upcomingHeading = headings.find((heading) => heading.textContent === "次回の大会")!;
  const actions = view.querySelector('section[aria-label="対局を始める"]')!;
  expect(currentHeading).toBeDefined();
  expect(upcomingHeading).toBeDefined();
  expect(currentHeading.closest("section")).not.toBeNull();
  expect(upcomingHeading.closest("section")).not.toBeNull();
  expect(
    announcement.compareDocumentPosition(currentHeading) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(
    currentHeading.compareDocumentPosition(upcomingHeading) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(
    actions.compareDocumentPosition(announcement) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(view.querySelector(`a[href="/tournaments/${current.id}"]`)).not.toBeNull();
  expect(view.querySelector(`a[href="/tournaments/${upcoming.id}"]`)).not.toBeNull();
  expect(view.querySelector('[aria-label="次回の大会案内"]')).toBeNull();
});

test("スマホでは開催中と受付中を区別し、参加への入口を結果より先に一度ずつ表示する", async () => {
  const media = mockMobileLobby();
  const game = "four-shogi";
  const path = gameCatalog[game].lobbyPath;
  const current = tournament(11, "active");
  const upcoming = tournament(12, "upcoming");
  const publicCards = [current, upcoming].map(
    ({ id, name, status, startsAtMs, endsAtMs, entryCount }) => ({
      id,
      name,
      status,
      startsAtMs,
      endsAtMs,
      entryCount,
      game,
      winners: [],
    }),
  );
  const finished = {
    ...publicCards[0],
    id: 9,
    name: "過去の決勝",
    status: "finished",
    winners: [{ name: "優勝者", avatarUrl: null }],
  };
  const router = createMemoryRouter(
    [
      { path, element: <LobbyView {...lobbyProps(game)} /> },
      { path: "/games/:gameId/posts", Component: BoardTimelinePage },
      { path: "/tournaments/:id", element: <h1>大会詳細</h1> },
    ],
    { initialEntries: [path] },
  );
  try {
    const view = render(
      <AccountContext
        value={{ user: null, loading: false, error: null, refresh: async () => {}, update() {} }}
      >
        <ActiveTournamentsContext
          value={{ tournaments: [current], upcoming: [upcoming], serverNowMs: Date.now() }}
        >
          <RouterProvider router={router} />
        </ActiveTournamentsContext>
      </AccountContext>,
    );
    clock.advance(0);
    tournamentRequest(game).respond({
      current: [current],
      upcoming: [upcoming],
      serverTimeMs: Date.now(),
    });
    await flush();
    const tabs = () => view.querySelector('nav[aria-label="ゲームロビー"]')!;
    for (const label of ["対局", "ランキング", "投稿", "大会"]) {
      const link = [...tabs().querySelectorAll("a")].find((link) =>
        link.textContent?.startsWith(label),
      )!;
      await act(async () => link.click());
      expect(tabs().querySelector('[aria-current="page"]')?.textContent).toStartWith(label);
      const notice = view.querySelector('main [aria-label="次回の大会案内"]')!;
      expect(notice).not.toBeNull();
      expect(notice.textContent).toContain(upcoming.name);
      expect(notice.textContent).toContain("受付中");
      expect(notice.querySelector(`a[href="/tournaments/${upcoming.id}"]`)?.textContent).toBe(
        "大会詳細",
      );
      expect(
        notice.compareDocumentPosition(tabs()) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      expect(tabs().lastElementChild?.textContent).toBe("大会開催中");
    }
    clock.advance(0);
    requests
      .filter(({ url }) => url === "/api/tournaments/lobby?view=sections&game=four-shogi")
      .at(-1)!
      .respond({ current: [current], upcoming: [upcoming], serverTimeMs: Date.now() });
    requests
      .find(({ url }) => url === "/api/tournaments?game=four-shogi")!
      .respond({
        tournaments: [...publicCards, finished],
        nextCursor: "1700000000000:9",
        serverTimeMs: Date.now(),
      });
    await flush();
    const cards = () => [...view.querySelectorAll('main [role="article"]')];
    expect(
      cards().map(
        (card) => card.querySelector("h3")?.textContent ?? card.getAttribute("aria-label"),
      ),
    ).toEqual([current.name, upcoming.name, finished.name]);
    expect(cards()[1]!.textContent).not.toContain(upcoming.name);
    expect(cards()[1]!.textContent).not.toContain("詳細へ");
    expect(cards()[1]!.textContent).toContain("人がエントリー中");
    press(view, "もっと見る");
    requests
      .find(({ url }) => url.includes("cursor="))!
      .respond({
        tournaments: [publicCards[0], finished],
        nextCursor: null,
        serverTimeMs: Date.now(),
      });
    await flush();
    expect(cards()).toHaveLength(3);
    expect(cards()[2]?.textContent).toContain("優勝者");
    const entry = [...cards()[1]!.querySelectorAll("a")].find(
      (link) => link.textContent === "ゲストでエントリー",
    )!;
    await act(async () => entry.click());
    expect(router.state.location).toMatchObject({
      pathname: "/tournaments/12",
      state: { tournamentEntryRequested: true },
    });
  } finally {
    router.dispose();
    media.mockRestore();
  }
});

test("スマホの案内と大会本文は区分取得の遅延・失敗・先行する開催中更新でも重複しない", async () => {
  const media = mockMobileLobby();
  const game = "four-shogi";
  const announced = tournament(21, "upcoming");
  const other = { ...tournament(22, "upcoming"), name: "別の受付中の大会" };
  const path = `${gameCatalog[game].lobbyPath}?lobbyTab=tournaments`;
  try {
    const view = render(
      wrap(
        profile,
        path,
      )(
        <ActiveTournamentsContext
          value={{ tournaments: [], upcoming: [announced], serverNowMs: Date.now() }}
        >
          <LobbyView {...lobbyProps(game)} />
        </ActiveTournamentsContext>,
      ),
    );
    const links = () => [...view.querySelectorAll(`main a[href="/tournaments/${announced.id}"]`)];
    clock.advance(0);
    const sections = tournamentRequest(game);
    requests
      .find(({ url }) => url === "/api/tournaments?game=four-shogi")!
      .respond({
        tournaments: [announced, other].map(
          ({ id, name, status, startsAtMs, endsAtMs, entryCount }) => ({
            id,
            name,
            status,
            startsAtMs,
            endsAtMs,
            entryCount,
            game,
            winners: [],
          }),
        ),
        nextCursor: null,
        serverTimeMs: Date.now(),
      });
    await flush();
    expect(links().map((link) => link.textContent)).toEqual(["大会詳細"]);
    expect(view.querySelector('main [role="article"] h3')?.textContent).toBe(other.name);
    sections.reject();
    await flush();
    expect(links().map((link) => link.textContent)).toEqual(["大会詳細"]);
    expect(view.textContent).toContain("大会の情報を取得できませんでした。");
    press(view, "再試行");
    clock.advance(0);
    requests
      .filter(({ url }) => url === sections.url)
      .at(-1)!
      .respond({
        current: [{ ...announced, status: "active", startsAtMs: Date.now() }],
        upcoming: [other],
        serverTimeMs: Date.now(),
      });
    await flush();
    for (const { id } of [announced, other]) {
      requests
        .find(({ url }) => url === `/api/tournaments/${id}/participation`)!
        .respond({
          entered: id === announced.id,
          status: "idle",
          controller: "none",
          controllerVersion: 0,
        });
    }
    await flush();
    expect(links().map((link) => link.textContent)).toEqual(["大会詳細", "大会に参加"]);
    expect(view.querySelector('main [role="article"] h3')?.textContent).toBe(other.name);
    expect(view.textContent).toContain("人が参加中");
  } finally {
    media.mockRestore();
  }
});

test("投稿の直アクセスでは対象ゲームの次回案内を開始時刻ごとに切り替える", async () => {
  const media = mockMobileLobby();
  const router = createMemoryRouter(
    [
      {
        element: (
          <ActiveTournamentProvider>
            <Outlet />
          </ActiveTournamentProvider>
        ),
        children: [{ path: "/games/:gameId/posts", Component: BoardTimelinePage }],
      },
    ],
    { initialEntries: ["/games/four-shogi/posts"] },
  );
  try {
    const view = render(
      <AccountContext
        value={{ user: null, loading: false, error: null, refresh: async () => {}, update() {} }}
      >
        <RouterProvider router={router} />
      </AccountContext>,
    );
    const notice = () => view.querySelector('main [aria-label="次回の大会案内"]');
    expect(notice()).toBeNull();
    const serverTimeMs = Date.now() - 86_400_000;
    const candidate = (id: number, delay: number) => ({
      ...tournament(id, "upcoming"),
      name: `次回大会 ${id}`,
      startsAtMs: serverTimeMs + delay,
      endsAtMs: serverTimeMs + delay + 7200000,
    });
    const other = {
      ...candidate(11, 500),
      ruleVersion: 2,
      settings: {
        game: "four-gomoku",
        mode: "singles",
        timeControl: { mainTimeMs: 0, byoyomiMs: 30000 },
      },
    };
    const first = candidate(12, 1500);
    const next = candidate(13, 2500);
    clock.advance(0);
    tournamentRequest("all").respond({
      current: [],
      upcoming: [candidate(10, 0), other, first, next],
      serverTimeMs,
    });
    await flush();
    expect(notice()?.querySelector("a")?.getAttribute("href")).toBe("/tournaments/12");
    expect(notice()?.textContent).toContain(
      tournamentDate(first.startsAtMs, first.endsAtMs, { showTimeZone: false }),
    );
    expect(notice()?.previousElementSibling?.querySelector("h1")?.textContent).toBe("四人将棋");
    clock.advance(1499);
    expect(notice()?.textContent).toContain(first.name);
    clock.advance(1);
    expect(notice()?.querySelector("a")?.getAttribute("href")).toBe("/tournaments/13");
    await act(async () => router.navigate("/games/gomoku/posts"));
    expect(notice()).toBeNull();
    await act(async () => router.navigate("/games/four-shogi/posts"));
    expect(notice()?.textContent).toContain(next.name);
    clock.advance(1000);
    expect(notice()).toBeNull();
    expect(
      view
        .querySelector('nav[aria-label="ゲームロビー"]')
        ?.previousElementSibling?.querySelector("h1")?.textContent,
    ).toBe("四人将棋");
  } finally {
    router.dispose();
    media.mockRestore();
  }
});

test("スマホの大会は一覧取得失敗時も開け、再試行で0件を表示する", async () => {
  const media = mockMobileLobby();
  try {
    const game = "gomoku";
    const view = render(
      wrap(
        null,
        gameCatalog[game].lobbyPath + "?lobbyTab=tournaments",
      )(<LobbyView {...lobbyProps(game)} />),
    );
    expect(
      view.querySelector('nav[aria-label="ゲームロビー"] [aria-current="page"]')?.textContent,
    ).toBe("大会");
    clock.advance(0);
    const lists = () => requests.filter(({ url }) => url === "/api/tournaments?game=gomoku");
    const sections = tournamentRequest(game);
    sections.respond({ current: [], upcoming: [], serverTimeMs: Date.now() });
    lists()[0]!.reject();
    await flush();
    expect(view.textContent).toContain("大会一覧を取得できませんでした。");
    press(view, "再試行");
    lists()[1]!.respond({ tournaments: [], nextCursor: null, serverTimeMs: Date.now() });
    await flush();
    expect(view.textContent).toContain("公開されている大会はありません。");
  } finally {
    media.mockRestore();
  }
});
