import { RoomIdentityFields } from "../account/RoomIdentityFields";
import { useAccount } from "../account/useAccount";
import { AppButton } from "../../shared/ui/AppButton";
import { AppTextField } from "../../shared/ui/AppTextField";
import { AppDialog } from "../../shared/ui/AppDialog";
import { type useRoomInvitation } from "./useRoomInvitation";
import { type AppTheme } from "../../shared/ui/appTheme";

export function RoomInvitationDialogs({
  invitation,
  roomId,
  theme = "default",
}: {
  invitation: ReturnType<typeof useRoomInvitation>;
  roomId: string;
  theme?: AppTheme;
}) {
  const account = useAccount();
  if (invitation.dialog === "copy")
    return (
      <AppDialog size="compact" title="招待リンク" onClose={invitation.close} theme={theme}>
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
      theme={theme}
    >
      <form
        className="flex flex-col gap-3 min-w-0"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void invitation.submit();
        }}
      >
        <RoomIdentityFields
          name={invitation.name}
          onChange={invitation.setName}
          busy={invitation.busy}
        />
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
            isDisabled={
              invitation.busy ||
              invitation.unavailableReason !== null ||
              account.loading ||
              Boolean(account.error)
            }
          >
            {invitation.busy ? "参加中…" : "参加する"}
          </AppButton>
        </div>
      </form>
    </AppDialog>
  );
}
