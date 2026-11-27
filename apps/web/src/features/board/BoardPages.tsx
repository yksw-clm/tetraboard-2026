import {
  boardPostResultSchema,
  boardReplyResultSchema,
  type BoardAttachment,
  type BoardPost,
  type BoardReply,
} from "@tetraboard/protocol/board";
import { boardPostPath } from "@tetraboard/protocol/board-presentation";
import { gameCatalog, isGameId, type GameId } from "@tetraboard/protocol/games";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Link, Navigate, useLocation, useNavigate, useParams } from "react-router";
import { updatePageMetadata } from "../../seo/pageMetadata";
import { matchedBoardPostNumber } from "../../shared/siteNavigation";
import { AppButton, AppButtonLink } from "../../shared/ui/AppButton";
import { AppHeader } from "../../shared/ui/AppHeader";
import { AppPageLoading, AppPageState } from "../../shared/ui/AppPageState";
import { appThemeClasses, gameThemes } from "../../shared/ui/appTheme";
import { appPageWidthClasses } from "../../shared/ui/pageLayout";
import { useRegistrationRestore } from "../account/useRegistrationRestore";
import { boardTimelineReturnPath, readBoardAttachmentSearch } from "./boardAttachmentSearch";
import { boardLinkClasses } from "./BoardBody";
import { BoardComposer } from "./BoardComposer";
import { BoardEntry } from "./BoardEntry";
import { BoardMediaContext, createBoardMedia, refreshBoardMedia } from "./boardMedia";
import {
  boardLoadError,
  boardMissing,
  boardPostApiPath,
  boardEntriesRequest,
  boardTimelinePath,
  readDetail,
  readDetailOrMissing,
  readReplies,
  readTimeline,
} from "./boardApi";
import { boardPageMetadata } from "./boardPageMetadata";
import { useViewerKey } from "./boardViewer";
import { useBoardData } from "./useBoardData";

function BoardLayout({
  game,
  media,
  children,
}: {
  game: GameId;
  media: ReturnType<typeof createBoardMedia>;
  children: ReactNode;
}) {
  const theme = gameThemes[game];
  return (
    <div className="app-theme flex min-h-dvh flex-col text-ink">
      <AppHeader homeTo="/" homeLabel="総合ロビーへ" theme={theme} />
      <div className={`lobby-background text-ink flex-1 ${appThemeClasses[theme]}`}>
        <main className={`${appPageWidthClasses} py-8 [@media(max-width:767px)]:py-3`}>
          <BoardMediaContext.Provider value={media}>
            <div className="mx-auto grid min-w-0 max-w-3xl gap-5 [@media(max-width:767px)]:gap-2.5">
              {children}
            </div>
          </BoardMediaContext.Provider>
        </main>
      </div>
    </div>
  );
}

function Retry({
  action,
  pending,
  disabled,
}: {
  action: () => void;
  pending: boolean;
  disabled: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center justify-center gap-3">
      <p role="alert">{boardLoadError}</p>
      <AppButton appearance="secondary" isPending={pending} isDisabled={disabled} onPress={action}>
        再試行
      </AppButton>
    </div>
  );
}

function Missing({ message = boardMissing }: { message?: string }) {
  return (
    <AppPageState>
      <p role="alert">{message}</p>
      <AppButtonLink to="/">総合ロビーへ</AppButtonLink>
    </AppPageState>
  );
}

function appendDistinct<T extends { id: string }>(current: T[], next: T[]) {
  const seen = new Set(current.map(({ id }) => id));
  return [
    ...current,
    ...next.filter(({ id }) => {
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    }),
  ];
}

function mergeReplies(current: BoardReply[], next: BoardReply[]) {
  return appendDistinct(current, next).sort(
    (a, b) => a.postedAtMs - b.postedAtMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

function likePost(post: BoardPost, id: string, like: Pick<BoardReply, "liked" | "likeCount">) {
  return post.id === id && post.status === "published" ? { ...post, ...like } : post;
}

export function BoardTimelinePage() {
  const { gameId } = useParams();
  const viewer = useViewerKey();
  if (!isGameId(gameId)) return <Missing message="掲示板が見つかりません。" />;
  return <BoardTimeline key={`${gameId}:${viewer}`} game={gameId} />;
}

function BoardTimeline({ game }: { game: GameId }) {
  const catalog = gameCatalog[game];
  const path = boardTimelinePath(game);
  const location = useLocation();
  const navigate = useNavigate();
  const latestLocation = useRef(location);
  const [media, setMedia] = useState(createBoardMedia);
  const attachment = readBoardAttachmentSearch(new URLSearchParams(location.search));
  const returnTo = boardTimelineReturnPath(path, attachment);
  const restored = useRegistrationRestore();
  const readFirst = useCallback((signal: AbortSignal) => readTimeline(game, signal), [game]);
  const board = useBoardData(readFirst);
  const { data, pending, failure } = board;
  const busy = pending !== null;

  useLayoutEffect(() => {
    latestLocation.current = location;
  }, [location]);

  function refresh() {
    void board.refresh(true, () => setMedia(refreshBoardMedia(media)));
  }

  function changeAttachment(value: BoardAttachment | null) {
    const current = latestLocation.current;
    const search = new URLSearchParams(current.search);
    if (value) {
      search.set("match", value.matchId);
      search.set("position", String(value.position));
    } else {
      const saved = readBoardAttachmentSearch(search);
      if (saved?.matchId !== attachment?.matchId || saved?.position !== attachment?.position)
        return;
      search.delete("match");
      search.delete("position");
    }
    void navigate(
      { pathname: current.pathname, search: search.toString(), hash: current.hash },
      { replace: true, state: current.state, preventScrollReset: true },
    );
  }

  const more = (retry = false) => {
    const before = data?.nextCursor;
    if (!before) return;
    void board.more(async (signal) => {
      const next = await readTimeline(game, signal, before);
      return (current) => ({ ...next, posts: appendDistinct(current.posts, next.posts) });
    }, retry);
  };

  async function syncRemovedPost(id: string, signal: AbortSignal) {
    try {
      const next = await readDetailOrMissing(id, signal);
      signal.throwIfAborted();
      board.change((current) => ({
        ...current,
        posts: current.posts.flatMap((post) =>
          post.id === id ? (next ? [next.post] : []) : [post],
        ),
      }));
    } catch {
      if (signal.reason?.name !== "AbortError") board.syncFailed();
    }
  }

  if (!data && pending === "initial") {
    return <AppPageLoading message="掲示板を読み込んでいます…" theme={gameThemes[game]} />;
  }

  return (
    <BoardLayout game={game} media={media}>
      <div className="grid gap-2 [@media(max-width:767px)]:gap-1">
        <Link to={catalog.lobbyPath} className={boardLinkClasses}>
          {catalog.name}のロビーへ
        </Link>
        <h1 className="text-2xl font-bold [@media(max-width:767px)]:text-xl">
          {catalog.name}の掲示板
        </h1>
      </div>
      {data && (
        <>
          <BoardComposer
            posting={data}
            returnTo={returnTo}
            initialText={restored?.path === returnTo ? restored.boardDraft?.text : undefined}
            attachmentEditor={{ game, value: attachment, onChange: changeAttachment }}
            placeholder={`${catalog.name}について投稿する`}
            busy={busy}
            write={board.write}
            onSubmit={async (input, signal) => {
              const response = await boardEntriesRequest(
                path,
                {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify(input),
                  signal,
                },
                "投稿を送信できませんでした。",
              );
              const { post } = boardPostResultSchema.parse(await response.json());
              signal.throwIfAborted();
              const exists = post && data.posts.some(({ id }) => id === post.id);
              const first = data.posts[0];
              if (!post || (!exists && first && post.postedAtMs < first.postedAtMs)) {
                await board.replace(signal);
                return;
              }
              board.change((current) => ({
                ...current,
                serverTimeMs: Math.max(current.serverTimeMs, post.postedAtMs),
                posts: exists
                  ? current.posts.map((item) => (item.id === post.id ? post : item))
                  : [post, ...current.posts],
              }));
            }}
          />
          {data.posts.length === 0 && <p className="text-muted">まだ投稿はありません。</p>}
          <div className="grid gap-3 [@media(max-width:767px)]:gap-2">
            {data.posts.map((post) => (
              <BoardEntry
                key={post.id}
                item={post}
                game={game}
                timeline
                serverTimeMs={data.serverTimeMs}
                busy={busy}
                write={board.write}
                onLike={(id, like) =>
                  board.change((current) => ({
                    ...current,
                    posts: current.posts.map((post) => likePost(post, id, like)),
                  }))
                }
                onRemove={syncRemovedPost}
              />
            ))}
          </div>
          {data.nextCursor && (
            <AppButton
              appearance="secondary"
              className="justify-self-center"
              isPending={pending === "more"}
              isDisabled={busy}
              onPress={() => more()}
            >
              もっと見る
            </AppButton>
          )}
        </>
      )}
      {failure && (
        <Retry
          action={() => (failure.source === "more" ? more(true) : refresh())}
          pending={pending === "retry"}
          disabled={busy}
        />
      )}
    </BoardLayout>
  );
}

export function BoardDetailPage() {
  const { pathname, search, hash, state } = useLocation();
  const { id } = useParams();
  const number = matchedBoardPostNumber(pathname, id);
  const viewer = useViewerKey();
  if (number === null) return <Missing />;
  const path = boardPostPath(number);
  if (pathname.replace(/\/$/, "") !== path)
    return <Navigate to={{ pathname: path, search, hash }} state={state} replace />;
  return <BoardDetail key={`${number}:${viewer}`} number={number} />;
}

function BoardDetail({ number }: { number: number }) {
  const navigate = useNavigate();
  const [media] = useState(createBoardMedia);
  const { pathname } = useLocation();
  const path = boardPostPath(number);
  const restored = useRegistrationRestore();
  const readFirst = useCallback(
    async (signal: AbortSignal) => {
      const firstPage = await readDetail(number, signal);
      return { ...firstPage, firstPage };
    },
    [number],
  );
  const board = useBoardData(readFirst);
  const { data, pending, failure } = board;
  const busy = pending !== null;
  // head には詳細 API が返した最初のページを使います。
  const metadata = failure?.notFound
    ? null
    : !failure || failure.source === "more"
      ? data?.firstPage
      : undefined;
  useEffect(() => {
    if (pathname.replace(/\/$/, "") !== path) return;
    const page = metadata ? boardPageMetadata(metadata) : metadata;
    updatePageMetadata(pathname, undefined, undefined, undefined, undefined, page);
  }, [pathname, path, metadata]);
  // 同期に失敗した場合も、再試行で除外する返信 ID を保持します。
  const removedReplies = useRef(new Set<string>());

  const more = (retry = false) => {
    if (!data?.nextCursor) return;
    const { nextCursor, post } = data;
    void board.more(async (signal) => {
      const next = await readReplies(post.id, signal, nextCursor);
      return (current) => ({
        ...current,
        nextCursor: next.nextCursor,
        replies: mergeReplies(current.replies, next.replies),
      });
    }, retry);
  };

  async function syncDetail(
    signal: AbortSignal,
    change: { removedId?: string; reply?: BoardReply | null } = {},
  ) {
    if (!data) return;
    const { removedId, reply } = change;
    if (removedId && removedId !== data.post.id) removedReplies.current.add(removedId);
    try {
      const next = await readDetailOrMissing(number, signal);
      signal.throwIfAborted();
      if (!next) {
        updatePageMetadata(pathname, undefined, undefined, undefined, undefined, null);
        void navigate(boardTimelinePath(data.post.gameId), { replace: true });
        return;
      }
      const removed = removedReplies.current;
      removedReplies.current = new Set();
      board.change((current) => ({
        ...next,
        firstPage: next,
        nextCursor: current.nextCursor,
        replies: mergeReplies(
          next.replies,
          reply ? [...current.replies, reply] : current.replies,
        ).filter(({ id }) => !removed.has(id)),
      }));
      board.clearSyncFailure();
    } catch {
      if (signal.reason?.name === "AbortError") return;
      if (reply) {
        board.change((current) => ({
          ...current,
          replies: mergeReplies(current.replies, [reply]),
        }));
      }
      board.syncFailed();
    }
  }

  function retryRead() {
    if (failure?.source === "sync") void board.retrySync(syncDetail);
    else if (failure?.source === "more") more(true);
    else void board.refresh(true);
  }

  const retry = <Retry action={retryRead} pending={pending === "retry"} disabled={busy} />;

  if (failure?.notFound) return <Missing />;
  if (!data) {
    if (!failure) return <AppPageLoading message="投稿を読み込んでいます…" />;
    return (
      <AppPageState>
        {retry}
        <AppButtonLink to="/">総合ロビーへ</AppButtonLink>
      </AppPageState>
    );
  }

  const { post, replies } = data;
  const hasReplies = post.replyCount > 0;
  const game = post.gameId;
  const timeline = boardTimelinePath(game);
  const catalog = gameCatalog[game];

  function updateLike(likedId: string, like: Pick<BoardReply, "liked" | "likeCount">) {
    board.change((current) => ({
      ...current,
      post: likePost(current.post, likedId, like),
      replies: current.replies.map((reply) =>
        reply.id === likedId ? { ...reply, ...like } : reply,
      ),
    }));
  }

  const actions = {
    busy,
    write: board.write,
    onLike: updateLike,
    onRemove: (removedId: string, signal: AbortSignal) => syncDetail(signal, { removedId }),
  };
  return (
    <BoardLayout game={game} media={media}>
      <nav aria-label="掲示板の移動" className="flex flex-wrap gap-x-4 gap-y-2">
        <Link to={catalog.lobbyPath} className={boardLinkClasses}>
          {catalog.name}のロビーへ
        </Link>
      </nav>
      <div className="flex items-center gap-2">
        <AppButtonLink
          to={timeline}
          aria-label={`${catalog.name}の掲示板へ`}
          appearance="quiet"
          size="compact"
          className="min-h-11 min-w-11 p-0"
        >
          <svg
            aria-hidden="true"
            className="size-5"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M19 12H5m7-7-7 7 7 7" />
          </svg>
        </AppButtonLink>
        <h1 className="text-2xl font-bold [@media(max-width:767px)]:text-xl">投稿の詳細</h1>
      </div>
      <div className="grid min-w-0 gap-3 [@media(max-width:767px)]:gap-2">
        <BoardEntry item={post} game={game} serverTimeMs={data.serverTimeMs} {...actions} />
        {(hasReplies || replies.length > 0) && (
          <section
            aria-labelledby={hasReplies ? "board-replies-heading" : undefined}
            aria-label={hasReplies ? undefined : "返信"}
            className="grid min-w-0 gap-2"
          >
            {hasReplies && (
              <h2 id="board-replies-heading" className="text-sm font-bold">
                返信 {post.replyCount} 件
              </h2>
            )}
            <div
              className={`grid min-w-0 gap-2 ${hasReplies ? "ml-3 border-l-2 border-solid border-line pl-3" : ""}`}
            >
              {replies.map((reply) => (
                <BoardEntry
                  item={reply}
                  game={game}
                  key={reply.id}
                  serverTimeMs={data.serverTimeMs}
                  {...actions}
                />
              ))}
            </div>
          </section>
        )}
      </div>
      {data.nextCursor && (
        <AppButton
          appearance="secondary"
          className="justify-self-center"
          isPending={pending === "more"}
          isDisabled={busy}
          onPress={() => more()}
        >
          もっと見る
        </AppButton>
      )}
      {failure && retry}
      {post.status === "deleted" ? (
        <p className="text-sm text-muted">削除された投稿には返信できません。</p>
      ) : (
        <BoardComposer
          posting={data}
          returnTo={path}
          initialText={restored?.path === path ? restored.boardDraft?.text : undefined}
          placeholder="返信を書く"
          reply
          busy={busy}
          write={board.write}
          onSubmit={async (input, signal) => {
            const response = await boardEntriesRequest(
              `${boardPostApiPath(post.id)}/replies`,
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(input),
                signal,
              },
              "返信を送信できませんでした。",
            );
            const { reply } = boardReplyResultSchema.parse(await response.json());
            signal.throwIfAborted();
            await syncDetail(signal, { reply });
          }}
        />
      )}
    </BoardLayout>
  );
}
