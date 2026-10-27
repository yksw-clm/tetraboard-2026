import { expect, test } from "bun:test";
import type { ComponentProps } from "react";
import { gameCatalog, gameIds, type GameId } from "@tetraboard/protocol/games";
import type { TournamentPublic } from "@tetraboard/protocol";
import { LobbyView } from "../src/features/lobby/LobbyView";
import { clock, flush, render, requests, wrap } from "./harness";

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
    clock.advance(0);
    tournamentRequest(game).respond({ current: [], upcoming: [], serverTimeMs: Date.now() });
    await flush();
    const main = view.querySelector("main")!;
    expect(
      [...main.querySelectorAll(":scope > section")].map((section) =>
        section.getAttribute("aria-label"),
      ),
    ).toEqual(["対局を始める", `${gameCatalog[game].name}の紹介`]);
    expect([...main.querySelectorAll("h2")].map((heading) => heading.textContent)).not.toContain(
      "大会",
    );
    expect([...main.querySelectorAll("h2")].map((heading) => heading.textContent)).not.toContain(
      "次回の大会",
    );
  },
);

test("四人将棋ロビーはお知らせ・大会・次回の大会・対局操作の順で表示する", async () => {
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
    upcomingHeading.compareDocumentPosition(actions) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(view.querySelector(`a[href="/tournaments/${current.id}"]`)).not.toBeNull();
  expect(view.querySelector(`a[href="/tournaments/${upcoming.id}"]`)).not.toBeNull();
});
