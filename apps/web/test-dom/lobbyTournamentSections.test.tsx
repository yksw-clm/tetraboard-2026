import { expect, test } from "bun:test";
import type { ComponentProps } from "react";
import { gameCatalog, gameIds, type GameId } from "@tetraboard/protocol/games";
import { createMemoryRouter, RouterProvider } from "react-router";
import { AccountContext } from "../src/features/account/useAccount";
import { ActiveTournamentsContext } from "../src/features/tournaments/useActiveTournaments";
import type { TournamentPublic } from "@tetraboard/protocol";
import { LobbyView } from "../src/features/lobby/LobbyView";
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

function tournamentRequest(game: GameId) {
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
});

test("スマホの大会は受付中を示し、参加への入口を結果より先に一度ずつ表示する", async () => {
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
          value={{ tournaments: [], upcoming: [upcoming], serverNowMs: Date.now() }}
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
    const link = view.querySelector<HTMLAnchorElement>(
      'nav[aria-label="ゲームロビー"] a[href*="tournaments"]',
    )!;
    expect(link.textContent).toContain("受付中");
    await act(async () => link.click());
    expect(link.getAttribute("aria-current")).toBe("page");
    clock.advance(0);
    requests
      .find(({ url }) => url === "/api/tournaments?game=four-shogi")!
      .respond({
        tournaments: [...publicCards, finished],
        nextCursor: "1700000000000:9",
        serverTimeMs: Date.now(),
      });
    await flush();
    const cards = () => [...view.querySelectorAll('main [role="article"]')];
    expect(cards().map((card) => card.querySelector("h3")?.textContent)).toEqual([
      current.name,
      upcoming.name,
      finished.name,
    ]);
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
