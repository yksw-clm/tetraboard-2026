import { AcceptedGameRequest } from "./acceptedGameRequest";
import { env } from "cloudflare:workers";
import { expect, test } from "vitest";
import { accountAvatarPresetId, avatarPresetUrl } from "@tetraboard/protocol";
import { accountFixture, origin } from "./accountFixtures";
import { accountIdentity, publicProfile } from "../src/adapters/account/auth";
import { deleteUnusedAvatars } from "../src/routes/accountAvatars";
import { prepareLegacyAccounts } from "../scripts/legacyAccountPlan";
import {
  registerAccountRoomsFixtures,
  attachAvatar,
  created,
  request,
  snapshot,
  leave,
} from "./accountRoomsFixtures";

registerAccountRoomsFixtures();

test("プロフィール編集・画像削除・ログアウト後も席と画像を保持し、退室後に解放する", async () => {
  const user = await accountFixture();
  const key = await attachAvatar(user);
  const result = await created(user);
  const form = new FormData();
  form.set("name", "変更した名前");
  form.set("username", user.username);
  form.set("avatarAction", "remove");
  expect(
    (
      await request("/account/profile", {
        method: "PATCH",
        headers: { Cookie: user.cookie, Origin: origin },
        body: form,
      })
    ).status,
  ).toBe(200);
  await deleteUnusedAvatars(env);
  expect(await env.OBJECT_STORAGE.get(key)).not.toBeNull();
  expect((await snapshot(result.room.id)).players[0]).toMatchObject({
    name: "登録名",
    avatarUrl: `/api/avatars/${key.slice(8, -5)}`,
  });
  await request("/auth/sign-out", { method: "POST", headers: user.headers, body: "{}" });
  expect(
    (
      await request(`/rooms/${result.room.id}/me`, {
        headers: { Authorization: `Bearer ${result.membership.token}` },
      })
    ).status,
  ).toBe(200);
  await leave(result.room.id, result.membership.token);
  await env.GAME_ROOM.getByName(result.room.id).getRoom();
  await deleteUnusedAvatars(env);
  expect(await env.OBJECT_STORAGE.get(key)).toBeNull();
});

test("外部画像は公開せず、移行では未設定にする", async () => {
  const user = await accountFixture();
  await env.APP_DB.prepare("UPDATE user SET image = ? WHERE id = ?")
    .bind("https://example.test/image", user.id)
    .run();
  const identity = await accountIdentity(
    new AcceptedGameRequest(origin, { headers: user.headers }),
    env,
  );
  expect(publicProfile(identity!).avatarUrl).toBe(avatarPresetUrl(accountAvatarPresetId(user.id)));
  const result = await created(user);
  expect(result.room.players[0]).toMatchObject({
    avatarUrl: avatarPresetUrl(accountAvatarPresetId(user.id)),
  });
  const legacy = {
    ...identity!,
    email: `${user.id}@example.test`,
    emailVerified: 1,
    createdAt: 1,
    updatedAt: 1,
  };
  const plan = prepareLegacyAccounts(
    {
      users: [legacy],
      accounts: [
        {
          id: "old-account",
          userId: user.id,
          providerId: "google",
          accountId: "google-id",
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    },
    { users: [], accounts: [] },
  );
  expect(plan.sql).not.toContain("https://");
  expect(plan.avatars).toEqual([]);
});
