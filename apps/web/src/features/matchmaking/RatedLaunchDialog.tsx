import { useId, useState } from "react";
import { useNavigate } from "react-router";
import type { RatedMatchmakingGame } from "@tetraboard/protocol";
import { gameCatalog } from "@tetraboard/protocol/games";
import { AppDialog } from "../../shared/ui/AppDialog";
import { AppButton } from "../../shared/ui/AppButton";
import { gameThemes } from "../../shared/ui/appTheme";
import { lastLobbyGame } from "../../shared/lastLobbyGame";
import { useAccount } from "../account/useAccount";
import { SocialSignInButtons } from "../account/SocialSignInButtons";
import { useSocialSignIn } from "../account/useSocialSignIn";
import { matchmakingPath } from "./paths";

export function RatedLaunchDialog({
  games,
  game,
  onClose,
}: {
  games: readonly RatedMatchmakingGame[];
  game?: RatedMatchmakingGame;
  onClose: () => void;
}) {
  const gamesLabelId = useId();
  const account = useAccount();
  const navigate = useNavigate();
  const [selected, setSelected] = useState<RatedMatchmakingGame>(() => {
    const preferred = game ?? lastLobbyGame.getSnapshot();
    return games.find((value) => value === preferred) ?? games[0]!;
  });
  const registered = Boolean(account.user && !account.user.isGuest);
  const signIn = useSocialSignIn("rated-match", selected);
  const unavailable = account.loading || Boolean(account.error);
  return (
    <AppDialog
      title="レート戦が開幕しました！"
      theme={gameThemes[selected]}
      busy={signIn.busy}
      onClose={onClose}
    >
      <div className="flex flex-col gap-4">
        <div className="space-y-2 text-sm leading-relaxed">
          <p>24時間いつでも、近いレートのプレイヤーと対局できます。</p>
          <p>プレイヤーが集まらないときは、近い強さのCPUとも対局できます。</p>
          <p>
            各ゲームで最初の認定戦5局を終えると、初回レートが公開されます。その後は対局結果に応じてレートが変わります。
          </p>
        </div>
        <div role="group" aria-labelledby={gamesLabelId}>
          <p id={gamesLabelId} className="mb-2 text-sm font-bold">
            対応ゲーム
          </p>
          <div className="grid grid-cols-2 gap-2">
            {games.map((value) => (
              <AppButton
                key={value}
                className="min-h-11 w-full min-w-0 px-2 whitespace-normal"
                appearance={selected === value ? "primary" : "secondary"}
                aria-pressed={selected === value}
                isDisabled={signIn.busy}
                onPress={() => setSelected(value)}
              >
                {gameCatalog[value].name}
              </AppButton>
            ))}
          </div>
        </div>
        <p className="text-sm font-bold">
          {registered
            ? "さっそくレート戦に参加しましょう！"
            : "アカウントを連携して、レート戦に参加しましょう！"}
        </p>
        {registered ? (
          <AppButton
            className="min-h-11 w-full"
            isDisabled={unavailable}
            onPress={() => {
              onClose();
              void navigate(
                account.user?.profileCompleted ? matchmakingPath(selected) : "/account/setup",
                { state: { matchmakingFromLobby: true } },
              );
            }}
          >
            レート戦に参加する
          </AppButton>
        ) : (
          <SocialSignInButtons
            busy={signIn.busy || unavailable}
            pendingProvider={signIn.pendingProvider}
            consentBelowButtons
            layout="vertical"
            onSignIn={(provider) =>
              void signIn.start(provider, { path: matchmakingPath(selected) })
            }
          />
        )}
        {(signIn.message || account.error) && (
          <p role="alert" className="text-sm text-danger">
            {signIn.message ?? account.error}
          </p>
        )}
        <AppButton
          appearance="secondary"
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
