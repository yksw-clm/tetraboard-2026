import { Link } from "react-router";
import type { BoardPublishedPost } from "@tetraboard/protocol/board";
import { AppAvatar } from "../../shared/ui/AppAvatar";
import { AppCard } from "../../shared/ui/AppCard";
import { boardPostPath } from "../board/boardApi";
import { formatMatchDate } from "../matches/matchDatePresentation";

function PostPreview({ post, nowMs }: { post: BoardPublishedPost; nowMs: number }) {
  const date = new Date(post.postedAtMs);
  const iso = Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  return (
    <Link
      to={boardPostPath(post.id)}
      className="block rounded-panel no-underline focus-visible:outline-3 focus-visible:outline-focus focus-visible:outline-offset-2"
    >
      <AppCard density="compact" className="min-w-0 hover:bg-surface-hover">
        <div className="flex min-w-0 items-center gap-2">
          <AppAvatar src={post.author.avatarUrl} />
          <span className="min-w-0 truncate text-sm font-bold">{post.author.name}</span>
          {iso && (
            <time className="ml-auto shrink-0 text-xs text-muted" dateTime={iso}>
              {formatMatchDate(post.postedAtMs, nowMs)}
            </time>
          )}
        </div>
        <p className="line-clamp-3 whitespace-pre-wrap wrap-anywhere text-sm">{post.text}</p>
        <div className="flex items-center gap-3 text-xs text-muted">
          <span>♡ {post.likeCount}</span>
          <span>返信 {post.replyCount}</span>
        </div>
      </AppCard>
    </Link>
  );
}

export function LobbyPostPreviewContent({
  acceptingPosts,
  posts,
  nowMs,
}: {
  acceptingPosts: boolean;
  posts: BoardPublishedPost[];
  nowMs: number;
}) {
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
          <PostPreview post={post} nowMs={nowMs} />
        </li>
      ))}
    </ul>
  );
}
