import type { GameId } from "@tetraboard/protocol/games";
import { AppButton, AppButtonLink } from "../../shared/ui/AppButton";
import { AppDialog } from "../../shared/ui/AppDialog";
import { gameThemes } from "../../shared/ui/appTheme";
import { SocialSignInButtons } from "../account/SocialSignInButtons";
import { useAccount } from "../account/useAccount";
import { useSocialSignIn } from "../account/useSocialSignIn";
import { boardTimelinePath } from "../board/boardApi";

export function BoardLaunchDialog({
  game,
  onClose,
  onDisplay,
}: {
  game: GameId;
  onClose: () => void;
  onDisplay?: (content: HTMLDivElement | null) => void;
}) {
  const { user } = useAccount();
  const signIn = useSocialSignIn("account-link", game);
  const path = boardTimelinePath(game);

  return (
    <AppDialog
      title="掲示板を公開しました！"
      theme={gameThemes[game]}
      busy={signIn.busy}
      onClose={onClose}
    >
      <div ref={onDisplay} data-board-launch-dialog className="flex flex-col gap-4">
        <div className="space-y-2 text-sm leading-relaxed">
          <p>対局の感想や質問を投稿したり、棋譜の気になった局面を添付したりできます。</p>
          <p>掲示板はどなたでも読めます。投稿や返信にはアカウント連携が必要です。</p>
        </div>
        {user && !user.isGuest ? (
          <AppButtonLink
            appearance="primary"
            className="min-h-11 w-full"
            to={path}
            onClick={onClose}
          >
            さっそく投稿してみる
          </AppButtonLink>
        ) : (
          <div className="flex flex-col gap-2">
            <p className="text-sm font-semibold">ユーザー登録をして投稿してみる</p>
            <SocialSignInButtons
              busy={signIn.busy}
              pendingProvider={signIn.pendingProvider}
              consentBelowButtons
              layout="vertical"
              onSignIn={(provider) => void signIn.start(provider, { path })}
            />
          </div>
        )}
        {signIn.message && (
          <p role="alert" className="text-sm text-danger">
            {signIn.message}
          </p>
        )}
        <AppButton
          appearance="quiet"
          className="min-h-11 w-full"
          isDisabled={signIn.busy}
          onPress={onClose}
        >
          あとで
        </AppButton>
      </div>
    </AppDialog>
  );
}
