import { gameCatalog } from "@tetraboard/protocol/games";
import type { SocialProvider } from "./useSocialSignIn";
import { defaultGameId, type GameId } from "@tetraboard/protocol/games";
import { RegistrationBenefits, RegistrationBadgeExamples } from "./RegistrationBenefits";
import { SocialSignInButtons } from "./SocialSignInButtons";
import { AppButton } from "../../shared/ui/AppButton";

export function RegistrationPrompt({
  game = defaultGameId,
  humanOnly,
  busy,
  pendingProvider = null,
  onRegister,
  onDismiss,
}: {
  game?: GameId;
  humanOnly: boolean;
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
      <h2 className="m-0 text-base font-bold">この対局を、自分の記録に残そう</h2>
      <p className="m-0 text-sm leading-relaxed">
        {humanOnly
          ? "登録・ログインすると、この対局の戦績と棋譜がマイページに追加されます。"
          : "登録・ログインすると、この対局の棋譜がマイページに追加されます。"}
        そのまま同じ席で、アカウントとして再戦できます。
      </p>
      <RegistrationBenefits game={game} />
      <RegistrationBadgeExamples game={game} />
      {!humanOnly && (
        <p className="m-0 text-xs text-muted">
          {!gameCatalog[game].hasModes
            ? "CPUを含む対局は、戦績・ランキングの対象外です。"
            : "CPUを含む対局は、戦績・ランキング・バッジの対象外です。"}
        </p>
      )}
      <p className="m-0 text-xs leading-relaxed text-muted">
        席は最初の登録開始から10分間保持します。対局の引継ぎは開始から1時間以内で、やり直しても期限は延びません。
        公開棋譜の名前・画像も、登録プロフィールの現在の表示に変わります。
      </p>
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
