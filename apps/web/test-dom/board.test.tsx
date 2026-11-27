import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
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
  NavigationType,
  Outlet,
  Route,
  RouterProvider,
  Routes,
  useLocation,
} from "react-router";
import reversiArchive from "../../../test-fixtures/matches/reversi-doubles-normal.json";
import reversiSinglesArchive from "../../../test-fixtures/matches/reversi-singles-normal.json";
import shogiArchive from "../../../test-fixtures/matches/shogi-singles.json";
import {
  readRegistrationReturn,
  registrationPath,
  registrationReturnKey,
  saveRegistrationReturn,
} from "../src/features/account/registrationReturn";
import { LoginPage, ProfilePage } from "../src/features/account/AccountPages";
import { AccountLayout } from "../src/features/account/AccountSession";
import { AccountContext } from "../src/features/account/useAccount";
import { BoardAttachmentBoard } from "../src/features/board/BoardAttachmentBoard";
import { BoardDetailPage, BoardTimelinePage } from "../src/features/board/BoardPages";
import { MobileLobbyNavigation } from "../src/features/lobby/MobileLobbyNavigation";
import { BoardLikeButton } from "../src/features/board/BoardReactions";
import { formatMatchDate } from "../src/features/matches/matchDatePresentation";
import { startPageMetadata } from "../src/seo/pageMetadata";
import { appThemeClasses } from "../src/shared/ui/appTheme";
// 遅延読み込みされるモジュールを先に評価し、act 内で描画を待てるようにします。
import "../src/features/board/boardAttachmentFrames";
import "../src/features/board/boardMediaRequests";
import "../src/features/room/fourShogiMatchReplay";
import "../src/features/room/replayFrames";
import {
  act,
  clock,
  denyStorage,
  enter,
  flush,
  press,
  mockMobileLobby,
  render,
  requests,
  rerender,
  wrap,
  type Request,
} from "./harness";

const uuid = (id: number) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(id).padStart(12, "0")}`;
const postPath = "/posts/1001";
const timelinePath = "/games/four-shogi/posts";
const includeAttachments = "?includeAttachments=1";
const timelineUrl = "/api" + timelinePath + includeAttachments;
const postUrl = `/api/posts/${uuid(1)}`;
const detailQuery = includeAttachments + "&includeIndexable=1";
const detailUrl = "/api" + postPath + detailQuery;
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
    publicNumber: 1000 + id,
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
function deleted({ id, publicNumber, postedAtMs, gameId, replyCount }: BoardPost): BoardPost {
  return { id, publicNumber, postedAtMs, gameId, replyCount, status: "deleted" };
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
        <Route path="/users/:handle" element={<Destination />} />
      </Routes>,
    ),
  );
}
const latest = () => requests.at(-1)!;
const articles = (view: HTMLElement) => [...view.querySelectorAll("article")];
const input = (view: HTMLElement) => view.querySelector("textarea")!;
const like = (element: HTMLElement) =>
  element.querySelector<HTMLButtonElement>('button[aria-label="いいね"]')!;
const postMenuTrigger = (entry: HTMLElement) =>
  entry.querySelector<HTMLButtonElement>('button[aria-label="投稿メニュー"]')!;
const postMenu = () =>
  document.querySelector<HTMLElement>('[role="menu"][aria-label="投稿メニュー"]');
const menuItems = () => [...postMenu()!.querySelectorAll<HTMLElement>('[role="menuitem"]')];

function choosePostMenu(entry: HTMLElement, label: string) {
  act(() => postMenuTrigger(entry).click());
  const item = menuItems().find((item) => item.textContent?.trim() === label);
  expect(item).toBeDefined();
  act(() => item!.click());
}

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
const reversiBoardPath = "/games/four-reversi/posts";
const reversiMatchPath = `/matches/${reversiMatch.id}`;

function loadAttachmentUrl(url: string) {
  enter(dialog().querySelector("input")!, url);
  press(dialog(), "読み込む");
}

function attachmentPosition() {
  return dialog().querySelector("select")!;
}

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

test.each([
  ["投稿欄", timelinePath],
  ["返信欄", postPath],
] as const)("%sの入力欄の手前に本人の画像を表示する", async (_, path) => {
  const avatarUrl = "/api/avatars/board-owner.webp";
  const images: HTMLImageElement[] = [];
  const NativeImage = window.Image;
  window.Image = class extends NativeImage {
    constructor(width?: number, height?: number) {
      super(width, height);
      images.push(this);
    }
  };
  try {
    const view = show(path, { ...user, avatarUrl });
    await respond(path === timelinePath ? timeline([]) : thread(post(1, "閲覧する投稿")));
    for (const image of images) {
      Object.defineProperties(image, {
        complete: { value: true },
        naturalWidth: { value: 32 },
      });
      act(() => image.dispatchEvent(new Event("load")));
    }
    await flush();

    const avatar = input(view).previousElementSibling;
    expect(avatar?.querySelector("img")?.getAttribute("src")).toBe(avatarUrl);
    expect(avatar?.querySelector('[data-slot="avatar-fallback"]')).toBeNull();
  } finally {
    window.Image = NativeImage;
  }
});

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

test("未ログインでも公開棋譜URLから添付でき、URL・対局・局面を検証する", async () => {
  const view = show(reversiBoardPath, null);
  await respond(timeline([]));
  enter(input(view), "局面について");
  expect(requests).toHaveLength(1);
  press(view, "棋譜を添付");
  expect(dialog().closest(".app-modal")).not.toBeNull();
  const origin = window.location.origin;
  for (const url of [
    `https://outside.test${reversiMatchPath}`,
    `${origin}/account${reversiMatchPath}`,
    `${origin}${reversiMatchPath}/replay`,
    `${origin}/matches/invalid`,
  ]) {
    loadAttachmentUrl(url);
    expect(dialog().querySelector("[role=alert]")?.textContent).toContain("公開棋譜のURL");
  }
  expect(requests).toHaveLength(1);
  loadAttachmentUrl(`${origin}/matches/${shogiMatch.id}`);
  await flush();
  expect(latest().url).toBe(`/api/matches/${shogiMatch.id}`);
  await respond({ match: shogiMatch });
  expect(dialog().querySelector("[role=alert]")?.textContent).toContain("同じゲーム");
  press(dialog(), "この局面を添付");
  expect(view.querySelector("form a[href^='/matches/']")).toBeNull();

  press(dialog(), "戻る");
  loadAttachmentUrl(`${origin}${reversiMatchPath}?position=37&ref=link#replay`);
  await flush();
  expect(latest().url).toBe("/api" + reversiMatchPath);
  await respond({ match: reversiMatch });
  expect(attachmentPosition().selectedOptions[0]?.textContent).toBe("黒 パス");
  expect(dialog().querySelector('[aria-label="四人リバーシの盤面"]')).not.toBeNull();
  press(dialog(), "この局面を添付");
  await flush();
  expect(view.querySelector(`form a[href="${reversiMatchPath}?position=37"]`)?.textContent).toBe(
    "黒 パス",
  );
  expect(input(view).value).toBe("局面について");
});

test("ゲストの本人履歴をモード別に選び、選択した対局を公開棋譜で開く", async () => {
  const view = show(reversiBoardPath, { ...user, isGuest: true });
  await respond(timeline([]));
  press(view, "棋譜を添付");
  clock.advance(0);
  expect(latest().url).toContain("/api/account/matches?mode=singles");
  await respond({ matches: [], nextCursor: null });
  expect(dialog().textContent).toContain("まだ対局履歴がありません");
  press(dialog(), "ダブルス");
  clock.advance(0);
  expect(latest().url).toContain("/api/account/matches?mode=doubles");
  const { id, startedAtMs, endedAtMs, participants } = reversiMatch;
  await respond({
    matches: [
      {
        id,
        startedAtMs,
        endedAtMs,
        participants,
        game: "four-reversi",
        mode: "doubles",
        result: reversiMatch.game.result,
        moveCount: reversiMatch.game.moveNumber,
      },
    ],
    nextCursor: null,
  });
  const candidate = dialog().querySelector("time")!;
  expect(candidate.textContent).toBe(formatMatchDate(startedAtMs));
  expect(candidate.closest("button")?.textContent).toContain(participants[0]!.name);
  act(() => candidate.closest("button")!.click());
  await flush();
  expect(latest().url).toBe("/api" + reversiMatchPath);
  await respond({ match: reversiMatch });
  expect(attachmentPosition().selectedIndex).toBe(attachmentPosition().options.length - 1);
  press(dialog(), "この局面を添付");
  await flush();
  expect(view.querySelector("form a[href^='/matches/']")).not.toBeNull();
});

test("アカウント切替で以前の本人履歴を破棄し、取得に失敗してもURLに切り替えられる", async () => {
  const accountBoard = (viewer: AccountProfile) =>
    wrap(
      viewer,
      timelinePath,
    )(
      <Routes>
        <Route path="/games/:gameId/posts" element={<BoardTimelinePage />} />
      </Routes>,
    );
  const view = render(accountBoard(user));
  await respond(timeline([]));
  press(view, "棋譜を添付");
  expect(dialog().closest(`.${appThemeClasses["four-shogi"]}`)).not.toBeNull();
  clock.advance(0);
  const previous = latest();
  expect(previous.url).toContain("/api/account/matches?");
  expect(previous.url).toContain("game=four-shogi");

  rerender(view, accountBoard({ ...user, username: "another" }));
  expect(dialog()).toBeNull();
  expect(previous.init.signal?.aborted).toBe(true);
  await respond(timeline([]));
  press(view, "棋譜を添付");
  clock.advance(0);
  previous.respond({
    matches: [
      {
        id: shogiMatch.id,
        startedAtMs: shogiMatch.startedAtMs,
        endedAtMs: shogiMatch.endedAtMs,
        participants: shogiMatch.participants,
        game: "four-shogi",
        mode: "singles",
        result: shogiMatch.game.result,
      },
    ],
    nextCursor: null,
  });
  await respond({}, 503);
  expect(dialog().querySelector("[role=alert]")?.textContent).toContain("対局履歴を取得");
  expect(dialog().querySelector("time")).toBeNull();
  press(dialog(), "URLを貼る");
  expect(dialog().querySelector('input[type="url"]')).not.toBeNull();
});

test("添付の変更中に届いた古い棋譜を捨て、確定済みの添付と本文は送信成功まで保持する", async () => {
  const { selfPlayerId: _, ...replacement } = reversiSinglesArchive.detail;
  const routeState = { source: "別の画面" };
  const router = createMemoryRouter(
    [
      {
        path: "/games/:gameId/posts",
        element: (
          <AccountContext.Provider
            value={{ user, loading: false, error: null, refresh: async () => {}, update: () => {} }}
          >
            <BoardTimelinePage />
          </AccountContext.Provider>
        ),
      },
    ],
    {
      initialEntries: [
        {
          pathname: reversiBoardPath,
          search: `?view=all&match=${reversiMatch.id}&position=36`,
          hash: "#compose",
          state: routeState,
        },
      ],
    },
  );
  const view = render(<RouterProvider router={router} />);
  await respond(timeline([]));
  await respond({ match: reversiMatch });
  enter(input(view), "変更する本文");
  press(view, "変更");
  await flush();
  await respond({ match: reversiMatch });
  expect(attachmentPosition().value).toBe("36");
  press(dialog(), "戻る");
  press(dialog(), "URLを貼る");
  loadAttachmentUrl(`${window.location.origin}/matches/${uuid(90)}`);
  await flush();
  await respond({}, 404);
  expect(dialog().querySelector("[role=alert]")?.textContent).toContain("公開棋譜が見つかりません");
  press(dialog(), "戻る");
  loadAttachmentUrl(`${window.location.origin}/matches/${uuid(91)}`);
  await flush();
  const older = latest();
  press(dialog(), "戻る");
  loadAttachmentUrl(`${window.location.origin}${reversiMatchPath}?position=9999`);
  await flush();
  expect(older.init.signal?.aborted).toBe(true);
  older.respond({}, 404);
  await respond({ match: reversiMatch });
  const position = attachmentPosition();
  expect(position.selectedIndex).toBe(position.options.length - 1);
  press(dialog(), "キャンセル");
  expect(view.querySelector("form a[href^='/matches/']")?.textContent).toBe("36: 青H5");

  press(view, "変更");
  await flush();
  await respond({ match: reversiMatch });
  press(dialog(), "戻る");
  press(dialog(), "URLを貼る");
  loadAttachmentUrl(`${window.location.origin}/matches/${replacement.id}`);
  await flush();
  await respond({ match: replacement });
  act(() => {
    attachmentPosition().value = "0";
    attachmentPosition().dispatchEvent(new Event("change", { bubbles: true }));
  });
  press(dialog(), "この局面を添付");
  expect(router.state.location).toMatchObject({
    search: `?view=all&match=${replacement.id}&position=0`,
    hash: "#compose",
    state: routeState,
  });
  expect(input(view).value).toBe("変更する本文");
  press(view, "投稿する");
  const postInput = requestInput(latest());
  expect(postInput).toMatchObject({
    text: "変更する本文",
    attachment: { matchId: replacement.id, position: 0 },
  });
  await respond({}, 503);
  expect(view.querySelector("form [role=alert]")?.textContent).toContain("投稿を送信できません");
  expect(view.querySelector("form a[href^='/matches/']")?.textContent).toBe("開始局面");
  expect(input(view).value).toBe("変更する本文");
  press(view, "投稿する");
  expect(requestInput(latest())).toEqual(postInput);
  await respond({
    post: post(1, "変更する本文", { gameId: "four-reversi", attachment: postInput.attachment }),
    availableAtMs: 0,
  });
  expect(input(view).value).toBe("");
  expect(router.state.location).toMatchObject({
    search: "?view=all",
    hash: "#compose",
    state: routeState,
  });
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

const guest = { ...user, isGuest: true };
const signInUrl = "/api/auth/sign-in/social";
const googleOAuthUrl = "https://accounts.google.com/o/oauth2/auth";
const signInRequest = () => requests.findLast(({ url }) => url === signInUrl);
const storedRegistrationReturn = () => sessionStorage.getItem(registrationReturnKey);
const boardWrites = () =>
  requests.filter(
    ({ url, init }) => url.includes("/posts") && init.method && init.method !== "GET",
  );

function expectBoardLinkDialog(draft = false) {
  const link = dialog();
  expect(link).not.toBeNull();
  expect(link.textContent).toContain("掲示板のアカウント連携");
  expect(link.textContent).toContain("アカウントを連携して、掲示板を楽しもう！");
  expect(link.textContent).toContain("連携すると、投稿・返信・いいねができます。");
  expect(link.textContent?.includes("連携後も、入力した内容から続けられます。")).toBe(draft);
  return link;
}

test.each([
  ["未ログイン", null],
  ["ゲスト", guest],
] as const)("%s の投稿・返信は入力を残して連携を案内する", async (_, viewer) => {
  for (const isReply of [false, true]) {
    const path = isReply ? postPath : timelinePath;
    const label = isReply ? "返信する" : "投稿する";
    const view = show(path, viewer);
    await respond(isReply ? thread(post(1, "投稿")) : timeline([]));
    expect(Boolean(input(view).previousElementSibling)).toBe(Boolean(viewer));
    enter(input(view), "  ");
    expect(view.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true);
    enter(input(view), "入力中の本文");
    press(view, label);
    press(expectBoardLinkDialog(true), "キャンセル");
    expect(dialog()).toBeNull();
    expect(input(view).value).toBe("入力中の本文");
    expect(storedRegistrationReturn()).toBeNull();

    press(view, label);
    press(dialog(), "Discordで続ける");
    await flush();
    expect(storedRegistrationReturn()).toBeNull();
    expect(dialog().querySelector('[data-pending="true"]')?.textContent).toContain(
      "Discordで続ける",
    );
    expect([...dialog().querySelectorAll("button")].every(({ disabled }) => disabled)).toBe(true);
    expect(requests.every(({ init }) => !String(init.body).includes("入力中の本文"))).toBe(true);
    signInRequest()!.respond({ message: "連携の開始に失敗しました。" }, 503);
    await flush();
    expect(dialog().querySelector('[role="alert"]')?.textContent).toBe(
      "連携の開始に失敗しました。",
    );
    press(dialog(), "キャンセル");
    expect(input(view).value).toBe("入力中の本文");
    expect(storedRegistrationReturn()).toBeNull();
    expect(boardWrites()).toEqual([]);
  }
});

test("保存不可の下書きは入力欄に残り、プロバイダーへ遷移しない", async () => {
  const view = show(timelinePath, null);
  await respond(timeline([]));
  enter(input(view), "入力中");
  press(view, "投稿する");
  const denied = denyStorage();
  const assign = spyOn(window.location, "assign").mockImplementation(() => {});
  try {
    press(dialog(), "Googleで続ける");
    await flush();
    const oauth = signInRequest()!;
    expect(oauth.init.method).toBe("POST");
    oauth.respond({ url: googleOAuthUrl });
    await flush();
    expect(dialog().querySelector('[role="alert"]')?.textContent).toContain(
      "下書きを保存できませんでした",
    );
    expect(assign).not.toHaveBeenCalled();
    expect(storedRegistrationReturn()).toBeNull();
    expect(boardWrites()).toEqual([]);
    press(dialog(), "キャンセル");
    expect(input(view).value).toBe("入力中");
  } finally {
    assign.mockRestore();
    denied.mockRestore();
  }
});

test("OAuth開始中に掲示板を離れると、遅れて成功が返っても下書きを保存しない", async () => {
  const view = show(timelinePath, null);
  await respond(timeline([]));
  enter(input(view), "入力中");
  press(view, "投稿する");
  const assign = spyOn(window.location, "assign").mockImplementation(() => {});
  try {
    press(dialog(), "Googleで続ける");
    await flush();
    const oauth = signInRequest()!;
    rerender(view, null);
    expect(oauth.init.signal?.aborted).toBe(true);
    oauth.respond({ url: googleOAuthUrl });
    await flush();
    expect(assign).not.toHaveBeenCalled();
    expect(storedRegistrationReturn()).toBeNull();
  } finally {
    assign.mockRestore();
  }
});

test("同じ掲示板で添付URLが変わったら連携を閉じ、新しい添付でやり直せる", async () => {
  const router = createMemoryRouter(
    [
      {
        path: "/games/:gameId/posts",
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
            <BoardTimelinePage />
          </AccountContext.Provider>
        ),
      },
    ],
    { initialEntries: [timelineWithPosition] },
  );
  const view = render(<RouterProvider router={router} />);
  await respond(timeline([]));
  enter(input(view), "入力中");
  press(view, "投稿する");
  press(dialog(), "Googleで続ける");
  await flush();
  const previous = signInRequest()!;
  const nextPath = timelineWithPosition.replace("position=0", "position=1");
  await act(async () => router.navigate(nextPath));
  expect(dialog()).toBeNull();
  expect(previous.init.signal?.aborted).toBe(true);
  expect(input(view).value).toBe("入力中");

  const assign = spyOn(window.location, "assign").mockImplementation(() => {});
  try {
    previous.respond({ url: googleOAuthUrl });
    await flush();
    expect(assign).not.toHaveBeenCalled();
    expect(storedRegistrationReturn()).toBeNull();
    press(view, "投稿する");
    press(dialog(), "Googleで続ける");
    await flush();
    signInRequest()!.respond({ url: googleOAuthUrl });
    await flush();
    expect(assign).toHaveBeenCalledWith(googleOAuthUrl);
    expect(readRegistrationReturn()).toMatchObject({
      path: nextPath,
      boardDraft: { text: "入力中" },
    });
  } finally {
    assign.mockRestore();
  }
});

test.each([
  { path: postPath, label: "返信する", setup: false, canceled: false },
  {
    path: `/games/four-reversi/posts?match=${reversiMatch.id}&position=36`,
    label: "投稿する",
    setup: true,
    canceled: false,
  },
  { path: postPath, label: "返信する", setup: false, canceled: true },
] as const)(
  "OAuthから戻ると元の入力欄に一度だけ復元する %j",
  async ({ path, label, setup, canceled }) => {
    const isReply = path === postPath;
    const response = isReply ? thread(post(1, "投稿")) : timeline([]);
    const destination = canceled
      ? "/login?error=access_denied"
      : setup
        ? "/account/setup"
        : "/account";
    const draft = "  入力中の本文👨‍👩‍👧‍👦\n";
    const initialPath = setup ? reversiBoardPath : path;
    const initial = show(initialPath, setup ? guest : null);
    await respond(response);
    enter(input(initial), draft);
    if (setup) {
      press(initial, "棋譜を添付");
      press(dialog(), "URLを貼る");
      loadAttachmentUrl(`${window.location.origin}${reversiMatchPath}?position=36`);
      await flush();
      await respond({ match: reversiMatch });
      press(dialog(), "この局面を添付");
      await flush();
      expect(initial.querySelector("form")?.textContent).toContain("36: 青H5");
    }
    press(initial, label);
    const assign = spyOn(window.location, "assign").mockImplementation(() => {
      expect(readRegistrationReturn()).toMatchObject({
        path,
        boardDraft: { kind: isReply ? "reply" : "post", text: draft },
        oauthStarted: true,
      });
    });
    try {
      press(dialog(), "Googleで続ける");
      await flush();
      expect(storedRegistrationReturn()).toBeNull();
      signInRequest()!.respond({ url: googleOAuthUrl });
      await flush();
      expect(assign).toHaveBeenCalledWith(googleOAuthUrl);
    } finally {
      assign.mockRestore();
    }

    rerender(initial, null);
    const router = createMemoryRouter(
      [
        {
          element: <AccountLayout />,
          children: [
            { path: "/account", element: <p>マイページ</p> },
            { path: "/account/setup", element: <ProfilePage setup /> },
            { path: "/login", element: <LoginPage /> },
            { path: "/posts/:id", element: <BoardDetailPage /> },
            { path: "/games/:gameId/posts", element: <BoardTimelinePage /> },
          ],
        },
      ],
      { initialEntries: ["/account", destination], initialIndex: 1 },
    );
    const view = render(<RouterProvider router={router} />);
    const accountRequest = requests.findLast(({ url }) => url === "/api/account/session")!;
    accountRequest.respond({ user: canceled ? null : { ...user, profileCompleted: !setup } });
    await flush();
    if (setup) {
      expect(router.state.location.pathname).toBe("/account/setup");
      expect(readRegistrationReturn()?.boardDraft?.text).toBe(draft);
      press(view, "プロフィールを作成");
      const request = requests.findLast(({ url }) => url === "/api/account/setup")!;
      expect(request.init.method).toBe("POST");
      request.respond(user);
      await flush();
    }
    if (canceled) {
      expect(view.textContent).toContain("ログインを完了できませんでした");
      press(view, "Discordで続ける");
      await flush();
      signInRequest()!.respond({ message: "再試行に失敗しました。" }, 503);
      await flush();
      expect(view.textContent).toContain("再試行に失敗しました。");
      expect(readRegistrationReturn()).toMatchObject({
        path,
        boardDraft: { text: draft },
        oauthStarted: false,
      });
      press(view, "元の画面へ戻る");
      await flush();
    }
    expect(router.state.location.pathname + router.state.location.search).toBe(path);
    const dataUrl = isReply ? detailUrl : "/api" + path.split("?")[0] + includeAttachments;
    const boardRead = () => requests.findLast(({ url }) => url === dataUrl)!;
    boardRead().respond(response);
    await flush();
    expect(input(view).value).toBe(draft);
    expect(router.state.location.state).toBeNull();
    expect(readRegistrationReturn()).toBeNull();
    expect(boardWrites()).toEqual([]);
    if (setup) {
      expect(view.textContent).toContain("添付を外す");
      const replay = requests.findLast(({ url }) => url === `/api/matches/${reversiMatch.id}`)!;
      replay.respond({ match: reversiMatch });
      await flush();
      expect(view.querySelector("form")?.textContent).toContain("36: 青H5");
      press(view, label);
      expect(requestInput(boardWrites()[0]!)).toMatchObject({
        text: draft,
        attachment: { matchId: reversiMatch.id, position: 36 },
      });
    }
    await act(async () => router.navigate(-1));
    await act(async () => router.navigate(1));
    boardRead().respond(response);
    await flush();
    expect(input(view).value).toBe("");
  },
);

test("期限切れの掲示板下書きは読み込み時にタブから削除する", () => {
  saveRegistrationReturn({ path: postPath, boardDraft: { kind: "reply", text: "入力中" } }, true);
  clock.advance(3_600_000);
  expect(storedRegistrationReturn()).not.toBeNull();
  expect(readRegistrationReturn()).toBeNull();
  expect(storedRegistrationReturn()).toBeNull();
});

test.each([
  { name: "期限切れ", path: postPath, age: 3_600_000 },
  { name: "別の投稿", path: "/posts/1002", age: 0 },
])("$name の復帰stateからは返信欄を復元しない", async ({ path, age }) => {
  const view = render(
    wrap(user, {
      pathname: postPath,
      state: {
        registrationReturn: {
          path,
          createdAt: Date.now() - age,
          oauthStarted: true,
          boardDraft: { kind: "reply", text: "別の下書き" },
        },
      },
    })(
      <Routes>
        <Route path="/posts/:id" element={<BoardDetailPage />} />
      </Routes>,
    ),
  );
  await respond(thread(post(1, "公開された投稿")));
  expect(input(view).value).toBe("");
  expect(boardWrites()).toEqual([]);
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
      await router.navigate(`/posts/1002/`);
    });
    await respond(thread(second));
    expect(document.title).toBe("別の投稿｜リバーシの掲示板 | TetraBoard");
    expect(canonical()).toBe(`https://tetraboard.net/posts/1002`);
    expect(robots()).toBe("noindex,follow");
    expect(meta('meta[property="og:image"]')).toBe("https://tetraboard.net/assets/ogp/reversi.png");

    await act(async () => {
      await router.navigate("/posts/1003");
    });
    await respond({}, 404);
    expectFallback();
    await act(async () => {
      await router.navigate("/posts/1004");
    });
    await respond({}, 503);
    expectFallback();
  } finally {
    stop();
    router.dispose();
    document.head.innerHTML = previousHead;
  }
});

function initialBoardMetadata(
  parent: BoardPublishedPost,
  replies: BoardReply[],
  path = `${postPath}/`,
) {
  const previousHead = document.head.innerHTML;
  const router = boardMetadataRouter(path);
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

test("初期HTMLが届いた符号化済みの投稿URLは履歴を置き換え、本文とメタ情報を表示する", async () => {
  const parent = post(1, "投稿の本文");
  const suffix = "?source=board&label=a%2Fb#thread";
  const { router, dispose } = initialBoardMetadata(parent, [], "/posts/%31001" + suffix);
  const initialContent = readBoardHead();
  try {
    expect(initialContent.canonical).toBe(`https://tetraboard.net${postPath}`);
    expect(initialContent.jsonLd).toContain(parent.text);
    const view = render(<RouterProvider router={router} />);
    await flush();
    expect(router.state.historyAction).toBe(NavigationType.Replace);
    expect(router.state.location).toMatchObject({
      pathname: postPath,
      search: "?source=board&label=a%2Fb",
      hash: "#thread",
    });
    expect(readBoardHead()).toEqual(initialContent);
    expect(requests.map(({ url }) => url)).toEqual([detailUrl]);
    await respond(thread(parent, [], null, true));
    expect(view.textContent).toContain(parent.text);
    expect(readBoardHead()).toEqual(initialContent);
  } finally {
    dispose();
  }
});

test.each([
  `/posts/${uuid(1)}`,
  "/posts/%301001",
  "/posts/1001%2F",
  "/posts/1001%3Fsource",
  "/posts/1001%23thread",
  "/posts/%2531001",
])("投稿詳細の無効なパス %s では投稿を読み込まない", async (path) => {
  const view = show(path);
  await flush();
  expect(view.textContent).toContain("投稿が見つかりません");
  expect(requests).toHaveLength(0);
});

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
  expectDetailLink(first!, `/posts/${recent.publicNumber}`);
  const detail = expectDetailLink(second!, postPath);
  await act(async () => detail.click());
  expect(latest().url).toBe(detailUrl);
  await respond(thread(old));
  expect(view.querySelector("h1")?.textContent).toBe("投稿の詳細");
  expect(view.querySelector("h2")).toBeNull();
  expect(view.querySelector("section[aria-labelledby] .border-l-2")).toBeNull();
});

function mobileBoard(entry: string, viewer = user) {
  const media = mockMobileLobby();
  const { pathname, search } = new URL(entry, "https://example.test");
  const router = createMemoryRouter(
    [
      {
        path: "/games/four-shogi",
        element: <MobileLobbyNavigation game="four-shogi" selected="play" />,
      },
      { path: "/games/:gameId/posts", Component: BoardTimelinePage },
      { path: "/posts/:id", Component: BoardDetailPage },
    ],
    { initialEntries: [{ pathname, search, key: crypto.randomUUID() }] },
  );
  const page = (account: AccountProfile) => (
    <AccountContext
      value={{ user: account, loading: false, error: null, refresh: async () => {}, update() {} }}
    >
      <RouterProvider router={router} />
    </AccountContext>
  );
  const view = render(page(viewer));
  const clickTab = async (name: string) => {
    const tabs = view.querySelector('nav[aria-label="ゲームロビー"]')!;
    const link = [...tabs.querySelectorAll("a")].find((link) => link.textContent === name)!;
    await act(async () => link.click());
  };
  return {
    view,
    router,
    clickTab,
    setViewer: (next: AccountProfile) => rerender(view, page(next)),
    dispose() {
      router.dispose();
      media.mockRestore();
    },
  };
}

test("スマホの投稿は添付と本文をタブ往復で保持し、成功後は履歴からも下書きを復活させない", async () => {
  const { view, router, clickTab, dispose } = mobileBoard(timelineWithPosition);
  try {
    expect(view.querySelector("h1")?.textContent).toBe("四人将棋");
    expect(
      view.querySelector('nav[aria-label="ゲームロビー"] [aria-current="page"]')?.textContent,
    ).toBe("投稿");
    await respond(timeline([]));
    await respond({}, 404);
    enter(input(view), "タブを往復する下書き");
    await clickTab("対局");
    await clickTab("投稿");
    expect(router.state.location.pathname).toBe(timelinePath);
    expect(router.state.location.search).toContain("position=0");
    expect(router.state.location.search).not.toContain("下書き");
    await respond(timeline([]));
    await respond({}, 404);
    expect(input(view).value).toBe("タブを往復する下書き");
    expect(view.querySelector("form")?.textContent).toContain("添付を外す");
    await clickTab("対局");
    await clickTab("投稿");
    await respond(timeline([]));
    await respond({}, 404);
    press(view, "投稿する");
    expect(requestInput(latest())).toMatchObject({
      text: "タブを往復する下書き",
      attachment: { matchId: shogiMatch.id, position: 0 },
    });
    await respond({ post: post(1, "投稿できた下書き"), availableAtMs: 0 });
    expect(input(view).value).toBe("");
    expect(router.state.location.search).toBe("");
    await act(async () => router.navigate(-1));
    await act(async () => router.navigate(-1));
    await respond(timeline([]));
    expect(router.state.location.search).toBe("");
    expect(input(view).value).toBe("");
    expect(view.querySelector("form")?.textContent).not.toContain("添付を外す");
    await clickTab("対局");
    await clickTab("投稿");
    await respond(timeline([]));
    expect(input(view).value).toBe("");
    expect(view.querySelector("form")?.textContent).not.toContain("添付を外す");
  } finally {
    dispose();
  }
});

test("別ゲーム・別の閲覧者へ下書きを渡さず、明示された棋譜と連携復帰の本文を優先する", async () => {
  const { view, router, clickTab, setViewer, dispose } = mobileBoard(timelineWithPosition);
  try {
    await respond(timeline([]));
    await respond({}, 404);
    enter(input(view), "以前の下書き");
    await clickTab("対局");
    await act(async () => router.navigate("/games/gomoku/posts"));
    await respond(timeline([]));
    expect(input(view).value).toBe("");
    expect(view.querySelector("form")?.textContent).not.toContain("添付を外す");

    const explicit = timelineWithPosition.replace("position=0", "position=1");
    await act(async () =>
      router.navigate(explicit, {
        state: {
          registrationReturn: {
            path: explicit,
            createdAt: Date.now(),
            oauthStarted: true,
            boardDraft: { kind: "post", text: "連携から復元した本文" },
          },
        },
      }),
    );
    await respond(timeline([]));
    await respond({}, 404);
    expect(input(view).value).toBe("連携から復元した本文");
    expect(router.state.location.search).toContain("position=1");
    await clickTab("対局");
    setViewer({ ...user, username: "another-owner" });
    await clickTab("投稿");
    await respond(timeline([]));
    expect(input(view).value).toBe("");
    expect(router.state.location.search).toBe("");
    expect(view.querySelector("form")?.textContent).not.toContain("添付を外す");
  } finally {
    dispose();
  }
});

test.each(["ブラウザーの戻る", "掲示板へ戻る"] as const)(
  "スマホで詳細から%sと追加読込済みの投稿とスクロール位置を復元する",
  async (method) => {
    const { view, router, dispose } = mobileBoard(timelinePath);
    const scroll = spyOn(window, "scrollTo");
    const scrollY = Object.getOwnPropertyDescriptor(window, "scrollY");
    try {
      const first = post(1, "最初のページ");
      const second = post(2, "次のページ");
      await respond(timeline([first], cursor(first)));
      press(view, "もっと見る");
      await respond(timeline([second]));
      Object.defineProperty(window, "scrollY", { configurable: true, value: 812 });
      await act(async () => expectDetailLink(articles(view)[1]!, "/posts/1002").click());
      await respond(thread(second));
      if (method === "ブラウザーの戻る") {
        await act(async () => router.navigate(-1));
      } else {
        await act(async () =>
          view.querySelector<HTMLAnchorElement>('a[aria-label="四人将棋の掲示板へ"]')!.click(),
        );
      }
      expect(articles(view)).toHaveLength(2);
      expect(articles(view)[1]?.textContent).toContain("次のページ");
      expect(scroll).toHaveBeenCalledWith(0, 812);
      expect(requests.filter(({ url }) => url === timelineUrl)).toHaveLength(1);
    } finally {
      if (scrollY) Object.defineProperty(window, "scrollY", scrollY);
      else Reflect.deleteProperty(window, "scrollY");
      scroll.mockRestore();
      dispose();
    }
  },
);

test.each(["削除枠", "404"] as const)(
  "詳細の初回取得が%sなら、戻った一覧を再取得せず該当する投稿だけ同期する",
  async (result) => {
    const { view, router, dispose } = mobileBoard(timelinePath);
    const scroll = spyOn(window, "scrollTo");
    const scrollY = Object.getOwnPropertyDescriptor(window, "scrollY");
    try {
      const first = post(1, "削除された元の本文");
      const second = post(2, "追加読込で取得した本文");
      await respond(timeline([first], cursor(first)));
      press(view, "もっと見る");
      await respond(timeline([second]));
      Object.defineProperty(window, "scrollY", { configurable: true, value: 185 });
      await act(async () => expectDetailLink(articles(view)[1]!, "/posts/1002").click());
      await respond(thread(second));
      await act(async () =>
        view.querySelector<HTMLAnchorElement>('a[aria-label="四人将棋の掲示板へ"]')!.click(),
      );
      Object.defineProperty(window, "scrollY", { configurable: true, value: 208 });
      await act(async () => expectDetailLink(articles(view)[0]!, postPath).click());
      if (result === "404") await respond({}, 404);
      else await respond(thread(deleted({ ...first, replyCount: 1 })));
      await act(async () => router.navigate(-1));

      expect(view.textContent).not.toContain(first.text);
      expect(view.textContent).toContain(second.text);
      expect(articles(view)).toHaveLength(result === "404" ? 1 : 2);
      if (result === "削除枠") expect(articles(view)[0]?.textContent).toContain("削除された投稿");
      expect(scroll).toHaveBeenCalledWith(0, 208);
      await act(async () => router.navigate(-1));
      await respond(thread(second));
      await act(async () => router.navigate(-1));
      expect(view.textContent).not.toContain(first.text);
      expect(articles(view)).toHaveLength(result === "404" ? 1 : 2);
      expect(scroll).toHaveBeenLastCalledWith(0, 185);
      expect(requests.filter(({ url }) => url.startsWith(timelineUrl))).toHaveLength(2);
    } finally {
      if (scrollY) Object.defineProperty(window, "scrollY", scrollY);
      else Reflect.deleteProperty(window, "scrollY");
      scroll.mockRestore();
      dispose();
    }
  },
);

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

  choosePostMenu(articles(view)[1]!, "削除");
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
    expect(more?.getAttribute("href")).toBe("/posts/1002");
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
    expect(latest().url).toBe(`/api/posts/1002${detailQuery}`);
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
  expect(
    input(view).previousElementSibling?.querySelector('[data-slot="avatar-fallback"] svg'),
  ).toBeTruthy();
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

test.each([
  ["連携済み", user],
  ["未ログイン", null],
] as const)("%s でEnterは送信せず、変換中のCtrlまたは⌘+Enterも送信しない", async (_, viewer) => {
  const view = show(timelinePath, viewer);
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
  expect(dialog()).toBeNull();
  keydown({ metaKey: true });
  if (viewer) expect(latest().init.method).toBe("POST");
  else {
    expectBoardLinkDialog(true);
    expect(boardWrites()).toEqual([]);
  }
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
  expect(report.nextElementSibling).toBe(postMenuTrigger(card));

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
  expect(
    input(view).previousElementSibling?.querySelector('[data-slot="avatar-fallback"] svg'),
  ).toBeTruthy();
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
  ["未ログインのタイムライン", null, timelinePath + "?other=1", timelinePath],
  [
    "ゲストのタイムライン",
    guest,
    `${timelinePath}?position=0&match=${shogiMatch.id}`,
    timelineWithPosition,
  ],
  ["不正な添付のタイムライン", null, timelinePath + "?match=bad&position=0", timelinePath],
  ["未ログインの投稿詳細", null, postPath + "?other=1", postPath],
  ["ゲストの投稿詳細", guest, postPath, postPath],
] as const)(
  "%s でいいねを押すと、現在のページに戻る連携を案内する",
  async (_, viewer, url, path) => {
    const view = show(url, viewer);
    await respond(
      path === postPath ? thread(post(1, "投稿"), [reply(2, "返信")]) : timeline([post(1, "投稿")]),
    );
    const button = path === postPath ? like(articles(view)[1]!) : like(view);
    act(() => button.click());
    expect(button.getAttribute("aria-pressed")).toBe("false");
    expect(boardWrites()).toEqual([]);
    press(expectBoardLinkDialog(), "Googleで続ける");
    await flush();
    expect(readRegistrationReturn()).toMatchObject({ path, oauthStarted: true });
    expect(readRegistrationReturn()?.boardDraft).toBeUndefined();
    expect(boardWrites()).toEqual([]);
  },
);

test("いいねの連携は添付や認証状態が変わると閉じ、開き直すと現在の復帰先を使う", async () => {
  const router = createMemoryRouter(
    [
      {
        path: "/games/:gameId/posts",
        element: (
          <BoardLikeButton
            item={post(1, "投稿")}
            write={(operation) => operation(new AbortController().signal)}
            onLike={() => {}}
            onError={() => {}}
          />
        ),
      },
    ],
    { initialEntries: [timelineWithPosition] },
  );
  const page = (viewer: AccountProfile | null, error: string | null = null) => (
    <AccountContext.Provider
      value={{ user: viewer, loading: false, error, refresh: async () => {}, update: () => {} }}
    >
      <RouterProvider router={router} />
    </AccountContext.Provider>
  );
  const view = render(page(null));
  act(() => like(view).click());
  press(expectBoardLinkDialog(), "Googleで続ける");
  await flush();
  const previous = signInRequest()!;
  const assign = spyOn(window.location, "assign").mockImplementation(() => {});
  try {
    await act(async () => router.navigate(`${timelinePath}?position=0&match=${shogiMatch.id}`));
    expectBoardLinkDialog();
    expect(previous.init.signal?.aborted).toBe(false);
    const nextPath = timelineWithPosition.replace("position=0", "position=1");
    await act(async () => router.navigate(nextPath));
    expect(dialog()).toBeNull();
    expect(previous.init.signal?.aborted).toBe(true);
    previous.respond({ url: googleOAuthUrl });
    await flush();
    expect(assign).not.toHaveBeenCalled();

    for (const invalid of [page(null, "ログイン状態を確認できません。"), page(user)]) {
      act(() => like(view).click());
      expectBoardLinkDialog();
      rerender(view, invalid);
      expect(dialog()).toBeNull();
      rerender(view, page(null));
      expect(dialog()).toBeNull();
    }

    act(() => like(view).click());
    press(expectBoardLinkDialog(), "Googleで続ける");
    await flush();
    expect(readRegistrationReturn()?.path).toBe(nextPath);
    expect(boardWrites()).toEqual([]);
  } finally {
    assign.mockRestore();
  }
});

test("連携済みでもプロフィール未設定なら設定を案内する", async () => {
  const view = show(timelinePath, { ...user, profileCompleted: false });
  await respond(timeline([post(1, "閲覧する投稿")]));
  expect(input(view)).toBeNull();
  expect(view.querySelector('main a[href="/account/setup"]')?.textContent).toBe(
    "プロフィールを設定する",
  );
  act(() => like(view).click());
  expect(view.querySelector('[role="alert"]')?.textContent).toBe(
    "プロフィールの初回設定を完了するといいねできます。",
  );
  expect(dialog()).toBeNull();
  expect(boardWrites()).toEqual([]);
});

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

test("ログイン状態の取得失敗時には連携を案内せず、入力中なら連携を閉じる", async () => {
  const view = render(
    <MemoryRouter initialEntries={[timelinePath]}>
      <Routes>
        <Route element={<AccountLayout />}>
          <Route path="/games/:gameId/posts" element={<BoardTimelinePage />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
  const session = () => requests.findLast(({ url }) => url === "/api/account/session")!;
  requests.find(({ url }) => url === timelineUrl)!.respond(timeline([post(1, "閲覧する投稿")]));
  await flush();
  expect(view.textContent).toContain("ログイン状態を確認しています");
  expect(input(view)).toBeNull();
  act(() => like(view).click());
  expect(dialog()).toBeNull();

  session().respond({}, 503);
  await flush();
  act(() => like(view).click());
  expect(view.querySelector("main [role=alert]")?.textContent).toContain(
    "ログイン状態を確認できません",
  );
  expect(input(view)).toBeNull();
  expect(dialog()).toBeNull();
  expect(boardWrites()).toEqual([]);
  press(view.querySelector("main")!, "再試行");
  session().respond({ user: null });
  await flush();
  enter(input(view), "入力中");
  press(view, "投稿する");
  expectBoardLinkDialog(true);
  act(() => window.dispatchEvent(new Event("focus")));
  session().respond({}, 503);
  await flush();
  expect(input(view)).toBeNull();
  expect(dialog()).toBeNull();
  press(view.querySelector("main")!, "再試行");
  session().respond({ user: null });
  await flush();
  expect(input(view).value).toBe("入力中");
  expect(dialog()).toBeNull();
  press(view, "投稿する");
  expectBoardLinkDialog(true);
});

test("タイムラインの投稿者リンクはカードの詳細リンクから独立して公開ページを開く", async () => {
  const view = show();
  const profileId = uuid(3);
  const author = {
    name: "現在名",
    avatarUrl: null,
    profileTarget: { source: "profile" as const, profileId },
    username: "current_author",
  };
  await respond(timeline([post(1, "投稿", { author }), post(2, "プロフィールなし")]));
  const [withProfile, withoutProfile] = articles(view);
  const playerPath = "/users/@current_author?game=four-shogi&mode=singles";
  const link = withProfile!.querySelector<HTMLAnchorElement>(`a[href="${playerPath}"]`)!;
  expect(link?.textContent).toBe(author.name);
  expect(link.querySelector("svg")).not.toBeNull();
  expect(link.classList.contains("z-10")).toBe(true);
  expect(expectDetailLink(withProfile!, postPath).contains(link)).toBe(false);
  expectDetailLink(withoutProfile!, "/posts/1002");
  expect(withoutProfile?.querySelector("header")?.textContent).toContain("投稿者");
  expect(
    withoutProfile?.querySelector('header a[href^="/users/"], header a[href^="/players/"]'),
  ).toBeNull();
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
      username: "parent_author",
    },
  });
  const child = reply(2, "返信", {
    author: {
      name: "返信者名",
      avatarUrl: null,
      profileTarget: { source: "profile", profileId: uuid(5) },
      username: "reply_author",
    },
  });
  await respond(thread(parent, [child, reply(3, "プロフィールなし")]));
  const [postCard, replyCard, withoutProfile] = articles(view);
  const parentPath = "/users/@parent_author?game=reversi";
  const replyPath = "/users/@reply_author?game=reversi";
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

test.each([
  [false, true, "現在、掲示板への投稿を受け付けていません。投稿は閲覧できます。"],
  [true, true, "このアカウントは掲示板への投稿を停止されています。"],
] as const)(
  "受付設定と投稿停止を投稿欄に表示する",
  async (acceptingPosts, postingStopped, message) => {
    const view = show(timelinePath, guest);
    await respond(timeline([], null, { acceptingPosts, postingStopped }));
    expect(view.textContent).toContain(message);
    expect(input(view)).toBeNull();
  },
);

test.each([
  [user, true, ["リンクをコピー", "削除"]],
  [user, false, ["リンクをコピー"]],
  [null, false, ["リンクをコピー"]],
] as const)(
  "タイムラインの投稿メニューは閲覧者と本人の区別を反映する (%#)",
  async (viewer, own, labels) => {
    const view = show(timelinePath, viewer);
    await respond(timeline([post(1, "公開中の投稿", { own })]));
    const trigger = postMenuTrigger(articles(view)[0]!);
    expect(trigger.closest("a")).toBeNull();
    expect(trigger.matches(".relative.z-10.ml-auto.min-h-11.min-w-11")).toBe(true);
    act(() => trigger.click());
    expect(menuItems().map((item) => item.textContent?.trim())).toEqual([...labels]);
    expect(requests).toHaveLength(1);
  },
);

test("キーボードで投稿メニューを開閉し、コピーの失敗を知らせてから数字URLを再コピーできる", async () => {
  const write = spyOn(navigator.clipboard, "writeText").mockRejectedValueOnce(new Error("denied"));
  write.mockResolvedValue(undefined);
  try {
    const parent = post(1, "コピーする投稿");
    const view = show(timelinePath + "?preview=1#top", null);
    await respond(timeline([parent]));
    const entry = articles(view)[0]!;
    const trigger = postMenuTrigger(entry);
    function key(target: Element, key: string, type = "keydown") {
      act(() =>
        target.dispatchEvent(
          new KeyboardEvent(type, { key, code: key, bubbles: true, cancelable: true }),
        ),
      );
    }

    act(() => trigger.focus());
    key(trigger, "ArrowDown");
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    const copy = menuItems()[0]!;
    await flush();
    expect(postMenu()!.parentElement!.contains(document.activeElement)).toBe(true);
    key(copy, "Escape");
    clock.advance(32);
    expect(postMenu()).toBeNull();
    expect(document.activeElement === trigger).toBe(true);

    key(trigger, "ArrowDown");
    const reopened = menuItems()[0]!;
    act(() => reopened.focus());
    key(reopened, "Enter");
    key(reopened, "Enter", "keyup");
    await flush();
    expect(entry.querySelector('[aria-live="polite"]')?.textContent).toBe(
      "リンクをコピーできませんでした。",
    );
    expect(postMenu()).toBeNull();
    clock.advance(32);
    expect(document.activeElement === trigger).toBe(true);

    choosePostMenu(entry, "リンクをコピー");
    await flush();
    expect(entry.querySelector('[aria-live="polite"]')?.textContent).toBe(
      "リンクをコピーしました。",
    );
    expect(write).toHaveBeenCalledTimes(2);
    const url = new URL(write.mock.calls[1]![0]);
    expect(url.href).toBe(window.location.origin + postPath);
    expect(requests).toHaveLength(1);
    expect(view.querySelector("h1")?.textContent).toBe("四人将棋の掲示板");

    const detail = show(url.pathname, null);
    expect(latest().url).toBe(detailUrl);
    await respond(thread(parent));
    expect(detail.querySelector("h1")?.textContent).toBe("投稿の詳細");
    expect(articles(detail)[0]?.textContent).toContain(parent.text);
    expect(postMenuTrigger(articles(detail)[0]!)).toBeTruthy();
  } finally {
    write.mockRestore();
  }
});

test("タイムラインの削除は詳細の404で消し、200なら返信の枠に置き換える", async () => {
  const view = show();
  const gainsReply = post(3, "返信が増えた投稿", { own: true });
  const losesReplies = post(2, "返信が減った投稿", { own: true, replyCount: 4 });
  const older = post(1, "追加取得済みの投稿");
  await respond(timeline([gainsReply, losesReplies], cursor(losesReplies)));
  press(view, "もっと見る");
  await respond(timeline([older], cursor(older)));

  const [existing, empty] = articles(view);
  const trigger = postMenuTrigger(empty!);
  expect(like(empty!).previousElementSibling?.textContent).toContain("返信 4 件");
  expect(like(empty!).nextElementSibling).toBe(trigger);
  act(() => trigger.focus());
  choosePostMenu(empty!, "削除");
  expect(dialog().textContent).toContain("投稿を削除しますか？");
  expect(dialog().textContent).toContain("削除すると元に戻せません。");
  press(dialog(), "キャンセル");
  clock.advance(32);
  expect(document.activeElement).toBe(trigger);
  expect(requests).toHaveLength(2);
  expect(articles(view)).toHaveLength(3);
  choosePostMenu(empty!, "削除");
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

  choosePostMenu(existing!, "削除");
  press(dialog(), "削除する");
  await respond(null, 204);
  expect(latest().url).toBe(`/api/posts/${gainsReply.id}${detailQuery}`);
  await respond(thread(deleted({ ...gainsReply, replyCount: 2 })));
  const [placeholder, preserved] = articles(view);
  expect(placeholder?.textContent).toContain("削除された投稿");
  expect(placeholder?.textContent).not.toContain(gainsReply.text);
  expect(placeholder?.textContent).not.toContain(gainsReply.author.name);
  expect(placeholder?.querySelector("button")).toBeNull();
  const deletedPath = `/posts/${gainsReply.publicNumber}`;
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
  choosePostMenu(articles(view)[0]!, "削除");
  press(dialog(), "削除する");
  await respond(null, 204);
  expect(latest().url).toBe(postUrl + detailQuery);
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
  choosePostMenu(articles(view)[0]!, "削除");
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
      choosePostMenu(articles(view)[0]!, "削除");
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

test("ログイン後の戻り先は6ゲームの掲示板と正の安全整数の投稿詳細だけを追加で受け付ける", () => {
  for (const game of gameIds) {
    const path = `/games/${game}/posts`;
    expect(registrationPath(path)).toBe(path);
  }
  expect(registrationPath(postPath)).toBe(postPath);
  expect(registrationPath(postPath + "/")).toBe(postPath + "/");
  const max = "/posts/9007199254740991";
  expect(registrationPath(max)).toBe(max);
  for (const path of [
    "/games/unknown/posts",
    `/posts/${uuid(1)}`,
    "/posts/0",
    "/posts/01",
    "/posts/-1",
    "/posts/9007199254740992",
    "/posts/%31",
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
