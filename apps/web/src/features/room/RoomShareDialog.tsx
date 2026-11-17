import type { GameId } from "@tetraboard/protocol/games";
import { roomRecruitmentIntent } from "@tetraboard/protocol/room-sharing";
import { AppDialog } from "../../shared/ui/AppDialog";
import { AppButton, AppButtonLink } from "../../shared/ui/AppButton";
import { AppIcon } from "../../shared/ui/AppIcon";
import { XIcon } from "../../shared/ui/XIcon";
import { AppTextField } from "../../shared/ui/AppTextField";
import type { AppTheme } from "../../shared/ui/appTheme";
import type { useRoomInvitation } from "./useRoomInvitation";

export function RoomShareDialog({
  game,
  invitation,
  theme,
  onCopied,
}: {
  game: GameId;
  invitation: ReturnType<typeof useRoomInvitation>;
  theme: AppTheme;
  onCopied: () => void;
}) {
  return (
    <AppDialog size="compact" title="ルームを共有" onClose={invitation.close} theme={theme}>
      <div className="flex min-w-0 flex-col gap-4">
        <p className="text-sm text-ink-secondary">
          リンクを送って友達を招待したり、Xで対戦相手を募集できます。
        </p>
        <AppTextField isReadOnly value={invitation.invitationUrl}>
          <AppTextField.Label>ルームURL</AppTextField.Label>
          <AppTextField.Input onFocus={(event) => event.currentTarget.select()} />
        </AppTextField>
        {invitation.copyError && (
          <p className="text-xs text-danger" role="alert">
            {invitation.copyError}
          </p>
        )}
        <AppButton
          className="w-full"
          isDisabled={invitation.copying}
          isPending={invitation.copying}
          onPress={() => void invitation.copy(onCopied)}
        >
          <AppIcon name="copy" />
          ルームURLをコピー
        </AppButton>
        {invitation.recruitmentUnavailable ? (
          <AppButton appearance="secondary" className="w-full" isDisabled>
            <XIcon />
            Xで対戦相手を募集
          </AppButton>
        ) : (
          <AppButtonLink
            to={roomRecruitmentIntent(game, invitation.invitationUrl)}
            target="_blank"
            rel="noopener noreferrer"
            className="w-full"
          >
            <XIcon />
            Xで対戦相手を募集
          </AppButtonLink>
        )}
        {invitation.recruitmentUnavailable && (
          <p className="text-xs text-muted" role="status">
            {invitation.recruitmentUnavailable}
          </p>
        )}
      </div>
    </AppDialog>
  );
}
