import {
  boardPostResultSchema,
  boardReplyResultSchema,
  type BoardPost,
  type BoardReply,
} from "@tetraboard/protocol/board";
import { gameCatalog, isGameId, type GameId } from "@tetraboard/protocol/games";
import { useCallback, useEffect, useRef, type ReactNode } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router";
import { updatePageMetadata } from "../../seo/pageMetadata";
import { AppButton, AppButtonLink } from "../../shared/ui/AppButton";
import { AppHeader } from "../../shared/ui/AppHeader";
import { AppPageLoading, AppPageState } from "../../shared/ui/AppPageState";
import { appThemeClasses, gameThemes } from "../../shared/ui/appTheme";
import { appPageWidthClasses } from "../../shared/ui/pageLayout";
import { useAccount } from "../account/useAccount";
import { boardLinkClasses } from "./BoardBody";
import { BoardComposer } from "./BoardComposer";
import { BoardEntry } from "./BoardEntry";
import {
  boardLoadError,
  boardMissing,
  boardPostPath,
  boardRequest,
  boardTimelinePath,
  readDetail,
  readDetailOrMissing,
  readReplies,
  readTimeline,
} from "./boardApi";
import { useBoardData } from "./useBoardData";

function BoardLayout({ game, children }: { game: GameId; children: ReactNode }) {
  const theme = gameThemes[game];
  return (
    <div className={`app-theme ${appThemeClasses[theme]} lobby-background min-h-dvh text-ink`}>
      <AppHeader homeTo="/" homeLabel="総合ロビーへ" theme={theme} />
      <main className={`${appPageWidthClasses} space-y-5 py-6 sm:py-8`}>
        <div className="mx-auto grid min-w-0 max-w-3xl gap-5">{children}</div>
      </main>
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

function useViewerKey() {
  const { user } = useAccount();
  return JSON.stringify([user?.profileId ?? user?.username, user?.isGuest, user?.profileCompleted]);
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
  const readFirst = useCallback((signal: AbortSignal) => readTimeline(game, signal), [game]);
  const board = useBoardData(readFirst);
  const { data, pending, failure } = board;
  const busy = pending !== null;

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
    <BoardLayout game={game}>
      <div className="grid gap-2">
        <Link to={catalog.lobbyPath} className={boardLinkClasses}>
          {catalog.name}のロビーへ
        </Link>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h1 className="text-2xl font-bold">{catalog.name}の掲示板</h1>
          {data && (
            <AppButton
              appearance="secondary"
              onPress={() => void board.refresh()}
              isPending={pending === "refresh"}
              isDisabled={busy}
            >
              更新
            </AppButton>
          )}
        </div>
      </div>
      {data && (
        <>
          <BoardComposer
            posting={data}
            returnTo={path}
            placeholder={`${catalog.name}について投稿する`}
            busy={busy}
            write={board.write}
            onSubmit={async (input, signal) => {
              const response = await boardRequest(
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
          <div className="grid gap-3">
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
          action={() => (failure.source === "more" ? more(true) : void board.refresh(true))}
          pending={pending === "retry"}
          disabled={busy}
        />
      )}
    </BoardLayout>
  );
}

export function BoardDetailPage() {
  const { id = "" } = useParams();
  const viewer = useViewerKey();
  return <BoardDetail key={`${id}:${viewer}`} id={id} />;
}

function BoardDetail({ id }: { id: string }) {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const path = boardPostPath(id);
  const readFirst = useCallback((signal: AbortSignal) => readDetail(id, signal), [id]);
  const board = useBoardData(readFirst);
  const { data, pending, failure } = board;
  const busy = pending !== null;
  const metadataPost =
    failure && (failure.notFound || failure.source !== "more") ? undefined : data?.post;
  const indexable = data?.indexable ?? false;
  useEffect(() => {
    if (pathname.replace(/\/$/, "") !== path) return;
    const page = metadataPost && { post: metadataPost, indexable };
    updatePageMetadata(pathname, undefined, undefined, undefined, undefined, page);
  }, [pathname, path, metadataPost, indexable]);
  // 同期に失敗した場合も、再試行で除外する返信 ID を保持します。
  const removedReplies = useRef(new Set<string>());

  const more = (retry = false) => {
    const after = data?.nextCursor;
    if (!after) return;
    void board.more(async (signal) => {
      const next = await readReplies(id, signal, after);
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
    if (removedId && removedId !== id) removedReplies.current.add(removedId);
    try {
      const next = await readDetailOrMissing(id, signal);
      signal.throwIfAborted();
      if (!next) {
        void navigate(boardTimelinePath(data.post.gameId), { replace: true });
        return;
      }
      const removed = removedReplies.current;
      removedReplies.current = new Set();
      board.change((current) => ({
        ...next,
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
    <BoardLayout game={game}>
      <nav aria-label="掲示板の移動" className="flex flex-wrap gap-x-4 gap-y-2">
        <Link to={timeline} className={boardLinkClasses}>
          {catalog.name}の掲示板へ
        </Link>
        <Link to={catalog.lobbyPath} className={boardLinkClasses}>
          {catalog.name}のロビーへ
        </Link>
      </nav>
      <h1 className="text-2xl font-bold">投稿の詳細</h1>
      <BoardEntry item={post} game={game} serverTimeMs={data.serverTimeMs} {...actions} />
      {replies.length > 0 && (
        <section aria-label="返信" className="grid gap-3">
          {replies.map((reply) => (
            <BoardEntry
              item={reply}
              game={game}
              key={reply.id}
              serverTimeMs={data.serverTimeMs}
              {...actions}
            />
          ))}
        </section>
      )}
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
          placeholder="返信を書く"
          reply
          busy={busy}
          write={board.write}
          onSubmit={async (input, signal) => {
            const response = await boardRequest(
              path + "/replies",
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
