import { expect, test } from "bun:test";
import {
  accountAvatarUrl,
  profileAvatarUrl,
  publicProfile,
  readProfileDetails,
  selectProfileAvatar,
  accountCreatedAtMsSql,
  accountRegisteredAtMsSql,
} from "../src";
import { policy, preset, uploadedId, user } from "./fixtures";
test("公開プロフィールは内部ID・画像キー・テスト属性を公開しません", () => {
  expect(publicProfile(user, policy)).toEqual({
    profileId: user.publicProfileId,
    name: "対局者",
    username: "player_1",
    avatarUrl: `/api/avatars/${preset}`,
    avatarPresetId: preset,
    profileCompleted: true,
    profileMessage: "よろしく",
    favoriteGames: ["shogi", "gomoku"],
  });
  expect(
    publicProfile({ ...user, publicProfileId: undefined, profileCompleted: 0 }, policy),
  ).toMatchObject({ profileId: null, profileCompleted: false });
});
test("ゲストは名前設定状態だけを加え、登録者の詳細を読みません", () => {
  const guest = { ...user, isAnonymous: 1, guestNameCustomized: 0, favoriteGames: "broken" };
  const result = publicProfile(guest, policy);
  expect(result).toEqual({
    profileId: user.publicProfileId,
    name: "対局者",
    username: "player_1",
    avatarUrl: `/api/avatars/${preset}`,
    avatarPresetId: preset,
    profileCompleted: true,
    isGuest: true,
    nameCustomized: false,
  });
  expect(publicProfile({ ...guest, guestNameCustomized: 1 }, policy).nameCustomized).toBe(true);
});
test("アップロード画像を優先し、不正キーでは選択された候補に戻します", () => {
  expect(profileAvatarUrl(`avatars/${uploadedId}.webp`, preset, policy)).toBe(
    `/api/avatars/${uploadedId}`,
  );
  for (const key of [
    null,
    "avatars/../secret.webp",
    `avatars/${uploadedId.toUpperCase()}.webp`,
    `avatars/${uploadedId}.png`,
  ]) {
    expect(profileAvatarUrl(key, preset, policy)).toBe(`/api/avatars/${preset}`);
    expect(profileAvatarUrl(key, "unknown", policy)).toBeNull();
  }
  expect(
    accountAvatarUrl({ id: user.id, avatarKey: null, avatarPresetId: "unknown" }, policy),
  ).toBe(`/api/avatars/${preset}`);
});
test("詳細の既定値と保存JSONを検証関数へ渡し、破損JSONを隠しません", () => {
  expect(readProfileDetails({}, policy.parseDetails)).toEqual({
    profileMessage: "",
    favoriteGames: [],
  });
  expect(() => readProfileDetails({ favoriteGames: "broken" }, policy.parseDetails)).toThrow();
  expect(() =>
    readProfileDetails({}, () => {
      throw new Error("invalid details");
    }),
  ).toThrow("invalid details");
});
test("画像の維持・削除・候補の選択で保存する値を保ちます", () => {
  const withImage = { ...user, avatarKey: `avatars/${uploadedId}.webp` };
  expect(selectProfileAvatar(withImage, "keep", null, policy)).toEqual({
    avatarKey: withImage.avatarKey,
    image: `/api/avatars/${uploadedId}`,
    avatarPresetId: null,
  });
  expect(selectProfileAvatar(withImage, "remove", null, policy)).toEqual({
    avatarKey: null,
    image: null,
    avatarPresetId: null,
  });
  expect(selectProfileAvatar(withImage, "preset", preset, policy)).toEqual({
    avatarKey: null,
    image: null,
    avatarPresetId: preset,
  });
});
test("作成日時とゲスト登録日時のSQL式を維持します", () => {
  expect(accountCreatedAtMsSql("createdAt")).toBe(
    "CAST(ROUND(unixepoch(createdAt, 'subsec') * 1000) AS INTEGER)",
  );
  expect(accountRegisteredAtMsSql()).toBe(
    "COALESCE(u.guestRegisteredAt,CAST(ROUND(unixepoch(u.createdAt, 'subsec') * 1000) AS INTEGER))",
  );
});
