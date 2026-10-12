import { LegalNotice } from "../privacy/LegalNotice";
import { PrivacyLinks } from "../privacy/PrivacyLinks";
import { type AccountProfile } from "@tetraboard/protocol";
import { AppAvatar } from "../../shared/ui/AppAvatar";
import { AppButton } from "../../shared/ui/AppButton";
import { AppTextField } from "../../shared/ui/AppTextField";
import { AppIcon } from "../../shared/ui/AppIcon";
import { useProfileDraft } from "./useProfileDraft";
export function ProfileForm({
  user,
  setup,
  onSaved,
  onBusyChange,
}: {
  user: AccountProfile;
  setup: boolean;
  onSaved?: (profile: AccountProfile) => void;
  onBusyChange?: (busy: boolean) => void;
}) {
  const {
    name,
    setName,
    username,
    setUsername,
    submitted,
    nameInvalid,
    usernameInvalid,
    fileInput,
    busy,
    processing,
    saving,
    error,
    image,
    selectImage,
    submit,
    removeImage,
  } = useProfileDraft({ user, setup, onSaved, onBusyChange });
  return (
    <form onSubmit={(e) => void submit(e)} noValidate className="flex flex-col gap-6">
      <div className="flex flex-col items-center gap-3">
        <div className="relative size-24">
          <AppAvatar src={image} label="アイコンのプレビュー" className="size-24 [&_svg]:size-10" />
          <AppButton
            type="button"
            appearance="quiet"
            aria-label="アイコン画像を選択"
            className="absolute left-1/2 top-1/2 size-11 min-h-11 -translate-x-1/2 -translate-y-1/2 rounded-full border-0 bg-black/50 p-0 text-white enabled:hover:bg-black/65 enabled:hover:text-white data-[hovered=true]:bg-black/65 data-[hovered=true]:text-white"
            isDisabled={busy}
            onPress={() => fileInput.current?.click()}
          >
            <AppIcon name="camera" className="size-6" />
          </AppButton>
        </div>
        {image && (
          <AppButton
            type="button"
            appearance="quiet"
            size="compact"
            isDisabled={busy || !image}
            onPress={removeImage}
          >
            アイコンを削除
          </AppButton>
        )}
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
        <AppTextField.Description>1〜10文字。前後の空白は除きます。</AppTextField.Description>
        <AppTextField.Error>名前は1〜10文字で入力してください。</AppTextField.Error>
      </AppTextField>
      <AppTextField name="username" isInvalid={submitted && usernameInvalid} isDisabled={busy}>
        <AppTextField.Label>ID（@ID）</AppTextField.Label>
        <AppTextField.Input
          value={username}
          onChange={(event) => {
            setUsername(event.target.value);
          }}
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
        />
        <AppTextField.Description>
          英数字・_の3〜20文字。大文字は小文字になり、@を付けて表示します。他の人と同じIDは使えません。
        </AppTextField.Description>
        <AppTextField.Error>IDは英数字・_の3〜20文字で入力してください。</AppTextField.Error>
      </AppTextField>
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
  );
}
