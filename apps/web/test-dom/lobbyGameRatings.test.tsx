import { expect, test } from "bun:test";
import { useState } from "react";
import { MemoryRouter } from "react-router";
import { ratedMatchmakingGameIds, type AccountProfile } from "@tetraboard/protocol";
import type { LobbyGameRatings } from "@tetraboard/protocol/general-lobby";
import { AccountContext } from "../src/features/account/useAccount";
import { GeneralLobbyPage } from "../src/features/lobby/GeneralLobbyPage";
import { profile } from "../test/fixtures/account";
import { guestProfile } from "./guestAccountFixtures";
import { act, clock, flush, press, render, requests, wrap } from "./harness";

const user = { ...profile, profileId: "11111111-1111-4111-8111-111111111111" };
const path = "/api/lobby/game-ratings";
const latest = () => requests.filter(({ url }) => url === path).at(-1)!;
function result(account: AccountProfile | null = user): LobbyGameRatings {
  return {
    viewer:
      account && !account.isGuest
        ? { profileId: account.profileId ?? null, username: account.username }
        : null,
    games: {
      shogi: { enabled: true, summary: { status: "rated", rating: 1542 } },
      reversi: { enabled: false, summary: { status: "rated", rating: 1723 } },
      "four-reversi": { enabled: true, summary: { status: "placement", games: 2 } },
      "four-shogi": { enabled: true, summary: { status: "placement", games: 0 } },
    },
  };
}
const section = (view: HTMLElement) =>
  view.querySelector<HTMLElement>('section[aria-labelledby="game-list-title"]')!;
const card = (view: HTMLElement, game: string) =>
  section(view).querySelector(`a[href="/games/${game}"]`)!;
function visibility(value: string) {
  Object.defineProperty(document, "visibilityState", { configurable: true, value });
  act(() => document.dispatchEvent(new Event("visibilitychange")));
}

test("ホームから1回の取得で4ゲームのレート・認定進捗と受付状態を表示する", async () => {
  visibility("visible");
  const view = render(wrap(user)(<GeneralLobbyPage />));
  clock.advance(0);
  expect(latest().init.cache).toBe("no-store");
  expect(section(view).textContent).toContain("読み込んでいます");
  latest().respond(result());
  await flush();
  expect(card(view, "shogi").textContent).toContain("レート1542");
  expect(card(view, "reversi").textContent).toContain("受付停止中");
  expect(card(view, "reversi").textContent).toContain("1723");
  expect(card(view, "four-reversi").textContent).toContain("認定中 2/5局");
  expect(card(view, "four-shogi").textContent).toContain("認定前 0/5局");
  for (const game of ratedMatchmakingGameIds)
    expect(card(view, game).textContent).toContain("レート戦");
  for (const game of ["gomoku", "four-gomoku"])
    expect(card(view, game).textContent).not.toContain("レート");
  clock.advance(30000);
  expect(requests.filter(({ url }) => url === path)).toHaveLength(1);
  visibility("hidden");
  visibility("visible");
  const refreshed = result();
  refreshed.games.shogi.summary = { status: "rated", rating: 1558 };
  latest().respond(refreshed);
  await flush();
  expect(card(view, "shogi").textContent).toContain("1558");
});

test.each([null, guestProfile()])(
  "未ログイン・ゲストにも対応マークとログイン案内を表示する（%s）",
  async (account) => {
    visibility("visible");
    const view = render(wrap(account)(<GeneralLobbyPage />));
    clock.advance(0);
    const response = result(account);
    for (const game of ratedMatchmakingGameIds) response.games[game].summary = null;
    latest().respond(response);
    await flush();
    expect(section(view).querySelectorAll('a[href="/login"]')).toHaveLength(1);
    expect(card(view, "shogi").textContent).toContain("レート戦");
    expect(section(view).textContent).not.toContain("認定前");
    expect(section(view).textContent).not.toContain("1542");
  },
);

test("取得失敗を認定前や受付停止にせず、再取得でゲーム別の失敗からも回復する", async () => {
  visibility("visible");
  const view = render(wrap(user)(<GeneralLobbyPage />));
  clock.advance(0);
  latest().respond({ message: "失敗" }, 503);
  await flush();
  expect(card(view, "shogi").textContent).toContain("取得できませんでした");
  expect(card(view, "shogi").textContent).toContain("受付状況不明");
  expect(card(view, "shogi").textContent).not.toContain("認定前");
  press(section(view), "レート情報を再取得");
  const partial = result();
  partial.games.reversi.summary = { status: "error" };
  latest().respond(partial);
  await flush();
  expect(card(view, "shogi").textContent).toContain("1542");
  expect(card(view, "reversi").textContent).toContain("取得できませんでした");
  press(section(view), "レート情報を再取得");
  latest().respond(result());
  await flush();
  expect(card(view, "reversi").textContent).toContain("1723");
  expect(section(view).textContent).not.toContain("再取得");
});

test("アカウント切替では直前のレートと遅れて返った応答を表示しない", async () => {
  visibility("visible");
  const other = { ...user, username: "another", profileId: "22222222-2222-4222-8222-222222222222" };
  function Page() {
    const [account, setAccount] = useState<AccountProfile>(user);
    return (
      <MemoryRouter>
        <AccountContext.Provider
          value={{
            user: account,
            loading: false,
            error: null,
            refresh: async () => {},
            update: () => {},
          }}
        >
          <button onClick={() => setAccount(other)}>アカウント切替</button>
          <GeneralLobbyPage />
        </AccountContext.Provider>
      </MemoryRouter>
    );
  }
  const view = render(<Page />);
  clock.advance(0);
  latest().respond(result());
  await flush();
  visibility("hidden");
  visibility("visible");
  const stale = latest();
  press(view, "アカウント切替");
  expect(section(view).textContent).not.toContain("1542");
  clock.advance(0);
  stale.respond(result());
  await flush();
  expect(section(view).textContent).not.toContain("1542");
  const fresh = result(other);
  fresh.games.shogi.summary = { status: "rated", rating: 1800 };
  latest().respond(fresh);
  await flush();
  expect(card(view, "shogi").textContent).toContain("1800");
});
