import { legalVersion } from "@tetraboard/protocol/privacy";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import {
  avatarPresetUrl,
  avatarPresets,
  countCharacters,
  usernameSchema,
  profileDetailsSchema,
  profileMessageSchema,
  gameIds,
  type GameId,
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
  const [profileMessage, setProfileMessage] = useState(user.profileMessage ?? "");
  const [favoriteGames, setFavoriteGames] = useState<GameId[]>(user.favoriteGames ?? []);
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
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const busy = processing || saving;
  const nameInvalid = countCharacters(name.trim()) < 1 || countCharacters(name.trim()) > 10;
  const usernameInvalid = !user.isGuest && !usernameSchema.safeParse(username).success;
  const profileMessageInvalid =
    !user.isGuest && !profileMessageSchema.safeParse(profileMessage).success;
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
    const details = profileDetailsSchema.safeParse({ profileMessage, favoriteGames });
    if (nameInvalid || usernameInvalid || (!user.isGuest && !details.success)) return;
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
        if (details.success) {
          data.set("profileMessage", details.data.profileMessage);
          data.set("favoriteGames", JSON.stringify(details.data.favoriteGames));
        }
        if (avatarAction === "preset" && presetId) data.set("avatarPresetId", presetId);
        if (avatarAction === "replace" && avatar) data.set("avatar", avatar, "avatar.webp");
        saved = await saveProfile(setup, data);
      }
      if (!active.current) return;
      acceptSaved(saved);
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
  function acceptSaved(saved: AccountProfile) {
    profiles?.store.invalidate(saved.profileId ? { profileId: saved.profileId } : {});
    update(saved);
    setName(saved.name);
    setUsername(saved.username ?? "");
    setProfileMessage(saved.profileMessage ?? "");
    setFavoriteGames(saved.favoriteGames ?? []);
    setAvatar(null);
    setAvatarAction("keep");
    setPresetId(saved.avatarPresetId);
    setPreview(null);
    setSubmitted(false);
  }
  async function saveBeforeLink() {
    if (!user.isGuest) return;
    setSubmitted(true);
    if (nameInvalid) throw new Error("名前は1〜10文字で入力してから連携してください。");
    if (busy || submission.current) throw new Error("保存が終わってから連携してください。");
    submission.current = true;
    setSaving(true);
    onBusyChange?.(true);
    try {
      const saved = await saveGuestName(name, avatarAction === "preset" ? presetId : undefined);
      if (!active.current) return;
      if (user.profileId && saved.profileId !== user.profileId)
        throw new Error("アカウントが変わりました。プロフィールを開き直してください。");
      acceptSaved(saved);
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
    profileMessage,
    setProfileMessage,
    profileMessageInvalid,
    favoriteGames,
    toggleFavoriteGame(game: GameId) {
      if (busy) return;
      setFavoriteGames((current) =>
        current.includes(game)
          ? current.filter((id) => id !== game)
          : current.length < 3
            ? gameIds.filter((id) => id === game || current.includes(id))
            : current,
      );
    },
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
    saveBeforeLink,
    removeImage() {
      if (busy || user.isGuest) return;
      setAvatarAction("remove");
      setAvatar(null);
      setPreview(null);
    },
  };
}
