import { beforeAll, expect, mock, test } from "bun:test";
import { StrictMode } from "react";
import type { BoardPost, BoardPublishedPost } from "@tetraboard/protocol/board";
import { gameCatalog, gameIds, type GameId } from "@tetraboard/protocol/games";
import { LobbyView } from "../src/features/lobby/LobbyView";
import { clock, flush, press, render, requests, rerender, wrap } from "./harness";

const game = "four-shogi";
const firstPostPrompt = "対局の感想や気になる局面を、最初に投稿してみませんか。";
const timelinePath = (game: GameId) => `/games/${game}/posts`;
const timelineRequests = (game: GameId) =>
  requests.filter(({ url }) => url === `/api${timelinePath(game)}`);

beforeAll(async () => {
  await import("../src/features/lobby/loadLobbyPostPreview");
});

function show(game: GameId) {
  return render(
    <StrictMode>
      {wrap(
        null,
        gameCatalog[game].lobbyPath,
      )(
        <LobbyView
          game={game}
          name=""
          roomCode=""
          mode="singles"
          cpuLevel={1}
          timeControl={{ mainTimeMs: 60_000, byoyomiMs: 0 }}
          isSubmitting={null}
          message={null}
          renderRooms={() => <section aria-label="公開ルーム">公開ルーム</section>}
          onNameChange={() => {}}
          onRoomCodeChange={() => {}}
          onModeChange={() => {}}
          onCpuLevelChange={() => {}}
          onTimeControlChange={() => {}}
          onClearMessage={() => {}}
        />,
      )}
    </StrictMode>,
  );
}

function preview(view: HTMLElement) {
  const heading = [...view.querySelectorAll("h2")].find(
    (node) => node.textContent === "みんなの投稿",
  );
  expect(heading).toBeDefined();
  const section = heading!.closest("section")!;
  expect(section.getAttribute("aria-labelledby")).toBe(heading!.id);
  return section;
}

function post(index: number): BoardPublishedPost {
  return {
    id: `aaaaaaaa-aaaa-4aaa-8aaa-${String(index).padStart(12, "0")}`,
    status: "published",
    gameId: game,
    author: { name: `投稿者${index}`, avatarUrl: null, profileTarget: null },
    postedAtMs: Date.now() - index * 60_000,
    text: `投稿${index}\n/matches/example`,
    likeCount: index + 2,
    replyCount: index + 1,
    liked: false,
    own: false,
  };
}

function timeline(posts: BoardPost[], acceptingPosts = true) {
  return {
    posts,
    acceptingPosts,
    nextCursor: null,
    postingStopped: false,
    availableAtMs: 0,
    serverTimeMs: Date.now(),
  };
}

test.each([...gameIds])("%s のロビーはそのゲームのタイムラインを1回だけ取得する", async (game) => {
  const section = preview(show(game));
  expect(section.textContent).toContain(`${gameCatalog[game].name}の掲示板の新しい投稿です。`);
  const actions = [...section.querySelectorAll("a")];
  expect(actions.map((link) => [link.textContent, link.getAttribute("href")])).toEqual([
    ["投稿する", timelinePath(game)],
    ["もっと見る", timelinePath(game)],
  ]);
  await flush();
  expect(timelineRequests(game)).toHaveLength(1);
  timelineRequests(game)[0]!.respond(timeline([]));
  await flush();
  clock.advance(60_000);
  expect(timelineRequests(game)).toHaveLength(1);
});

test("読み込み中は3枠と1つの案内を出し、削除枠を除いて新しい投稿を3件表示する", async () => {
  const section = preview(show(game));
  await flush();
  const statuses = section.querySelectorAll('[role="status"]');
  expect(statuses).toHaveLength(1);
  expect(statuses[0]?.textContent).toContain("読み込んでいます");
  expect(section.querySelectorAll('.card[aria-hidden="true"]')).toHaveLength(3);

  const [first, third, fourth, fifth] = [post(1), post(3), post(4), post(5)];
  const { id, postedAtMs, gameId, replyCount } = post(2);
  timelineRequests(game)[0]!.respond(
    timeline([
      first,
      { id, postedAtMs, gameId, replyCount, status: "deleted" },
      third,
      fourth,
      fifth,
    ]),
  );
  await flush();

  expect(section.querySelector('[role="status"]')).toBeNull();
  const links = [...section.querySelectorAll<HTMLAnchorElement>('a[href^="/posts/"]')];
  expect(links.map((link) => link.getAttribute("href"))).toEqual(
    [first, third, fourth].map(({ id }) => `/posts/${id}`),
  );
  expect(links[0]!.textContent).toContain(first.author.name);
  expect(links[0]!.textContent).toContain(first.text);
  expect(links[0]!.textContent).toContain("♡ 3");
  expect(links[0]!.textContent).toContain("返信 2");
  expect(links[0]!.querySelector("time")?.textContent).toBe("1分前");
  expect(links[0]!.querySelector("time")?.dateTime).toBe(new Date(first.postedAtMs).toISOString());
  expect(links[0]!.querySelector("a, button")).toBeNull();
  expect(section.textContent).not.toContain("削除された投稿");
});

test.each([true, false])(
  "投稿が0件なら受付状態 %s に応じて投稿を案内する",
  async (acceptingPosts) => {
    const section = preview(show(game));
    await flush();
    const { id, postedAtMs, gameId, replyCount } = post(1);
    timelineRequests(game)[0]!.respond(
      timeline([{ id, postedAtMs, gameId, replyCount, status: "deleted" }], acceptingPosts),
    );
    await flush();
    expect(section.textContent).toContain("まだ投稿はありません。");
    expect(section.textContent?.includes(firstPostPrompt)).toBe(acceptingPosts);
    expect([...section.querySelectorAll("a")].map((link) => link.textContent)).toEqual(
      acceptingPosts ? ["投稿する", "もっと見る"] : ["もっと見る"],
    );
  },
);

test("取得に失敗しても公開ルームは残り、投稿の取得を再試行できる", async () => {
  const view = show(game);
  const section = preview(view);
  const rooms = view.querySelector('section[aria-label="公開ルーム"]');
  expect(rooms).not.toBeNull();
  await flush();
  timelineRequests(game)[0]!.respond(null, 503);
  await flush();
  expect(section.querySelector('[role="alert"]')?.textContent).toBe("投稿を取得できませんでした。");
  expect(view.querySelector('section[aria-label="公開ルーム"]')).toBe(rooms);

  press(section, "再試行");
  await flush();
  expect(timelineRequests(game)).toHaveLength(2);
  const retry = timelineRequests(game)[1]!;
  retry.respond(timeline([post(1)]));
  await flush();
  expect(section.querySelector('[role="alert"]')).toBeNull();
  expect(section.textContent).toContain(post(1).text);
});

test("ロビーを離れると進行中の投稿取得を中止する", async () => {
  const view = show(game);
  await flush();
  const signal = timelineRequests(game)[0]!.init.signal!;
  expect(signal.aborted).toBe(false);
  rerender(view, null);
  expect(signal.aborted).toBe(true);
});

test("区画が画面に入ったときだけゲームを1回送信し、監視を終了する", async () => {
  let intersect: ((isIntersecting: boolean) => void) | undefined;
  const disconnect = mock(() => {});
  const beacon = mock((_url: string, _body: Blob) => true);
  const originalObserver = Object.getOwnPropertyDescriptor(window, "IntersectionObserver");
  const originalBeacon = Object.getOwnPropertyDescriptor(navigator, "sendBeacon");
  class Observer {
    disconnect = disconnect;
    private callback: IntersectionObserverCallback;
    constructor(callback: IntersectionObserverCallback) {
      this.callback = callback;
    }
    observe(target: Element) {
      if (target.querySelector("h2")?.textContent !== "みんなの投稿") return;
      intersect = (isIntersecting) =>
        this.callback(
          [{ target, isIntersecting } as IntersectionObserverEntry],
          this as unknown as IntersectionObserver,
        );
    }
  }
  Object.defineProperty(window, "IntersectionObserver", { configurable: true, value: Observer });
  Object.defineProperty(navigator, "sendBeacon", { configurable: true, value: beacon });
  try {
    const view = show(game);
    expect(intersect).toBeDefined();
    expect(beacon).not.toHaveBeenCalled();
    intersect!(false);
    expect(beacon).not.toHaveBeenCalled();
    disconnect.mockClear();
    intersect!(true);
    intersect!(true);
    expect(beacon).toHaveBeenCalledTimes(1);
    expect(disconnect).toHaveBeenCalledTimes(1);
    const [url, body] = beacon.mock.calls[0]!;
    expect(url).toBe("/api/board-preview-views");
    expect(body.type).toMatch(/^application\/json(?:;|$)/);
    expect(JSON.parse(await body.text())).toEqual({ game });
    rerender(view, null);
  } finally {
    if (originalObserver) Object.defineProperty(window, "IntersectionObserver", originalObserver);
    else Reflect.deleteProperty(window, "IntersectionObserver");
    if (originalBeacon) Object.defineProperty(navigator, "sendBeacon", originalBeacon);
    else Reflect.deleteProperty(navigator, "sendBeacon");
  }
});
