import { legalVersion } from "@tetraboard/protocol/privacy";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import {
  avatarPresetUrl,
  avatarPresets,
  countCharacters,
  usernameSchema,
  type AccountProfile,
  type AvatarPresetId,
} from "@tetraboard/protocol";
import { usePlayerProfiles } from "../players/usePlayerProfiles";
import { useAccount } from "./useAccount";
import { convertAvatar, saveGuestName, saveProfile } from "./accountApi";

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
  const profiles = usePlayerProfiles();
  const navigate = useNavigate();
  const [name, setName] = useState(user.name);
  const [username, setUsername] = useState(user.username ?? "");
  const [avatar, setAvatar] = useState<Blob | null>(null);
  const [avatarAction, setAvatarAction] = useState<"keep" | "replace" | "remove" | "preset">(
    "keep",
  );
  const [presetId, setPresetId] = useState<AvatarPresetId | undefined>(user.avatarPresetId);
  const [preview, setPreview] = useState<string | null>(null);
  const [processing, setProcessing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const submission = useRef(false);
  const busy = processing || saving;
  const nameInvalid = countCharacters(name.trim()) < 1 || countCharacters(name.trim()) > 10;
  const usernameInvalid = !user.isGuest && !usernameSchema.safeParse(username).success;
  useEffect(
    () => () => {
      if (preview) URL.revokeObjectURL(preview);
    },
    [preview],
  );
  async function selectImage(file: File) {
    if (busy || user.isGuest) return;
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
    try {
      let saved: AccountProfile;
      if (user.isGuest) {
        saved = await saveGuestName(name, avatarAction === "preset" ? presetId : undefined);
      } else {
        const data = new FormData();
        if (setup) data.set("consentVersion", legalVersion);
        data.set("name", name);
        data.set("username", username);
        data.set("avatarAction", avatarAction);
        if (avatarAction === "preset" && presetId) data.set("avatarPresetId", presetId);
        if (avatarAction === "replace" && avatar) data.set("avatar", avatar, "avatar.webp");
        saved = await saveProfile(setup, data);
      }
      profiles?.store.invalidate(saved.profileId ? { profileId: saved.profileId } : {});
      update(saved);
      setName(saved.name);
      setUsername(saved.username ?? "");
      setAvatar(null);
      setAvatarAction("keep");
      setPresetId(saved.avatarPresetId);
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
  const fallback = user.avatarPresetId ? avatarPresetUrl(user.avatarPresetId) : null;
  const image =
    avatarAction === "remove"
      ? fallback
      : avatarAction === "preset" && presetId
        ? avatarPresetUrl(presetId)
        : avatarAction === "replace"
          ? preview
          : user.avatarUrl;
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
    selectedPresetId: avatarPresets.find((preset) => avatarPresetUrl(preset.id) === image)?.id,
    canRemoveImage: Boolean(
      image && !avatarPresets.some((preset) => avatarPresetUrl(preset.id) === image),
    ),
    selectPreset(id: AvatarPresetId) {
      if (busy) return;
      setPresetId(id);
      setAvatarAction("preset");
      setAvatar(null);
      setPreview(null);
      setError(null);
    },
    submit,
    removeImage() {
      if (busy || user.isGuest) return;
      setAvatarAction("remove");
      setAvatar(null);
      setPreview(null);
    },
  };
}
