import { expect, test } from "bun:test";
import { readCurrentProfiles, saveProfile } from "../src";
import { MemoryProfiles, policy, preset, row, user, saveCommand } from "./fixtures";
test("現在のプロフィールは重複IDを一度だけ照会し、現在の画像と詳細を返します", async () => {
  const memory = new MemoryProfiles();
  const profiles = await readCurrentProfiles(memory, policy, [user.id, user.id, "missing"]);
  expect(memory.reads).toEqual([[user.id, "missing"]]);
  expect([...profiles]).toEqual([
    [
      user.id,
      {
        name: row.name,
        username: row.username,
        publicProfileId: row.publicProfileId,
        profileCompleted: 1,
        isAnonymous: 0,
        profileMessage: "よろしく",
        favoriteGames: ["shogi", "gomoku"],
        avatarUrl: `/api/avatars/${preset}`,
      },
    ],
  ]);
  memory.rows.set(row.id, { ...row, name: "新しい名前" });
  expect((await readCurrentProfiles(memory, policy, [row.id])).get(row.id)?.name).toBe(
    "新しい名前",
  );
});
test("IDが空なら保存先を呼ばず、非公開・存在しない行を補完しません", async () => {
  const memory = new MemoryProfiles();
  expect((await readCurrentProfiles(memory, policy, [])).size).toBe(0);
  expect(memory.reads).toEqual([]);
  memory.rows.clear();
  expect((await readCurrentProfiles(memory, policy, [row.id])).size).toBe(0);
});
test("初回設定は公開IDと詳細を保存し、保存先の確定値を応答に使います", async () => {
  const memory = new MemoryProfiles();
  const initial = { ...user, profileCompleted: 0, publicProfileId: null };
  memory.users.set(user.id, initial);
  const command = saveCommand({
    user: initial,
    expectedCompleted: 0,
    details: { profileMessage: "初回", favoriteGames: ["gomoku"] },
    consent: true,
  });
  expect(await saveProfile(memory, command)).toMatchObject({
    name: "更新名",
    username: "updated_1",
    profileCompleted: 1,
    publicProfileId: "new-profile-id",
    profileMessage: "初回",
    favoriteGames: '["gomoku"]',
    avatarPresetId: preset,
  });
  expect(memory.commands).toEqual([command]);
});
test("旧フォームの省略はDB現在値を保持し、空欄は明示的に消します", async () => {
  const memory = new MemoryProfiles();
  memory.users.set(user.id, {
    ...user,
    profileMessage: "別タブの更新",
    favoriteGames: '["reversi"]',
  });
  expect(await saveProfile(memory, saveCommand())).toMatchObject({
    publicProfileId: user.publicProfileId,
    profileMessage: "別タブの更新",
    favoriteGames: '["reversi"]',
  });
  expect(
    await saveProfile(
      memory,
      saveCommand({
        user: memory.users.get(user.id)!,
        details: { profileMessage: "", favoriteGames: [] },
      }),
    ),
  ).toMatchObject({ profileMessage: "", favoriteGames: "[]" });
});
test("同時編集や退会のため保存できない場合は成功プロフィールを返しません", async () => {
  for (const kind of ["deleted", "completed", "avatar", "preset"]) {
    const memory = new MemoryProfiles();
    if (kind === "deleted") memory.users.clear();
    else
      memory.users.set(user.id, {
        ...user,
        ...(kind === "completed"
          ? { profileCompleted: 0 }
          : kind === "avatar"
            ? { avatarKey: "another" }
            : { avatarPresetId: preset }),
      });
    expect(await saveProfile(memory, saveCommand())).toBeNull();
  }
});
test("保存の失敗は呼び出し側へ返します", async () => {
  await expect(
    saveProfile(
      {
        save: async () => {
          throw new Error("D1 unavailable");
        },
      },
      saveCommand(),
    ),
  ).rejects.toThrow("D1 unavailable");
});
