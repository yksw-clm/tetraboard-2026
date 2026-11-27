import type { BoardPost, BoardReply } from "@tetraboard/protocol/board";
import type { GameId } from "@tetraboard/protocol/games";
import { lazy, Suspense, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { AppButton } from "../../shared/ui/AppButton";
import { AppCard } from "../../shared/ui/AppCard";
import { AppDialog } from "../../shared/ui/AppDialog";
import { gameThemes } from "../../shared/ui/appTheme";
import { useAccount } from "../account/useAccount";
import { formatMatchDate } from "../matches/matchDatePresentation";
import { BoardBody } from "./BoardBody";
import { BoardAttachment } from "./BoardAttachment";
import { BoardAuthor } from "./BoardAuthor";
import { BoardLikeButton, BoardReplyCount, type BoardLike } from "./BoardReactions";
import type { BoardWrite } from "./useBoardData";
import { boardPostPath, boardRequest, mutationError } from "./boardApi";

const BoardReportDialog = lazy(() => import("./BoardReportDialog"));

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
  onLike: (id: string, like: BoardLike) => void;
  onRemove: (id: string, signal: AbortSignal) => Promise<void>;
};

function BoardEntryActions({
  item,
  reply,
  replies,
  game,
  busy,
  write,
  onLike,
  onRemove,
}: EntryActions & { item: BoardReply; reply: boolean; replies: ReactNode; game: GameId }) {
  const account = useAccount();
  const [confirm, setConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [reportOpen, setReportOpen] = useState(false);
  const [reportNotice, setReportNotice] = useState<string | null>(null);
  const path = boardPostPath(item.id);
  const type = reply ? "返信" : "投稿";

  function openReport() {
    const reason = account.error ?? (!account.user ? "通報するにはログインしてください。" : null);
    setError(reason);
    setReportNotice(null);
    if (!reason) setReportOpen(true);
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
        {replies}
        <BoardLikeButton
          item={item}
          busy={busy}
          write={write}
          onLike={onLike}
          onError={setError}
          className="relative z-10"
        />
        {item.own && (
          <AppButton
            appearance="quiet"
            size="compact"
            className="relative z-10 ml-auto"
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
          <AppButton
            appearance="quiet"
            size="compact"
            className="relative z-10 ml-auto"
            isDisabled={busy}
            onPress={openReport}
          >
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
  const timestamp = detailPath ? (
    <Link
      to={detailPath}
      className="no-underline before:absolute before:inset-0 before:z-[1] before:rounded-panel focus-visible:outline-none focus-visible:before:outline-3 focus-visible:before:outline-focus focus-visible:before:outline-offset-2"
    >
      <span className="sr-only">投稿の詳細 </span>
      {time}
    </Link>
  ) : (
    time
  );
  const replies = post && <BoardReplyCount count={post.replyCount} />;

  return (
    <article className="min-w-0">
      <AppCard
        density="compact"
        className={`min-w-0 wrap-anywhere ${timeline ? "relative isolate" : ""}`}
      >
        {"status" in item && item.status === "deleted" ? (
          <>
            <p className="font-semibold text-muted">削除された投稿</p>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
              {timestamp}
              {replies}
            </div>
          </>
        ) : (
          <>
            <header className="flex flex-wrap items-center justify-between gap-2">
              <BoardAuthor author={item.author} game={game} />
              {timestamp}
            </header>
            <BoardBody text={item.text} detailPath={detailPath} />
            {item.attachment && <BoardAttachment {...item.attachment} />}
            <BoardEntryActions
              {...actions}
              item={item}
              game={game}
              reply={!post}
              replies={replies}
            />
          </>
        )}
      </AppCard>
    </article>
  );
}
