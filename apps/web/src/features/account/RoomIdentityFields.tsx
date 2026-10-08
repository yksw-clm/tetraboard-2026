import type { GameId } from "@tetraboard/protocol/games";
import { AppAvatar } from "../../shared/ui/AppAvatar";
import { AppButton } from "../../shared/ui/AppButton";
import { AppTextField } from "../../shared/ui/AppTextField";
import { useAccount } from "./useAccount";
import { RegistrationPrompt } from "./RegistrationPrompt";

export function RoomIdentityFields({
  name,
  onChange,
  busy,
  id,
  registration,
}: {
  name: string;
  onChange: (name: string) => void;
  busy: boolean;
  id?: string;
  registration?: { game?: GameId; humanOnly: boolean; onRegister: () => void; isPending?: boolean };
}) {
  const account = useAccount();
  if (account.loading && !account.error)
    return (
      <p role="status" className="text-muted text-sm">
        ログイン状態を確認しています…
      </p>
    );
  if (account.error)
    return (
      <div className="flex flex-col gap-2">
        <p role="alert" className="text-danger text-sm">
          {account.error}
        </p>
        <AppButton
          appearance="secondary"
          size="compact"
          isDisabled={account.loading}
          isPending={account.pendingSource === "identity-retry"}
          onPress={() => void account.refresh("identity-retry")}
        >
          再試行
        </AppButton>
      </div>
    );
  if (account.user)
    return (
      <div className="flex items-center gap-3 min-w-0" aria-label="参加するアカウント">
        <AppAvatar src={account.user.avatarUrl} label={account.user.name} />
        <div className="min-w-0">
          <strong className="block wrap-anywhere">{account.user.name}</strong>
          <p className="text-muted text-xs">このアカウントで参加します。</p>
        </div>
      </div>
    );
  return (
    <div className="flex flex-col gap-3">
      <AppTextField value={name} onChange={onChange} isDisabled={busy}>
        <AppTextField.Label>ニックネーム</AppTextField.Label>
        <AppTextField.Input id={id} autoFocus autoComplete="nickname" placeholder="例：てとら" />
        <AppTextField.Description>
          1〜10文字。ユーザー登録は必要ありません。
        </AppTextField.Description>
      </AppTextField>
      {registration && (
        <RegistrationPrompt
          game={registration.game}
          humanOnly={registration.humanOnly}
          busy={busy}
          onRegister={registration.onRegister}
          isPending={registration.isPending}
        />
      )}
    </div>
  );
}
