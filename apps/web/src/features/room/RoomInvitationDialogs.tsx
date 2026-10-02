import { AppButton } from "../../shared/ui/AppButton";
import { AppTextField } from "../../shared/ui/AppTextField";
import { RoomDialog } from "./RoomDialog";
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
      <RoomDialog title="招待リンク" onClose={invitation.close}>
        <div className="room-entry-form">
          <p>リンクを選択してコピーし、友達に送ってください。</p>
          <AppTextField isReadOnly value={invitation.invitationUrl}>
            <AppTextField.Label>招待リンク</AppTextField.Label>
            <AppTextField.Input autoFocus onFocus={(event) => event.currentTarget.select()} />
          </AppTextField>
          <AppButton appearance="secondary" size="compact" onPress={invitation.close}>
            閉じる
          </AppButton>
        </div>
      </RoomDialog>
    );
  if (invitation.dialog !== "join") return null;
  return (
    <RoomDialog title={`ルーム ${roomId} に参加`} busy={invitation.busy} onClose={invitation.close}>
      <form
        className="room-entry-form"
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
          <p className="room-error" role="alert">
            {invitation.message ?? invitation.unavailableReason}
          </p>
        )}
        <div className="room-dialog-actions">
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
    </RoomDialog>
  );
}
