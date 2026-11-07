import { expect, test } from "bun:test";
import {
  accountAvatarPresetId,
  avatarPresetIds,
  avatarPresets,
  avatarPresetUrl,
  accountProfileSchema,
  playerAppearanceSchema,
} from "../src";

test("v1の自動アイコンは既存IDに対して固定し、選び直したプリセットを優先する", () => {
  expect(accountAvatarPresetId("guest-one")).toBe(avatarPresetIds[0]);
  expect(accountAvatarPresetId("registered-two")).toBe(avatarPresetIds[4]);
  expect(accountAvatarPresetId("00000000-0000-4000-8000-000000000001")).toBe(avatarPresetIds[2]);
  expect(accountAvatarPresetId("guest-one", avatarPresetIds[5])).toBe(avatarPresetIds[5]);
  expect(new Set(avatarPresets.map((preset) => preset.id)).size).toBe(6);
});
test("プリセットのURLは従来の対局画像の形式で、古いアカウント応答も読める", () => {
  for (const { id } of avatarPresets)
    expect(
      playerAppearanceSchema.parse({ kind: "human", avatarUrl: avatarPresetUrl(id) }).kind,
    ).toBe("human");
  expect(
    accountProfileSchema.safeParse({
      name: "旧プロフィール",
      username: "old",
      avatarUrl: null,
      profileCompleted: true,
    }).success,
  ).toBe(true);
});
