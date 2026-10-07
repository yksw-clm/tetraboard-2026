import { expect, test } from "bun:test";
import { createMemoryRouter, RouterProvider } from "react-router";
import { fourReversiMatchDetailSchema, fourShogiMatchDetailSchema } from "@tetraboard/protocol";
import { reversiArchives, shogiArchives } from "../../../test-fixtures/matches";
import FourReversiMatchReplayView from "../src/features/room/FourReversiMatchReplayView";
import FourShogiMatchReplayView from "../src/features/room/FourShogiMatchReplayView";
import { MatchReplayErrorPage } from "../src/features/room/MatchReplayPage";
import { matchReplayLoader } from "../src/features/room/matchReplayLoader";
import { fetchFourShogiMatchReplay } from "../src/features/room/fourShogiMatchReplay";
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
    act(() =>
      view.querySelector<HTMLButtonElement>('[aria-label="盤面を時計回りに90度回転"]')!.click(),
    );
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
    act(() =>
      view.querySelector<HTMLButtonElement>('[aria-label="盤面を時計回りに90度回転"]')!.click(),
    );
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
