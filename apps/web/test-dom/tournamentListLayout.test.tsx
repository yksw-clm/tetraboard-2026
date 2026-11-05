import { expect, spyOn, test } from "bun:test";
import type { ComponentProps } from "react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { AccountContext } from "../src/features/account/useAccount";
import { GeneralLobbyPage } from "../src/features/lobby/GeneralLobbyPage";
import { LobbyView } from "../src/features/lobby/LobbyView";
import { profile } from "../test/fixtures/account";
import { match } from "../test/fixtures/matchSummary";
import { act, clock, enter, flush, render, requests, wrap } from "./harness";

const pastTournament = {
  id: 1,
  game: "four-shogi",
  name: "過去の大会",
  startsAtMs: 1_700_000_000_000,
  endsAtMs: 1_700_003_600_000,
  status: "finished",
  entryCount: 4,
  winners: [{ name: "優勝した人", avatarUrl: null }],
};
function respondList(game: string) {
  requests
    .find(({ url }) => url === `/api/tournaments?game=${game}`)!
    .respond({
      tournaments: [pastTournament],
      nextCursor: null,
      serverTimeMs: Date.now(),
    });
}
const before = (first: Node, second: Node) =>
  expect(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

test("ホームの大会一覧は幅変更で位置だけを変え、チャットの下書きと取得済み一覧を保持する", async () => {
  let mobile = false;
  const events = new window.EventTarget();
  const matchMedia = spyOn(window, "matchMedia").mockImplementation(
    (query) =>
      ({
        media: query,
        get matches() {
          return query === "(max-width: 767px)" && mobile;
        },
        addEventListener: events.addEventListener.bind(events),
        removeEventListener: events.removeEventListener.bind(events),
      }) as unknown as MediaQueryList,
  );
  const router = createMemoryRouter([{ path: "/", element: <GeneralLobbyPage /> }]);
  try {
    const view = render(
      <AccountContext.Provider
        value={{
          user: profile,
          loading: false,
          error: null,
          refresh: async () => {},
          update: () => {},
        }}
      >
        <RouterProvider router={router} />
      </AccountContext.Provider>,
    );
    const rooms = view.querySelector('[aria-labelledby="public-rooms-title"]')!;
    const list = view.querySelector('[aria-labelledby="tournament-list-all-title"]')!;
    const recent = view.querySelector('[aria-labelledby="recent-matches-title"]')!;
    for (const section of [rooms, list, recent]) {
      expect(section.querySelectorAll('[role="status"]')).toHaveLength(1);
      expect(section.querySelector('.skeleton[aria-hidden="true"]')).not.toBeNull();
    }
    clock.advance(0);
    respondList("all");
    requests
      .find(({ url }) => url.startsWith("/api/lobby/rooms?"))!
      .respond({ rooms: [], nextCursor: null, totalCount: 0 });
    requests
      .find(({ url }) => url.startsWith("/api/lobby/matches?"))!
      .respond({ matches: [match(1)] });
    requests
      .find(({ url }) => url.startsWith("/api/lobby/chat?"))!
      .respond({
        messages: [],
        nextCursor: null,
        acceptingPosts: true,
        postingStopped: false,
        availableAtMs: 0,
        serverTimeMs: Date.now(),
      });
    await flush();
    for (const section of [rooms, list, recent])
      expect(section.querySelector(".skeleton")).toBeNull();
    expect(recent.querySelector("article")).not.toBeNull();
    act(() => recent.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
    clock.advance(0);
    expect(recent.querySelector(".skeleton")).toBeNull();
    expect(recent.querySelector('[role="status"]')).not.toBeNull();
    const filtered = requests.find(({ url }) => url.includes("humanOnly=true"))!;
    filtered.respond({ matches: [] });
    await flush();
    expect(recent.textContent).toContain("対人戦の対局履歴がありません。");
    const chat = view.querySelector('[aria-labelledby="public-chat-title"]')!;
    before(rooms, list);
    before(list, chat);
    before(chat, recent);
    const input = view.querySelector<HTMLInputElement>("input[placeholder]")!;
    enter(input, "幅を変えても保持する下書き");
    const requestCount = requests.length;
    mobile = true;
    act(() => events.dispatchEvent(new Event("change")));
    await flush();
    before(rooms, chat);
    before(chat, recent);
    before(recent, list);
    expect(view.querySelector('[aria-labelledby="tournament-list-all-title"]')).toBe(list);
    expect(view.querySelector("input[placeholder]")).toBe(input);
    expect(input.value).toBe("幅を変えても保持する下書き");
    expect(requests).toHaveLength(requestCount);
    mobile = false;
    act(() => events.dispatchEvent(new Event("change")));
    await flush();
    before(list, chat);
    expect(requests).toHaveLength(requestCount);
  } finally {
    router.dispose();
    matchMedia.mockRestore();
  }
});

test("ゲーム別の大会一覧は公開ルーム・ランキング・最近の対局の後に置く", async () => {
  const props: ComponentProps<typeof LobbyView> = {
    game: "four-shogi",
    name: "",
    roomCode: "",
    mode: "singles",
    cpuLevel: 1,
    timeControl: { mainTimeMs: 60000, byoyomiMs: 0 },
    isSubmitting: null,
    message: null,
    renderRooms: () => <section aria-label="公開ルーム検証" />,
    rankings: <section aria-label="ランキング検証" />,
    onNameChange() {},
    onRoomCodeChange() {},
    onModeChange() {},
    onCpuLevelChange() {},
    onTimeControlChange() {},
    onClearMessage() {},
  };
  const view = render(wrap()(<LobbyView {...props} />));
  clock.advance(0);
  respondList("four-shogi");
  await flush();
  const rooms = view.querySelector('[aria-label="公開ルーム検証"]')!;
  const rankings = view.querySelector('[aria-label="ランキング検証"]')!;
  const recent = view.querySelector('[aria-labelledby="recent-matches-title"]')!;
  const list = view.querySelector('[aria-labelledby="tournament-list-four-shogi-title"]')!;
  before(rooms, rankings);
  before(rankings, recent);
  before(recent, list);
  expect(list.textContent).toContain("過去の大会");
  expect(list.textContent).toContain("優勝した人");
});
