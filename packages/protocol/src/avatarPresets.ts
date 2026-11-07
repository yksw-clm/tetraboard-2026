import { z } from "zod";

export const avatarPresetIds = [
  "a7e7ab0a-0001-4000-8000-000000000001",
  "a7e7ab0a-0001-4000-8000-000000000002",
  "a7e7ab0a-0001-4000-8000-000000000003",
  "a7e7ab0a-0001-4000-8000-000000000004",
  "a7e7ab0a-0001-4000-8000-000000000005",
  "a7e7ab0a-0001-4000-8000-000000000006",
] as const;
export const avatarPresetIdSchema = z.enum(avatarPresetIds);
export type AvatarPresetId = z.infer<typeof avatarPresetIdSchema>;
export const avatarPresets = [
  { id: avatarPresetIds[0], name: "にこにこ将棋駒", file: "shogi-smile.webp" },
  { id: avatarPresetIds[1], name: "おだやかな黒石", file: "black-stone.webp" },
  { id: avatarPresetIds[2], name: "元気な白石", file: "white-stone.webp" },
  { id: avatarPresetIds[3], name: "得意げな将棋駒", file: "shogi-confident.webp" },
  { id: avatarPresetIds[4], name: "好奇心いっぱいの緑石", file: "green-disc.webp" },
  { id: avatarPresetIds[5], name: "にこにこ赤石", file: "coral-stone.webp" },
] as const;
export function isAvatarPresetId(id: unknown): id is AvatarPresetId {
  return typeof id === "string" && avatarPresetIds.some((candidate) => candidate === id);
}
export function avatarPresetUrl(id: AvatarPresetId): string {
  return `/api/avatars/${id}`;
}
export function accountAvatarPresetId(accountId: string, selected?: string | null): AvatarPresetId {
  if (isAvatarPresetId(selected)) return selected;
  // v1の候補と順序を固定し、追加後も既存アカウントの自動アイコンを変えません。
  let hash = 2166136261;
  for (let i = 0; i < accountId.length; i++)
    hash = Math.imul(hash ^ accountId.charCodeAt(i), 16777619);
  return avatarPresetIds[(hash >>> 0) % 6]!;
}
