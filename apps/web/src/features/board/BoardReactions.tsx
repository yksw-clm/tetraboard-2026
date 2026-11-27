import { boardLikeResultSchema, type BoardReply } from "@tetraboard/protocol/board";
import { useState } from "react";
import { Link } from "react-router";
import { AppButton } from "../../shared/ui/AppButton";
import { useAccount } from "../account/useAccount";
import { boardPostPath, boardRequest, mutationError } from "./boardApi";
import type { BoardWrite } from "./useBoardData";

export type BoardLike = Pick<BoardReply, "liked" | "likeCount">;

const reactionClasses = "gap-1 text-xs text-ink-secondary";
const iconPaths = {
  heart: "M12 20 4.5 12.5a4.5 4.5 0 0 1 6.4-6.4L12 7.2l1.1-1.1a4.5 4.5 0 0 1 6.4 6.4L12 20Z",
  reply: "M21 11a8 8 0 0 1-8 8H8l-5 3V11a9 9 0 0 1 18 0Z",
};

function ReactionIcon({
  name,
  filled = false,
}: {
  name: keyof typeof iconPaths;
  filled?: boolean;
}) {
  return (
    <svg
      className="size-4 shrink-0 align-middle"
      viewBox="0 0 24 24"
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={iconPaths[name]} />
    </svg>
  );
}

export function BoardLikeButton({
  item,
  write,
  busy = false,
  onLike,
  onError,
  className,
}: {
  item: BoardLike & { id: string };
  write: BoardWrite;
  busy?: boolean;
  onLike: (id: string, like: BoardLike) => void;
  onError: (reason: string | null) => void;
  className?: string;
}) {
  const account = useAccount();
  const [optimistic, setOptimistic] = useState<BoardLike | null>(null);
  const { liked, likeCount } = optimistic ?? item;
  const pending = busy || optimistic !== null;

  function toggleLike() {
    if (pending) return;
    const reason =
      account.error ??
      (!account.user
        ? "いいねするにはログインしてください。"
        : account.user.isGuest
          ? "いいねにはアカウント登録が必要です。"
          : !account.user.profileCompleted
            ? "プロフィールの初回設定を完了するといいねできます。"
            : null);
    onError(reason);
    if (reason) return;
    void write(async (signal) => {
      const fallback = "いいねを更新できませんでした。";
      setOptimistic({ liked: !liked, likeCount: Math.max(0, likeCount + (liked ? -1 : 1)) });
      try {
        const response = await boardRequest(
          `${boardPostPath(item.id)}/like`,
          { method: liked ? "DELETE" : "PUT", signal },
          fallback,
        );
        const like = boardLikeResultSchema.parse(await response.json());
        signal.throwIfAborted();
        onLike(item.id, like);
      } catch (error) {
        onError(mutationError(error, fallback));
      } finally {
        setOptimistic(null);
      }
    });
  }

  return (
    <AppButton
      appearance={liked ? "secondary" : "quiet"}
      size="compact"
      className={`${reactionClasses} ${className ?? ""}`}
      aria-label="いいね"
      aria-pressed={liked}
      aria-disabled={pending || undefined}
      onPress={toggleLike}
    >
      <ReactionIcon name="heart" filled={liked} />
      {likeCount}
    </AppButton>
  );
}

export function BoardReplyCount({ count, to }: { count: number; to?: string }) {
  const content = (
    <>
      <span aria-hidden="true" className={`inline-flex items-center ${reactionClasses}`}>
        <ReactionIcon name="reply" />
        {count}
      </span>
      <span className="sr-only">返信 {count} 件</span>
    </>
  );
  return to ? (
    <Link to={to} className="inline-flex rounded-control no-underline hover:underline">
      {content}
    </Link>
  ) : (
    <span className="inline-flex">{content}</span>
  );
}
