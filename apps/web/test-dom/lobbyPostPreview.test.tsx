import { beforeAll, expect, mock, spyOn, test } from "bun:test";
import { StrictMode } from "react";
import { MemoryRouter, useLocation } from "react-router";
import type { AccountProfile } from "@tetraboard/protocol";
import type { BoardPost, BoardPublishedPost } from "@tetraboard/protocol/board";
import { gameCatalog, gameIds, type GameId } from "@tetraboard/protocol/games";
import { AccountContext } from "../src/features/account/useAccount";
import { LobbyView } from "../src/features/lobby/LobbyView";
import * as previewImport from "../src/features/lobby/importLobbyPostPreview";
import { preloadRecovery } from "../src/shared/preloadRecovery";
import { act, clock, flush, press, render, requests, rerender } from "./harness";

const game = "four-shogi";
const firstPostPrompt = "対局の感想や気になる局面を、最初に投稿してみませんか。";
const timelinePath = (game: GameId) => `/games/${game}/posts`;
const timelineRequests = (game: GameId) =>
  requests.filter(({ url }) => url === `/api${timelinePath(game)}?includeAttachments=1`);
const viewer: AccountProfile = {
  username: "viewer",
  name: "閲覧者",
  avatarUrl: null,
  profileCompleted: true,
};
const otherViewer = { ...viewer, username: "other-viewer", name: "別の閲覧者" };

beforeAll(async () => {
  await previewImport.importLobbyPostPreview();
});

function CurrentPath() {
  const { pathname, search } = useLocation();
  return <p aria-label="現在のパス">{pathname + search}</p>;
}

function lobby(game: GameId, user: AccountProfile | null, loading = false) {
  return (
    <StrictMode>
      <MemoryRouter initialEntries={[gameCatalog[game].lobbyPath]}>
        <AccountContext.Provider
          value={{ user, loading, error: null, refresh: async () => {}, update: () => {} }}
        >
          <CurrentPath />
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
          />
        </AccountContext.Provider>
      </MemoryRouter>
    </StrictMode>
  );
}

function show(game: GameId, user: AccountProfile | null = null) {
  return render(lobby(game, user));
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

function links(section: HTMLElement) {
  return [...section.querySelectorAll("a")].map((link) => [
    link.textContent,
    link.getAttribute("href"),
  ]);
}

function expectTimelineLink(section: HTMLElement, game: GameId) {
  const link = section.lastElementChild;
  expect(link?.tagName).toBe("A");
  expect(link?.textContent).toBe("掲示板をすべて見る");
  expect(link?.getAttribute("href")).toBe(timelinePath(game));
  expect(link?.classList.contains("w-full")).toBe(true);
  expect(links(section).map(([label]) => label)).not.toContain("もっと見る");
}

function like(card: HTMLElement) {
  const button = card.querySelector<HTMLButtonElement>('button[aria-label="いいね"]');
  expect(button).not.toBeNull();
  return button!;
}

function expectLike(button: HTMLButtonElement, liked: boolean, count: number) {
  expect(button.getAttribute("aria-pressed")).toBe(String(liked));
  expect(button.querySelector("svg")?.getAttribute("fill")).toBe(liked ? "currentColor" : "none");
  expect(button.textContent).toBe(String(count));
}

function post(index: number): BoardPublishedPost {
  return {
    id: `aaaaaaaa-aaaa-4aaa-8aaa-${String(index).padStart(12, "0")}`,
    status: "published",
    attachment: null,
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
  expectTimelineLink(section, game);
  await flush();
  expect(timelineRequests(game)).toHaveLength(1);
  expect(links(section)).toEqual([["掲示板をすべて見る", timelinePath(game)]]);
  timelineRequests(game)[0]!.respond(timeline([]));
  await flush();
  expect(links(section)).toEqual([
    ["投稿する", timelinePath(game)],
    ["掲示板をすべて見る", timelinePath(game)],
  ]);
  clock.advance(60_000);
  expect(timelineRequests(game)).toHaveLength(1);
});

test.each([
  { name: "登録者", user: viewer },
  { name: "未ログイン", user: null },
])("セッション確認後に $name のプレビューを1回だけ取得する", async ({ user }) => {
  const view = render(lobby(game, null, true));
  const section = preview(view);
  await flush();
  expect(timelineRequests(game)).toHaveLength(0);
  expect(section.querySelector('[role="status"]')?.textContent).toBe("投稿を読み込んでいます…");
  expectTimelineLink(section, game);

  rerender(view, lobby(game, user));
  await flush();
  expect(timelineRequests(game)).toHaveLength(1);
  const first = post(1);
  timelineRequests(game)[0]!.respond(timeline([first]));
  await flush();
  expect(section.textContent).toContain(first.text);

  rerender(view, lobby(game, user, true));
  await flush();
  rerender(view, lobby(game, user));
  await flush();
  expect(timelineRequests(game)).toHaveLength(1);
  expect(section.textContent).toContain(first.text);
});

test("読み込み中は3枠と1つの案内を出し、削除枠を除いて新しい投稿を3件表示する", async () => {
  const section = preview(show(game));
  await flush();
  const statuses = section.querySelectorAll('[role="status"]');
  expect(statuses).toHaveLength(1);
  expect(statuses[0]?.textContent).toContain("読み込んでいます");
  expect(section.querySelectorAll('.card[aria-hidden="true"]')).toHaveLength(3);

  const [first, third, fourth, fifth] = [post(1), post(3), post(4), post(5)];
  first.attachment = { matchId: first.id, position: 0 };
  first.text = `投稿1\n${window.location.origin}/rooms/12345`;
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
    [first, third, fourth].flatMap(({ id }) => [`/posts/${id}`, `/posts/${id}`]),
  );
  expect(links[0]!.textContent).toContain(first.text);
  const firstCard = links[0]!.closest("li")!;
  expect(firstCard.querySelector("header")?.textContent).toContain(first.author.name);
  expect(firstCard.querySelector("header a, header button")).toBeNull();
  expect(firstCard.querySelector(".sr-only")?.textContent).toBe("返信 2 件");
  expectLike(like(firstCard), false, 3);
  expect(firstCard.querySelector("time")?.textContent).toBe("1分前");
  expect(firstCard.querySelector("time")?.dateTime).toBe(new Date(first.postedAtMs).toISOString());
  expect(links[0]!.querySelector("a, button")).toBeNull();
  expect(section.querySelector('[aria-label*="盤面"]')).toBeNull();
  expect(section.textContent).not.toContain("ルーム 12345");
  expect(requests.some(({ url }) => url.startsWith("/api/matches/"))).toBe(false);
  expect(section.textContent).not.toContain("削除された投稿");
  expectTimelineLink(section, game);
});

async function showPosts(user: AccountProfile | null, ...posts: BoardPublishedPost[]) {
  const view = show(game, user);
  await flush();
  timelineRequests(game)[0]!.respond(timeline(posts));
  await flush();
  return { view, cards: [...preview(view).querySelectorAll("li")] };
}

test("ロビーでアバターと名前を押すと投稿のゲームの公開プレイヤーページに移る", async () => {
  const first = post(1);
  first.gameId = "four-reversi";
  const profileId = post(2).id;
  first.author.profileTarget = { source: "profile", profileId };
  const {
    view,
    cards: [card],
  } = await showPosts(viewer, first);
  const playerPath = `/players/${profileId}?game=four-reversi&mode=singles`;
  const profile = card!.querySelector<HTMLAnchorElement>(`a[href="${playerPath}"]`)!;
  const detail = card!.querySelector<HTMLAnchorElement>(`a[href="/posts/${first.id}"]`)!;
  expect(profile?.textContent).toBe(first.author.name);
  expect(profile.querySelector("svg")).not.toBeNull();
  expect(profile.parentElement?.closest("a")).toBeNull();
  expect(profile.classList.contains("z-10")).toBe(true);
  expect(detail.textContent).toContain(first.text);
  expect(detail.classList.contains("before:inset-0")).toBe(true);
  expect(detail.querySelector("a, button")).toBeNull();
  const requestCount = requests.length;
  await act(async () => profile.click());
  expect(view.querySelector('[aria-label="現在のパス"]')?.textContent).toBe(playerPath);
  expect(requests).toHaveLength(requestCount);
});

test("ロビーの返信リンクは投稿者リンクと独立してカードと同じ投稿の詳細を開く", async () => {
  const first = post(1);
  first.author.profileTarget = { source: "profile", profileId: post(2).id };
  const {
    view,
    cards: [card],
  } = await showPosts(viewer, first);
  const detailPath = `/posts/${first.id}`;
  const [detail, replies] = card!.querySelectorAll<HTMLAnchorElement>(`a[href="${detailPath}"]`);
  expect(card!.querySelector("header a")?.textContent).toBe(first.author.name);
  expect(detail?.textContent).toBe(first.text);
  expect(replies?.querySelector(".sr-only")?.textContent).toBe("返信 2 件");
  expect(replies?.querySelector('span[aria-hidden="true"]')?.textContent).toBe("2");
  expect(replies?.parentElement?.closest("a")).toBeNull();
  expect(replies?.querySelector("a, button")).toBeNull();
  expect(replies?.nextElementSibling).toBe(like(card!));
  expect(replies?.classList.contains("z-10")).toBe(true);
  expect(replies?.classList.contains("focus-visible:outline-focus")).toBe(true);
  replies!.focus();
  expect(document.activeElement).toBe(replies!);
  const requestCount = requests.length;
  await act(async () => replies!.click());
  expect(view.querySelector('[aria-label="現在のパス"]')?.textContent).toBe(detailPath);
  expect(requests).toHaveLength(requestCount);
});

test("ロビーのいいねは詳細へ移らず、即時表示して応答で数を確定する", async () => {
  const first = post(1);
  const {
    view,
    cards: [card, other],
  } = await showPosts(viewer, first, post(2));
  const button = like(card!);
  const path = view.querySelector('[aria-label="現在のパス"]');
  const link = card!.querySelector<HTMLAnchorElement>("a")!;
  expect(button.closest("a")).toBeNull();
  expect(button.previousElementSibling?.textContent).toContain("返信 2 件");
  expect(button.classList.contains("z-10")).toBe(true);
  expect(link.getAttribute("href")).toBe(`/posts/${first.id}`);

  act(() => button.click());
  const request = requests.at(-1)!;
  expect(request.url).toBe(`/api/posts/${first.id}/like`);
  expect(request.init.method).toBe("PUT");
  expectLike(button, true, 4);
  expect(path?.textContent).toBe(gameCatalog[game].lobbyPath);
  act(() => button.click());
  expect(requests.filter(({ url }) => url === request.url)).toHaveLength(1);

  request.respond({ liked: true, likeCount: 6 });
  await flush();
  expectLike(button, true, 6);
  expectLike(like(other!), false, 4);
  act(() => button.click());
  const removal = requests.at(-1)!;
  expect(removal.url).toBe(request.url);
  expect(removal.init.method).toBe("DELETE");
  expectLike(button, false, 5);
  removal.respond({ liked: false, likeCount: 4 });
  await flush();
  expectLike(button, false, 4);
  expect(path?.textContent).toBe(gameCatalog[game].lobbyPath);
  act(() => link.click());
  await flush();
  expect(path?.textContent).toBe(`/posts/${first.id}`);
});

test("ロビーのいいねを取り消すと即時表示し、失敗したときは元に戻して理由を示す", async () => {
  const first = { ...post(1), liked: true, likeCount: 6 };
  const {
    cards: [card, other],
  } = await showPosts(viewer, first, post(2));
  const button = like(card!);

  act(() => button.click());
  const request = requests.at(-1)!;
  expect(request.url).toBe(`/api/posts/${first.id}/like`);
  expect(request.init.method).toBe("DELETE");
  expectLike(button, false, 5);
  request.respond({ message: "いいねを保存できませんでした。" }, 503);
  await flush();
  expectLike(button, true, 6);
  expect(card!.querySelector('[role="alert"]')?.textContent).toBe("いいねを保存できませんでした。");
  expect(other!.querySelector('[role="alert"]')).toBeNull();
});

test.each([
  [null, "いいねするにはログインしてください。"],
  [{ ...viewer, isGuest: true }, "いいねにはアカウント登録が必要です。"],
  [{ ...viewer, profileCompleted: false }, "プロフィールの初回設定を完了するといいねできます。"],
] as const)("ロビーでいいねができない場合は通信せず理由を示す（%s）", async (user, reason) => {
  const {
    cards: [card],
  } = await showPosts(user, post(1));
  const button = like(card!);
  const requestCount = requests.length;

  act(() => button.click());
  expect(card!.querySelector('[role="alert"]')?.textContent).toBe(reason);
  expectLike(button, false, 3);
  expect(requests).toHaveLength(requestCount);
});

test("ロビーを離れると進行中のいいねを中止する", async () => {
  const {
    view,
    cards: [card],
  } = await showPosts(viewer, post(1));
  act(() => like(card!).click());
  const signal = requests.at(-1)!.init.signal!;
  expect(signal.aborted).toBe(false);
  rerender(view, null);
  expect(signal.aborted).toBe(true);
});

test.each([
  { name: "ログアウト", user: null, liked: false, method: null },
  { name: "いいねしていない閲覧者への切り替え", user: otherViewer, liked: false, method: "PUT" },
  { name: "いいね済みの閲覧者への切り替え", user: otherViewer, liked: true, method: "DELETE" },
])("$name の後は新しい閲覧者の状態でいいねを判定する", async ({ user, liked, method }) => {
  const first = post(1);
  const {
    view,
    cards: [oldCard],
  } = await showPosts(viewer, { ...first, liked: true, likeCount: 6 });
  const section = preview(view);
  expectLike(like(oldCard!), true, 6);

  rerender(view, lobby(game, user));
  expect(section.querySelectorAll('button[aria-label="いいね"]')).toHaveLength(0);
  expect(section.querySelector('[role="status"]')?.textContent).toBe("投稿を読み込んでいます…");
  await flush();
  expect(timelineRequests(game)).toHaveLength(2);
  timelineRequests(game)[1]!.respond(timeline([{ ...first, liked }]));
  await flush();

  const card = section.querySelector("li")!;
  const button = like(card);
  expectLike(button, liked, first.likeCount);
  const requestCount = requests.length;
  act(() => button.click());
  if (method) {
    expect(requests).toHaveLength(requestCount + 1);
    expect(requests.at(-1)?.url).toBe(`/api/posts/${first.id}/like`);
    expect(requests.at(-1)?.init.method).toBe(method);
  } else {
    expect(requests).toHaveLength(requestCount);
    expect(card.querySelector('[role="alert"]')?.textContent).toBe(
      "いいねするにはログインしてください。",
    );
  }
});

test("閲覧者を切り替えると進行中の取得を中止し、遅れて届いた応答を捨てる", async () => {
  const view = show(game, viewer);
  await flush();
  const oldRequest = timelineRequests(game)[0]!;
  expect(oldRequest.init.signal?.aborted).toBe(false);

  rerender(view, lobby(game, otherViewer));
  await flush();
  expect(oldRequest.init.signal?.aborted).toBe(true);
  expect(timelineRequests(game)).toHaveLength(2);
  const current = post(2);
  timelineRequests(game)[1]!.respond(timeline([current]));
  await flush();

  oldRequest.respond(timeline([{ ...post(1), liked: true, likeCount: 99 }]));
  await flush();
  const section = preview(view);
  expect(section.textContent).toContain(current.text);
  expect(section.textContent).not.toContain(post(1).text);
  expectLike(like(section), false, current.likeCount);
});

test.each([
  { name: "成功", status: 200, body: { liked: true, likeCount: 99 } },
  { name: "失敗", status: 503, body: { message: "切り替え前のいいねの失敗理由" } },
])(
  "閲覧者を切り替えると進行中のいいねを中止し、遅れて届いた$name 応答を捨てる",
  async ({ status, body }) => {
    const first = post(1);
    const {
      view,
      cards: [card],
    } = await showPosts(viewer, first);
    act(() => like(card!).click());
    const oldRequest = requests.at(-1)!;
    expect(oldRequest.init.method).toBe("PUT");
    expect(oldRequest.init.signal?.aborted).toBe(false);
    expectLike(like(card!), true, first.likeCount + 1);

    rerender(view, lobby(game, otherViewer));
    await flush();
    expect(oldRequest.init.signal?.aborted).toBe(true);
    expect(timelineRequests(game)).toHaveLength(2);
    const current = { ...first, liked: false, likeCount: 10 };
    timelineRequests(game)[1]!.respond(timeline([current]));
    await flush();

    oldRequest.respond(body, status);
    await flush();
    const section = preview(view);
    expectLike(like(section), false, current.likeCount);
    expect(section.querySelector('[role="alert"]')).toBeNull();
  },
);

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
      acceptingPosts ? ["投稿する", "掲示板をすべて見る"] : ["掲示板をすべて見る"],
    );
    expectTimelineLink(section, game);
  },
);

test("投稿 API の失敗から、読み込み済みの区画で投稿の取得を再試行できる", async () => {
  const load = spyOn(previewImport, "importLobbyPostPreview");
  try {
    const view = show(game);
    const section = preview(view);
    const rooms = view.querySelector('section[aria-label="公開ルーム"]');
    expect(rooms).not.toBeNull();
    await flush();
    expect(load).toHaveBeenCalled();
    timelineRequests(game)[0]!.respond(null, 503);
    await flush();
    expect(section.querySelector('[role="alert"]')?.textContent).toBe(
      "投稿を取得できませんでした。",
    );
    expect(links(section)).toEqual([["掲示板をすべて見る", timelinePath(game)]]);
    expectTimelineLink(section, game);
    expect(view.querySelector('section[aria-label="公開ルーム"]')).toBe(rooms);

    load.mockClear();
    press(section, "再試行");
    await flush();
    expect(timelineRequests(game)).toHaveLength(2);
    expect(load).not.toHaveBeenCalled();
    const retry = timelineRequests(game)[1]!;
    retry.respond(timeline([post(1)]));
    await flush();
    expect(section.querySelector('[role="alert"]')).toBeNull();
    expect(section.textContent).toContain(post(1).text);
    expect(links(section)).toContainEqual(["投稿する", timelinePath(game)]);
  } finally {
    load.mockRestore();
  }
});

test("チャンクを読み込めないときは、ロビーを使いながら手動でページを再読み込みできる", async () => {
  const load = spyOn(previewImport, "importLobbyPostPreview").mockRejectedValue(
    new Error("Failed to fetch dynamically imported module"),
  );
  const reload = spyOn(preloadRecovery, "reload").mockImplementation(() => {});
  const autoReload = spyOn(preloadRecovery, "tryAutoReload").mockImplementation(() => {});
  try {
    const view = show(game);
    const section = preview(view);
    const rooms = view.querySelector('section[aria-label="公開ルーム"]');
    expect(rooms).not.toBeNull();
    await flush();

    expect(section.querySelector('[role="alert"]')?.textContent).toBe(
      "画面を読み込めませんでした。アプリが更新された可能性があります。再読み込みしてください。",
    );
    expect(links(section)).toEqual([["掲示板をすべて見る", timelinePath(game)]]);
    expectTimelineLink(section, game);
    expect(section.textContent).not.toContain("再試行");
    expect(view.querySelector('section[aria-label="公開ルーム"]')).toBe(rooms);
    expect(timelineRequests(game)).toHaveLength(0);
    expect(autoReload).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();

    press(section, "再読み込み");
    expect(reload).toHaveBeenCalledTimes(1);
  } finally {
    autoReload.mockRestore();
    reload.mockRestore();
    load.mockRestore();
  }
});

test("ロビーを離れると進行中の投稿取得を中止する", async () => {
  const view = show(game);
  await flush();
  const signal = timelineRequests(game)[0]!.init.signal!;
  expect(signal.aborted).toBe(false);
  rerender(view, null);
  expect(signal.aborted).toBe(true);
});

test("区画が画面に入ったときだけゲームを1回送信し、閲覧者の切り替えでも再送しない", async () => {
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
    const view = show(game, viewer);
    const section = preview(view);
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
    rerender(view, lobby(game, otherViewer));
    expect(preview(view)).toBe(section);
    intersect!(true);
    expect(beacon).toHaveBeenCalledTimes(1);
    rerender(view, null);
  } finally {
    if (originalObserver) Object.defineProperty(window, "IntersectionObserver", originalObserver);
    else Reflect.deleteProperty(window, "IntersectionObserver");
    if (originalBeacon) Object.defineProperty(navigator, "sendBeacon", originalBeacon);
    else Reflect.deleteProperty(navigator, "sendBeacon");
  }
});
