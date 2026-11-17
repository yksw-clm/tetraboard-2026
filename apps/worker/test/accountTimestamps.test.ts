import { env, exports } from "cloudflare:workers";
import { afterEach, expect, test } from "vitest";
import { legalVersion } from "@tetraboard/protocol/privacy";
import { createAuth, withAccountSessionCookies, type StoredProfile } from "../src/accounts/auth";
import { createGuestAccount } from "../src/routes/guestSession";
import { completeGuestLink, rememberGuestLink } from "../src/accounts/guestLinking";
import { accountFixture, origin } from "./accountFixtures";

const users: string[] = [];
afterEach(async () => {
  for (const id of users.splice(0)) {
    await env.APP_DB.prepare("DELETE FROM session WHERE userId=?").bind(id).run();
    await env.APP_DB.prepare("DELETE FROM user WHERE id=?").bind(id).run();
  }
});
const dates = (id: string) =>
  env.APP_DB.prepare(`SELECT createdAt,updatedAt,
  typeof(createdAt) AS createdType,typeof(updatedAt) AS updatedType FROM user WHERE id=?`)
    .bind(id)
    .first<{ createdAt: string; updatedAt: string; createdType: string; updatedType: string }>();
function expectIsoDates(row: Awaited<ReturnType<typeof dates>>) {
  expect(row).not.toBeNull();
  expect(row!.createdType).toBe("text");
  expect(row!.updatedType).toBe("text");
  expect(new Date(row!.createdAt).toISOString()).toBe(row!.createdAt);
  expect(new Date(row!.updatedAt).toISOString()).toBe(row!.updatedAt);
}
async function guest() {
  const request = new Request(`${origin}/api/account/guest`, {
    headers: { Origin: origin, "X-Legal-Consent": legalVersion },
  });
  let identity: StoredProfile | undefined;
  const response = await withAccountSessionCookies(request, async () => {
    identity = await createGuestAccount(request, env);
    users.push(identity.id);
    return new Response(null);
  });
  const cookie = response.headers.getSetCookie()[0]!.split(";")[0]!;
  return { ...identity!, cookie };
}
const request = (path: string, init: RequestInit) =>
  exports.default.fetch(new Request(`${origin}/api${path}`, init));

test("better-authのD1アダプターは両日時をISO textで作成・更新し、Dateとして読み戻す", async () => {
  const { internalAdapter } = await createAuth(env).$context;
  const createdAt = new Date("2026-10-02T15:38:11.458Z");
  const updatedAt = new Date("2026-11-15T00:00:00.001Z");
  const user = await internalAdapter.createUser(
    {
      name: "登録者",
      email: `${crypto.randomUUID()}@test.invalid`,
      createdAt,
      updatedAt,
    },
    { method: "admin" },
  );
  users.push(user.id);
  expect(await dates(user.id)).toEqual({
    createdAt: createdAt.toISOString(),
    updatedAt: updatedAt.toISOString(),
    createdType: "text",
    updatedType: "text",
  });
  const stored = await internalAdapter.findUserById(user.id);
  expect(stored?.createdAt).toEqual(createdAt);
  expect(stored?.updatedAt).toEqual(updatedAt);
  const changed = await internalAdapter.updateUser(user.id, { name: "更新した名前" });
  expect(changed.createdAt).toEqual(createdAt);
  expect(changed.updatedAt).toBeInstanceOf(Date);
  expect((await dates(user.id))?.updatedAt).toBe(changed.updatedAt.toISOString());
  expectIsoDates(await dates(user.id));
});

test("新規ゲスト・初回名前設定・名前変更は両日時をISO textのまま保持する", async () => {
  const user = await guest();
  const created = await dates(user.id);
  expectIsoDates(created);
  expect(created!.createdAt).toBe(created!.updatedAt);
  const old = "2000-01-01T00:00:00.000Z";
  for (const [path, method, name] of [
    ["/account/guest", "POST", "初回の名前"],
    ["/account/guest/name", "PATCH", "変更後の名前"],
  ]) {
    await env.APP_DB.prepare("UPDATE user SET updatedAt=? WHERE id=?").bind(old, user.id).run();
    const response = await request(path!, {
      method,
      headers: {
        Cookie: user.cookie,
        Origin: origin,
        "Content-Type": "application/json",
        "X-Legal-Consent": legalVersion,
      },
      body: JSON.stringify({ name }),
    });
    expect(response.status).toBe(200);
    const changed = await dates(user.id);
    expectIsoDates(changed);
    expect(changed!.createdAt).toBe(created!.createdAt);
    expect(changed!.updatedAt).not.toBe(old);
  }
});

test("プロフィール更新はcreatedAtを保ち、updatedAtをISO textで保存する", async () => {
  const user = await accountFixture();
  users.push(user.id);
  const before = await dates(user.id);
  await env.APP_DB.prepare("UPDATE user SET updatedAt=? WHERE id=?")
    .bind("2000-01-01T00:00:00.000Z", user.id)
    .run();
  const form = new FormData();
  form.set("name", "変更後の名前");
  form.set("username", user.username);
  form.set("avatarAction", "keep");
  form.set("consentVersion", legalVersion);
  const encoded = new Request(`${origin}/api/account/profile`, {
    method: "PATCH",
    headers: { Cookie: user.cookie, Origin: origin },
    body: form,
  });
  const body = await encoded.arrayBuffer();
  const response = await request("/account/profile", {
    method: "PATCH",
    headers: encoded.headers,
    body,
  });
  expect(response.status).toBe(200);
  const after = await dates(user.id);
  expectIsoDates(after);
  expect(after!.createdAt).toBe(before!.createdAt);
  expect(after!.updatedAt).not.toBe("2000-01-01T00:00:00.000Z");
});

test("新規OAuth連携のゲスト昇格は日時をISO textで保ち、登録時刻はミリ秒のまま保持する", async () => {
  const user = await guest();
  const before = await dates(user.id);
  const state = crypto.randomUUID();
  const start = new Request(`${origin}/api/auth/sign-in/social`, {
    headers: { Cookie: user.cookie },
  });
  await rememberGuestLink(start, env, user, state, "google");
  const target = await accountFixture(false);
  users.push(target.id);
  await env.APP_DB.prepare(`INSERT INTO account(id,accountId,providerId,userId,createdAt,updatedAt)
    VALUES(?,?,'google',?,?,?)`)
    .bind(
      crypto.randomUUID(),
      crypto.randomUUID(),
      target.id,
      new Date().toISOString(),
      new Date().toISOString(),
    )
    .run();
  await env.APP_DB.prepare("UPDATE user SET updatedAt=? WHERE id=?")
    .bind("2000-01-01T00:00:00.000Z", user.id)
    .run();
  const callback = new Request(`${origin}/api/auth/callback/google?state=${state}`, {
    headers: { Cookie: user.cookie },
  });
  await completeGuestLink(
    callback,
    new Response(null, {
      status: 302,
      headers: { "Set-Cookie": `${target.cookie}; Path=/; HttpOnly`, Location: "/account" },
    }),
    env,
  );
  const after = await dates(user.id);
  expectIsoDates(after);
  expect(after!.createdAt).toBe(before!.createdAt);
  expect(after!.updatedAt).not.toBe("2000-01-01T00:00:00.000Z");
  const promoted = await env.APP_DB.prepare(
    "SELECT isAnonymous,guestRegisteredAt FROM user WHERE id=?",
  )
    .bind(user.id)
    .first<{ isAnonymous: number; guestRegisteredAt: number }>();
  expect(promoted?.isAnonymous).toBe(0);
  expect(typeof promoted?.guestRegisteredAt).toBe("number");
});
