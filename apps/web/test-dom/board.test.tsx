import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  fourShogiPublicStateSchema,
  type AccountProfile,
  type TournamentDetail,
} from "@tetraboard/protocol";
import type {
  BoardPost,
  BoardPostInput,
  BoardPublishedPost,
  BoardReply,
} from "@tetraboard/protocol/board";
import {
  boardPostMetadata,
  renderDiscussionForumPostingJsonLd,
} from "@tetraboard/protocol/board-pages";
import { gameIds } from "@tetraboard/protocol/games";
import {
  createMemoryRouter,
  MemoryRouter,
  Outlet,
  Route,
  RouterProvider,
  Routes,
  useLocation,
} from "react-router";
import reversiArchive from "../../../test-fixtures/matches/reversi-doubles-normal.json";
import shogiArchive from "../../../test-fixtures/matches/shogi-singles.json";
import {
  readRegistrationReturn,
  registrationPath,
} from "../src/features/account/registrationReturn";
import { AccountLayout } from "../src/features/account/AccountSession";
import { AccountContext } from "../src/features/account/useAccount";
import { BoardAttachmentBoard } from "../src/features/board/BoardAttachmentBoard";
import { BoardDetailPage, BoardTimelinePage } from "../src/features/board/BoardPages";
import { formatMatchDate } from "../src/features/matches/matchDatePresentation";
import { startPageMetadata } from "../src/seo/pageMetadata";
import { appThemeClasses } from "../src/shared/ui/appTheme";
// 遅延読み込みされるモジュールを先に評価し、act 内で描画を待てるようにします。
import "../src/features/board/boardAttachmentFrames";
import "../src/features/board/boardMediaRequests";
import "../src/features/room/fourShogiMatchReplay";
import "../src/features/room/replayFrames";
import { act, clock, enter, flush, press, render, requests, wrap, type Request } from "./harness";

const uuid = (id: number) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(id).padStart(12, "0")}`;
const postPath = `/posts/${uuid(1)}`;
const timelinePath = "/games/four-shogi/posts";
const includeAttachments = "?includeAttachments=1";
const timelineUrl = "/api" + timelinePath + includeAttachments;
const postUrl = "/api" + postPath;
const detailQuery = includeAttachments + "&includeIndexable=1";
const detailUrl = postUrl + detailQuery;
const repliesUrl = postUrl + "/replies" + includeAttachments;
const user: AccountProfile = {
  username: "owner",
  name: "本人",
  avatarUrl: null,
  profileCompleted: true,
};

const originalObserver = Object.getOwnPropertyDescriptor(window, "IntersectionObserver");
beforeEach(() => {
  Object.defineProperty(window, "IntersectionObserver", { configurable: true, value: undefined });
});
afterEach(() => {
  if (originalObserver) Object.defineProperty(window, "IntersectionObserver", originalObserver);
  else Reflect.deleteProperty(window, "IntersectionObserver");
});

function observeMedia() {
  const targets = new Map<
    Element,
    { rootMargin?: string; intersect: (visible: boolean) => void }
  >();
  class Observer {
    private target: Element | null = null;
    private readonly callback: IntersectionObserverCallback;
    private readonly rootMargin?: string;
    constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
      this.callback = callback;
      this.rootMargin = options?.rootMargin;
    }
    observe(target: Element) {
      this.target = target;
      targets.set(target, {
        rootMargin: this.rootMargin,
        intersect: (isIntersecting) =>
          this.callback(
            [{ target, isIntersecting } as IntersectionObserverEntry],
            this as unknown as IntersectionObserver,
          ),
      });
    }
    disconnect() {
      if (this.target) targets.delete(this.target);
    }
  }
  Object.defineProperty(window, "IntersectionObserver", { configurable: true, value: Observer });
  return targets;
}

function reply(id: number, text: string, overrides: Partial<BoardReply> = {}): BoardReply {
  return {
    id: uuid(id),
    text,
    author: { name: "投稿者", avatarUrl: null, profileTarget: null },
    postedAtMs: Date.now() - 60_000 + id,
    liked: false,
    likeCount: 2,
    own: false,
    ...overrides,
  };
}

function post(
  id: number,
  text: string,
  overrides: Partial<BoardPublishedPost> = {},
): BoardPublishedPost {
  return {
    ...reply(id, text),
    status: "published",
    gameId: "four-shogi",
    replyCount: 0,
    ...overrides,
  };
}

function state(overrides = {}) {
  return {
    acceptingPosts: true,
    postingStopped: false,
    availableAtMs: 0,
    serverTimeMs: Date.now(),
    ...overrides,
  };
}

function timeline(posts: BoardPost[], nextCursor: string | null = null, overrides = {}) {
  return { ...state(overrides), posts, nextCursor };
}
function thread(
  parent: BoardPost,
  replies: BoardReply[] = [],
  nextCursor: string | null = null,
  indexable?: boolean,
) {
  return { ...state(), post: parent, replies, nextCursor, indexable };
}
function deleted({ id, postedAtMs, gameId, replyCount }: BoardPost): BoardPost {
  return { id, postedAtMs, gameId, replyCount, status: "deleted" };
}
function cursor({ id, postedAtMs }: BoardReply) {
  return `${postedAtMs}:${id}`;
}

function Destination() {
  const { pathname, search } = useLocation();
  return <p>{pathname + search}</p>;
}

function show(entry = timelinePath, viewer: AccountProfile | null = user) {
  return render(
    wrap(
      viewer,
      entry,
    )(
      <Routes>
        <Route path="/games/:gameId/posts" element={<BoardTimelinePage />} />
        <Route path="/posts/:id" element={<BoardDetailPage />} />
        <Route path="/matches/:id" element={<Destination />} />
        <Route path="/players/:profileId" element={<Destination />} />
        <Route path="/login" element={<p>ログイン画面</p>} />
      </Routes>,
    ),
  );
}
const latest = () => requests.at(-1)!;
const articles = (view: HTMLElement) => [...view.querySelectorAll("article")];
const input = (view: HTMLElement) => view.querySelector("textarea")!;
const like = (element: HTMLElement) =>
  element.querySelector<HTMLButtonElement>('button[aria-label="いいね"]')!;
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')!;
const requestInput = (request: Request) => JSON.parse(String(request.init.body)) as BoardPostInput;

function expectDetailLink(entry: HTMLElement, path: string) {
  const times = entry.querySelectorAll<HTMLTimeElement>(`a[href="${path}"] > time`);
  expect(times).toHaveLength(1);
  const time = times[0]!;
  const link = time.closest("a")!;
  expect(time.textContent).toMatch(/分前$/);
  expect(link.getAttribute("aria-label")).toBeNull();
  expect(link.textContent?.trim()).toBe(`投稿の詳細 ${time.textContent}`);
  expect(link.querySelector("a, button")).toBeNull();
  expect(link.classList.contains("before:inset-0")).toBe(true);
  expect(link.classList.contains("focus-visible:before:outline-focus")).toBe(true);
  return link;
}

function expectReplyLink(entry: HTMLElement, path: string, count: number) {
  const link = [...entry.querySelectorAll<HTMLAnchorElement>(`a[href="${path}"]`)].find(
    (candidate) => candidate.querySelector(".sr-only")?.textContent === `返信 ${count} 件`,
  );
  expect(link).toBeDefined();
  expect(link!.parentElement?.closest("a")).toBeNull();
  expect(link!.querySelector("a, button")).toBeNull();
  expect(link!.querySelector('span[aria-hidden="true"]')?.textContent).toBe(String(count));
  expect(link!.classList.contains("z-10")).toBe(true);
  expect(link!.classList.contains("focus-visible:outline-focus")).toBe(true);
  link!.focus();
  expect(document.activeElement).toBe(link!);
  return link!;
}

const { selfPlayerId: _reversiSelf, ...reversiMatch } = reversiArchive.detail;
const { selfPlayerId: _shogiSelf, ...shogiMatch } = shogiArchive.detail;
const timelineWithPosition = `${timelinePath}?match=${shogiMatch.id}&position=0`;

async function respond(body: unknown, status?: number) {
  latest().respond(body, status);
  await flush();
}

test.each([
  ["タイムライン", timelinePath],
  ["詳細", postPath],
] as const)(
  "掲示板の%sは共通のヘッダーを表示し、本文にゲームのテーマを適用する",
  async (_, path) => {
    const view = show(path, null);
    await respond(path === timelinePath ? timeline([]) : thread(post(1, "四人将棋の投稿")));

    const banner = view.querySelector("header")!;
    expect(banner.textContent).not.toContain("4人の遊びを、もっと気軽に。");
    expect(banner.querySelector('a[href="/login"]')?.textContent).toBe("登録・ログイン");

    const logo = banner.querySelector('a[aria-label="総合ロビーへ"] .text-brand')!;
    const themeSelector = `.${appThemeClasses["four-shogi"]}`;
    expect(logo.textContent).toBe("Board");
    expect(logo.closest(themeSelector)).toBeNull();
    expect(view.querySelector("main")!.parentElement!.closest(themeSelector)).not.toBeNull();
  },
);

test("カードと添付が表示範囲に近づいた対局だけを取得する", async () => {
  const observed = observeMedia();
  const view = show("/games/four-reversi/posts");
  const matchPath = `/matches/${reversiMatch.id}`;
  const origin = window.location.origin;
  const items = [
    post(2, origin + `/matches/${shogiMatch.id}`, {
      attachment: { matchId: shogiMatch.id, position: 0 },
    }),
    post(1, origin + matchPath, { attachment: { matchId: reversiMatch.id, position: 37 } }),
  ];
  await respond(timeline(items));
  expect(requests).toHaveLength(1);
  const nearPost = articles(view)[1]!;
  expect(nearPost.querySelector(`a[href="${matchPath}"]`)?.textContent).toBe(origin + matchPath);
  expect(observed.size).toBe(4);
  const near = [...observed].filter(([element]) => nearPost.contains(element));
  expect(near.map(([, target]) => target.rootMargin)).toEqual(["200px", "200px"]);
  act(() => near.forEach(([, target]) => target.intersect(false)));
  await flush();
  expect(requests).toHaveLength(1);
  act(() => near.forEach(([, target]) => target.intersect(true)));
  await flush();
  expect(requests.map(({ url }) => url)).toEqual([
    "/api/games/four-reversi/posts" + includeAttachments,
    "/api" + matchPath,
  ]);
  expect(observed.size).toBe(2);
  await respond({ match: reversiMatch });
  expect(nearPost.querySelector(`a[href="${matchPath}?position=37"]`)?.textContent).toBe("黒 パス");
  expect(nearPost.querySelectorAll(`a[href="${matchPath}"]`)).toHaveLength(2);
});

test("対局と大会を合わせて同時に3件まで取得し、残りは順番に開始する", async () => {
  show();
  const paths = [
    "/tournaments/21",
    `/matches/${reversiMatch.id}`,
    "/tournaments/22",
    `/matches/${shogiMatch.id}`,
    "/tournaments/23",
  ];
  const urls = () => requests.slice(1).map(({ url }) => url.slice(4));
  await respond(timeline([post(1, paths.map((path) => window.location.origin + path).join("\n"))]));
  expect(urls()).toEqual(paths.slice(0, 3));
  requests[2]!.reject();
  await flush();
  expect(urls()).toEqual(paths.slice(0, 4));
  requests[1]!.respond({}, 404);
  await flush();
  expect(urls()).toEqual(paths);
  for (const request of requests.slice(3)) request.respond({}, 404);
  await flush();
});

test.each([
  ["本文のリンク", 0],
  ["棋譜カード", 1],
  ["局面ラベル", 2],
] as const)("棋譜の取得を共有し、タイムラインの%sから公開棋譜の局面へ移る", async (_, index) => {
  const view = show("/games/four-reversi/posts");
  const matchPath = `/matches/${reversiMatch.id}`;
  const positionPath = matchPath + "?position=37";
  await respond(
    timeline([
      post(1, window.location.origin + positionPath, {
        gameId: "four-reversi",
        attachment: { matchId: reversiMatch.id, position: 37 },
      }),
      post(2, "同じ対局の開始局面", {
        gameId: "four-reversi",
        attachment: { matchId: reversiMatch.id, position: 0 },
      }),
    ]),
  );
  expect(requests.map(({ url }) => url)).toEqual([
    "/api/games/four-reversi/posts" + includeAttachments,
    "/api" + matchPath,
  ]);
  const loading = view.querySelectorAll('[aria-label="棋譜を読み込んでいます"]');
  expect(loading).toHaveLength(2);
  for (const frame of loading) {
    expect(frame.classList.contains("[@media(min-width:768px)]:w-96")).toBe(true);
    expect(frame.classList.contains("max-w-full")).toBe(true);
    expect(frame.classList.contains("w-full")).toBe(true);
  }
  await respond({ match: reversiMatch });
  const [first, second] = articles(view);
  const board = first!.querySelector('[aria-label="四人リバーシの盤面"]')!;
  const boardArea = board.closest(".pointer-events-none")!;
  expect(boardArea.closest("a")).toBeNull();
  expect(boardArea.parentElement?.className).toBe(loading[0]?.className);
  expect(first?.querySelector('[aria-label^="A1："]')).not.toBeNull();
  expect(first?.textContent).not.toContain(reversiMatch.participants[0]?.name);
  const links = first!.querySelectorAll<HTMLAnchorElement>(`a[href="${positionPath}"]`);
  expect([...links].map((link) => link.textContent)).toEqual([
    window.location.origin + positionPath,
    "四人リバーシ " + formatMatchDate(reversiMatch.startedAtMs),
    "黒 パス",
  ]);
  expect(second?.querySelector(`a[href="${matchPath}?position=0"]`)?.textContent).toBe("開始局面");
  expect(requests).toHaveLength(2);
  const detail = expectDetailLink(first!, postPath);
  const link = links[index]!;
  expect(detail.contains(link)).toBe(false);
  expect(link.classList.contains("z-10")).toBe(true);
  await act(async () => link.click());
  expect(view.textContent).toBe(positionPath);
});

test("返信の添付は公開棋譜のページを最後まで取得し、同じ対局の範囲外の局面は案内を表示する", async () => {
  const view = show(postPath);
  const matchPath = `/matches/${shogiMatch.id}`;
  await respond(
    thread(post(1, "投稿", { replyCount: 2 }), [
      reply(2, "将棋の局面", { attachment: { matchId: shogiMatch.id, position: 101 } }),
      reply(3, "範囲外", { attachment: { matchId: shogiMatch.id, position: 104 } }),
    ]),
  );
  expect(latest().url).toBe("/api" + matchPath);
  await respond({ match: shogiMatch });
  for (const cursor of [0, 100]) {
    expect(latest().url).toBe(`/api${matchPath}/replay${cursor ? "?cursor=100" : ""}`);
    await respond({
      matchId: shogiMatch.id,
      ...shogiMatch.replay,
      events: shogiArchive.events.slice(cursor, cursor + 100),
      nextCursor: cursor === 0 ? 100 : null,
    });
  }
  const [, first, second] = articles(view);
  const board = first!.querySelector<HTMLElement>('[aria-label="四人将棋の盤面"]')!;
  const links = first!.querySelectorAll<HTMLAnchorElement>(`a[href^="${matchPath}"]`);
  expect(links).toHaveLength(1);
  expect(links[0]?.getAttribute("href")).toBe(`${matchPath}?position=101`);
  expect(links[0]?.textContent).toBe("西 退室");
  expect(links[0]?.classList.contains("after:inset-0")).toBe(false);
  expect(first?.querySelector(".pointer-events-none [data-hand-kind]")).not.toBeNull();
  expect(second?.textContent).toContain("棋譜を表示できません。");
  expect(second?.querySelector(`a[href^="${matchPath}"]`)).toBeNull();
  expect(requests).toHaveLength(4);
  act(() => board.click());
  expect(view.querySelector("h1")?.textContent).toBe("投稿の詳細");
  expect(requests).toHaveLength(4);
  await act(async () => links[0]!.click());
  expect(view.textContent).toBe(`${matchPath}?position=101`);
});

test("スマホの四人将棋の添付では、折り返せる持ち駒台に4種と枚数を表示する", () => {
  const state = fourShogiPublicStateSchema.parse(shogiMatch.game);
  const hand = { ...state.hands.north, pawn: 4 };
  const game = {
    ...state,
    board: state.board.map((row) =>
      row.map((piece) => (piece?.side === "south" && piece.kind === "pawn" ? null : piece)),
    ),
    hands: { ...state.hands, north: hand },
  };
  const view = render(
    <BoardAttachmentBoard
      game="four-shogi"
      frame={{
        game,
        label: "表示確認",
        checkState: { south: false, west: false, north: false, east: false },
      }}
    />,
  );
  const trays = [...view.querySelectorAll('[data-testid="shogi-hand"]')];
  const wrapping = trays.filter((tray) => tray.classList.contains("flex-wrap"));
  expect(wrapping).toHaveLength(4);
  const northTray = wrapping.find((tray) => tray.getAttribute("aria-label") === "北の持ち駒");
  expect(northTray?.querySelectorAll("[data-hand-kind]")).toHaveLength(4);
  for (const [kind, count] of Object.entries(hand)) {
    const piece = northTray?.querySelector(`[data-hand-kind="${kind}"]`);
    expect(piece?.querySelector(".tabular-nums")?.textContent).toBe(
      count >= 2 ? String(count) : undefined,
    );
    expect(piece?.getAttribute("aria-label")).toContain(`${count}枚`);
  }
});

test("棋譜を表示できない下書きでも添付を送信し、400の案内を出してから添付を外せる", async () => {
  const view = show(timelineWithPosition);
  await respond(timeline([]));
  expect(latest().url).toBe(`/api/matches/${shogiMatch.id}`);
  await respond({}, 404);
  expect(view.querySelector("form")?.textContent).toContain("棋譜を表示できません。");
  enter(input(view), "下書き");
  press(view, "投稿する");
  const first = requestInput(latest());
  expect(first).toMatchObject({
    text: "下書き",
    attachment: { matchId: shogiMatch.id, position: 0 },
  });
  await respond({ message: "添付した棋譜の局面が見つかりません。" }, 400);
  expect(view.querySelector("form [role=alert]")?.textContent).toBe(
    "添付した棋譜の局面が見つかりません。",
  );
  press(view, "添付を外す");
  expect(view.querySelector("form")?.textContent).not.toContain("棋譜を表示できません。");
  expect(input(view).value).toBe("下書き");
  press(view, "投稿する");
  const next = requestInput(latest());
  expect(next).not.toHaveProperty("attachment");
  expect(next.requestId).not.toBe(first.requestId);
  await respond({ post: post(1, "下書き"), availableAtMs: 0 });
});

test("クエリから投稿欄に盤面を表示し、送信成功で投稿欄の添付を消す", async () => {
  const attachment = { matchId: reversiMatch.id, position: 36 };
  const path = "/games/four-reversi/posts";
  const view = show(`${path}?match=${attachment.matchId}&position=${attachment.position}`);
  await respond(timeline([]));
  await respond({ match: reversiMatch });
  expect(view.querySelector("form [aria-label='四人リバーシの盤面']")).not.toBeNull();
  expect(view.querySelector("form")?.textContent).toContain("36: 青H5");
  enter(input(view), "この局面について");
  press(view, "投稿する");
  expect(requestInput(latest())).toMatchObject({ attachment });
  await respond({
    post: post(1, "この局面について", { gameId: "four-reversi", attachment }),
    availableAtMs: 0,
  });
  expect(input(view).value).toBe("");
  expect(view.querySelector("form")?.textContent).not.toContain("添付を外す");
  expect(articles(view)[0]?.textContent).toContain("36: 青H5");
  expect(requests.map(({ url }) => url)).toEqual([
    "/api" + path + includeAttachments,
    `/api/matches/${attachment.matchId}`,
    "/api" + path + includeAttachments,
  ]);
});

test.each([
  "?match=bad&position=0",
  `?match=${shogiMatch.id}&position=1e0`,
  `?match=${shogiMatch.id}&position=9007199254740992`,
  `?match=${shogiMatch.id}&position=1&position=0`,
])("不正な添付クエリ %s から棋譜を取得しない", async (search) => {
  const view = show(timelinePath + search);
  await respond(timeline([]));
  expect(view.querySelector("form")?.textContent).not.toContain("添付を外す");
  expect(requests).toHaveLength(1);
});

test("添付のクエリをログイン後の復帰先に引き継ぐ", async () => {
  const view = show(timelineWithPosition, null);
  await respond(timeline([]));
  expect(input(view)).toBeNull();
  expect(requests).toHaveLength(1);
  press(view, "ログインして投稿");
  expect(view.textContent).toBe("ログイン画面");
  expect(readRegistrationReturn()?.path).toBe(timelineWithPosition);
});

test("大会とルームをカードにし、取得に失敗した URL は本文のリンクだけを出す", async () => {
  const view = show();
  const matchPath = `/matches/${shogiMatch.id}`;
  const roomPath = `/rooms/12345?invite=${uuid(123)}&watch=1`;
  const origin = window.location.origin;
  const paths = ["/tournaments/21", "/tournaments/22", matchPath, roomPath];
  await respond(
    timeline([post(1, paths.map((path) => origin + path).join("\n")), post(2, origin + paths[0])]),
  );
  expect(requests.map(({ url }) => url)).toEqual([
    timelineUrl,
    "/api/tournaments/21",
    "/api/tournaments/22",
    "/api" + matchPath,
  ]);
  const tournament: TournamentDetail = {
    tournament: {
      id: 21,
      name: "四人将棋大会",
      description: "",
      rulesDescription: "",
      startsAtMs: 1,
      endsAtMs: 2,
      status: "upcoming",
      entryCount: 0,
      waitingCount: 0,
      playingCount: 0,
      pendingCount: 0,
      completedCount: 0,
      ruleVersion: 1,
      finalizedAtMs: null,
    },
    nextTournament: null,
    standings: [],
    self: null,
    nextCursor: null,
  };
  requests[1]!.respond(tournament);
  requests[2]!.respond({}, 404);
  requests[3]!.reject();
  await flush();
  const linkText = (path: string) =>
    [...view.querySelectorAll<HTMLAnchorElement>("article a")]
      .filter((link) => link.getAttribute("href") === path)
      .map((link) => {
        expect(link.hasAttribute("rel")).toBe(false);
        return link.textContent;
      });
  expect(linkText(paths[0]!)).toEqual([
    origin + paths[0],
    "四人将棋大会",
    origin + paths[0],
    "四人将棋大会",
  ]);
  expect(linkText(paths[1]!)).toEqual([origin + paths[1]]);
  expect(linkText(matchPath)).toEqual([origin + matchPath]);
  expect(linkText(roomPath)).toEqual([origin + roomPath, "ルーム 12345"]);
});

function boardMetadataRouter(path: string) {
  return createMemoryRouter(
    [
      {
        element: (
          <AccountContext.Provider
            value={{
              user: null,
              loading: false,
              error: null,
              refresh: async () => {},
              update: () => {},
            }}
          >
            <Outlet />
          </AccountContext.Provider>
        ),
        children: [
          { path: "/games/:gameId/posts", element: <BoardTimelinePage /> },
          { path: "/posts/:id", element: <BoardDetailPage /> },
        ],
      },
    ],
    { initialEntries: [path] },
  );
}

test("画面内で投稿の詳細を開くと投稿ごとのメタ情報に更新し、読めない場合はnoindexに戻す", async () => {
  const previousHead = document.head.innerHTML;
  const router = boardMetadataRouter(timelinePath);
  const stop = startPageMetadata(router);
  const canonical = () =>
    document.head.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.href;
  const meta = (selector: string) =>
    document.head.querySelector<HTMLMetaElement>(selector)?.content;
  const robots = () => meta('meta[name="robots"]');
  const expectFallback = () => {
    expect(robots()).toBe("noindex,follow");
    expect(document.title).toBe("TetraBoard");
    expect(canonical()).toBeUndefined();
    expect(
      [...document.head.querySelectorAll('meta[property^="og:"], meta[name^="twitter:"]')].map(
        (tag) => tag.getAttribute("property"),
      ),
    ).toEqual(["og:site_name"]);
  };
  try {
    const view = render(<RouterProvider router={router} />);
    const first = post(1, "最初の投稿\n次の行");
    await respond(timeline([first]));
    await act(async () => view.querySelector<HTMLAnchorElement>(`a[href="${postPath}"]`)!.click());
    expect(latest().url).toBe(detailUrl);
    expectFallback();
    await respond(thread(first, [], null, true));
    expect(document.title).toBe("最初の投稿 次の行｜四人将棋の掲示板 | TetraBoard");
    expect(meta('meta[name="description"]')).toBe("最初の投稿 次の行");
    expect(canonical()).toBe(`https://tetraboard.net${postPath}`);
    expect(robots()).toBe("index,follow");
    expect(meta('meta[property="og:image"]')).toBe(
      "https://tetraboard.net/assets/ogp/four-shogi.png",
    );
    expect(document.head.querySelector('script[type="application/ld+json"]')).toBeNull();

    const second = post(2, "別の投稿", { gameId: "reversi" });
    await act(async () => {
      await router.navigate(`/posts/${second.id}/`);
    });
    await respond(thread(second));
    expect(document.title).toBe("別の投稿｜リバーシの掲示板 | TetraBoard");
    expect(canonical()).toBe(`https://tetraboard.net/posts/${second.id}`);
    expect(robots()).toBe("noindex,follow");
    expect(meta('meta[property="og:image"]')).toBe("https://tetraboard.net/assets/ogp/reversi.png");

    await act(async () => {
      await router.navigate(`/posts/${uuid(3)}`);
    });
    await respond({}, 404);
    expectFallback();
    await act(async () => {
      await router.navigate(`/posts/${uuid(4)}`);
    });
    await respond({}, 503);
    expectFallback();
  } finally {
    stop();
    router.dispose();
    document.head.innerHTML = previousHead;
  }
});

function initialBoardMetadata(parent: BoardPublishedPost, replies: BoardReply[]) {
  const previousHead = document.head.innerHTML;
  const router = boardMetadataRouter(`${postPath}/`);
  const { title, description, canonical } = boardPostMetadata("https://tetraboard.net", parent);
  document.head.innerHTML = `<title>${title}</title><meta name="description" content="${description}"><meta name="robots" content="index,follow"><link rel="canonical" href="${canonical}"><meta property="og:image" content="https://tetraboard.net/assets/ogp/four-shogi.png">${renderDiscussionForumPostingJsonLd(canonical, parent, replies)}`;
  const stop = startPageMetadata(router);
  return {
    router,
    dispose() {
      stop();
      router.dispose();
      document.head.innerHTML = previousHead;
    },
  };
}

function readBoardHead() {
  return {
    title: document.title,
    description: document.head.querySelector('meta[name="description"]')?.getAttribute("content"),
    canonical: document.head.querySelector('link[rel="canonical"]')?.getAttribute("href"),
    robots: document.head.querySelector('meta[name="robots"]')?.getAttribute("content"),
    jsonLd: document.head.querySelector('script[type="application/ld+json"]')?.textContent,
  };
}

test("直接開いた投稿が初期HTMLと同じならメタ情報とJSON-LDの内容が変わらない", async () => {
  const parent = post(1, "投稿の本文", { replyCount: 2 });
  const first = reply(2, "最初の返信", { own: true });
  const next = reply(3, "追加取得した返信");
  const { router, dispose } = initialBoardMetadata(parent, [first]);
  const initialHead = document.head.innerHTML;
  const initialContent = readBoardHead();
  try {
    const view = render(<RouterProvider router={router} />);
    expect(document.head.innerHTML).toBe(initialHead);
    await respond(thread(parent, [first], cursor(first), true));
    expect(view.textContent).toContain(parent.text);
    expect(readBoardHead()).toEqual(initialContent);

    press(view, "もっと見る");
    await respond({ replies: [next], nextCursor: null });
    expect(view.textContent).toContain(next.text);
    expect(readBoardHead()).toEqual(initialContent);

    press(articles(view)[1]!, "削除");
    press(dialog(), "削除する");
    await respond(null, 204);
    expect(latest().url).toBe(detailUrl);
    const newFirst = reply(4, "再取得の最初のページにある返信");
    await respond(thread(parent, [newFirst], null, true));
    expect(view.textContent).toContain(next.text);
    const updated = readBoardHead();
    expect(JSON.parse(updated.jsonLd!).comment.map(({ text }: { text: string }) => text)).toEqual([
      newFirst.text,
    ]);

    await act(async () => {
      await router.navigate(`${postPath}?source=board`);
    });
    expect(readBoardHead()).toEqual(updated);
    await act(async () => {
      await router.navigate(timelinePath);
    });
    expect(readBoardHead().jsonLd).toBeUndefined();
    expect(readBoardHead().description).toBeUndefined();
    expect(readBoardHead().robots).toBe("noindex,follow");
  } finally {
    dispose();
  }
});

test("直接開いた投稿の詳細APIが削除枠を返すとheadから元の内容を取り除く", async () => {
  const parent = post(1, "削除された元の本文", { replyCount: 1 });
  const remaining = reply(2, "残った返信");
  const { router, dispose } = initialBoardMetadata(parent, [remaining]);
  try {
    render(<RouterProvider router={router} />);
    await respond(thread(deleted(parent), [remaining], null, false));
    expect(readBoardHead()).toEqual({
      title: "削除された投稿｜四人将棋の掲示板 | TetraBoard",
      description: "四人将棋の掲示板の削除された投稿です。返信 1 件を読めます。",
      canonical: `https://tetraboard.net${postPath}`,
      robots: "noindex,follow",
      jsonLd: undefined,
    });
    expect(document.head.innerHTML).not.toContain(parent.text);
  } finally {
    dispose();
  }
});

test("直接開いた投稿の詳細APIで返信が減ったときはJSON-LDにも反映する", async () => {
  const parent = post(1, "投稿の本文", { replyCount: 2 });
  const removed = reply(2, "削除された元の返信");
  const remaining = reply(3, "残った返信");
  const { router, dispose } = initialBoardMetadata(parent, [removed, remaining]);
  const initialContent = readBoardHead();
  try {
    render(<RouterProvider router={router} />);
    await respond(thread({ ...parent, replyCount: 1 }, [remaining], null, true));
    const { jsonLd, ...updated } = readBoardHead();
    expect(updated).toEqual({
      title: initialContent.title,
      description: initialContent.description,
      canonical: initialContent.canonical,
      robots: "index,follow",
    });
    expect(JSON.parse(jsonLd!)).toMatchObject({
      "@type": "DiscussionForumPosting",
      url: updated.canonical,
      text: parent.text,
      comment: [{ "@type": "Comment", text: remaining.text }],
    });
    expect(jsonLd).not.toContain(removed.text);
  } finally {
    dispose();
  }
});

test("直接開いた投稿の詳細APIが404を返すとnoindexにしてJSON-LDを取り除く", async () => {
  const parent = post(1, "削除された元の本文");
  const { router, dispose } = initialBoardMetadata(parent, []);
  try {
    const view = render(<RouterProvider router={router} />);
    await respond({}, 404);
    expect(view.textContent).toContain("投稿が見つかりません。");
    expect(readBoardHead()).toEqual({
      title: "TetraBoard",
      description: undefined,
      canonical: undefined,
      robots: "noindex,follow",
      jsonLd: undefined,
    });
    expect(document.head.querySelector('meta[property="og:image"]')).toBeNull();
    expect(document.head.innerHTML).not.toContain(parent.text);
  } finally {
    dispose();
  }
});

test("タイムラインは更新ボタンを表示せず、追加取得で重複を除いて詳細へ移れる", async () => {
  const view = show();
  expect(view.querySelector('[role="status"]')?.textContent).toContain("読み込んでいます");
  expect(latest().url).toBe(timelineUrl);
  const recent = post(2, "最新の投稿");
  const old = post(1, "古い投稿");
  const before = cursor(recent);
  await respond(timeline([recent], before));
  expect(view.querySelector("h1")?.textContent).toBe("四人将棋の掲示板");
  expect(view.querySelector('a[href="/games/four-shogi"]')).not.toBeNull();
  expect([...view.querySelectorAll("button")].some((button) => button.textContent === "更新")).toBe(
    false,
  );
  expect(articles(view)[0]?.textContent).toContain("最新の投稿");
  clock.advance(60_000);
  expect(requests).toHaveLength(1);
  press(view, "もっと見る");
  expect(latest().url).toBe(`${timelineUrl}&before=${encodeURIComponent(before)}`);
  expect(view.querySelector('button[data-pending="true"]')?.textContent).toBe("もっと見る");
  await respond(timeline([recent, old]));
  expect(articles(view)).toHaveLength(2);
  expect(articles(view)[1]?.textContent).toContain("古い投稿");

  const [first, second] = articles(view);
  expectDetailLink(first!, `/posts/${recent.id}`);
  const detail = expectDetailLink(second!, postPath);
  await act(async () => detail.click());
  expect(latest().url).toBe(detailUrl);
  await respond(thread(old));
  expect(view.querySelector("h1")?.textContent).toBe("投稿の詳細");
  expect(view.querySelector("h2")).toBeNull();
  expect(view.querySelector("section[aria-labelledby] .border-l-2")).toBeNull();
});

test("タイムラインの返信リンクはカードと同じ投稿の詳細を開く", async () => {
  const view = show();
  const parent = post(1, "返信のある投稿", { replyCount: 2 });
  await respond(timeline([parent]));
  const [entry] = articles(view);
  const detail = expectDetailLink(entry!, postPath);
  const replies = expectReplyLink(entry!, postPath, 2);
  expect(detail.contains(replies)).toBe(false);
  expect(replies.nextElementSibling).toBe(like(entry!));
  await act(async () => replies.click());
  expect(latest().url).toBe(detailUrl);
  await respond(thread(parent, [reply(2, "投稿への返信"), reply(3, "続く返信")]));
  expect(view.querySelector("h1")?.textContent).toBe("投稿の詳細");
  expect(view.textContent).toContain("投稿への返信");
  expect(articles(view)[0]?.querySelector(`a[href="${postPath}"]`)).toBeNull();
});

test("タイムラインの再試行は失敗した添付と棋譜カードをまとめて再取得する", async () => {
  const view = show();
  const matchPath = `/matches/${reversiMatch.id}`;
  const item = post(1, window.location.origin + matchPath, {
    attachment: { matchId: reversiMatch.id, position: 37 },
  });
  await respond(timeline([item, post(2, "削除する投稿", { own: true })]));
  expect(latest().url).toBe("/api" + matchPath);
  await respond({}, 503);
  const entry = articles(view)[0]!;
  expect(entry.textContent).toContain("棋譜を表示できません。");
  expect(entry.querySelectorAll(`a[href="${matchPath}"]`)).toHaveLength(1);

  press(articles(view)[1]!, "削除");
  press(dialog(), "削除する");
  await respond(null, 204);
  expect(latest().url).toBe(`/api/posts/${uuid(2)}${detailQuery}`);
  await respond(null, 503);

  const beforeRetry = requests.length;
  press(view, "再試行");
  expect(latest().url).toBe(timelineUrl);
  await respond(timeline([item]));
  expect(requests.slice(beforeRetry).map(({ url }) => url)).toEqual([
    timelineUrl,
    "/api" + matchPath,
  ]);
  expect(entry.querySelector('[aria-label="棋譜を読み込んでいます"]')).not.toBeNull();
  await respond({ match: reversiMatch });
  expect(entry.querySelector('[aria-label="四人リバーシの盤面"]')).not.toBeNull();
  expect(entry.querySelector(`a[href="${matchPath}?position=37"]`)?.textContent).toBe("黒 パス");
  expect(entry.querySelectorAll(`a[href="${matchPath}"]`)).toHaveLength(2);
});

test("取得失敗後に同じ対局の投稿を追加表示すると、失敗した棋譜を再取得する", async () => {
  const view = show();
  const matchId = reversiMatch.id;
  const matchUrl = `/api/matches/${matchId}`;
  const item = post(2, "先頭の投稿", { attachment: { matchId, position: 37 } });
  await respond(timeline([item], cursor(item)));
  expect(latest().url).toBe(matchUrl);
  await respond({}, 404);
  expect(articles(view)[0]?.textContent).toContain("棋譜を表示できません。");
  press(view, "もっと見る");
  await respond(timeline([post(1, "追加した投稿", { attachment: { matchId, position: 0 } })]));
  expect(latest().url).toBe(matchUrl);
  expect(requests.filter(({ url }) => url === matchUrl)).toHaveLength(2);
  await respond({ match: reversiMatch });
  expect(articles(view)[1]?.textContent).toContain("開始局面");
});

test("タイムラインの通信失敗は再試行でき、追加取得に失敗しても取得済み投稿を保持する", async () => {
  const view = show();
  latest().reject();
  await flush();
  expect(view.querySelector('[role="alert"]')?.textContent).toBe("投稿を取得できませんでした。");
  press(view, "再試行");
  const first = post(1, "取得済み");
  await respond(timeline([first], cursor(first)));
  press(view, "もっと見る");
  const nextUrl = latest().url;
  await respond(null, 503);
  expect(view.textContent).toContain("取得済み");
  expect(view.textContent).toContain("投稿を取得できませんでした。");
  press(view, "再試行");
  expect(latest().url).toBe(nextUrl);
  await respond(timeline([post(2, "続き")]));
  expect(view.textContent).toContain("続き");
});

test("省略した投稿ではカードを取得せず、詳細では全文のリンクとカードを取得する", async () => {
  const prototype = HTMLElement.prototype;
  const original = Object.getOwnPropertyDescriptor(prototype, "scrollHeight");
  Object.defineProperty(prototype, "scrollHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return this.matches("p.line-clamp-5") && (this.textContent?.split("\n").length ?? 0) > 5
        ? this.clientHeight + 20
        : this.clientHeight;
    },
  });
  try {
    const view = show();
    const internal = window.location.origin + "/tournaments/21";
    const hidden = window.location.origin + "/tournaments/22";
    const longPost = post(2, `一\n二\n三\n四\n五\n${hidden}`);
    const external = "https://example.com/";
    await respond(timeline([longPost, post(1, `${internal} と ${external}\n二\n三\n四\n五`)]));
    const [long, short] = articles(view);
    const more = [...long!.querySelectorAll("a")].find((link) => link.textContent === "続きを読む");
    expect(more?.getAttribute("href")).toBe(`/posts/${uuid(2)}`);
    expect(long?.querySelector('a[href="/tournaments/22"]')?.textContent).toBe(hidden);
    expect(requests.map(({ url }) => url)).toEqual([timelineUrl, "/api/tournaments/21"]);
    expect(short?.textContent).not.toContain("続きを読む");
    const link = short?.querySelector('a[href="/tournaments/21"]');
    expect(link?.textContent).toBe(internal);
    expect(link?.hasAttribute("rel")).toBe(false);
    expect(link?.hasAttribute("target")).toBe(false);
    expect(short?.querySelector('a[href*="example.com"]')).toBeNull();
    expect(short?.textContent).toContain(external);
    expectDetailLink(short!, postPath);
    expect(like(short!).previousElementSibling?.textContent).toContain("返信 0 件");
    expect(more?.classList.contains("z-10")).toBe(true);
    act(() => more!.click());
    await flush();
    expect(latest().url).toBe(`/api/posts/${uuid(2)}${detailQuery}`);
    await respond(thread(longPost));
    expect(latest().url).toBe("/api/tournaments/22");
  } finally {
    if (original) Object.defineProperty(prototype, "scrollHeight", original);
    else Reflect.deleteProperty(prototype, "scrollHeight");
  }
});

test("投稿の失敗と再送で下書きとrequestIdを保持し、本文変更後の成功で先頭に足す", async () => {
  const view = show();
  await respond(timeline([post(1, "以前の投稿")]));
  enter(input(view), "  \n");
  expect(view.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true);
  enter(input(view), "あ".repeat(1001));
  expect(view.textContent).toContain("1001/1000");
  expect(view.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true);
  enter(input(view), "下書き👨‍👩‍👧‍👦");
  expect(view.textContent).toContain("4/1000");
  press(view, "投稿する");
  const first = requestInput(latest());
  expect(latest().url).toBe(timelineUrl);
  expect(latest().init.method).toBe("POST");
  expect(view.querySelector('button[data-pending="true"]')?.textContent).toBe("投稿する");
  press(view, "投稿する");
  act(() => {
    input(view).dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  act(() =>
    input(view).form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
  expect(
    requests.filter(({ url, init }) => url === timelineUrl && init.method === "POST"),
  ).toHaveLength(1);
  await respond({ message: "少し待ってから再試行してください。" }, 429);
  expect(input(view).value).toBe(first.text);
  expect(view.textContent).toContain("少し待ってから再試行してください。");
  press(view, "投稿する");
  expect(requestInput(latest())).toEqual(first);
  await respond({ message: "送信失敗" }, 503);
  enter(input(view), "新しい本文");
  press(view, "投稿する");
  const second = requestInput(latest());
  expect(second.requestId).not.toBe(first.requestId);
  await respond({ post: post(2, second.text), availableAtMs: 0 });
  expect(input(view).value).toBe("");
  expect(articles(view)[0]?.textContent).toContain(second.text);
  expect(articles(view)[1]?.textContent).toContain("以前の投稿");

  enter(input(view), second.text);
  press(view, "投稿する");
  expect(requestInput(latest()).requestId).not.toBe(second.requestId);
  await respond({ post: null, availableAtMs: 0 });
  expect(latest().url).toBe(timelineUrl);
  expect(latest().init.method).toBeUndefined();
  await respond(timeline([post(2, second.text)]));
  expect(articles(view)).toHaveLength(1);
});

test("投稿欄は前後の空白を除いて1,000字まで送信できる", async () => {
  const view = show();
  await respond(timeline([]));
  const submit = view.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  enter(input(view), " \n　");
  expect(view.textContent).toContain("0/1000");
  expect(submit.disabled).toBe(true);
  enter(input(view), "あ".repeat(1001));
  expect(view.textContent).toContain("1001/1000");
  expect(submit.disabled).toBe(true);
  const text = "\n" + "あ".repeat(1000) + "\n";
  enter(input(view), text);
  expect(view.textContent).toContain("1000/1000");
  expect(submit.disabled).toBe(false);
  press(view, "投稿する");
  expect(requestInput(latest()).text).toBe(text);
});

test.each([true, false])(
  "古い投稿の再送成功は表示位置を維持するか先頭から取り直す（取得済み: %s）",
  async (loaded) => {
    const view = show();
    const newest = post(3, "最新の投稿");
    const old = post(1, "保存済みの本文", { own: true });
    await respond(timeline(loaded ? [newest, old] : [newest], cursor(newest)));
    enter(input(view), old.text);
    press(view, "投稿する");
    const original = requestInput(latest());
    latest().reject();
    await flush();
    press(view, "投稿する");
    expect(requestInput(latest())).toEqual(original);
    const replayed = { ...old, likeCount: 17 };
    await respond({ post: replayed, availableAtMs: 0 });
    if (!loaded) {
      expect(latest().url).toBe(timelineUrl);
      expect(latest().init.method).toBeUndefined();
      expect(articles(view)).toHaveLength(1);
      await respond(timeline([newest, replayed]));
    }
    expect(articles(view)).toHaveLength(2);
    expect(articles(view)[0]?.textContent).toContain(newest.text);
    expect(articles(view)[1]?.textContent).toContain(old.text);
    expect(like(articles(view)[1]!).textContent).toContain("17");
    expect(input(view).value).toBe("");
  },
);

test("Enterは送信せず、変換中のCtrlまたは⌘+Enterも送信しない", async () => {
  const view = show();
  await respond(timeline([]));
  enter(input(view), "変換中");
  const keydown = (options: KeyboardEventInit, keyCode?: number) =>
    act(() => {
      const event = new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
        ...options,
      });
      if (keyCode) Object.defineProperty(event, "keyCode", { value: keyCode });
      input(view).dispatchEvent(event);
    });
  keydown({});
  keydown({ ctrlKey: true, isComposing: true });
  keydown({ metaKey: true }, 229);
  expect(requests).toHaveLength(1);
  keydown({ metaKey: true });
  expect(latest().init.method).toBe("POST");
});

test("詳細は全文と正確な日時を表示し、返信の追加取得と送信を古い順で重複なく表示する", async () => {
  const view = show(postPath);
  expect(latest().url).toBe(detailUrl);
  const first = reply(2, "最初の返信");
  const newReply = reply(4, "送信した返信");
  const second = reply(5, "次の返信", {
    id: uuid(5).toUpperCase(),
    postedAtMs: newReply.postedAtMs,
  });
  const parent = post(1, "投稿の全文\n二\n三\n四\n五\n六", { replyCount: 2 });
  await respond(thread(parent, [first], cursor(first)));
  const main = articles(view)[0]!;
  expect(main.textContent).toContain(parent.text);
  expect(main.querySelector(".line-clamp-5")).toBeNull();
  const time = main.querySelector("time")!;
  expect(time.dateTime).toBe(new Date(parent.postedAtMs).toISOString());
  expect(time.textContent).toBe(time.title);
  expect(articles(view)[1]?.querySelector("time")?.textContent).toMatch(/分前$/);
  expect(view.querySelector(`a[href="${timelinePath}"]`)).not.toBeNull();
  for (const entry of articles(view)) {
    expect(entry.querySelector('a[href^="/posts/"]')).toBeNull();
  }
  const heading = view.querySelector("h2")!;
  const replies = view.querySelector(`section[aria-labelledby="${heading.id}"]`);
  expect(heading.textContent).toBe("返信 2 件");
  expect(replies?.contains(heading)).toBe(true);
  expect(replies?.querySelector(".ml-3.border-l-2.pl-3 article")).toBe(articles(view)[1]!);
  enter(input(view), newReply.text);
  press(view, "返信する");
  expect(latest().url).toBe(repliesUrl);
  expect(latest().init.method).toBe("POST");
  await respond({ reply: newReply, availableAtMs: 0 });
  expect(latest().url).toBe(detailUrl);
  expect(latest().init.method).toBeUndefined();
  await respond(
    thread({ ...parent, replyCount: 7, liked: true, likeCount: 14 }, [first], cursor(newReply)),
  );
  expect(articles(view)[2]?.textContent).toContain(newReply.text);
  expect(main.textContent).toContain("返信 7 件");
  expect(heading.textContent).toBe("返信 7 件");
  expect(like(main).textContent).toContain("14");
  expect(like(main).getAttribute("aria-pressed")).toBe("true");
  press(view, "もっと見る");
  expect(latest().url).toBe(`${repliesUrl}&after=${encodeURIComponent(cursor(first))}`);
  await respond({ replies: [second, newReply], nextCursor: null });
  expect(articles(view)).toHaveLength(4);
  expect(articles(view)[1]?.textContent).toContain(first.text);
  expect(articles(view)[2]?.textContent).toContain(second.text);
  expect(articles(view)[3]?.textContent).toContain(newReply.text);
  expect(main.textContent).toContain("返信 7 件");
});

test("タイムラインの返信数、いいね、通報は独立した操作として順に並ぶ", async () => {
  const view = show();
  await respond(timeline([post(1, "投稿", { replyCount: 3 })]));
  const card = articles(view)[0]!;
  const button = like(card);
  const report = reportButton(card)!;
  const count = button.previousElementSibling!;
  expect(count.textContent).toContain("返信 3 件");
  expect(count.querySelector("svg")?.classList.contains("size-5")).toBe(true);
  expect(button.querySelector("svg")?.classList.contains("size-5")).toBe(true);
  expect(button.classList.contains("min-h-11")).toBe(true);
  expect(button.classList.contains("min-w-11")).toBe(true);
  expect(count.getAttribute("href")).toBe(postPath);
  expect(count.parentElement?.closest("a")).toBeNull();
  expect(button.nextElementSibling).toBe(report);
  expect(button.closest("a")).toBeNull();
  expect(report.closest("a")).toBeNull();
  expect(button.classList.contains("z-10")).toBe(true);
  expect(report.classList.contains("z-10")).toBe(true);
  expect(report.classList.contains("ml-auto")).toBe(true);

  act(() => button.click());
  expect(latest().url).toBe(postUrl + "/like");
  expect(latest().init.method).toBe("PUT");
  await respond({ liked: true, likeCount: 3 });
  await act(async () => {
    report.click();
    await import("../src/features/board/BoardReportDialog");
  });
  expect(dialog().textContent).toContain("投稿を通報");
  expect(view.querySelector("h1")?.textContent).toBe("四人将棋の掲示板");
  expect(requests).toHaveLength(2);
});

test("返信送信後に同期が失敗しても返信を表示し、再試行で返信数を同期する", async () => {
  const view = show(postPath);
  const parent = post(1, "本文", { replyCount: 1 });
  const original = reply(2, "既存の返信");
  const sent = reply(3, "送信した返信");
  await respond(thread(parent, [original]));
  enter(input(view), sent.text);
  press(view, "返信する");
  await respond({ reply: sent, availableAtMs: 0 });
  expect(latest().url).toBe(detailUrl);
  await respond(null, 503);
  expect(input(view).value).toBe("");
  expect(articles(view)).toHaveLength(3);
  expect(articles(view)[2]?.textContent).toContain(sent.text);
  expect(articles(view)[0]?.textContent).toContain("返信 1 件");
  expect(view.textContent).toContain("投稿を取得できませんでした。");
  press(view, "再試行");
  await respond({
    ...thread({ ...parent, replyCount: 8 }, [original, sent], cursor(sent)),
    acceptingPosts: false,
  });
  expect(articles(view)).toHaveLength(3);
  expect(articles(view)[0]?.textContent).toContain("返信 8 件");
  expect(view.textContent).toContain("現在、掲示板への投稿を受け付けていません。");
  expect(view.textContent).not.toContain("もっと見る");
  expect(view.textContent).not.toContain("再試行");
});

test("返信の再送成功は一覧にある返信も重複させず、返信がnullでも再取得する", async () => {
  const view = show(postPath);
  const parent = post(1, "本文", { replyCount: 1 });
  const saved = reply(2, "保存済みの返信");
  await respond(thread(parent, [saved]));
  enter(input(view), saved.text);
  press(view, "返信する");
  const original = requestInput(latest());
  latest().reject();
  await flush();
  press(view, "返信する");
  expect(requestInput(latest())).toEqual(original);
  await respond({ reply: saved, availableAtMs: 0 });
  expect(latest().url).toBe(detailUrl);
  await respond(thread({ ...parent, replyCount: 3 }, [saved]));
  expect(articles(view)).toHaveLength(2);
  expect(articles(view)[0]?.textContent).toContain("返信 3 件");

  enter(input(view), "別の返信");
  press(view, "返信する");
  await respond({ reply: null, availableAtMs: 0 });
  expect(latest().url).toBe(detailUrl);
  await respond(thread({ ...parent, replyCount: 4 }, [saved, reply(3, "別の返信")]));
  expect(articles(view)).toHaveLength(3);
  expect(articles(view)[0]?.textContent).toContain("返信 4 件");
});

test.each([503, 200])("詳細の障害・不正な応答では再試行できる（HTTP %s）", async (status) => {
  const view = show(postPath);
  await respond({ invalid: true }, status);
  expect(view.textContent).toContain("投稿を取得できませんでした。");
  press(view, "再試行");
  expect(latest().url).toBe(detailUrl);
  await respond(thread(post(1, "再試行の詳細")));
  expect(view.textContent).toContain("再試行の詳細");
});

test("詳細の404では見つからない案内と総合ロビーへの導線が出る", async () => {
  const view = show(postPath);
  await respond(null, 404);
  expect(view.textContent).toContain(
    "投稿が見つかりません。削除されたか、URL が間違っている可能性があります。",
  );
  expect(view.querySelector('a[href="/"]')?.textContent).toBe("総合ロビーへ");
  expect(view.textContent).not.toContain("再試行");
});

test("返信の追加取得が404なら見つからない案内を表示する", async () => {
  const view = show(postPath);
  const first = reply(2, "最初の返信");
  await respond(thread(post(1, "本文", { replyCount: 2 }), [first], cursor(first)));
  press(view, "もっと見る");
  expect(latest().url).toBe(`${repliesUrl}&after=${encodeURIComponent(cursor(first))}`);
  await respond(null, 404);
  expect(view.textContent).toContain("投稿が見つかりません。");
  expect(view.querySelector('a[href="/"]')?.textContent).toBe("総合ロビーへ");
});

test("自分の投稿と返信にもいいねできる。即時反映し、応答に合わせ、失敗は元に戻す", async () => {
  const view = show(postPath);
  await respond(
    thread(post(1, "投稿", { own: true, replyCount: 1 }), [reply(2, "返信", { own: true })]),
  );
  const [main, child] = articles(view);
  const mainLike = like(main!);
  const replyLike = like(child!);
  expect(replyLike.previousElementSibling).toBeNull();
  expect(replyLike.nextElementSibling?.textContent).toBe("削除");
  expect(mainLike.matches(".min-h-11.min-w-11")).toBe(true);
  expect([...mainLike.classList].filter((name) => /(^|:)border|(^|:)bg-/.test(name))).toEqual([
    "border-0",
    "bg-transparent",
  ]);
  expect(mainLike.classList.contains("text-ink-secondary")).toBe(true);
  expect(mainLike.querySelector("svg")?.getAttribute("fill")).toBe("none");
  act(() => mainLike.click());
  expect(latest().url).toBe(postUrl + "/like");
  expect(latest().init.method).toBe("PUT");
  expect(mainLike.getAttribute("aria-pressed")).toBe("true");
  expect([...mainLike.classList].filter((name) => /(^|:)border|(^|:)bg-/.test(name))).toEqual([
    "border-0",
    "bg-transparent",
  ]);
  expect(mainLike.classList.contains("text-danger")).toBe(true);
  expect(mainLike.querySelector("svg")?.getAttribute("fill")).toBe("currentColor");
  expect(mainLike.textContent).toContain("3");
  act(() => mainLike.click());
  expect(requests).toHaveLength(2);
  await respond({ liked: true, likeCount: 5 });
  expect(mainLike.textContent).toContain("5");
  act(() => mainLike.click());
  expect(latest().init.method).toBe("DELETE");
  expect(mainLike.getAttribute("aria-pressed")).toBe("false");
  await respond({ liked: false, likeCount: 4 });
  expect(mainLike.textContent).toContain("4");

  act(() => replyLike.click());
  expect(latest().url).toBe(`/api/posts/${uuid(2)}/like`);
  expect(replyLike.getAttribute("aria-pressed")).toBe("true");
  await respond({ message: "いいねを保存できませんでした。" }, 503);
  expect(replyLike.getAttribute("aria-pressed")).toBe("false");
  expect(replyLike.textContent).toContain("2");
  expect(child?.textContent).toContain("いいねを保存できませんでした。");
  act(() => replyLike.click());
  await respond({ liked: true, likeCount: 3 });
  expect(replyLike.getAttribute("aria-pressed")).toBe("true");
});

test.each([
  {
    viewer: null,
    reason: "いいねするにはログインしてください。",
    prompt: "投稿するにはログインしてください。",
  },
  {
    viewer: { ...user, isGuest: true },
    reason: "いいねにはアカウント登録が必要です。",
    prompt: "掲示板への投稿にはアカウント登録が必要です。",
  },
  {
    viewer: { ...user, profileCompleted: false },
    reason: "プロフィールの初回設定を完了するといいねできます。",
    prompt: "プロフィールの初回設定を完了すると投稿できます。",
  },
])(
  "投稿できない利用者への案内を出し、いいねの理由はボタンを押して確認できる",
  async ({ viewer, reason, prompt }) => {
    const view = show(timelinePath, viewer);
    await respond(timeline([post(1, "閲覧する投稿")]));
    expect(view.textContent).toContain(prompt);
    expect(input(view)).toBeNull();
    const button = like(view);
    expect(button.textContent).toContain("2");
    act(() => button.click());
    expect(view.querySelector('[role="alert"]')?.textContent).toBe(reason);
    expect(requests).toHaveLength(1);
    if (viewer?.isGuest) {
      press(view, "アカウント登録へ");
      expect(view.textContent).toBe("ログイン画面");
    } else if (viewer) {
      expect(
        [...view.querySelectorAll('a[href="/account/setup"]')].map((link) => link.textContent),
      ).toContain("プロフィールを設定する");
    } else {
      press(view, "ログインして投稿");
      expect(view.textContent).toBe("ログイン画面");
      expect(readRegistrationReturn()?.path).toBe(timelinePath);
    }
  },
);

test("プロフィール設定前でもAccountLayoutから掲示板を閲覧できる", async () => {
  const view = render(
    <MemoryRouter initialEntries={[timelinePath]}>
      <Routes>
        <Route element={<AccountLayout />}>
          <Route path="/games/:gameId/posts" element={<BoardTimelinePage />} />
          <Route path="/account/setup" element={<p>初回設定画面</p>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
  requests
    .find(({ url }) => url === "/api/account/session")!
    .respond({
      user: { ...user, profileCompleted: false },
    });
  await flush();
  requests
    .filter(({ url }) => url === timelineUrl)
    .at(-1)!
    .respond(timeline([post(1, "閲覧する投稿")]));
  await flush();
  expect(view.textContent).toContain("閲覧する投稿");
  expect(view.textContent).toContain("プロフィールを設定する");
});

test("タイムラインの投稿者リンクはカードの詳細リンクから独立して公開ページを開く", async () => {
  const view = show();
  const profileId = uuid(3);
  const author = {
    name: "現在名",
    avatarUrl: null,
    profileTarget: { source: "profile" as const, profileId },
  };
  await respond(timeline([post(1, "投稿", { author }), post(2, "プロフィールなし")]));
  const [withProfile, withoutProfile] = articles(view);
  const playerPath = `/players/${profileId}?game=four-shogi&mode=singles`;
  const link = withProfile!.querySelector<HTMLAnchorElement>(`a[href="${playerPath}"]`)!;
  expect(link?.textContent).toBe(author.name);
  expect(link.querySelector("svg")).not.toBeNull();
  expect(link.classList.contains("z-10")).toBe(true);
  expect(expectDetailLink(withProfile!, postPath).contains(link)).toBe(false);
  expectDetailLink(withoutProfile!, `/posts/${uuid(2)}`);
  expect(withoutProfile?.querySelector("header")?.textContent).toContain("投稿者");
  expect(withoutProfile?.querySelector('header a[href^="/players/"], header button')).toBeNull();
  await act(async () => link.click());
  expect(view.textContent).toBe(playerPath);
  expect(requests.map(({ url }) => url)).toEqual([timelineUrl]);
});

test("詳細の投稿と返信は表示中のゲームでそれぞれの公開ページを開ける", async () => {
  const view = show(postPath);
  const parent = post(1, "投稿", {
    gameId: "reversi",
    replyCount: 2,
    author: {
      name: "投稿者名",
      avatarUrl: null,
      profileTarget: { source: "profile", profileId: uuid(4) },
    },
  });
  const child = reply(2, "返信", {
    author: {
      name: "返信者名",
      avatarUrl: null,
      profileTarget: { source: "profile", profileId: uuid(5) },
    },
  });
  await respond(thread(parent, [child, reply(3, "プロフィールなし")]));
  const [postCard, replyCard, withoutProfile] = articles(view);
  const parentPath = `/players/${uuid(4)}?game=reversi`;
  const replyPath = `/players/${uuid(5)}?game=reversi`;
  expect(postCard?.querySelector(`a[href="${parentPath}"]`)?.textContent).toBe(parent.author.name);
  const link = replyCard!.querySelector<HTMLAnchorElement>(`a[href="${replyPath}"]`)!;
  expect(link?.textContent).toBe(child.author.name);
  expect(withoutProfile?.querySelector("header")?.textContent).toContain("投稿者");
  expect(withoutProfile?.querySelector("header a, header button")).toBeNull();
  await act(async () =>
    link.querySelector("svg")!.dispatchEvent(new MouseEvent("click", { bubbles: true })),
  );
  expect(view.textContent).toBe(replyPath);
  expect(requests.map(({ url }) => url)).toEqual([detailUrl]);
});

test("詳細を直接開いても見出し左のアイコンからそのゲームの掲示板へ戻る", async () => {
  const view = show(postPath);
  await respond(thread(post(1, "投稿", { gameId: "four-reversi" })));
  const heading = view.querySelector("h1")!;
  const back = heading.previousElementSibling as HTMLAnchorElement;
  const destination = "/games/four-reversi/posts";
  expect(heading.textContent).toBe("投稿の詳細");
  expect(back?.getAttribute("aria-label")).toBe("四人リバーシの掲示板へ");
  expect(back?.getAttribute("href")).toBe(destination);
  expect(back.textContent).toBe("");
  expect(back.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
  expect(back.classList.contains("min-h-11")).toBe(true);
  expect(back.classList.contains("min-w-11")).toBe(true);
  expect(back.classList.contains("focus-visible:outline-focus")).toBe(true);
  expect(view.querySelectorAll(`a[href="${destination}"]`)).toHaveLength(1);
  expect(view.querySelector('main nav a[href="/games/four-reversi"]')?.textContent).toBe(
    "四人リバーシのロビーへ",
  );
  await act(async () => back.click());
  expect(latest().url).toBe(`/api${destination}${includeAttachments}`);
  await respond(timeline([]));
  expect(view.querySelector("h1")?.textContent).toBe("四人リバーシの掲示板");
});

test("未ログインの返信欄は詳細をログイン後の戻り先に保存する", async () => {
  const view = show(postPath, null);
  await respond(thread(post(1, "閲覧する投稿")));
  expect(view.textContent).toContain("返信するにはログインしてください。");
  press(view, "ログインして返信");
  expect(readRegistrationReturn()?.path).toBe(postPath);
});

test.each([
  [false, true, "現在、掲示板への投稿を受け付けていません。投稿は閲覧できます。"],
  [true, true, "このアカウントは掲示板への投稿を停止されています。"],
] as const)(
  "受付設定と投稿停止を投稿欄に表示する",
  async (acceptingPosts, postingStopped, message) => {
    const view = show();
    await respond(timeline([], null, { acceptingPosts, postingStopped }));
    expect(view.textContent).toContain(message);
    expect(input(view)).toBeNull();
  },
);

test("タイムラインの削除は詳細の404で消し、200なら返信の枠に置き換える", async () => {
  const view = show();
  const gainsReply = post(3, "返信が増えた投稿", { own: true });
  const losesReplies = post(2, "返信が減った投稿", { own: true, replyCount: 4 });
  const older = post(1, "追加取得済みの投稿");
  await respond(timeline([gainsReply, losesReplies], cursor(losesReplies)));
  press(view, "もっと見る");
  await respond(timeline([older], cursor(older)));

  const [existing, empty] = articles(view);
  const deleteButton = like(empty!).nextElementSibling!;
  expect(like(empty!).previousElementSibling?.textContent).toContain("返信 4 件");
  expect(deleteButton.textContent).toBe("削除");
  expect(deleteButton.closest("a")).toBeNull();
  expect(deleteButton.matches(".relative.z-10.ml-auto")).toBe(true);
  press(empty!, "削除");
  expect(dialog().textContent).toContain("投稿を削除しますか？");
  expect(dialog().textContent).toContain("削除すると元に戻せません。");
  press(dialog(), "キャンセル");
  expect(requests).toHaveLength(2);
  expect(articles(view)).toHaveLength(3);
  press(empty!, "削除");
  press(dialog(), "削除する");
  expect(latest().url).toBe(`/api/posts/${losesReplies.id}`);
  expect(latest().init.method).toBe("DELETE");
  await respond({ message: "削除の失敗理由" }, 503);
  expect(dialog().textContent).toContain("削除の失敗理由");
  expect(articles(view)).toHaveLength(3);
  press(dialog(), "削除する");
  await respond(null, 204);
  expect(latest().url).toBe(`/api/posts/${losesReplies.id}${detailQuery}`);
  expect(latest().init.method).toBeUndefined();
  expect(articles(view)).toHaveLength(3);
  await respond(null, 404);
  expect(articles(view)).toHaveLength(2);
  expect(view.textContent).not.toContain(losesReplies.text);

  press(existing!, "削除");
  press(dialog(), "削除する");
  await respond(null, 204);
  expect(latest().url).toBe(`/api/posts/${gainsReply.id}${detailQuery}`);
  await respond(thread(deleted({ ...gainsReply, replyCount: 2 })));
  const [placeholder, preserved] = articles(view);
  expect(placeholder?.textContent).toContain("削除された投稿");
  expect(placeholder?.textContent).not.toContain(gainsReply.text);
  expect(placeholder?.textContent).not.toContain(gainsReply.author.name);
  expect(placeholder?.querySelector("button")).toBeNull();
  const deletedPath = `/posts/${gainsReply.id}`;
  expectDetailLink(placeholder!, deletedPath);
  const replies = expectReplyLink(placeholder!, deletedPath, 2);
  expect(preserved?.textContent).toContain(older.text);
  press(view, "もっと見る");
  expect(latest().url).toBe(`${timelineUrl}&before=${encodeURIComponent(cursor(older))}`);
  await respond(timeline([]));
  await act(async () => replies.click());
  expect(latest().url).toBe(`/api${deletedPath}${detailQuery}`);
  await respond(thread(deleted({ ...gainsReply, replyCount: 1 }), [reply(4, "残った返信")]));
  expect(view.querySelector("h1")?.textContent).toBe("投稿の詳細");
  expect(view.textContent).toContain("残った返信");
});

test("タイムラインの削除後に詳細の取得が失敗すると表示を保ち、先頭から再試行できる", async () => {
  const view = show();
  const parent = post(1, "表示を保つ投稿", { own: true });
  await respond(timeline([parent]));
  press(articles(view)[0]!, "削除");
  press(dialog(), "削除する");
  await respond(null, 204);
  expect(latest().url).toBe(detailUrl);
  expect(latest().init.method).toBeUndefined();
  await respond(null, 503);
  expect(articles(view)[0]?.textContent).toContain(parent.text);
  expect(view.textContent).toContain("投稿を取得できませんでした。");
  press(view, "再試行");
  expect(latest().url).toBe(timelineUrl);
  await respond(timeline([]));
  expect(articles(view)).toHaveLength(0);
});

test("詳細で返信を削除すると読み直した数になり、投稿の再取得が404なら掲示板へ戻る", async () => {
  const view = show(postPath);
  const parent = post(1, "本文", { own: true, replyCount: 1 });
  const remaining = reply(3, "別ページの返信");
  await respond(thread(parent, [reply(2, "本人の返信", { own: true })], cursor(remaining)));
  press(view, "もっと見る");
  await respond({ replies: [remaining], nextCursor: null });
  press(articles(view)[1]!, "削除");
  expect(dialog().textContent).toContain("返信を削除しますか？");
  press(dialog(), "削除する");
  expect(latest().url).toBe(`/api/posts/${uuid(2)}`);
  await respond(null, 204);
  expect(latest().url).toBe(detailUrl);
  expect(latest().init.method).toBeUndefined();
  await respond(thread({ ...parent, replyCount: 5 }, [reply(4, "新しい返信")], cursor(remaining)));
  expect(articles(view)).toHaveLength(3);
  expect(articles(view)[0]?.textContent).toContain("返信 5 件");
  expect(articles(view)[1]?.textContent).toContain(remaining.text);
  expect(view.textContent).not.toContain("本人の返信");
  expect(view.textContent).not.toContain("もっと見る");
  press(articles(view)[0]!, "削除");
  press(dialog(), "削除する");
  await respond(null, 204);
  expect(latest().url).toBe(detailUrl);
  await respond(null, 404);
  expect(latest().url).toBe(timelineUrl);
  await respond(timeline([]));
  expect(view.querySelector("h1")?.textContent).toBe("四人将棋の掲示板");
});

test("返信削除後の同期に失敗しても表示を保ち、再試行で削除済みの返信と数を同期する", async () => {
  const view = show(postPath);
  const parent = post(1, "本文", { replyCount: 2 });
  const removed = reply(3, "削除する本人の返信", { own: true });
  const remaining = reply(2, "残る返信");
  await respond(thread(parent, [remaining], cursor(remaining)));
  press(view, "もっと見る");
  await respond({ replies: [removed], nextCursor: null });
  press(articles(view)[2]!, "削除");
  press(dialog(), "削除する");
  await respond(null, 204);
  expect(latest().url).toBe(detailUrl);
  await respond(null, 503);
  expect(articles(view)[2]?.textContent).toContain(removed.text);
  expect(articles(view)[0]?.textContent).toContain("返信 2 件");
  press(view, "再試行");
  expect(latest().url).toBe(detailUrl);
  expect(latest().init.method).toBeUndefined();
  await respond(thread({ ...parent, replyCount: 1 }, [remaining], cursor(remaining)));
  expect(articles(view)).toHaveLength(2);
  expect(articles(view)[1]?.textContent).toContain(remaining.text);
  expect(articles(view)[0]?.textContent).toContain("返信 1 件");
  expect(view.textContent).not.toContain("もっと見る");
});

test.each([false, true])(
  "削除された詳細は枠と既存の返信を表示する（自分で削除: %s）",
  async (remove) => {
    const view = show(postPath);
    const parent = post(1, "削除する本文", { own: true, replyCount: 1 });
    const survivingReply = reply(2, "残る返信");
    await respond(
      remove ? thread({ ...parent, replyCount: 0 }) : thread(deleted(parent), [survivingReply]),
    );
    if (remove) {
      press(articles(view)[0]!, "削除");
      press(dialog(), "削除する");
      await respond(null, 204);
      expect(latest().url).toBe(detailUrl);
      await respond(thread(deleted(parent), [survivingReply]));
    }
    const [placeholder, child] = articles(view);
    expect(placeholder?.textContent).toContain("削除された投稿");
    expect(placeholder?.textContent).toContain("返信 1 件");
    expect(placeholder?.textContent).not.toContain(parent.text);
    expect(placeholder?.textContent).not.toContain(parent.author.name);
    expect(placeholder?.querySelector("button")).toBeNull();
    expect(placeholder?.querySelector("a")).toBeNull();
    expect(child?.textContent).toContain("残る返信");
    expect(view.textContent).toContain("削除された投稿には返信できません。");
    expect(input(view)).toBeNull();
  },
);

test("削除された投稿の最後の返信を消すと掲示板へ戻る", async () => {
  const view = show(postPath);
  await respond(
    thread(deleted(post(1, "元の本文", { replyCount: 1 })), [
      reply(2, "最後の返信", { own: true }),
    ]),
  );
  press(articles(view)[1]!, "削除");
  press(dialog(), "削除する");
  await respond(null, 204);
  expect(latest().url).toBe(detailUrl);
  await respond(null, 404);
  expect(latest().url).toBe(timelineUrl);
  await respond(timeline([]));
  expect(view.textContent).toContain("まだ投稿はありません。");
});

test("ログイン後の戻り先は6ゲームの掲示板とUUIDの投稿詳細だけを追加で受け付ける", () => {
  for (const game of gameIds) {
    const path = `/games/${game}/posts`;
    expect(registrationPath(path)).toBe(path);
  }
  expect(registrationPath(postPath)).toBe(postPath);
  expect(registrationPath(postPath + "/")).toBe(postPath + "/");
  const upperCaseId = `/posts/${uuid(1).toUpperCase()}`;
  expect(registrationPath(upperCaseId)).toBe(upperCaseId);
  for (const path of [
    "/games/unknown/posts",
    "/posts/not-a-uuid",
    "/posts/aaaaaaaa-aaaa-4aaa-7aaa-000000000001",
    postPath + "/replies",
    postPath + "?next=1",
    "https://example.com" + postPath,
    "//example.com" + postPath,
  ])
    expect(registrationPath(path)).toBeNull();
});

const reportButton = (scope: HTMLElement, label = "通報") =>
  [...scope.querySelectorAll("button")].find((button) => button.textContent === label);

test("通報ボタンは本人以外の公開中の投稿に出て、未ログイン時は案内を出す", async () => {
  const view = show(timelinePath, null);
  await respond(
    timeline([
      post(1, "公開中"),
      post(2, "自分の投稿", { own: true }),
      deleted(post(3, "削除済み", { replyCount: 1 })),
    ]),
  );
  const [published, own, placeholder] = articles(view);
  expect(reportButton(published!)).toBeDefined();
  expect(reportButton(own!)).toBeUndefined();
  expect(reportButton(placeholder!)).toBeUndefined();
  press(published!, "通報");
  expect(published!.querySelector('[role="alert"]')?.textContent).toBe(
    "通報するにはログインしてください。",
  );
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(requests).toHaveLength(1);
});

test("ゲストが詳細の投稿・返信を通報でき、失敗時は選んだ理由とエラーをダイアログに残す", async () => {
  const view = show(postPath, { ...user, isGuest: true, profileCompleted: false });
  const parent = post(1, "本文", { replyCount: 2 });
  const other = reply(2, "他の人の返信");
  await respond(thread(parent, [other, reply(3, "自分の返信", { own: true })]));
  const [root, target, own] = articles(view);
  expect(reportButton(own!)).toBeUndefined();
  await act(async () => {
    reportButton(root!)!.click();
    await import("../src/features/board/BoardReportDialog");
  });
  expect(dialog().textContent).toContain("投稿を通報");
  expect(dialog().textContent).toContain("この投稿を運営に通報しますか？理由を1つ選んでください。");
  press(dialog(), "キャンセル");
  expect(requests).toHaveLength(1);

  press(target!, "通報");
  expect(dialog().textContent).toContain("返信を通報");
  expect(dialog().textContent).toContain("この返信を運営に通報しますか？理由を1つ選んでください。");
  const radios = [...dialog().querySelectorAll<HTMLInputElement>('input[type="radio"]')];
  expect(radios.map((radio) => radio.labels?.[0]?.textContent)).toEqual([
    "晒し・嫌がらせ",
    "暴言",
    "スパム・宣伝",
    "個人情報",
    "その他",
  ]);
  expect(radios.some((radio) => radio.checked)).toBe(false);
  expect(reportButton(dialog(), "通報する")?.disabled).toBe(true);
  act(() => radios[3]!.click());
  expect(reportButton(dialog(), "通報する")?.disabled).toBe(false);
  press(dialog(), "通報する");
  expect(latest().url).toBe(`/api/posts/${other.id}/reports`);
  expect(latest().init.method).toBe("POST");
  expect(JSON.parse(String(latest().init.body))).toEqual({ reason: "personalInfo" });
  expect(reportButton(dialog(), "通報する")?.disabled).toBe(true);
  await respond({ message: "通報の上限に達しています。" }, 429);
  expect(dialog().querySelector('[role="alert"]')?.textContent).toBe("通報の上限に達しています。");
  expect(radios[3]?.checked).toBe(true);
  press(dialog(), "通報する");
  await respond(null, 503);
  expect(dialog().querySelector('[role="alert"]')?.textContent).toBe("通報できませんでした。");
  press(dialog(), "通報する");
  await respond({ message: "通報を受け付けました。" }, 201);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(target!.querySelector('[role="status"]')?.textContent).toBe("通報を受け付けました。");

  press(root!, "通報");
  act(() => dialog().querySelector<HTMLInputElement>('input[value="other"]')!.click());
  press(dialog(), "通報する");
  expect(latest().url).toBe(postUrl + "/reports");
  await respond({ message: "通報を受け付けています。" }, 200);
  expect(root!.querySelector('[role="status"]')?.textContent).toBe("通報を受け付けています。");
});
