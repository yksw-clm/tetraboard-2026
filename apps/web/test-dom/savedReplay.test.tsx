import { expect, test } from "bun:test";
import { createMemoryRouter, RouterProvider } from "react-router";
import {
  fourReversiMatchDetailSchema,
  fourShogiMatchDetailSchema,
  matchSummarySchema,
} from "@tetraboard/protocol";
import { reversiArchives, shogiArchives } from "../../../test-fixtures/matches";
import FourReversiMatchReplayView from "../src/features/room/FourReversiMatchReplayView";
import FourShogiMatchReplayView from "../src/features/room/FourShogiMatchReplayView";
import { MatchReplayErrorPage } from "../src/features/room/MatchReplayPage";
import { matchReplayLoader } from "../src/features/room/matchReplayLoader";
import { fetchFourShogiMatchReplay } from "../src/features/room/fourShogiMatchReplay";
import { MatchHistoryCard } from "../src/features/matches/MatchHistoryCard";
import { simultaneousMateFrames } from "../test/fixtures/shogiKnockouts";
import { token } from "../test/fixtures/rooms";
import { AccountContext } from "../src/features/account/useAccount";
import { act, clock, flush, press, render, requests, wrap } from "./harness";

test("固定棋譜5種を表示し、局面・回転操作は通信せず参加資格を維持する", async () => {
  sessionStorage.setItem("tetraboard:room:12345:membership", token);
  for (const fixture of reversiArchives) {
    const match = fourReversiMatchDetailSchema.parse(fixture.detail);
    const view = render(wrap()(<FourReversiMatchReplayView match={match} />));
    await flush();
    expect(view.textContent).toContain("棋譜閲覧中");
    const next = view.querySelector<HTMLButtonElement>('[aria-label="棋譜を1つ進む"]')!;
    expect(next.disabled).toBe(true);
    act(() => view.querySelector<HTMLButtonElement>('[aria-label="棋譜を1つ戻る"]')!.click());
    expect(next.disabled).toBe(false);
    const selectedLabel = view.querySelector('button[aria-haspopup="listbox"]')!.textContent;
    act(() =>
      view.querySelector<HTMLButtonElement>('[aria-label="盤面を時計回りに90度回転"]')!.click(),
    );
    expect(view.querySelector('button[aria-haspopup="listbox"]')!.textContent).toBe(selectedLabel);
    const squares = view.querySelectorAll<HTMLButtonElement>(
      '[aria-label="四人リバーシの盤面"] button',
    );
    expect(squares).toHaveLength(64);
    expect([...squares].every((b) => b.disabled)).toBe(true);
    expect(view.querySelector('a[href="/account"]')).not.toBeNull();
    expect(requests).toHaveLength(0);
  }
  for (const fixture of shogiArchives) {
    const match = fourShogiMatchDetailSchema.parse(fixture.detail);
    const loaded = fetchFourShogiMatchReplay(match, new AbortController().signal);
    let cursor = 0;
    while (cursor < fixture.events.length) {
      requests.at(-1)!.respond({
        matchId: match.id,
        ...match.replay,
        events: fixture.events.slice(cursor, cursor + 100),
        nextCursor: cursor + 100 < fixture.events.length ? cursor + 100 : null,
      });
      cursor += 100;
      await flush();
    }
    const frames = await loaded,
      count = requests.length;
    const view = render(wrap()(<FourShogiMatchReplayView match={match} frames={frames} />));
    await flush();
    expect(view.querySelectorAll("[data-side]")).toHaveLength(4);
    expect(view.querySelector('[aria-label="棋譜を1つ進む"]')!.hasAttribute("disabled")).toBe(true);
    act(() => view.querySelector<HTMLButtonElement>('[aria-label="棋譜を1つ戻る"]')!.click());
    const selectedLabel = view.querySelector('button[aria-haspopup="listbox"]')!.textContent;
    act(() =>
      view.querySelector<HTMLButtonElement>('[aria-label="盤面を時計回りに90度回転"]')!.click(),
    );
    expect(view.querySelector('button[aria-haspopup="listbox"]')!.textContent).toBe(selectedLabel);
    expect(
      [...view.querySelectorAll<HTMLButtonElement>("[data-square]")].every((b) => b.disabled),
    ).toBe(true);
    expect(requests).toHaveLength(count);
    press(view, "結果");
    await flush();
    const result = document.querySelector('[aria-label="対局結果の詳細"]')!;
    expect(result.querySelectorAll("li")).toHaveLength(4);
    expect(result.querySelectorAll('[aria-label="撃破したプレイヤー"]')).toHaveLength(4);
    expect(requests).toHaveLength(count);
    const names = [...result.querySelectorAll("li")].map(
      (row) => row.querySelector("[data-player-id]")!.textContent,
    );
    expect([...names].sort()).toEqual(match.participants.map((p) => p.name).sort());
    act(() =>
      document
        .querySelector<HTMLButtonElement>('[role="dialog"] button[aria-label="閉じる"]')!
        .click(),
    );
    clock.advance(1000);
    await flush();
  }
  expect(sessionStorage.getItem("tetraboard:room:12345:membership")).toBe(token);
});

test("棋譜エラーは400・404の案内と503の再試行を分け、再試行をロックして成功へ戻る", async () => {
  const fixture = reversiArchives[0];
  for (const status of [400, 404, 503]) {
    const router = createMemoryRouter(
      [
        {
          path: "/account/matches/:matchId",
          loader: matchReplayLoader,
          element: <p>棋譜取得成功</p>,
          errorElement: <MatchReplayErrorPage />,
          hydrateFallbackElement: <p role="status">棋譜を読み込んでいます…</p>,
        },
      ],
      { initialEntries: [`/account/matches/${fixture.detail.id}`] },
    );
    const view = render(
      <AccountContext.Provider
        value={{
          user: null,
          loading: false,
          error: null,
          refresh: async () => {},
          update: () => {},
        }}
      >
        <RouterProvider router={router} />
      </AccountContext.Provider>,
    );
    expect(view.textContent).toContain("読み込んで");
    requests.at(-1)!.respond({}, status);
    await flush();
    expect(view.querySelector('[role="alert"]')?.textContent).toContain(
      status === 400 ? "URL" : status === 404 ? "閲覧" : "取得",
    );
    expect(view.querySelector('a[href="/account"]')).not.toBeNull();
    if (status === 503) {
      const count = requests.length;
      press(view, "再試行");
      press(view, "再試行");
      expect(requests).toHaveLength(count + 1);
      expect(
        [...view.querySelectorAll("button")].find((b) => b.textContent === "再試行")!.disabled,
      ).toBe(true);
      requests.at(-1)!.respond({}, 503);
      await flush();
      expect(view.querySelector('[role="alert"]')).not.toBeNull();
      press(view, "再試行");
      requests.at(-1)!.respond({ match: fixture.detail });
      await flush();
      expect(view.textContent).toContain("棋譜取得成功");
    } else
      expect([...view.querySelectorAll("button")].some((b) => b.textContent === "再試行")).toBe(
        false,
      );
    act(() => router.dispose());
  }
});

for (const game of ["four-reversi", "four-shogi"] as const) {
  test(`${game}: 取得済みの現在の名前を棋譜カード・盤面カード・結果・撃破対象に表示する`, async () => {
    const frames = simultaneousMateFrames();
    const final = frames.at(-1)!.game;
    const match =
      game === "four-reversi"
        ? fourReversiMatchDetailSchema.parse(reversiArchives[0]!.detail)
        : fourShogiMatchDetailSchema.parse({
            ...shogiArchives[0]!.detail,
            settings: { ...shogiArchives[0]!.detail.settings, threePlayerAttackProhibited: false },
            selfPlayerId: final.players.south,
            game: final,
            participants: shogiArchives[0]!.detail.participants
              .map((player) => ({
                ...player,
                id: final.players[player.side as keyof typeof final.players],
                kind: "human",
                avatarUrl: null,
              }))
              .map(({ level: _level, ...player }) => player),
            replay: {
              ...shogiArchives[0]!.detail.replay,
              initial: {
                mode: "singles",
                players: final.players,
                threePlayerAttackProhibited: false,
              },
              eventCount: frames.length - 1,
            },
          });
    const originalNames = match.participants.filter((p) => p.kind === "human").map((p) => p.name);
    match.participants.forEach((player) => {
      if (player.kind === "human") player.name = `現在名${player.seat}`;
    });
    const summary = {
      id: match.id,
      game,
      mode: match.settings.mode,
      startedAtMs: match.startedAtMs,
      endedAtMs: match.endedAtMs,
      participants: match.participants,
      result: match.game.result,
    };
    const element = (
      <>
        <MatchHistoryCard match={matchSummarySchema.parse(summary)} to={`/matches/${match.id}`} />
        {"eliminations" in match ? (
          <FourReversiMatchReplayView match={match} />
        ) : (
          <FourShogiMatchReplayView match={match} frames={frames} />
        )}
      </>
    );
    const router = createMemoryRouter([{ path: "*", element }]);
    const view = render(<RouterProvider router={router} />);
    await flush();
    const card = view.querySelector("article")!;
    const playerNames = [...view.querySelectorAll('[data-testid="player-name"]')].map(
      (entry) => entry.textContent,
    );
    for (const player of match.participants) {
      expect(card.textContent).toContain(player.name);
      expect(playerNames.some((name) => name?.includes(player.name))).toBe(true);
    }
    press(view, "結果");
    await flush();
    const result = document.querySelector('[aria-label="対局結果の詳細"]')!;
    for (const player of match.participants) {
      const row = result.querySelector(`[data-player-id="${player.id}"]`)!;
      expect(row.textContent).toBe(player.name);
    }
    if (game === "four-shogi") {
      const targets = [
        ...result.querySelectorAll('[aria-label="撃破したプレイヤー"] [data-player-id]'),
      ];
      expect(targets).toHaveLength(2);
      for (const target of targets)
        expect(target.textContent).toBe(
          match.participants.find((p) => p.id === target.getAttribute("data-player-id"))!.name,
        );
    }
    for (const oldName of originalNames) {
      expect(card.textContent).not.toContain(oldName);
      expect(result.textContent).not.toContain(oldName);
    }
    expect(requests).toHaveLength(0);
    act(() => router.dispose());
  });
}
