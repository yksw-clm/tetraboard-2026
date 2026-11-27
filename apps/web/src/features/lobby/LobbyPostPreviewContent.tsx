import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import type { BoardPublishedPost } from "@tetraboard/protocol/board";
import { AppButton } from "../../shared/ui/AppButton";
import { AppCard } from "../../shared/ui/AppCard";
import { boardPostPath } from "@tetraboard/protocol/board-presentation";
import { BoardAuthor } from "../board/BoardAuthor";
import { BoardPostMenu } from "../board/BoardPostMenu";
import { BoardLikeButton, BoardReplyCount, type BoardLike } from "../board/BoardReactions";
import { boardLoadError } from "../board/boardApi";
import type { BoardDeleteActions } from "../board/BoardDeleteDialog";
import type { BoardWrite } from "../board/useBoardData";
import { formatMatchDate } from "../matches/matchDatePresentation";

function PostPreview({
  post,
  nowMs,
  onLike,
  ...actions
}: BoardDeleteActions & {
  post: BoardPublishedPost;
  nowMs: number;
  onLike: (id: string, like: BoardLike) => void;
}) {
  const [error, setError] = useState<string | null>(null);

  const date = new Date(post.postedAtMs);
  const iso = Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  const detailPath = boardPostPath(post.publicNumber);
  return (
    <AppCard density="compact" className="relative isolate min-w-0">
      <header className="flex min-w-0 items-center gap-2">
        <BoardAuthor author={post.author} game={post.gameId} compact />
        {iso && (
          <time className="ml-auto shrink-0 text-xs text-muted" dateTime={iso}>
            {formatMatchDate(post.postedAtMs, nowMs)}
          </time>
        )}
      </header>
      <Link
        to={detailPath}
        className="min-w-0 text-ink no-underline before:absolute before:inset-0 before:z-[1] before:rounded-panel focus-visible:outline-none focus-visible:before:outline-3 focus-visible:before:outline-focus focus-visible:before:outline-offset-2"
      >
        <p className="line-clamp-3 whitespace-pre-wrap wrap-anywhere text-sm">{post.text}</p>
        {post.attachment && <p className="mt-1 text-xs text-muted">棋譜付き</p>}
      </Link>
      <div className="flex flex-wrap items-center gap-2">
        <BoardReplyCount count={post.replyCount} detailPath={detailPath} />
        <BoardLikeButton
          item={post}
          busy={actions.busy}
          write={actions.write}
          onLike={onLike}
          onError={setError}
          className="relative z-10"
        />
        <BoardPostMenu post={post} {...actions} />
      </div>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
    </AppCard>
  );
}

type PreviewData = { acceptingPosts: boolean; posts: BoardPublishedPost[]; nowMs: number };

export function LobbyPostPreviewContent({
  data: { acceptingPosts, posts, nowMs },
  change,
  refresh,
}: {
  data: PreviewData;
  change: (update: (current: PreviewData) => PreviewData) => void;
  refresh: (signal: AbortSignal) => Promise<string | null>;
}) {
  const [pending, setPending] = useState<"write" | "retry" | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const active = useRef<AbortController | null>(null);
  useEffect(() => () => active.current?.abort(), []);

  async function run(source: "write" | "retry", operation: (signal: AbortSignal) => Promise<void>) {
    if (active.current) return;
    const controller = new AbortController();
    active.current = controller;
    setPending(source);
    try {
      await operation(AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]));
    } finally {
      active.current = null;
      setPending(null);
    }
  }

  const write: BoardWrite = (operation) => run("write", operation);

  function updateLike(id: string, like: BoardLike) {
    change((current) => ({
      ...current,
      posts: current.posts.map((post) => (post.id === id ? { ...post, ...like } : post)),
    }));
  }

  async function refreshPosts(signal: AbortSignal) {
    try {
      setRefreshError(await refresh(signal));
    } catch {
      if (signal.reason?.name !== "AbortError") setRefreshError(boardLoadError);
    }
  }

  async function removePost(id: string, signal: AbortSignal) {
    change((current) => ({ ...current, posts: current.posts.filter((post) => post.id !== id) }));
    await refreshPosts(signal);
  }

  return (
    <>
      {posts.length ? (
        <ul className="m-0 grid list-none gap-2 p-0">
          {posts.map((post) => (
            <li key={post.id} className="min-w-0">
              <PostPreview
                post={post}
                nowMs={nowMs}
                busy={pending !== null}
                write={write}
                onLike={updateLike}
                onRemove={removePost}
              />
            </li>
          ))}
        </ul>
      ) : (
        <AppCard className="gap-1 text-sm text-muted">
          <p>まだ投稿はありません。</p>
          {acceptingPosts && <p>対局の感想や気になる局面を、最初に投稿してみませんか。</p>}
        </AppCard>
      )}
      {refreshError && (
        <div className="mt-2 flex flex-col items-start gap-2">
          <p role="alert" className="text-sm text-danger">
            {refreshError}
          </p>
          <AppButton
            appearance="secondary"
            size="compact"
            isDisabled={pending === "write"}
            isPending={pending === "retry"}
            onPress={() => void run("retry", refreshPosts)}
          >
            再試行
          </AppButton>
        </div>
      )}
    </>
  );
}
