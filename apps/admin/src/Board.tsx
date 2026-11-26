import {
  boardAdminSchema,
  boardPostIdSchema,
  boardReportReasonLabels,
  type BoardAdminReport,
  type BoardModeration,
} from "@tetraboard/protocol/board";
import { gameCatalog } from "@tetraboard/protocol/games";
import { useState } from "react";
import { adminMutation } from "./api";
import { Button } from "./components/ui/button";
import { Card } from "./components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./components/ui/dialog";
import { Input } from "./components/ui/input";
import { useAdminData } from "./useAdminData";

const boardApi = "/api/admin/board";
const parseBoard = (input: unknown) => boardAdminSchema.parse(input);

type Operate = (input: BoardModeration, label: string) => void;

function reportPostId(value: string) {
  const trimmed = value.trim();
  if (!trimmed.startsWith("/") && !/^https?:\/\//i.test(trimmed)) return trimmed;
  try {
    const url = new URL(trimmed, window.location.origin);
    return url.pathname.match(/^\/posts\/([^/]+)$/)?.[1] ?? "";
  } catch {
    return "";
  }
}

function BoardOperationById({ operate, disabled }: { operate: Operate; disabled: boolean }) {
  const [value, setValue] = useState("");
  const id = boardPostIdSchema.safeParse(reportPostId(value));
  const invalid = value.trim().length > 0 && !id.success;

  return (
    <Card className="gap-3 p-5">
      <h2 className="text-lg font-bold">ID で操作</h2>
      <label className="grid gap-2">
        投稿の ID または URL
        <Input
          value={value}
          onChange={(event) => setValue(event.target.value)}
          aria-invalid={invalid || undefined}
        />
      </label>
      {invalid && <p role="alert">投稿の ID または URL を確認してください。</p>}
      <div className="flex flex-wrap gap-2">
        <Button
          disabled={disabled || !id.success}
          onClick={() => id.success && operate({ action: "delete", postId: id.data }, "投稿を削除")}
        >
          削除
        </Button>
        <Button
          disabled={disabled || !id.success}
          onClick={() =>
            id.success &&
            operate({ action: "stop", postId: id.data, stopped: true }, "投稿者を投稿停止")
          }
        >
          投稿者を投稿停止
        </Button>
      </div>
    </Card>
  );
}

function ReportRow({
  report,
  disabled,
  operate,
}: {
  report: BoardAdminReport;
  disabled: boolean;
  operate: Operate;
}) {
  const { postId, parentId, authorStopped, authorWithdrawn, postDeleted, moderatorDeletedAtMs } =
    report;
  const stopLabel = authorStopped ? "投稿停止を解除" : "投稿者を投稿停止";
  return (
    <article className="grid min-w-0 gap-2 border-b border-border py-3">
      <p>
        通報日時 {new Date(report.reportedAtMs).toLocaleString("ja")} ·{" "}
        {boardReportReasonLabels[report.reason]} · {report.reportCount} 件 ·{" "}
        {report.status === "open" ? "未対応" : "対応済み"}
      </p>
      <p>
        {gameCatalog[report.gameId].name} · {parentId ? "返信" : "投稿"} · {report.authorName} ·
        投稿日時 {new Date(report.postedAtMs).toLocaleString("ja")}
        {postDeleted && " · 削除済み"}
        {moderatorDeletedAtMs !== null &&
          ` · 運営が削除 ${new Date(moderatorDeletedAtMs).toLocaleString("ja")}`}
      </p>
      <p className="whitespace-pre-wrap wrap-anywhere">{report.text}</p>
      <a
        href={`/posts/${parentId ?? postId}`}
        className="justify-self-start text-primary underline"
        target="_blank"
        rel="noreferrer"
      >
        公開ページを開く
      </a>
      <div className="flex flex-wrap gap-2">
        {!postDeleted && (
          <Button
            disabled={disabled}
            onClick={() => operate({ action: "delete", postId }, "投稿を削除")}
          >
            投稿を削除
          </Button>
        )}
        {!authorWithdrawn && (
          <Button
            disabled={disabled}
            onClick={() => operate({ action: "stop", postId, stopped: !authorStopped }, stopLabel)}
          >
            {stopLabel}
          </Button>
        )}
        {report.status === "open" && (
          <Button
            disabled={disabled}
            onClick={() => operate({ action: "resolve", reportId: report.id }, "対応済みにする")}
          >
            対応済みにする
          </Button>
        )}
      </div>
    </article>
  );
}

export function Board() {
  const page = useAdminData(boardApi, parseBoard);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<{
    input: BoardModeration;
    label: string;
  } | null>(null);

  function operate(input: BoardModeration, label: string) {
    setError(null);
    setConfirmation({ input, label });
  }

  async function execute(input: BoardModeration) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await adminMutation(boardApi, "POST", input);
      setConfirmation(null);
      page.refresh();
    } catch (error) {
      setError(error instanceof Error ? error.message : "変更できませんでした。");
    } finally {
      setBusy(false);
    }
  }

  const disabled = busy || page.loading;
  const data = page.data;
  const acceptingLabel = data?.acceptingPosts ? "受付を停止" : "受付を再開";

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-bold">掲示板</h1>
      <p className="text-sm text-muted-foreground">掲示板の投稿停止は公開チャットとは別です。</p>
      {page.error && <p role="alert">{page.error}</p>}
      {page.loading && <p role="status">読み込んでいます…</p>}
      <Button disabled={disabled} onClick={page.refresh}>
        更新・再試行
      </Button>
      {data && (
        <>
          <Card className="gap-3 p-5">
            <h2 className="text-lg font-bold">投稿受付</h2>
            <p>{data.acceptingPosts ? "受付中" : "停止中"}</p>
            <Button
              disabled={disabled}
              onClick={() =>
                operate({ action: "accepting", accepting: !data.acceptingPosts }, acceptingLabel)
              }
            >
              {acceptingLabel}
            </Button>
          </Card>
          <Card className="gap-3 p-5">
            <h2 className="text-lg font-bold">通報（7日以内）</h2>
            {data.reports.length === 0 && <p>通報はありません。</p>}
            {data.reports.map((report) => (
              <ReportRow key={report.id} report={report} disabled={disabled} operate={operate} />
            ))}
          </Card>
          <BoardOperationById operate={operate} disabled={disabled} />
          <Card className="gap-3 p-5">
            <h2 className="text-lg font-bold">投稿停止中のアカウント</h2>
            {data.stoppedSenders.length === 0 && <p>投稿停止中のアカウントはありません。</p>}
            {data.stoppedSenders.map(({ accountId, name }) => (
              <div key={accountId} className="flex items-center justify-between gap-3">
                <span className="wrap-anywhere">{name}</span>
                <Button
                  disabled={disabled}
                  onClick={() => operate({ action: "unstop", accountId }, "投稿停止を解除")}
                >
                  解除
                </Button>
              </div>
            ))}
          </Card>
        </>
      )}
      <Dialog
        open={confirmation !== null}
        onOpenChange={(open, details) => {
          if (busy) details.cancel();
          else if (!open) setConfirmation(null);
        }}
      >
        {confirmation && (
          <DialogContent aria-modal="true" showCloseButton={!busy}>
            <DialogHeader>
              <DialogTitle>操作の確認</DialogTitle>
              <DialogDescription>
                選択した操作（{confirmation.label}）を実行しますか？
              </DialogDescription>
            </DialogHeader>
            {error && (
              <p role="alert" className="text-destructive">
                {error}
              </p>
            )}
            <DialogFooter>
              <Button
                variant="destructive"
                disabled={busy}
                aria-busy={busy}
                onClick={() => void execute(confirmation.input)}
              >
                実行
              </Button>
              <Button disabled={busy} onClick={() => setConfirmation(null)}>
                取り消す
              </Button>
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>
    </div>
  );
}
