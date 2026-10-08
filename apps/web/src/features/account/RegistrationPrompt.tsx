import type { SocialProvider } from "./useSocialSignIn";
import { defaultGameId, type GameId } from "@tetraboard/protocol/games";
import { RegistrationBenefits, RegistrationBadgeExamples } from "./RegistrationBenefits";
import { SocialSignInButtons } from "./SocialSignInButtons";
import { AppButton } from "../../shared/ui/AppButton";

export function RegistrationPrompt({
  game = defaultGameId,
  humanOnly,
  seated = false,
  result = false,
  busy,
  pendingProvider = null,
  onRegister,
  onDismiss,
}: {
  game?: GameId;
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
        {result ? "これからの対局で、バッジを集めよう" : "登録して、対局の成果を残そう"}
      </h2>
      <RegistrationBenefits />
      <RegistrationBadgeExamples game={game} />
      {!humanOnly && (
        <p className="m-0 text-xs text-muted">
          CPUを含む対局は、戦績・ランキング・バッジの対象外です。
        </p>
      )}
      {result && (
        <p className="m-0 text-xs leading-relaxed text-muted">
          今回のゲスト対局は、登録後の戦績・バッジ・本人の対局履歴には引き継がれません。
        </p>
      )}
      {seated && (
        <p className="text-xs text-muted">
          この部屋の席はゲストのままです。記録を残すには、登録後にアカウントで参加し直してください。
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <SocialSignInButtons busy={busy} pendingProvider={pendingProvider} onSignIn={onRegister} />
        {onDismiss && (
          <AppButton appearance="secondary" size="compact" isDisabled={busy} onPress={onDismiss}>
            今はしない
          </AppButton>
        )}
      </div>
    </section>
  );
}
