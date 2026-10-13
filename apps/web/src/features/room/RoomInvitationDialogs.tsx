import { publicRecordNotice } from "@tetraboard/protocol/privacy";
import { LegalNotice } from "../privacy/LegalNotice";
import { PrivacyLinks } from "../privacy/PrivacyLinks";
import { RoomIdentityFields } from "../account/RoomIdentityFields";
import { useAccount } from "../account/useAccount";
import { AppButton } from "../../shared/ui/AppButton";
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
  const busy = invitation.busy;
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
        <p className="text-sm text-muted">
          {publicRecordNotice} 本名・連絡先は名前に入力しないでください。
        </p>
        <RoomIdentityFields name={invitation.name} onChange={invitation.setName} busy={busy} />

        {(invitation.message || invitation.unavailableReason) && (
          <p className="text-danger text-xs" role="alert">
            {invitation.message ?? invitation.unavailableReason}
          </p>
        )}
        <LegalNotice />
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
        <PrivacyLinks newTab />
      </form>
    </AppDialog>
  );
}
