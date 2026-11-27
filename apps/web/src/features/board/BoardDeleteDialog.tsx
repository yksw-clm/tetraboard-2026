import type { GameId } from "@tetraboard/protocol/games";
import { useState } from "react";
import { AppButton } from "../../shared/ui/AppButton";
import { AppDialog } from "../../shared/ui/AppDialog";
import { gameThemes } from "../../shared/ui/appTheme";
import { boardPostApiPath, boardRequest, mutationError } from "./boardApi";
import type { BoardWrite } from "./useBoardData";

export type BoardDeleteActions = {
  busy: boolean;
  write: BoardWrite;
  onRemove: (id: string, signal: AbortSignal) => Promise<void>;
};

export function BoardDeleteDialog({
  id,
  game,
  reply = false,
  busy,
  write,
  onRemove,
  onClose,
}: BoardDeleteActions & { id: string; game: GameId; reply?: boolean; onClose: () => void }) {
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const type = reply ? "返信" : "投稿";

  function remove() {
    if (busy || deleting) return;
    void write(async (signal) => {
      const fallback = `${type}を削除できませんでした。`;
      setDeleting(true);
      setError(null);
      try {
        await boardRequest(boardPostApiPath(id), { method: "DELETE", signal }, fallback);
        signal.throwIfAborted();
        await onRemove(id, signal);
        onClose();
      } catch (error) {
        setError(mutationError(error, fallback));
      } finally {
        setDeleting(false);
      }
    });
  }

  return (
    <AppDialog
      title={`${type}を削除しますか？`}
      size="compact"
      theme={gameThemes[game]}
      busy={deleting}
      onClose={onClose}
      footer={
        <div className="flex flex-wrap gap-2">
          <AppButton appearance="secondary" isDisabled={deleting} onPress={onClose}>
            キャンセル
          </AppButton>
          <AppButton appearance="danger" isPending={deleting} isDisabled={busy} onPress={remove}>
            削除する
          </AppButton>
        </div>
      }
    >
      <p>削除すると元に戻せません。</p>
      {error && (
        <p role="alert" className="text-danger">
          {error}
        </p>
      )}
    </AppDialog>
  );
}
