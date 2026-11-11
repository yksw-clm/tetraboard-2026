import { LegalNotice } from "../privacy/LegalNotice";
import { PrivacyLinks } from "../privacy/PrivacyLinks";
import {
  avatarPresets,
  avatarPresetUrl,
  countCharacters,
  gameCatalog,
  gameIds,
  type AccountProfile,
} from "@tetraboard/protocol";
import { AppAvatar } from "../../shared/ui/AppAvatar";
import { AppButton } from "../../shared/ui/AppButton";
import { AppTextField } from "../../shared/ui/AppTextField";
import { AppIcon } from "../../shared/ui/AppIcon";
import { useProfileDraft } from "./useProfileDraft";
import { cn } from "@heroui/react";
import { LobbyBoardPreview } from "../lobby/LobbyBoardPreview";
import { gameAccentClasses, type AppTheme } from "../../shared/ui/appTheme";
import { useEffect, useState, type KeyboardEvent } from "react";
import { beginRegistrationEntry } from "../../analytics/registrationAnalytics";
import { AccountLinkDialog } from "./AccountLinkDialog";
export function ProfileForm({
  user,
  setup,
  onSaved,
  onBusyChange,
  theme = "default",
}: {
  user: AccountProfile;
  setup: boolean;
  onSaved?: (profile: AccountProfile) => void;
  onBusyChange?: (busy: boolean) => void;
  theme?: AppTheme;
}) {
  const [linkFeature, setLinkFeature] = useState<string | null>(null);
  const [linkBusy, setLinkBusy] = useState(false);
  const {
    name,
    setName,
    username,
    setUsername,
    submitted,
    nameInvalid,
    usernameInvalid,
    profileMessage,
    setProfileMessage,
    profileMessageInvalid,
    favoriteGames,
    toggleFavoriteGame,
    fileInput,
    busy: draftBusy,
    processing,
    saving,
    error,
    image,
    selectImage,
    submit,
    removeImage,
    selectPreset,
    selectedPresetId,
    canRemoveImage,
    saveBeforeLink,
  } = useProfileDraft({ user, setup, onSaved });
  const busy = draftBusy || linkBusy;
  useEffect(() => {
    onBusyChange?.(busy);
    return () => onBusyChange?.(false);
  }, [busy, onBusyChange]);
  function requireLink(feature: string) {
    if (!busy && user.isGuest) {
      beginRegistrationEntry("profile-edit");
      setLinkFeature(feature);
    }
  }
  function requireLinkOnKey(event: KeyboardEvent<HTMLInputElement>, feature: string) {
    if (user.isGuest && (event.key === "Enter" || event.key === " ")) {
      event.preventDefault();
      requireLink(feature);
    }
  }
  return (
    <>
      <form
        onSubmit={(e) => {
          if (linkBusy) e.preventDefault();
          else void submit(e);
        }}
        noValidate
        className="flex flex-col gap-6"
      >
        <div className="flex flex-col items-center gap-3">
          <div className="relative size-24">
            <AppAvatar
              src={image}
              label="アイコンのプレビュー"
              className="size-24 [&_svg]:size-10"
            />
            <AppButton
              type="button"
              appearance="quiet"
              aria-label="アイコン画像を選択"
              className="absolute left-1/2 top-1/2 size-11 min-h-11 -translate-x-1/2 -translate-y-1/2 rounded-full border-0 bg-black/50 p-0 text-white enabled:hover:bg-black/65 enabled:hover:text-white data-[hovered=true]:bg-black/65 data-[hovered=true]:text-white"
              isDisabled={busy}
              aria-haspopup={user.isGuest ? "dialog" : undefined}
              onPress={() =>
                user.isGuest ? requireLink("画像のアップロード") : fileInput.current?.click()
              }
            >
              <AppIcon name="camera" className="size-6" />
            </AppButton>
          </div>
          <fieldset className="flex max-w-full flex-col items-center gap-2" disabled={busy}>
            <legend className="mb-2 text-center text-sm">プリセットから選ぶ</legend>
            <div className="flex flex-wrap justify-center gap-2">
              {avatarPresets.map((preset) => (
                <AppButton
                  key={preset.id}
                  type="button"
                  appearance="quiet"
                  aria-label={preset.name}
                  aria-pressed={selectedPresetId === preset.id}
                  isDisabled={busy}
                  onPress={() => selectPreset(preset.id)}
                  className="relative size-14 min-h-14 rounded-full p-1 aria-pressed:border-2 aria-pressed:border-brand"
                >
                  <AppAvatar src={avatarPresetUrl(preset.id)} label="" className="size-11" />
                  {selectedPresetId === preset.id && (
                    <span
                      aria-hidden="true"
                      className="absolute -right-1 -bottom-1 grid size-5 place-items-center rounded-full bg-brand text-xs text-white"
                    >
                      ✓
                    </span>
                  )}
                </AppButton>
              ))}
            </div>
          </fieldset>
          <p className="text-center text-xs text-muted">
            アイコンの変更はプロフィールの保存で反映されます。
          </p>
          {canRemoveImage && (
            <AppButton
              type="button"
              appearance="quiet"
              size="compact"
              isDisabled={busy || !image}
              onPress={() => (user.isGuest ? requireLink("画像の削除") : removeImage())}
            >
              アップロード画像を削除
            </AppButton>
          )}
          {!user.isGuest && (
            <input
              ref={fileInput}
              type="file"
              className="sr-only"
              tabIndex={-1}
              aria-label="アイコン画像"
              accept="image/jpeg,image/png,image/webp"
              disabled={busy}
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void selectImage(file);
              }}
            />
          )}
          <p className="text-center text-xs text-muted">
            JPEG・PNG・WebP、5MB以下。中央を正方形に切り抜きます。
            <br />
            変更・削除はプロフィールの保存で反映されます。
          </p>
          {processing && (
            <p role="status" className="text-sm text-muted">
              画像を読み込んでいます…
            </p>
          )}
        </div>
        <AppTextField name="name" isInvalid={submitted && nameInvalid} isDisabled={busy}>
          <AppTextField.Label>名前</AppTextField.Label>
          <AppTextField.Input
            value={name}
            onChange={(event) => {
              setName(event.target.value);
            }}
            autoComplete="nickname"
          />
          <AppTextField.Description>
            1〜10文字。前後の空白は除きます。
            {user.isGuest && "本名・連絡先は入力しないでください。"}
          </AppTextField.Description>
          <AppTextField.Error>名前は1〜10文字で入力してください。</AppTextField.Error>
        </AppTextField>
        <AppTextField
          name="username"
          isInvalid={submitted && usernameInvalid}
          isDisabled={busy}
          isReadOnly={user.isGuest}
        >
          <AppTextField.Label>
            ID（@ID）
            {user.isGuest && <AppIcon name="lock" className="ml-1 inline-block size-3.5" />}
          </AppTextField.Label>
          <AppTextField.Input
            value={user.isGuest && username ? `@${username}` : username}
            onChange={user.isGuest ? undefined : (event) => setUsername(event.target.value)}
            onClick={user.isGuest ? () => requireLink("IDの変更") : undefined}
            onKeyDown={(event) => requireLinkOnKey(event, "IDの変更")}
            aria-haspopup={user.isGuest ? "dialog" : undefined}
            autoComplete={user.isGuest ? undefined : "username"}
            autoCapitalize="none"
            spellCheck={false}
            className="read-only:cursor-pointer read-only:bg-surface-muted"
          />
          <AppTextField.Description>
            {user.isGuest
              ? "画像アップロード・ID変更・ひとこと・お気に入りゲームの設定には、GoogleまたはDiscordとの連携が必要です。"
              : "英数字・_の3〜20文字。大文字は小文字になり、@を付けて表示します。他の人と同じIDは使えません。"}
          </AppTextField.Description>
          <AppTextField.Error>IDは英数字・_の3〜20文字で入力してください。</AppTextField.Error>
        </AppTextField>
        <AppTextField
          name="profileMessage"
          isInvalid={submitted && profileMessageInvalid}
          isDisabled={busy}
          isReadOnly={user.isGuest}
        >
          <AppTextField.Label>
            ひとこと（任意）
            {user.isGuest && <AppIcon name="lock" className="ml-1 inline-block size-3.5" />}
          </AppTextField.Label>
          <AppTextField.Input
            value={profileMessage}
            onChange={user.isGuest ? undefined : (event) => setProfileMessage(event.target.value)}
            onClick={user.isGuest ? () => requireLink("ひとことの設定") : undefined}
            onKeyDown={(event) => requireLinkOnKey(event, "ひとことの設定")}
            aria-haspopup={user.isGuest ? "dialog" : undefined}
            className="read-only:cursor-pointer read-only:bg-surface-muted"
            placeholder="よろしくお願いします！"
          />
          <AppTextField.Description>
            プロフィールカードに公開されます。改行なし・30文字以内。
            {user.isGuest && " GoogleまたはDiscordとの連携で設定できます。"}
            <span className="mt-1 block tabular-nums">
              {countCharacters(profileMessage.trim())} / 30文字
            </span>
          </AppTextField.Description>
          <AppTextField.Error>
            ひとことは改行なしの30文字以内で入力してください。
          </AppTextField.Error>
        </AppTextField>
        <fieldset disabled={busy} className="flex min-w-0 flex-col gap-2">
          <legend className="mb-2 text-[13px] font-semibold">
            お気に入りゲーム（任意）
            {user.isGuest && <AppIcon name="lock" className="ml-1 inline-block size-3.5" />}
          </legend>
          <div
            aria-label="お気に入りゲームの選択"
            role="group"
            className="grid grid-cols-2 gap-2 [@media(max-width:359px)]:grid-cols-1"
          >
            {gameIds.map((game) => {
              const selected = favoriteGames.includes(game);
              return (
                <AppButton
                  key={game}
                  type="button"
                  appearance="secondary"
                  size="compact"
                  className={cn(
                    gameAccentClasses[game],
                    "min-h-12 w-full min-w-0 justify-start gap-1.5 border-2 border-transparent bg-[color-mix(in_srgb,var(--game-accent)_8%,white)] px-2 text-[var(--game-accent)] shadow-none aria-pressed:border-[var(--game-accent)] [&:hover:not(:disabled)]:border-[var(--game-accent)] [&:hover:not(:disabled)]:bg-[color-mix(in_srgb,var(--game-accent)_12%,white)] data-[hovered=true]:border-[var(--game-accent)] data-[hovered=true]:bg-[color-mix(in_srgb,var(--game-accent)_12%,white)] disabled:opacity-75 data-[disabled=true]:opacity-75",
                  )}
                  aria-pressed={selected}
                  aria-haspopup={user.isGuest ? "dialog" : undefined}
                  isDisabled={busy || (!selected && favoriteGames.length >= 3)}
                  onPress={() =>
                    user.isGuest ? requireLink("お気に入りゲームの設定") : toggleFavoriteGame(game)
                  }
                >
                  <LobbyBoardPreview game={game} compact className="!w-6 !rotate-0 !shadow-none" />
                  <span className="min-w-0 flex-1 whitespace-normal text-left">
                    {gameCatalog[game].name}
                  </span>
                  {selected ? (
                    <AppIcon name="check" className="size-3.5 shrink-0" />
                  ) : (
                    <span aria-hidden="true" className="size-3.5 shrink-0" />
                  )}
                </AppButton>
              );
            })}
          </div>
          <p className="text-xs text-muted">
            3つまで選べます。プロフィールカードに公開されます。
            {user.isGuest && " GoogleまたはDiscordとの連携で設定できます。"}
          </p>
        </fieldset>
        {setup && <LegalNotice />}
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        <AppButton
          type="submit"
          isDisabled={busy}
          isPending={saving}
          className={setup ? undefined : "self-end"}
        >
          {setup ? "プロフィールを作成" : "保存"}
        </AppButton>
        {setup && <PrivacyLinks newTab />}
      </form>
      {linkFeature && (
        <AccountLinkDialog
          analyticsEntry="profile-edit"
          feature={linkFeature}
          theme={theme}
          beforeSignIn={saveBeforeLink}
          beforeSignInNotice="編集中の名前とアイコンを保存してから連携します。"
          cancelLabel="編集に戻る"
          onBusyChange={setLinkBusy}
          onClose={() => setLinkFeature(null)}
        />
      )}
    </>
  );
}
