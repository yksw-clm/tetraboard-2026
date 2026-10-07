import { useEffect, useRef, useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { countCharacters, usernameSchema, type AccountProfile } from "@tetraboard/protocol";
import { useAccount } from "./useAccount";
import { convertAvatar, saveProfile } from "./accountApi";

export function useProfileDraft({
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
    onBusyChange?.(true);
    setError(null);
    try {
      const converted = await convertAvatar(file);
      setAvatar(converted);
      setPreview(URL.createObjectURL(converted));
      setAvatarAction("replace");
    } catch (err) {
      setError(err instanceof Error ? err.message : "画像を読み込めませんでした。");
    } finally {
      setProcessing(false);
      onBusyChange?.(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || submission.current) return;
    setSubmitted(true);
    setError(null);
    if (nameInvalid || usernameInvalid) return;
    submission.current = true;
    setSaving(true);
    onBusyChange?.(true);
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
      else onSaved?.(saved);
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存できませんでした。");
    } finally {
      submission.current = false;
      setSaving(false);
      onBusyChange?.(false);
    }
  }
  const image =
    avatarAction === "remove" ? null : avatarAction === "replace" ? preview : user.avatarUrl;
  return {
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
    removeImage() {
      setAvatarAction("remove");
      setAvatar(null);
      setPreview(null);
    },
  };
}
