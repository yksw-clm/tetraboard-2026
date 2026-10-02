import { env } from "cloudflare:workers";
import { expect, test } from "vitest";
import {
  prepareLegacyAccounts,
  readSnapshot,
  type AccountSnapshot,
} from "../scripts/legacyAccountPlan";
const fixture = (): AccountSnapshot => {
  const id = `legacy_${crypto.randomUUID()}`;
  return {
    users: [
      {
        id,
        name: "旧版の名前",
        email: `${id}@example.test`,
        emailVerified: 1,
        image: "https://example.test/old-photo",
        createdAt: 1700000000000,
        updatedAt: 1710000000000,
        username: `u_${id.slice(-8)}`,
        profileCompleted: 1,
        avatarKey: null,
      },
    ],
    accounts: [
      {
        id: crypto.randomUUID(),
        accountId: crypto.randomUUID(),
        providerId: "google",
        userId: id,
        createdAt: 1700000000000,
        updatedAt: 1710000000000,
      },
    ],
  };
};
const empty: AccountSnapshot = { users: [], accounts: [] };
test("旧版の名前・ID・Google識別子・画像を新D1へ保存し、秘密トークンを移さない", async () => {
  const source = fixture();
  const key = `avatars/${crypto.randomUUID()}.webp`;
  source.users[0].avatarKey = key;
  source.users[0].image = "/api/avatars/legacy";
  source.users[0].name = "O'Brien";
  const plan = prepareLegacyAccounts(source, empty);
  expect(plan.avatars).toEqual([key]);
  expect(plan.sql).not.toMatch(
    /accessToken|refreshToken|idToken|INSERT INTO "session"|verification/,
  );
  for (const statement of plan.sql.trim().split(";\n"))
    await env.APP_DB.prepare(statement.replace(/;$/, "")).run();
  expect(
    await env.APP_DB.prepare("SELECT id, name, username, image FROM user WHERE id = ?")
      .bind(source.users[0].id)
      .first(),
  ).toEqual({
    id: source.users[0].id,
    name: "O'Brien",
    username: source.users[0].username,
    image: `/api/avatars/${key.slice(8, -5)}`,
  });
  expect(
    await env.APP_DB.prepare(
      "SELECT providerId, accountId, accessToken FROM account WHERE userId = ?",
    )
      .bind(source.users[0].id)
      .first(),
  ).toEqual({ providerId: "google", accountId: source.accounts[0].accountId, accessToken: null });
  const target = structuredClone(source);
  target.users[0].image = `/api/avatars/${key.slice(8, -5)}`;
  expect(prepareLegacyAccounts(source, target).sql.trim()).toBe("");
});
test("メール・ID・Google識別子の衝突、既存プロフィール差分を自動で上書きしない", () => {
  const source = fixture();
  const target = fixture();
  target.users[0].username = source.users[0].username!.toUpperCase();
  expect(() => prepareLegacyAccounts(source, target)).toThrow(/conflict/);
  target.users[0].username = "another_id";
  target.users[0].email = source.users[0].email;
  expect(() => prepareLegacyAccounts(source, target)).toThrow(/conflict/);
  target.users[0].email = "another@example.test";
  target.accounts[0].accountId = source.accounts[0].accountId;
  expect(() => prepareLegacyAccounts(source, target)).toThrow(/conflict/);
  const altered = structuredClone(source);
  altered.users[0].name = "新しい名前";
  expect(() => prepareLegacyAccounts(source, altered)).toThrow(/overwritten/);
});
test("ゲスト・テストユーザーを除外し、不正な画像・ID・Google未連携は移行前に停止する", () => {
  const source = fixture();
  source.users[0].isAnonymous = 1;
  expect(prepareLegacyAccounts(source, empty).users).toBe(0);
  source.users[0].isAnonymous = 0;
  source.users[0].isTestUser = 1;
  expect(prepareLegacyAccounts(source, empty).users).toBe(0);
  source.users[0].isTestUser = 0;
  source.users[0].avatarKey = "../private";
  expect(() => prepareLegacyAccounts(source, empty)).toThrow(/avatar/);
  source.users[0].avatarKey = null;
  source.users[0].username = "日本語";
  expect(() => prepareLegacyAccounts(source, empty)).toThrow(/profile/);
  source.users[0].username = "valid_id";
  source.accounts[0].providerId = "discord";
  expect(() => prepareLegacyAccounts(source, empty)).toThrow(/Google/);
  expect(readSnapshot([{ results: [{ snapshot: JSON.stringify(empty) }] }])).toEqual(empty);
});
