import { avatarPresets, type AvatarPresetId } from "@tetraboard/protocol";

export function randomGuestAvatar(current?: AvatarPresetId): AvatarPresetId {
  const candidates = avatarPresets.filter((preset) => preset.id !== current);
  return candidates[Math.floor(Math.random() * candidates.length)]!.id;
}
