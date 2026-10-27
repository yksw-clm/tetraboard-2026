import { expect, spyOn, test } from "bun:test";
import type { ComponentProps } from "react";
import { GeneralLobbyPage } from "../src/features/lobby/GeneralLobbyPage";
import { LobbyView } from "../src/features/lobby/LobbyView";
import { profile } from "../test/fixtures/account";
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
  try {
    const view = render(wrap(profile)(<GeneralLobbyPage />));
    clock.advance(0);
    respondList("all");
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
    const rooms = view.querySelector('[aria-labelledby="public-rooms-title"]')!;
    const list = view.querySelector('[aria-labelledby="tournament-list-all-title"]')!;
    const chat = view.querySelector('[aria-labelledby="public-chat-title"]')!;
    const recent = view.querySelector('[aria-labelledby="recent-matches-title"]')!;
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
