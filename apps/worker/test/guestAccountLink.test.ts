import { env } from "cloudflare:workers";
import { expect, test } from "vitest";
import { avatarPresets, createRoomContract } from "@tetraboard/protocol";
import { legalVersion } from "@tetraboard/protocol/privacy";
import { accountFixture, origin } from "./accountFixtures";
import { accountIdentity } from "../src/adapters/account/auth";
import { completeGuestLink } from "../src/routes/guestLinkOAuth";
import { humanFixtureRecord } from "./matchFixtures";
import { writeMatch } from "../src/flows/matchSave/snapshot";
import { guest, link, request, trackGuestAccountRooms } from "./guestAccountsFixtures";

const createdRooms = trackGuestAccountRooms();

for (const provider of ["google", "discord"])
  test(`${provider}: 新規連携は内部ID・名前・棋譜を保持して登録者へ切り替える`, async () => {
    const g = await guest(),
      record = humanFixtureRecord(g.id, 1);
    await writeMatch(env.APP_DB, record);
    await env.APP_DB.prepare("UPDATE user SET avatarPresetId=? WHERE id=?")
      .bind(avatarPresets[4].id, g.id)
      .run();
    const { target } = await link(g, false, provider);
    const user = await accountIdentity(new Request(origin, { headers: target.headers }), env);
    expect(user).toMatchObject({
      id: g.id,
      name: g.user.name,
      username: g.user.username,
      isAnonymous: 0,
      profileCompleted: 0,
      avatarPresetId: avatarPresets[4].id,
    });
    expect(await accountIdentity(new Request(origin, { headers: g.headers }), env)).toBeNull();
    expect(
      await env.APP_DB.prepare("SELECT id FROM user WHERE id=?").bind(target.id).first(),
    ).toBeNull();
    expect(
      (await env.APP_DB.prepare("SELECT userId FROM account WHERE userId=?").bind(g.id).all())
        .results,
    ).toHaveLength(1);
    expect(
      (await env.APP_DB.prepare("SELECT account_id FROM account_match_history WHERE match_id=?")
        .bind(record.id)
        .first<{ account_id: string }>())!.account_id,
    ).toBe(g.id);
    const form = new FormData();
    form.set("name", g.user.name);
    form.set("username", g.user.username!);
    form.set("avatarAction", "keep");
    form.set("consentVersion", legalVersion);
    const headers = { Cookie: target.cookie, Origin: origin };
    expect((await request("/account/setup", { method: "POST", headers, body: form })).status).toBe(
      200,
    );
    const changed = `member_${g.id.replaceAll("-", "").slice(0, 12)}`;
    form.set("username", changed);
    const edited = await request("/account/profile", { method: "PATCH", headers, body: form });
    expect(edited.status).toBe(200);
    expect(await edited.json()).toMatchObject({ username: changed });
  });

for (const played of [false, true])
  test(`既存アカウントへ引き継がずにログインしてログアウトしても元ゲストへ戻らない（対局${played ? "あり" : "なし"}）`, async () => {
    const g = await guest();
    const record = played ? humanFixtureRecord(g.id, 1) : null;
    if (record) await writeMatch(env.APP_DB, record);
    const { target, headers } = await link(g);
    expect(await accountIdentity(new Request(origin, { headers: g.headers }), env)).toBeNull();
    const wrong = await accountFixture();
    await request("/account/guest-merge", {
      method: "DELETE",
      headers: { ...wrong.headers, Cookie: `${wrong.cookie}; ${g.cookie}` },
    });
    expect(await (await request("/account/guest-merge", { headers })).json()).toMatchObject({
      pending: { guestName: g.user.name },
    });
    expect(
      (
        await request("/account/guest-merge", {
          method: "DELETE",
          headers: { ...headers, Origin: "https://wrong.test" },
        })
      ).status,
    ).toBe(403);
    const discarded = await request("/account/guest-merge", { method: "DELETE", headers });
    expect(discarded.status).toBe(200);
    expect(
      discarded.headers
        .getSetCookie()
        .some(
          (cookie) => cookie.startsWith("tetraboard-2026.guest=") && cookie.includes("Max-Age=0"),
        ),
    ).toBe(true);
    expect(
      await (await request("/account/session", { headers: target.headers })).json(),
    ).toMatchObject({ user: { username: target.username } });
    expect((await request("/auth/sign-out", { method: "POST", headers, body: "{}" })).status).toBe(
      200,
    );
    expect(await (await request("/account/session", { headers: g.headers })).json()).toEqual({
      user: null,
    });
    expect(
      await env.APP_DB.prepare("SELECT name,username FROM user WHERE id=?").bind(g.id).first(),
    ).toEqual({ name: g.user.name, username: g.user.username });
    expect(
      await env.APP_DB.prepare("SELECT 1 FROM guest_account_merges WHERE guest_id=?")
        .bind(g.id)
        .first(),
    ).toBeNull();
    if (record)
      expect(
        await env.APP_DB.prepare("SELECT account_id FROM account_match_history WHERE match_id=?")
          .bind(record.id)
          .first(),
      ).toEqual({ account_id: g.id });
  });

test("引き継ぎ確認を終えずログアウトした場合も、ゲスト資格と保留中の手続きを失効させる", async () => {
  const g = await guest(),
    linked = await link(g);
  const response = await request("/auth/sign-out", {
    method: "POST",
    headers: linked.headers,
    body: "{}",
  });
  expect(response.status).toBe(200);
  expect(await (await request("/account/session", { headers: g.headers })).json()).toEqual({
    user: null,
  });
  expect(
    await env.APP_DB.prepare("SELECT 1 FROM guest_oauth_flows WHERE guest_id=?").bind(g.id).first(),
  ).toBeNull();
  expect(
    await env.APP_DB.prepare("SELECT 1 FROM user WHERE id=?").bind(g.id).first(),
  ).not.toBeNull();
});

test("旧Cookieの並存と統合フローを持たない認証でも、登録者から元ゲストへ自動復帰しない", async () => {
  const g = await guest(),
    registered = await accountFixture();
  const headers = { ...registered.headers, Cookie: `${registered.cookie}; ${g.cookie}` };
  expect(await (await request("/account/session", { headers })).json()).toMatchObject({
    user: { username: registered.username },
  });
  expect(await accountIdentity(new Request(origin, { headers: g.headers }), env)).toBeNull();
  const adminGuest = await guest(),
    admin = await accountFixture();
  const callback = new Request(`${origin}/api/auth/callback/google?state=admin-login`, {
    headers: adminGuest.headers,
  });
  await completeGuestLink(
    callback,
    new Response(null, {
      status: 302,
      headers: { "Set-Cookie": `${admin.cookie}; Path=/; HttpOnly`, Location: "/admin" },
    }),
    env,
  );
  expect(
    await accountIdentity(new Request(origin, { headers: adminGuest.headers }), env),
  ).toBeNull();
  expect(
    await env.APP_DB.prepare("SELECT 1 FROM user WHERE id=?").bind(adminGuest.id).first(),
  ).not.toBeNull();
});

test("登録者のセッション期限切れ・OAuth取消でも意図しないゲストへの復帰や失効を起こさない", async () => {
  const g = await guest(),
    linked = await link(g);
  await env.APP_DB.prepare("UPDATE session SET expiresAt=0 WHERE userId=?")
    .bind(linked.target.id)
    .run();
  expect(await (await request("/account/session", { headers: linked.headers })).json()).toEqual({
    user: null,
  });
  // ブラウザが期限切れの登録Cookieを除去した後も、ゲストCookieで本人に戻りません。
  expect(await (await request("/account/session", { headers: g.headers })).json()).toEqual({
    user: null,
  });
  const cancelled = await guest();
  const callback = new Request(`${origin}/api/auth/callback/google?error=access_denied`, {
    headers: cancelled.headers,
  });
  await completeGuestLink(
    callback,
    new Response(null, {
      status: 302,
      headers: {
        Location: "/login?error=access_denied",
        "Set-Cookie": `${linked.target.cookie}; Path=/; HttpOnly`,
      },
    }),
    env,
  );
  expect(
    await accountIdentity(new Request(origin, { headers: cancelled.headers }), env),
  ).toMatchObject({ id: cancelled.id });
});

test("OAuth開始後の別タブ参加で連携を止めても、退室後の再試行で元の内部IDを保持する", async () => {
  const g = await guest();
  const created = await request("/rooms", {
    method: "POST",
    headers: g.headers,
    body: JSON.stringify({ game: "reversi", quickPlay: false }),
  });
  const room = createRoomContract.response.parse(await created.json());
  createdRooms.add(room.room.id);
  // 別タブの参加がOAuth開始後に届いた状態を、確定済みの対応を使って再現します。
  const linked = await link(g, false);
  expect(await (await request("/account/guest-merge", { headers: linked.headers })).json()).toEqual(
    { pending: { guestName: g.user.name, isNewTarget: true } },
  );
  await request(`/rooms/${room.room.id}/leave`, {
    method: "POST",
    headers: { ...g.headers, Authorization: `Bearer ${room.membership.token}` },
  });
  expect(
    (await request("/account/guest-merge", { method: "POST", headers: linked.headers })).status,
  ).toBe(200);
  expect(
    await accountIdentity(new Request(origin, { headers: linked.target.headers }), env),
  ).toMatchObject({ id: g.id, isAnonymous: 0 });
});
