import { AppButton } from "../../shared/ui/AppButton";
import { AppTextField } from "../../shared/ui/AppTextField";
import { AppDialog } from "../../shared/ui/AppDialog";
import { type useRoomInvitation } from "./useRoomInvitation";

export function RoomInvitationDialogs({
  invitation,
  roomId,
}: {
  invitation: ReturnType<typeof useRoomInvitation>;
  roomId: string;
}) {
  if (invitation.dialog === "copy")
    return (
      <AppDialog size="compact" title="招待リンク" onClose={invitation.close}>
        <div className="flex flex-col gap-3 min-w-0">
          <p>リンクを選択してコピーし、友達に送ってください。</p>
          <AppTextField isReadOnly value={invitation.invitationUrl}>
            <AppTextField.Label>招待リンク</AppTextField.Label>
            <AppTextField.Input autoFocus onFocus={(event) => event.currentTarget.select()} />
          </AppTextField>
          <AppButton appearance="secondary" size="compact" onPress={invitation.close}>
            閉じる
          </AppButton>
        </div>
      </AppDialog>
    );
  if (invitation.dialog !== "join") return null;
  return (
    <AppDialog
      size="compact"
      title={`ルーム ${roomId} に参加`}
      busy={invitation.busy}
      onClose={invitation.close}
    >
      <form
        className="flex flex-col gap-3 min-w-0"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void invitation.submit();
        }}
      >
        <p>対局で使うニックネームを入力してください。</p>
        <AppTextField
          value={invitation.name}
          onChange={invitation.setName}
          isDisabled={invitation.busy}
        >
          <AppTextField.Label>ニックネーム</AppTextField.Label>
          <AppTextField.Input autoFocus autoComplete="nickname" placeholder="例：てとら" />
          <AppTextField.Description>
            1〜10文字。ユーザー登録は必要ありません。
          </AppTextField.Description>
        </AppTextField>
        {(invitation.message || invitation.unavailableReason) && (
          <p className="text-danger text-xs" role="alert">
            {invitation.message ?? invitation.unavailableReason}
          </p>
        )}
        <div className="flex justify-end gap-[10px] mt-[22px]">
          <AppButton
            appearance="secondary"
            size="compact"
            isDisabled={invitation.busy}
            onPress={invitation.close}
          >
            観戦する
          </AppButton>
          <AppButton
            type="submit"
            size="compact"
            isDisabled={invitation.busy || invitation.unavailableReason !== null}
          >
            {invitation.busy ? "参加中…" : "参加する"}
          </AppButton>
        </div>
      </form>
    </AppDialog>
  );
}
