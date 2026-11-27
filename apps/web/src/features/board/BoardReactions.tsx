import { boardLikeResultSchema, type BoardReply } from "@tetraboard/protocol/board";
import { useState, type PointerEvent } from "react";
import { Link, useLocation } from "react-router";
import { boardPagePathPattern } from "../../shared/siteNavigation";
import { registrationPath } from "../account/registrationReturn";
import { useAccount } from "../account/useAccount";
import { boardPostPath, boardRequest, mutationError } from "./boardApi";
import { boardTimelineReturnPath, readBoardAttachmentSearch } from "./boardAttachmentSearch";
import { BoardLinkDialog } from "./BoardLinkDialog";
import type { BoardWrite } from "./useBoardData";

export type BoardLike = Pick<BoardReply, "liked" | "likeCount">;

const reactionClasses = "inline-flex items-center gap-1 text-xs";
const reactionControlClasses = `${reactionClasses} group/reaction -my-1 min-h-11 min-w-11 cursor-pointer justify-center rounded-control px-2 focus-visible:outline-3 focus-visible:outline-focus focus-visible:outline-offset-2`;
const iconPaths = {
  heart: "M12 20 4.5 12.5a4.5 4.5 0 0 1 6.4-6.4L12 7.2l1.1-1.1a4.5 4.5 0 0 1 6.4 6.4L12 20Z",
  reply: "M21 11a8 8 0 0 1-8 8H8l-5 3V11a9 9 0 0 1 18 0Z",
};

type ReactionPointerEvent = PointerEvent<HTMLButtonElement | HTMLAnchorElement>;

function clearTouchPress({ currentTarget, pointerId }: ReactionPointerEvent) {
  if (currentTarget.dataset.touchPressed === String(pointerId)) {
    delete currentTarget.dataset.touchPressed;
  }
}

const reactionTouchHandlers = {
  onPointerDown({ currentTarget, isPrimary, pointerId, pointerType }: ReactionPointerEvent) {
    // タッチの :active に頼らず、押下表示をポインターの寿命に合わせます。
    if (pointerType === "touch" && isPrimary)
      currentTarget.dataset.touchPressed = String(pointerId);
  },
  onPointerUp: clearTouchPress,
  onPointerCancel: clearTouchPress,
  onLostPointerCapture: clearTouchPress,
  onPointerLeave: clearTouchPress,
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
      className="pointer-events-none size-5 shrink-0 align-middle motion-safe:transition-transform motion-safe:duration-100 motion-safe:group-hover/reaction:scale-110 motion-safe:group-active/reaction:scale-90 motion-safe:group-data-[touch-pressed]/reaction:scale-90"
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
  const { pathname, search } = useLocation();
  const [linkPath, setLinkPath] = useState<string | null>(null);
  const [optimistic, setOptimistic] = useState<BoardLike | null>(null);
  const { liked, likeCount } = optimistic ?? item;
  const pending = busy || optimistic !== null;
  const canLink = !account.error && (account.user ? account.user.isGuest : !account.loading);
  const path = registrationPath(pathname.replace(/\/$/, "") || "/");
  const returnPath =
    path && boardPagePathPattern.exec(path)?.[1]
      ? boardTimelineReturnPath(path, readBoardAttachmentSearch(new URLSearchParams(search)))
      : path;
  const showLink = linkPath !== null && linkPath === returnPath && canLink;
  if (linkPath && !showLink) setLinkPath(null);

  function toggleLike() {
    if (pending || showLink) return;
    const reason =
      account.error ??
      (account.user && !account.user.isGuest && !account.user.profileCompleted
        ? "プロフィールの初回設定を完了するといいねできます。"
        : null);
    onError(reason);
    if (reason) return;
    if (!account.user || account.user.isGuest) {
      if (canLink) setLinkPath(returnPath);
      return;
    }
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
    <>
      <button
        type="button"
        className={`${reactionControlClasses} border-0 bg-transparent aria-disabled:cursor-default ${liked ? "text-danger" : "text-ink-secondary"} ${className ?? ""}`}
        aria-label="いいね"
        aria-pressed={liked}
        aria-disabled={pending || undefined}
        {...reactionTouchHandlers}
        onClick={toggleLike}
      >
        <ReactionIcon name="heart" filled={liked} />
        {likeCount}
      </button>
      {showLink && (
        <BoardLinkDialog destination={{ path: linkPath }} onClose={() => setLinkPath(null)} />
      )}
    </>
  );
}

export function BoardReplyCount({ count, detailPath }: { count: number; detailPath?: string }) {
  const content = (
    <>
      <ReactionIcon name="reply" />
      <span aria-hidden="true">{count}</span>
      <span className="sr-only">返信 {count} 件</span>
    </>
  );
  return detailPath ? (
    <Link
      to={detailPath}
      className={`${reactionControlClasses} relative z-10 text-ink-secondary no-underline`}
      {...reactionTouchHandlers}
    >
      {content}
    </Link>
  ) : (
    <span className={`${reactionClasses} text-ink-secondary`}>{content}</span>
  );
}
