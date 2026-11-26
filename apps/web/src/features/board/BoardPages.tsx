import {
  boardPostResultSchema,
  boardReplyResultSchema,
  type BoardPost,
  type BoardReply,
} from "@tetraboard/protocol/board";
import { gameCatalog, isGameId, type GameId } from "@tetraboard/protocol/games";
import { useCallback, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router";
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

function deletedPost({ id, gameId, postedAtMs, replyCount }: BoardPost): BoardPost {
  return { id, gameId, postedAtMs, replyCount, status: "deleted" };
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
              if (post) {
                board.change((current) => ({
                  ...current,
                  serverTimeMs: Math.max(current.serverTimeMs, post.postedAtMs),
                  posts: [post, ...current.posts.filter(({ id }) => id !== post.id)],
                }));
              } else await board.replace(signal);
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
                onRemove={(id) =>
                  board.change((current) => ({
                    ...current,
                    posts: current.posts.flatMap((post) => {
                      if (post.id !== id) return [post];
                      return post.replyCount ? [deletedPost(post)] : [];
                    }),
                  }))
                }
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
  const path = boardPostPath(id);
  const readFirst = useCallback((signal: AbortSignal) => readDetail(id, signal), [id]);
  const board = useBoardData(readFirst);
  const { data, pending, failure } = board;
  const busy = pending !== null;

  const more = (retry = false) => {
    const after = data?.nextCursor;
    if (!after) return;
    void board.more(async (signal) => {
      const next = await readReplies(id, signal, after);
      return (current) => ({
        ...current,
        nextCursor: next.nextCursor,
        replies: appendDistinct(current.replies, next.replies).sort(
          (a, b) => a.postedAtMs - b.postedAtMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
        ),
      });
    }, retry);
  };
  const retry = (
    <Retry
      action={() => (failure?.source === "more" ? more(true) : void board.refresh(true))}
      pending={pending === "retry"}
      disabled={busy}
    />
  );

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
  const returnToTimeline = () => void navigate(timeline, { replace: true });

  function remove(removedId: string) {
    if (post.id === removedId) {
      if (post.replyCount === 0) returnToTimeline();
      else board.change((current) => ({ ...current, post: deletedPost(current.post) }));
      return;
    }
    if (post.status === "deleted" && post.replyCount === 1) {
      returnToTimeline();
      return;
    }
    board.change((current) => ({
      ...current,
      post: { ...current.post, replyCount: Math.max(0, current.post.replyCount - 1) },
      replies: current.replies.filter(({ id }) => id !== removedId),
    }));
  }

  function updateLike(likedId: string, like: Pick<BoardReply, "liked" | "likeCount">) {
    board.change((current) => ({
      ...current,
      post: likePost(current.post, likedId, like),
      replies: current.replies.map((reply) =>
        reply.id === likedId ? { ...reply, ...like } : reply,
      ),
    }));
  }

  const actions = { busy, write: board.write, onLike: updateLike, onRemove: remove };
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
            if (reply) {
              board.change((current) =>
                current.replies.some(({ id }) => id === reply.id)
                  ? current
                  : {
                      ...current,
                      post: { ...current.post, replyCount: current.post.replyCount + 1 },
                      serverTimeMs: Math.max(current.serverTimeMs, reply.postedAtMs),
                      replies: [...current.replies, reply],
                    },
              );
            } else await board.replace(signal);
          }}
        />
      )}
    </BoardLayout>
  );
}
