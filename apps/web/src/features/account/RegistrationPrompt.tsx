import { AppButton } from "../../shared/ui/AppButton";

export function RegistrationPrompt({
  humanOnly,
  seated = false,
  result = false,
  busy,
  onRegister,
  onDismiss,
}: {
  humanOnly: boolean;
  seated?: boolean;
  result?: boolean;
  busy: boolean;
  onRegister: () => void;
  onDismiss?: () => void;
}) {
  return (
    <section
      aria-label="ユーザー登録のご案内"
      className="flex flex-col gap-3 rounded-control border border-solid border-line bg-surface-muted p-3 text-sm"
    >
      {result && <h2 className="text-base font-bold">棋譜をマイページに残そう</h2>}
      <p>アカウントで参加した対局は、あとから棋譜を振り返れます。</p>
      {humanOnly && (
        <p className="text-xs text-muted">
          戦績・ランキングにも参加できます。集計はCPUを含まない対人戦のみです。
        </p>
      )}
      {seated && (
        <p className="text-xs text-muted">
          この部屋の席はゲストのままです。記録を残すには、登録後にアカウントで参加し直してください。
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <AppButton size="compact" isDisabled={busy} onPress={onRegister}>
          {busy ? "Googleへ移動しています…" : "Googleで登録・ログイン"}
        </AppButton>
        {onDismiss && (
          <AppButton appearance="secondary" size="compact" isDisabled={busy} onPress={onDismiss}>
            今はしない
          </AppButton>
        )}
      </div>
    </section>
  );
}
