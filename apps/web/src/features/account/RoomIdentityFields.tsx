import { guestStorageNotice } from "./guestAccount";
import { AppAvatar } from "../../shared/ui/AppAvatar";
import { AppButton } from "../../shared/ui/AppButton";
import { AppTextField } from "../../shared/ui/AppTextField";
import { useAccount } from "./useAccount";
import { avatarPresets, avatarPresetUrl, type AvatarPresetId } from "@tetraboard/protocol";
import { Tooltip } from "@heroui/react";
import { useState } from "react";
import { AppIcon } from "../../shared/ui/AppIcon";
import { randomGuestAvatar } from "./guestAvatar";

export function RoomIdentityFields({
  name,
  onChange,
  busy,
  id,
  avatarPresetId,
  onAvatarChange,
}: {
  name: string;
  onChange: (name: string) => void;
  busy: boolean;
  id?: string;
  avatarPresetId?: AvatarPresetId;
  onAvatarChange?: (preset: AvatarPresetId) => void;
}) {
  const account = useAccount();
  const [announcement, setAnnouncement] = useState("");
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
  if (account.user && (!account.user.isGuest || account.user.nameCustomized))
    return (
      <div className="flex items-center gap-3 min-w-0" aria-label="参加するアカウント">
        <AppAvatar src={account.user.avatarUrl} label={account.user.name} />
        <div className="min-w-0">
          <strong className="block wrap-anywhere">{account.user.name}</strong>
          <p className="text-muted text-xs">
            {account.user.isGuest ? "ゲスト" : "このアカウントで参加します。"}
          </p>
        </div>
      </div>
    );
  return (
    <div className="flex flex-col gap-3">
      <div className="flex min-w-0 items-center gap-3">
        {avatarPresetId && onAvatarChange && (
          <div className="relative shrink-0 pr-2 pb-2">
            <AppAvatar
              src={avatarPresetUrl(avatarPresetId)}
              label={avatarPresets.find((preset) => preset.id === avatarPresetId)!.name}
              className="size-14"
            />
            <Tooltip>
              <AppButton
                type="button"
                appearance="quiet"
                aria-label="アイコンをランダムに変更"
                isDisabled={busy}
                className="absolute -right-1 -bottom-1 size-11 min-h-11 rounded-full p-0"
                onPress={() => {
                  const next = randomGuestAvatar(avatarPresetId);
                  onAvatarChange(next);
                  setAnnouncement(
                    `${avatarPresets.find((preset) => preset.id === next)!.name}に変更しました。`,
                  );
                }}
              >
                <span className="grid size-7 place-items-center rounded-full border border-solid border-line bg-white shadow-panel">
                  <AppIcon name="shuffle" className="size-4" />
                </span>
              </AppButton>
              <Tooltip.Content>アイコンをランダムに変更</Tooltip.Content>
            </Tooltip>
          </div>
        )}
        <AppTextField value={name} onChange={onChange} isDisabled={busy} className="flex-1">
          <AppTextField.Label>ニックネーム</AppTextField.Label>
          <AppTextField.Input id={id} autoFocus autoComplete="nickname" placeholder="例：てとら" />
          <AppTextField.Description>1〜10文字</AppTextField.Description>
        </AppTextField>
      </div>
      {avatarPresetId && (
        <p className="text-xs text-muted">アイコンは後からマイページで変更できます。</p>
      )}
      <span role="status" aria-live="polite" className="sr-only">
        {announcement}
      </span>
      <p className="text-xs text-muted">{guestStorageNotice}</p>
    </div>
  );
}
