import {
  boardReportReasonLabels,
  boardReportReasons,
  type BoardReportReason,
} from "@tetraboard/protocol/board";
import { useId, useState } from "react";
import { AppButton } from "../../shared/ui/AppButton";
import { AppDialog } from "../../shared/ui/AppDialog";
import type { AppTheme } from "../../shared/ui/appTheme";
import { boardRequest, mutationError } from "./boardApi";
import type { BoardWrite } from "./useBoardData";

export default function BoardReportDialog({
  path,
  type,
  theme,
  busy,
  write,
  onClose,
  onReported,
}: {
  path: string;
  type: "投稿" | "返信";
  theme: AppTheme;
  busy: boolean;
  write: BoardWrite;
  onClose: () => void;
  onReported: (message: string) => void;
}) {
  const radioGroup = useId();
  const [reason, setReason] = useState<BoardReportReason | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function report() {
    if (!reason || busy) return;
    void write(async (signal) => {
      const fallback = "通報できませんでした。";
      setSending(true);
      setError(null);
      try {
        const response = await boardRequest(
          path + "/reports",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ reason }),
            signal,
          },
          fallback,
        );
        const result: unknown = await response.json();
        signal.throwIfAborted();
        if (
          !result ||
          typeof result !== "object" ||
          !("message" in result) ||
          typeof result.message !== "string"
        )
          throw new Error(fallback);
        onReported(result.message);
      } catch (error) {
        setError(mutationError(error, fallback));
      } finally {
        setSending(false);
      }
    });
  }

  return (
    <AppDialog
      title={`${type}を通報`}
      size="compact"
      theme={theme}
      busy={sending}
      onClose={onClose}
      footer={
        <div className="flex flex-wrap gap-2">
          <AppButton appearance="secondary" isDisabled={sending} onPress={onClose}>
            キャンセル
          </AppButton>
          <AppButton isPending={sending} isDisabled={busy || !reason} onPress={report}>
            通報する
          </AppButton>
        </div>
      }
    >
      <p className="text-sm">この{type}を運営に通報しますか？理由を1つ選んでください。</p>
      <fieldset disabled={sending} className="mt-2 grid gap-1">
        <legend className="sr-only">通報の理由</legend>
        {boardReportReasons.map((value) => (
          <label key={value} className="flex min-h-8 items-center gap-2">
            <input
              type="radio"
              name={radioGroup}
              value={value}
              checked={reason === value}
              onChange={() => setReason(value)}
            />
            {boardReportReasonLabels[value]}
          </label>
        ))}
      </fieldset>
      {error && (
        <p role="alert" className="text-danger">
          {error}
        </p>
      )}
    </AppDialog>
  );
}
