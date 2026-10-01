import { Button, Description, Input, Label, TextField } from "@heroui/react";
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
          <TextField className="room-entry-field" isReadOnly value={invitation.invitationUrl}>
            <Label>招待リンク</Label>
            <Input autoFocus onFocus={(event) => event.currentTarget.select()} />
          </TextField>
          <Button className="room-button room-button-secondary" onPress={invitation.close}>
            閉じる
          </Button>
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
        <TextField
          className="room-entry-field"
          value={invitation.name}
          onChange={invitation.setName}
          isDisabled={invitation.busy}
        >
          <Label>ニックネーム</Label>
          <Input autoFocus autoComplete="nickname" placeholder="例：てとら" />
          <Description>1〜10文字。ユーザー登録は必要ありません。</Description>
        </TextField>
        {(invitation.message || invitation.unavailableReason) && (
          <p className="room-error" role="alert">
            {invitation.message ?? invitation.unavailableReason}
          </p>
        )}
        <div className="room-dialog-actions">
          <Button
            className="room-button room-button-secondary"
            isDisabled={invitation.busy}
            onPress={invitation.close}
          >
            観戦する
          </Button>
          <Button
            type="submit"
            className="room-button room-button-primary"
            isDisabled={invitation.busy || invitation.unavailableReason !== null}
          >
            {invitation.busy ? "参加中…" : "参加する"}
          </Button>
        </div>
      </form>
    </RoomDialog>
  );
}
