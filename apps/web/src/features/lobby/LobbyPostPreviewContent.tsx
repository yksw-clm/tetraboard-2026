import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import type { BoardPublishedPost } from "@tetraboard/protocol/board";
import { AppCard } from "../../shared/ui/AppCard";
import { boardPostPath } from "../board/boardApi";
import { BoardAuthor } from "../board/BoardAuthor";
import { BoardLikeButton, BoardReplyCount, type BoardLike } from "../board/BoardReactions";
import type { BoardWrite } from "../board/useBoardData";
import { formatMatchDate } from "../matches/matchDatePresentation";

function PostPreview({
  post,
  nowMs,
  onLike,
}: {
  post: BoardPublishedPost;
  nowMs: number;
  onLike: (id: string, like: BoardLike) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const active = useRef<AbortController | null>(null);
  useEffect(() => () => active.current?.abort(), []);

  const write: BoardWrite = async (operation) => {
    if (active.current) return;
    const controller = new AbortController();
    active.current = controller;
    try {
      await operation(AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]));
    } finally {
      active.current = null;
    }
  };

  const date = new Date(post.postedAtMs);
  const iso = Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  return (
    <AppCard density="compact" className="relative isolate min-w-0 hover:bg-surface-hover">
      <header className="flex min-w-0 items-center gap-2">
        <BoardAuthor author={post.author} game={post.gameId} compact />
        {iso && (
          <time className="ml-auto shrink-0 text-xs text-muted" dateTime={iso}>
            {formatMatchDate(post.postedAtMs, nowMs)}
          </time>
        )}
      </header>
      <Link
        to={boardPostPath(post.id)}
        className="min-w-0 text-ink no-underline before:absolute before:inset-0 before:z-[1] before:rounded-panel focus-visible:outline-none focus-visible:before:outline-3 focus-visible:before:outline-focus focus-visible:before:outline-offset-2"
      >
        <p className="line-clamp-3 whitespace-pre-wrap wrap-anywhere text-sm">{post.text}</p>
      </Link>
      <div className="flex items-center gap-2">
        <BoardReplyCount count={post.replyCount} />
        <BoardLikeButton
          item={post}
          write={write}
          onLike={onLike}
          onError={setError}
          className="relative z-10"
        />
      </div>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
    </AppCard>
  );
}

export function LobbyPostPreviewContent({
  acceptingPosts,
  posts: initialPosts,
  nowMs,
}: {
  acceptingPosts: boolean;
  posts: BoardPublishedPost[];
  nowMs: number;
}) {
  const [posts, setPosts] = useState(initialPosts);

  function updateLike(id: string, like: BoardLike) {
    setPosts((current) => current.map((post) => (post.id === id ? { ...post, ...like } : post)));
  }

  if (!posts.length) {
    return (
      <AppCard className="gap-1 text-sm text-muted">
        <p>まだ投稿はありません。</p>
        {acceptingPosts && <p>対局の感想や気になる局面を、最初に投稿してみませんか。</p>}
      </AppCard>
    );
  }

  return (
    <ul className="m-0 grid list-none gap-2 p-0">
      {posts.map((post) => (
        <li key={post.id} className="min-w-0">
          <PostPreview post={post} nowMs={nowMs} onLike={updateLike} />
        </li>
      ))}
    </ul>
  );
}
