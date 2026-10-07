import { RoomIdentityFields } from "../account/RoomIdentityFields";
import { useAccount } from "../account/useAccount";
import { AppButton } from "../../shared/ui/AppButton";
import { AppTextField } from "../../shared/ui/AppTextField";
import { AppDialog } from "../../shared/ui/AppDialog";
import { type useRoomInvitation } from "./useRoomInvitation";
import { type AppTheme } from "../../shared/ui/appTheme";
import { useGoogleSignIn } from "../account/useGoogleSignIn";

export function RoomInvitationDialogs({
  invitation,
  roomId,
  theme = "default",
  registrationPath,
  humanOnly,
}: {
  invitation: ReturnType<typeof useRoomInvitation>;
  roomId: string;
  theme?: AppTheme;
  registrationPath: string;
  humanOnly: boolean;
}) {
  const account = useAccount();
  const google = useGoogleSignIn();
  const busy = invitation.busy || google.busy;
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
      busy={busy}
      onClose={invitation.close}
      theme={theme}
    >
      <form
        className="flex flex-col gap-3 min-w-0"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          if (busy) return;
          void invitation.submit();
        }}
      >
        <RoomIdentityFields
          name={invitation.name}
          onChange={invitation.setName}
          busy={busy}
          registration={{
            isPending: google.busy,
            humanOnly,
            onRegister: () =>
              void google.start({ path: registrationPath, joinName: invitation.name }),
          }}
        />
        {google.message && (
          <p role="alert" className="text-sm text-danger">
            {google.message}
          </p>
        )}
        {(invitation.message || invitation.unavailableReason) && (
          <p className="text-danger text-xs" role="alert">
            {invitation.message ?? invitation.unavailableReason}
          </p>
        )}
        <div className="flex justify-end gap-[10px] mt-[22px]">
          <AppButton
            appearance="secondary"
            size="compact"
            isDisabled={busy}
            onPress={invitation.close}
          >
            観戦する
          </AppButton>
          <AppButton
            type="submit"
            size="compact"
            isPending={invitation.busy}
            isDisabled={
              busy ||
              invitation.unavailableReason !== null ||
              account.loading ||
              Boolean(account.error)
            }
          >
            参加する
          </AppButton>
        </div>
      </form>
    </AppDialog>
  );
}
