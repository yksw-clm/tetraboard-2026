import { expect, test } from "bun:test";
import type { AccountProfile } from "@tetraboard/protocol";
import type { BoardPost, BoardPublishedPost, BoardReply } from "@tetraboard/protocol/board";
import { gameIds } from "@tetraboard/protocol/games";
import { MemoryRouter, Route, Routes } from "react-router";
import {
  readRegistrationReturn,
  registrationPath,
} from "../src/features/account/registrationReturn";
import { AccountLayout } from "../src/features/account/AccountSession";
import { PlayerProfileProvider } from "../src/features/players/PlayerProfileProvider";
import { BoardDetailPage, BoardTimelinePage } from "../src/features/board/BoardPages";
import { act, clock, enter, flush, press, render, requests, wrap, type Request } from "./harness";

const uuid = (id: number) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(id).padStart(12, "0")}`;
const postPath = `/posts/${uuid(1)}`;
const timelinePath = "/games/four-shogi/posts";
const timelineUrl = "/api" + timelinePath;
const detailUrl = "/api" + postPath;
const repliesUrl = detailUrl + "/replies";
const user: AccountProfile = {
  username: "owner",
  name: "本人",
  avatarUrl: null,
  profileCompleted: true,
};

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
function thread(parent: BoardPost, replies: BoardReply[] = [], nextCursor: string | null = null) {
  return { ...state(), post: parent, replies, nextCursor };
}
function deleted({ id, postedAtMs, gameId, replyCount }: BoardPost): BoardPost {
  return { id, postedAtMs, gameId, replyCount, status: "deleted" };
}
function cursor({ id, postedAtMs }: BoardReply) {
  return `${postedAtMs}:${id}`;
}

function show(entry = timelinePath, viewer: AccountProfile | null = user) {
  return render(
    wrap(
      viewer,
      entry,
    )(
      <PlayerProfileProvider>
        <Routes>
          <Route path="/games/:gameId/posts" element={<BoardTimelinePage />} />
          <Route path="/posts/:id" element={<BoardDetailPage />} />
          <Route path="/login" element={<p>ログイン画面</p>} />
        </Routes>
      </PlayerProfileProvider>,
    ),
  );
}
const latest = () => requests.at(-1)!;
const articles = (view: HTMLElement) => [...view.querySelectorAll("article")];
const input = (view: HTMLElement) => view.querySelector("textarea")!;
const like = (element: HTMLElement) =>
  element.querySelector<HTMLButtonElement>('button[aria-label="いいね"]')!;
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')!;
const requestInput = (request: Request) =>
  JSON.parse(String(request.init.body)) as { requestId: string; text: string };

async function respond(body: unknown, status?: number) {
  latest().respond(body, status);
  await flush();
}

test("タイムラインは追加取得で重複を除き、更新で先頭の結果に戻る", async () => {
  const view = show();
  expect(view.querySelector('[role="status"]')?.textContent).toContain("読み込んでいます");
  expect(latest().url).toBe(timelineUrl);
  const recent = post(2, "最新の投稿");
  const old = post(1, "古い投稿");
  const before = cursor(recent);
  await respond(timeline([recent], before));
  expect(view.querySelector("h1")?.textContent).toBe("四人将棋の掲示板");
  expect(view.querySelector('a[href="/games/four-shogi"]')).not.toBeNull();
  expect(articles(view)[0]?.querySelector("time")?.textContent).toMatch(/分前$/);
  expect(articles(view)[0]?.textContent).toContain("最新の投稿");
  clock.advance(60_000);
  expect(requests).toHaveLength(1);
  press(view, "もっと見る");
  expect(latest().url).toBe(`${timelineUrl}?before=${encodeURIComponent(before)}`);
  expect(view.querySelector('button[data-pending="true"]')?.textContent).toBe("もっと見る");
  await respond(timeline([recent, old]));
  expect(articles(view)).toHaveLength(2);
  expect(articles(view)[1]?.textContent).toContain("古い投稿");

  press(view, "更新");
  expect(latest().url).toBe(timelineUrl);
  expect(view.querySelector('button[data-pending="true"]')?.textContent).toBe("更新");
  await respond(timeline([]));
  expect(articles(view)).toHaveLength(0);
  expect(view.textContent).toContain("まだ投稿はありません。");
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

test("5行を超える本文だけに続きを読むを出し、TetraBoard内のURLをリンクにする", async () => {
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
    const external = "https://example.com/";
    await respond(
      timeline([
        post(2, "一\n二\n三\n四\n五\n六"),
        post(1, `${internal} と ${external}\n二\n三\n四\n五`),
      ]),
    );
    const [long, short] = articles(view);
    const more = [...long!.querySelectorAll("a")].find((link) => link.textContent === "続きを読む");
    expect(more?.getAttribute("href")).toBe(`/posts/${uuid(2)}`);
    expect(short?.textContent).not.toContain("続きを読む");
    const link = short?.querySelector('a[href="/tournaments/21"]');
    expect(link?.textContent).toBe(internal);
    expect(link?.hasAttribute("rel")).toBe(false);
    expect(link?.hasAttribute("target")).toBe(false);
    expect(short?.querySelector('a[href*="example.com"]')).toBeNull();
    expect(short?.textContent).toContain(external);
    expect(short?.querySelector(`a[href="${postPath}"]`)?.textContent).toBe("返信 0");
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
  expect(main.textContent).toContain("返信 7");
  expect(like(main).textContent).toContain("14");
  expect(like(main).getAttribute("aria-pressed")).toBe("true");
  press(view, "もっと見る");
  expect(latest().url).toBe(`${repliesUrl}?after=${encodeURIComponent(cursor(first))}`);
  await respond({ replies: [second, newReply], nextCursor: null });
  expect(articles(view)).toHaveLength(4);
  expect(articles(view)[1]?.textContent).toContain(first.text);
  expect(articles(view)[2]?.textContent).toContain(second.text);
  expect(articles(view)[3]?.textContent).toContain(newReply.text);
  expect(main.textContent).toContain("返信 7");
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
  expect(articles(view)[0]?.textContent).toContain("返信 1");
  expect(view.textContent).toContain("投稿を取得できませんでした。");
  press(view, "再試行");
  await respond({
    ...thread({ ...parent, replyCount: 8 }, [original, sent], cursor(sent)),
    acceptingPosts: false,
  });
  expect(articles(view)).toHaveLength(3);
  expect(articles(view)[0]?.textContent).toContain("返信 8");
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
  expect(articles(view)[0]?.textContent).toContain("返信 3");

  enter(input(view), "別の返信");
  press(view, "返信する");
  await respond({ reply: null, availableAtMs: 0 });
  expect(latest().url).toBe(detailUrl);
  await respond(thread({ ...parent, replyCount: 4 }, [saved, reply(3, "別の返信")]));
  expect(articles(view)).toHaveLength(3);
  expect(articles(view)[0]?.textContent).toContain("返信 4");
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
  expect(latest().url).toBe(`${repliesUrl}?after=${encodeURIComponent(cursor(first))}`);
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
  act(() => mainLike.click());
  expect(latest().url).toBe(detailUrl + "/like");
  expect(latest().init.method).toBe("PUT");
  expect(mainLike.getAttribute("aria-pressed")).toBe("true");
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

test("投稿者の公開プロフィールがある場合だけプレイヤー情報を開ける", async () => {
  const view = show();
  const profileId = uuid(3);
  const author = {
    name: "現在名",
    avatarUrl: null,
    profileTarget: { source: "profile" as const, profileId },
  };
  await respond(timeline([post(1, "投稿", { author }), post(2, "プロフィールなし")]));
  const [withProfile, withoutProfile] = articles(view);
  expect(withoutProfile?.querySelector('button[aria-label$="プレイヤー情報"]')).toBeNull();
  act(() =>
    withProfile
      ?.querySelector<HTMLButtonElement>('button[aria-label="現在名のプレイヤー情報"]')
      ?.click(),
  );
  expect(latest().url).toContain(profileId);
  await respond({
    kind: "account",
    profileId,
    game: "four-shogi",
    name: "現在名",
    username: "current_id",
    avatarUrl: null,
    stats: { singles: { total: 3, first: 1 }, doubles: { total: 0, wins: 0 } },
  });
  expect(
    document.querySelector('[aria-label="現在名のプレイヤー情報"][role="region"]')?.textContent,
  ).toContain("現在名");
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
  expect(latest().url).toBe(`/api/posts/${losesReplies.id}`);
  expect(latest().init.method).toBeUndefined();
  expect(articles(view)).toHaveLength(3);
  await respond(null, 404);
  expect(articles(view)).toHaveLength(2);
  expect(view.textContent).not.toContain(losesReplies.text);

  press(existing!, "削除");
  press(dialog(), "削除する");
  await respond(null, 204);
  expect(latest().url).toBe(`/api/posts/${gainsReply.id}`);
  await respond(thread(deleted({ ...gainsReply, replyCount: 2 })));
  const [placeholder, preserved] = articles(view);
  expect(placeholder?.textContent).toContain("削除された投稿");
  expect(placeholder?.textContent).not.toContain(gainsReply.text);
  expect(placeholder?.textContent).not.toContain(gainsReply.author.name);
  expect(placeholder?.querySelector("button")).toBeNull();
  expect(placeholder?.querySelector("a")?.textContent).toBe("返信 2");
  expect(preserved?.textContent).toContain(older.text);
  press(view, "もっと見る");
  expect(latest().url).toBe(`${timelineUrl}?before=${encodeURIComponent(cursor(older))}`);
  await respond(timeline([]));
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
  expect(articles(view)[0]?.textContent).toContain("返信 5");
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
  expect(articles(view)[0]?.textContent).toContain("返信 2");
  press(view, "再試行");
  expect(latest().url).toBe(detailUrl);
  expect(latest().init.method).toBeUndefined();
  await respond(thread({ ...parent, replyCount: 1 }, [remaining], cursor(remaining)));
  expect(articles(view)).toHaveLength(2);
  expect(articles(view)[1]?.textContent).toContain(remaining.text);
  expect(articles(view)[0]?.textContent).toContain("返信 1");
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
    expect(placeholder?.textContent).toContain("返信 1");
    expect(placeholder?.textContent).not.toContain(parent.text);
    expect(placeholder?.textContent).not.toContain(parent.author.name);
    expect(placeholder?.querySelector("button")).toBeNull();
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
  expect(latest().url).toBe(detailUrl + "/reports");
  await respond({ message: "通報を受け付けています。" }, 200);
  expect(root!.querySelector('[role="status"]')?.textContent).toBe("通報を受け付けています。");
});
