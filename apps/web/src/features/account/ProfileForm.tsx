import { useEffect, useRef, useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { countCharacters, usernameSchema, type AccountProfile } from "@tetraboard/protocol";
import { AppAvatar } from "../../shared/ui/AppAvatar";
import { AppButton } from "../../shared/ui/AppButton";
import { AppTextField } from "../../shared/ui/AppTextField";
import { useAccount } from "./useAccount";
import { convertAvatar, saveProfile } from "./accountApi";
export function ProfileForm({ user, setup }: { user: AccountProfile; setup: boolean }) {
  const { update } = useAccount();
  const navigate = useNavigate();
  const [name, setName] = useState(user.name);
  const [username, setUsername] = useState(user.username ?? "");
  const [avatar, setAvatar] = useState<Blob | null>(null);
  const [avatarAction, setAvatarAction] = useState<"keep" | "replace" | "remove">("keep");
  const [preview, setPreview] = useState<string | null>(null);
  const [processing, setProcessing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const submission = useRef(false);
  const busy = processing || saving;
  const nameInvalid = countCharacters(name.trim()) < 1 || countCharacters(name.trim()) > 10;
  const usernameInvalid = !usernameSchema.safeParse(username).success;
  useEffect(
    () => () => {
      if (preview) URL.revokeObjectURL(preview);
    },
    [preview],
  );
  async function selectImage(file: File) {
    setProcessing(true);
    setError(null);
    setNotice(null);
    try {
      const converted = await convertAvatar(file);
      setAvatar(converted);
      setPreview(URL.createObjectURL(converted));
      setAvatarAction("replace");
    } catch (err) {
      setError(err instanceof Error ? err.message : "画像を読み込めませんでした。");
    } finally {
      setProcessing(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || submission.current) return;
    setSubmitted(true);
    setError(null);
    setNotice(null);
    if (nameInvalid || usernameInvalid) return;
    submission.current = true;
    setSaving(true);
    const data = new FormData();
    data.set("name", name);
    data.set("username", username);
    data.set("avatarAction", avatarAction);
    if (avatarAction === "replace" && avatar) data.set("avatar", avatar, "avatar.webp");
    try {
      const saved = await saveProfile(setup, data);
      update(saved);
      setName(saved.name);
      setUsername(saved.username ?? "");
      setAvatar(null);
      setAvatarAction("keep");
      setPreview(null);
      setSubmitted(false);
      if (setup) navigate("/account", { replace: true });
      else setNotice("プロフィールを保存しました。");
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存できませんでした。");
    } finally {
      submission.current = false;
      setSaving(false);
    }
  }
  const image =
    avatarAction === "remove" ? null : avatarAction === "replace" ? preview : user.avatarUrl;
  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-6">
      <div className="flex flex-col items-center gap-3">
        <AppAvatar src={image} label="アイコンのプレビュー" className="size-24 [&_svg]:size-10" />
        <div className="flex flex-wrap justify-center gap-2">
          <AppButton
            type="button"
            appearance="secondary"
            size="compact"
            isDisabled={busy}
            onPress={() => fileInput.current?.click()}
          >
            アイコンをアップロード
          </AppButton>
          <AppButton
            type="button"
            appearance="quiet"
            size="compact"
            isDisabled={busy || !image}
            onPress={() => {
              setAvatarAction("remove");
              setAvatar(null);
              setPreview(null);
              setNotice(null);
            }}
          >
            削除
          </AppButton>
        </div>
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
            setNotice(null);
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
            setNotice(null);
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
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="text-sm text-brand">
          {notice}
        </p>
      )}
      <AppButton type="submit" isDisabled={busy}>
        {saving ? "保存しています…" : setup ? "プロフィールを作成" : "プロフィールを保存"}
      </AppButton>
    </form>
  );
}
