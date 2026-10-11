import type { GameId } from "@tetraboard/protocol/games";
import { roomRecruitmentIntent } from "@tetraboard/protocol/room-sharing";
import { AppDialog } from "../../shared/ui/AppDialog";
import { AppButton, AppButtonLink } from "../../shared/ui/AppButton";
import { AppIcon } from "../../shared/ui/AppIcon";
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

function XIcon() {
  return (
    <svg
      aria-hidden="true"
      width="18"
      height="18"
      viewBox="0 0 24 24"
      className="shrink-0"
      fill="currentColor"
    >
      <path d="M18.9 2H22l-6.8 7.8L23.2 22h-6.3L12 14.6 5.5 22H2.3l7.2-8.4L1.8 2h6.5l4.5 6.7L18.9 2ZM17.8 20h1.7L7.2 3.9H5.4L17.8 20Z" />
    </svg>
  );
}
