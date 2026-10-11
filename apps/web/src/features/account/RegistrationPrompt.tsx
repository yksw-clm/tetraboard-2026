import { gameCatalog } from "@tetraboard/protocol/games";
import type { SocialProvider } from "./useSocialSignIn";
import { defaultGameId, type GameId } from "@tetraboard/protocol/games";
import { RegistrationBenefits, RegistrationBadgeExamples } from "./RegistrationBenefits";
import { SocialSignInButtons } from "./SocialSignInButtons";
import { AppButton } from "../../shared/ui/AppButton";

export function RegistrationPrompt({
  game = defaultGameId,
  showConsent = true,
  humanOnly,
  seated = false,
  result = false,
  busy,
  pendingProvider = null,
  onRegister,
  onDismiss,
}: {
  game?: GameId;
  showConsent?: boolean;
  humanOnly: boolean;
  seated?: boolean;
  result?: boolean;
  busy: boolean;
  pendingProvider?: SocialProvider | null;
  onRegister: (provider: SocialProvider) => void;
  onDismiss?: () => void;
}) {
  return (
    <section
      aria-label="ユーザー登録のご案内"
      className="flex flex-col gap-3 rounded-control border border-solid border-line bg-surface-muted p-3 text-sm"
    >
      <h2 className="m-0 text-base font-bold">
        {result && gameCatalog[game].hasModes
          ? "これからの対局で、バッジを集めよう"
          : "登録して、対局の成果を残そう"}
      </h2>
      <RegistrationBenefits game={game} />
      <RegistrationBadgeExamples game={game} />
      {!humanOnly && (
        <p className="m-0 text-xs text-muted">
          {!gameCatalog[game].hasModes
            ? "CPUを含む対局は、戦績・ランキングの対象外です。"
            : "CPUを含む対局は、戦績・ランキング・バッジの対象外です。"}
        </p>
      )}
      {result && (
        <p className="m-0 text-xs leading-relaxed text-muted">
          {!gameCatalog[game].hasModes
            ? "今回のゲスト対局は、登録後の戦績・本人の対局履歴には引き継がれません。"
            : "今回のゲスト対局は、登録後の戦績・バッジ・本人の対局履歴には引き継がれません。"}
        </p>
      )}
      {seated && (
        <p className="text-xs text-muted">
          この部屋の席はゲストのままです。記録を残すには、登録後にアカウントで参加し直してください。
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <SocialSignInButtons
          showConsent={showConsent}
          busy={busy}
          pendingProvider={pendingProvider}
          onSignIn={onRegister}
        />
        {onDismiss && (
          <AppButton appearance="secondary" size="compact" isDisabled={busy} onPress={onDismiss}>
            今はしない
          </AppButton>
        )}
      </div>
    </section>
  );
}
