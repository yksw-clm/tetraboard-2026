import { boardLikeResultSchema, type BoardPost, type BoardReply } from "@tetraboard/protocol/board";
import type { GameId } from "@tetraboard/protocol/games";
import { lazy, Suspense, useState } from "react";
import { Link } from "react-router";
import { AppAvatar } from "../../shared/ui/AppAvatar";
import { AppButton } from "../../shared/ui/AppButton";
import { AppCard } from "../../shared/ui/AppCard";
import { AppDialog } from "../../shared/ui/AppDialog";
import { gameThemes } from "../../shared/ui/appTheme";
import { useAccount } from "../account/useAccount";
import { formatMatchDate } from "../matches/matchDatePresentation";
import { PlayerProfileTrigger } from "../players/PlayerProfileTrigger";
import { BoardBody, boardLinkClasses } from "./BoardBody";
import type { BoardWrite } from "./useBoardData";
import { boardPostPath, boardRequest, mutationError } from "./boardApi";

const BoardReportDialog = lazy(() => import("./BoardReportDialog"));

type Like = Pick<BoardReply, "liked" | "likeCount">;

const exactTime = new Intl.DateTimeFormat("ja-JP", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

function BoardTime({ ms, relativeTo }: { ms: number; relativeTo?: number }) {
  const date = new Date(ms);
  const iso = Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  const exact = iso ? exactTime.format(date) : "";
  return (
    <time className="text-xs text-muted" dateTime={iso} title={exact}>
      {relativeTo !== undefined && iso ? formatMatchDate(ms, relativeTo) : exact}
    </time>
  );
}

type EntryActions = {
  busy: boolean;
  write: BoardWrite;
  onLike: (id: string, like: Like) => void;
  onRemove: (id: string, signal: AbortSignal) => Promise<void>;
};

function BoardEntryActions({
  item,
  reply,
  game,
  busy,
  write,
  onLike,
  onRemove,
}: EntryActions & { item: BoardReply; reply: boolean; game: GameId }) {
  const account = useAccount();
  const [optimistic, setOptimistic] = useState<Like | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [reportOpen, setReportOpen] = useState(false);
  const [reportNotice, setReportNotice] = useState<string | null>(null);
  const { liked, likeCount } = optimistic ?? item;
  const path = boardPostPath(item.id);
  const type = reply ? "返信" : "投稿";

  function openReport() {
    const reason = account.error ?? (!account.user ? "通報するにはログインしてください。" : null);
    setError(reason);
    setReportNotice(null);
    if (!reason) setReportOpen(true);
  }

  function toggleLike() {
    if (busy || optimistic) return;
    const reason =
      account.error ??
      (!account.user
        ? "いいねするにはログインしてください。"
        : account.user.isGuest
          ? "いいねにはアカウント登録が必要です。"
          : !account.user.profileCompleted
            ? "プロフィールの初回設定を完了するといいねできます。"
            : null);
    setError(reason);
    if (reason) return;
    void write(async (signal) => {
      const fallback = "いいねを更新できませんでした。";
      setOptimistic({ liked: !liked, likeCount: Math.max(0, likeCount + (liked ? -1 : 1)) });
      try {
        const response = await boardRequest(
          path + "/like",
          { method: liked ? "DELETE" : "PUT", signal },
          fallback,
        );
        const like = boardLikeResultSchema.parse(await response.json());
        signal.throwIfAborted();
        onLike(item.id, like);
      } catch (error) {
        setError(mutationError(error, fallback));
      } finally {
        setOptimistic(null);
      }
    });
  }

  function remove() {
    if (busy || deleting) return;
    void write(async (signal) => {
      const fallback = `${type}を削除できませんでした。`;
      setDeleting(true);
      setDeleteError(null);
      try {
        await boardRequest(path, { method: "DELETE", signal }, fallback);
        signal.throwIfAborted();
        await onRemove(item.id, signal);
        setConfirm(false);
      } catch (error) {
        setDeleteError(mutationError(error, fallback));
      } finally {
        setDeleting(false);
      }
    });
  }

  return (
    <div className="grid gap-1">
      <div className="flex flex-wrap items-center gap-2">
        <AppButton
          appearance={liked ? "secondary" : "quiet"}
          size="compact"
          aria-label="いいね"
          aria-pressed={liked}
          aria-disabled={busy || undefined}
          onPress={toggleLike}
        >
          <span aria-hidden="true">{liked ? "♥" : "♡"}</span>
          {likeCount}
        </AppButton>
        {item.own && (
          <AppButton
            appearance="quiet"
            size="compact"
            isDisabled={busy}
            onPress={() => {
              setDeleteError(null);
              setConfirm(true);
            }}
          >
            削除
          </AppButton>
        )}
        {!item.own && (
          <AppButton appearance="quiet" size="compact" isDisabled={busy} onPress={openReport}>
            通報
          </AppButton>
        )}
      </div>
      {reportNotice && (
        <p className="text-sm" role="status">
          {reportNotice}
        </p>
      )}
      {error && (
        <p className="text-sm text-danger" role="alert">
          {error}
        </p>
      )}
      {confirm && (
        <AppDialog
          title={`${type}を削除しますか？`}
          size="compact"
          theme={gameThemes[game]}
          busy={deleting}
          onClose={() => setConfirm(false)}
          footer={
            <div className="flex flex-wrap gap-2">
              <AppButton
                appearance="secondary"
                isDisabled={deleting}
                onPress={() => setConfirm(false)}
              >
                キャンセル
              </AppButton>
              <AppButton
                appearance="danger"
                isPending={deleting}
                isDisabled={busy}
                onPress={remove}
              >
                削除する
              </AppButton>
            </div>
          }
        >
          <p>削除すると元に戻せません。</p>
          {deleteError && (
            <p role="alert" className="text-danger">
              {deleteError}
            </p>
          )}
        </AppDialog>
      )}
      {reportOpen && (
        <Suspense fallback={<p role="status">通報画面を読み込んでいます…</p>}>
          <BoardReportDialog
            path={path}
            type={type}
            theme={gameThemes[game]}
            busy={busy}
            write={write}
            onClose={() => setReportOpen(false)}
            onReported={(message) => {
              setReportNotice(message);
              setReportOpen(false);
            }}
          />
        </Suspense>
      )}
    </div>
  );
}

export function BoardEntry({
  item,
  game,
  timeline = false,
  serverTimeMs,
  ...actions
}: EntryActions & {
  item: BoardPost | BoardReply;
  game: GameId;
  timeline?: boolean;
  serverTimeMs: number;
}) {
  const post = "status" in item ? item : null;
  const detailPath = timeline ? boardPostPath(item.id) : undefined;
  const time = (
    <BoardTime ms={item.postedAtMs} relativeTo={timeline || !post ? serverTimeMs : undefined} />
  );
  const replies =
    post &&
    (detailPath ? (
      <Link to={detailPath} className={boardLinkClasses}>
        返信 {post.replyCount}
      </Link>
    ) : (
      <span className="text-sm text-muted">返信 {post.replyCount}</span>
    ));

  return (
    <article className="min-w-0">
      <AppCard className="min-w-0 gap-3 wrap-anywhere">
        {"status" in item && item.status === "deleted" ? (
          <>
            <p className="font-semibold text-muted">削除された投稿</p>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
              {time}
              {replies}
            </div>
          </>
        ) : (
          <>
            <header className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
              <PlayerProfileTrigger
                target={item.author.profileTarget}
                label={item.author.name}
                game={game}
                mode="singles"
                theme={gameThemes[game]}
                className="flex min-w-0 max-w-full items-center gap-2"
              >
                <AppAvatar src={item.author.avatarUrl} />
                <span className="min-w-0 font-semibold wrap-anywhere">{item.author.name}</span>
              </PlayerProfileTrigger>
              {time}
            </header>
            <BoardBody text={item.text} detailPath={detailPath} />
            {replies}
            <BoardEntryActions {...actions} item={item} game={game} reply={!post} />
          </>
        )}
      </AppCard>
    </article>
  );
}
