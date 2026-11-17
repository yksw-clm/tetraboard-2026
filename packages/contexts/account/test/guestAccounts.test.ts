import { expect, test } from "bun:test";
import {
  createGuestAccount,
  changeGuestName,
  allowGuestCreation,
  createGuestUsername,
  isGuestUsernameCollision,
  type GuestAccountStore,
  type GuestCreation,
  type GuestRuntime,
} from "../src";
import { preset } from "./fixtures";
function fixture(failures: Error[] = []) {
  const commands: GuestCreation[] = [],
    events: string[] = [];
  let sequence = 0;
  const store: GuestAccountStore = {
    async create(command) {
      commands.push(structuredClone(command));
      events.push("save");
      const failure = failures.shift();
      if (failure) throw failure;
    },
    async customize() {
      return { id: "guest" };
    },
    async rename() {
      return null;
    },
    async rate() {
      return { count: 20 };
    },
    async clear() {},
    async suspend() {},
  };
  const runtime: GuestRuntime = {
    now: () => 1700000000000,
    id: () =>
      [
        "guest-id",
        "public-id",
        "11111111-2222-4333-8444-555555555555",
        "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      ][sequence++]!,
    number: () => 100007,
    credential: async () => ({ token: "secret-token", hash: "hashed-token" }),
    issueSession(token) {
      events.push(`cookie:${token}`);
    },
  };
  return { store, runtime, commands, events };
}
test("自動名・公開ID・表示IDと資格を保存後にCookieの発行を依頼します", async () => {
  const f = fixture();
  expect(await createGuestAccount(f.store, f.runtime)).toEqual({
    id: "guest-id",
    name: "ゲスト00007",
    username: "guest_11111111222243",
    image: null,
    avatarKey: null,
    avatarPresetId: null,
    profileCompleted: 1,
    isAnonymous: 1,
    guestNameCustomized: 0,
    publicProfileId: "public-id",
  });
  expect(f.commands).toEqual([
    {
      user: {
        id: "guest-id",
        name: "ゲスト00007",
        username: null,
        image: null,
        avatarKey: null,
        avatarPresetId: null,
        profileCompleted: 1,
        isAnonymous: 1,
        guestNameCustomized: 0,
        publicProfileId: "public-id",
      },
      username: "guest_11111111222243",
      hash: "hashed-token",
      now: 1700000000000,
    },
  ]);
  expect(f.events).toEqual(["save", "cookie:secret-token"]);
});
test("表示ID衝突では本人と資格を変えず、新しい表示IDで再試行します", async () => {
  const f = fixture([new Error("UNIQUE constraint failed: user.username")]);
  expect(await createGuestAccount(f.store, f.runtime, "設定名", preset)).toMatchObject({
    id: "guest-id",
    name: "設定名",
    username: "guest_aaaaaaaabbbb4c",
    avatarPresetId: preset,
    guestNameCustomized: 1,
  });
  expect(f.commands.map((c) => [c.user.id, c.user.publicProfileId, c.hash, c.username])).toEqual([
    ["guest-id", "public-id", "hashed-token", "guest_11111111222243"],
    ["guest-id", "public-id", "hashed-token", "guest_aaaaaaaabbbb4c"],
  ]);
  expect(f.events).toEqual(["save", "save", "cookie:secret-token"]);
});
test("表示IDの衝突は5回で終了し、同意や別の一意制約の失敗を再試行しません", async () => {
  for (const message of ["consent unavailable", "UNIQUE constraint failed: user.id"]) {
    const f = fixture([new Error(message)]);
    await expect(createGuestAccount(f.store, f.runtime)).rejects.toThrow(message);
    expect(f.events).toEqual(["save"]);
  }
  const f = fixture(
    Array.from(
      { length: 5 },
      () => new Error("UNIQUE constraint failed: user_username_normalized_idx"),
    ),
  );
  f.runtime.id = () => "11111111-2222-4333-8444-555555555555";
  await expect(createGuestAccount(f.store, f.runtime)).rejects.toThrow(
    "Guest username allocation failed",
  );
  expect(f.events).toEqual(["save", "save", "save", "save", "save"]);
  expect(createGuestUsername("12345678-1234-4234-8234-123456789abc")).toBe("guest_12345678123442");
  expect(isGuestUsernameCollision("UNIQUE constraint failed: user.username")).toBe(false);
});
test("初回の名前設定はIDを保ち、同時編集で保存を拒否されたら成功を返しません", async () => {
  const f = fixture();
  const user = await createGuestAccount(f.store, f.runtime);
  const command = {
    user,
    name: "変更名",
    avatarPresetId: preset,
    updatedAt: "2023-11-14T22:13:20.000Z",
  };
  expect(await changeGuestName(f.store, command, true)).toEqual({
    ...user,
    name: "変更名",
    avatarPresetId: preset,
    guestNameCustomized: 1,
  });
  expect(await changeGuestName(f.store, command)).toBeNull();
  expect(await allowGuestCreation(f.store, "hashed-ip", 1700000000000)).toBe(true);
  f.store.rate = async () => ({ count: 21 });
  expect(await allowGuestCreation(f.store, "hashed-ip", 1700000000000)).toBe(false);
});
