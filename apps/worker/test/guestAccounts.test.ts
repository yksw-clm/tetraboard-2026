import { adminIdentity } from "../src/admin/auth";
import { env, exports } from "cloudflare:workers";
import { runInDurableObject, evictDurableObject } from "cloudflare:test";
import { afterEach, expect, test, vi } from "vitest";
import { ensureGuestUsername } from "../src/accounts/guestUsernames";
import {
  accountProfileSchema,
  createRoomContract,
  joinRoomContract,
  getPlayerProfileContract,
} from "@tetraboard/protocol";
import { gameIds, gameCatalog } from "@tetraboard/protocol/games";
import { legalVersion } from "@tetraboard/protocol/privacy";
import { accountFixture, origin } from "./accountFixtures";
import { AcceptedGameRequest } from "./acceptedGameRequest";
import { accountIdentity, withAccountSessionCookies } from "../src/accounts/auth";
import { createGuestAccount, guestTokenHash, guestLifetimeMs } from "../src/accounts/guestAccounts";
import { completeGuestLink, rememberGuestLink } from "../src/accounts/guestLinking";
import { humanFixtureRecord, fixtureRecord } from "./matchFixtures";
import { writeMatch } from "../src/rooms/matchStore";
import { writeAnalyticsMatch } from "../src/analytics/store";
import { readAnalytics, japanDay } from "../src/admin/metrics";
import { requestDeletion } from "../src/privacy/deletion";

const request = (path: string, init?: RequestInit) =>
  exports.default.fetch(new AcceptedGameRequest(`${origin}/api${path}`, init));
async function guest(name = "ゲスト本人") {
  const response = await request("/account/guest", {
    method: "POST",
    headers: {
      Origin: origin,
      "Content-Type": "application/json",
      "CF-Connecting-IP": crypto.randomUUID(),
    },
    body: JSON.stringify({ name }),
  });
  expect(response.status).toBe(201);
  const user = accountProfileSchema.parse(await response.json());
  const cookie = response.headers
    .getSetCookie()
    .find((c) => c.startsWith("tetraboard-2026.guest="))!
    .split(";")[0]!;
  const headers = {
    Origin: origin,
    Cookie: cookie,
    "Content-Type": "application/json",
    "X-Legal-Consent": legalVersion,
  };
  const identity = await accountIdentity(new Request(origin, { headers }), env);
  return { user, cookie, headers, id: identity!.id };
}
async function link(g: Awaited<ReturnType<typeof guest>>, completed = true, provider = "google") {
  const state = crypto.randomUUID();
  const before = new Request(`${origin}/api/auth/sign-in/social`, { headers: g.headers });
  const identity = (await accountIdentity(before, env))!;
  await rememberGuestLink(before, env, identity, state, provider);
  const target = await accountFixture(completed);
  await env.APP_DB.prepare("UPDATE user SET createdAt=? WHERE id=?")
    .bind(new Date().toISOString(), target.id)
    .run();
  await env.APP_DB.prepare(
    "INSERT INTO account(id,accountId,providerId,userId,createdAt,updatedAt) VALUES(?,?,?,?,?,?)",
  )
    .bind(crypto.randomUUID(), crypto.randomUUID(), provider, target.id, Date.now(), Date.now())
    .run();
  const callback = new Request(`${origin}/api/auth/callback/${provider}?state=${state}`, {
    headers: { Cookie: g.cookie },
  });
  const response = new Response(null, {
    status: 302,
    headers: { "Set-Cookie": `${target.cookie}; Path=/; HttpOnly`, Location: "/account" },
  });
  await withAccountSessionCookies(callback, async () => {
    await completeGuestLink(callback, response, env);
    return response;
  });
  return { target, state, headers: { ...target.headers, Cookie: `${target.cookie}; ${g.cookie}` } };
}
test("閲覧・観戦ではゲストを作らず、名前・Origin・同意を検証して確定時だけ作る", async () => {
  const count = async () =>
    Number(
      (await env.APP_DB.prepare("SELECT COUNT(*) AS n FROM guest_sessions").first<{ n: number }>())!
        .n,
    );
  const before = await count();
  await request("/account/session");
  await request("/rooms");
  await request("/tournaments/lobby");
  for (const name of ["", " ", "あ".repeat(11)])
    expect(
      (
        await request("/account/guest", {
          method: "POST",
          headers: { Origin: origin },
          body: JSON.stringify({ name }),
        })
      ).status,
    ).toBe(400);
  expect(
    (await request("/account/guest", { method: "POST", body: JSON.stringify({ name: "名前" }) }))
      .status,
  ).toBe(403);
  expect(
    (
      await exports.default.fetch(
        new Request(`${origin}/api/account/guest`, {
          method: "POST",
          headers: { Origin: origin },
          body: JSON.stringify({ name: "名前" }),
        }),
      )
    ).status,
  ).toBe(403);
  expect(await count()).toBe(before);
  const g = await guest(" 👨‍👩‍👧‍👦 ");
  expect(g.user).toMatchObject({
    name: "👨‍👩‍👧‍👦",
    username: expect.stringMatching(/^guest_[a-f0-9]{14}$/),
    isGuest: true,
    nameCustomized: true,
  });
  expect(await count()).toBe(before + 1);
});
test("ゲストIDは同名でも一意で、旧ゲストの並行取得・登録者IDとの衝突・名前変更でも安定する", async () => {
  const g = await guest("同名"),
    other = await guest("同名"),
    registered = await accountFixture();
  expect(g.user.username).not.toBe(other.user.username);
  const collision = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const reserved = `guest_${collision.replaceAll("-", "").slice(0, 14)}`;
  await env.APP_DB.prepare("UPDATE user SET username=? WHERE id=?")
    .bind(reserved, registered.id)
    .run();
  await env.APP_DB.prepare("UPDATE user SET username=NULL WHERE id=?").bind(g.id).run();
  const uuid = vi.spyOn(crypto, "randomUUID").mockReturnValueOnce(collision);
  let assigned: string;
  try {
    assigned = await ensureGuestUsername(env.APP_DB, g.id);
    expect(assigned).not.toBe(reserved);
  } finally {
    uuid.mockRestore();
  }
  expect(
    await Promise.all([
      ensureGuestUsername(env.APP_DB, g.id),
      ensureGuestUsername(env.APP_DB, g.id),
    ]),
  ).toEqual([assigned!, assigned!]);
  const renamed = await request("/account/guest/name", {
    method: "PATCH",
    headers: g.headers,
    body: JSON.stringify({ name: "変更名", username: "changed" }),
  });
  expect(await renamed.json()).toMatchObject({ name: "変更名", username: assigned! });
  expect((await request("/account/profile", { method: "PATCH", headers: g.headers })).status).toBe(
    403,
  );
  await env.APP_DB.prepare("UPDATE user SET username=NULL WHERE id=?").bind(other.id).run();
  const card = await request(
    `${getPlayerProfileContract.path}?source=profile&profileId=${other.user.profileId}&game=four-reversi`,
  );
  const publicUser = (await card.json()) as { username: string };
  expect(publicUser.username).toMatch(/^guest_[a-f0-9]{14}$/);
  expect(
    await (await request("/account/session", { headers: other.headers })).json(),
  ).toMatchObject({ user: { username: publicUser.username } });
});
test("ゲストのログアウトを拒否して、本人認証と記録へのアクセスを維持する", async () => {
  const g = await guest();
  const response = await request("/auth/sign-out", {
    method: "POST",
    headers: g.headers,
    body: "{}",
  });
  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({ message: "ゲストはログアウトできません。" });
  expect(response.headers.getSetCookie().some((cookie) => cookie.includes("Max-Age=0"))).toBe(
    false,
  );
  expect(await (await request("/account/session", { headers: g.headers })).json()).toEqual({
    user: g.user,
  });
});
test("自動名と名前設定済みを区別し、180日Cookieで同じゲストを復元・更新する", async () => {
  const req = new AcceptedGameRequest(origin, { headers: { Origin: origin } });
  let identity: Awaited<ReturnType<typeof createGuestAccount>>;
  const response = await withAccountSessionCookies(req, async () => {
    identity = await createGuestAccount(req, env);
    return new Response(null);
  });
  expect(identity!.name).toMatch(/^ゲスト\d{5}$/);
  expect(identity!.guestNameCustomized).toBe(0);
  const cookie = response.headers.getSetCookie()[0]!;
  expect(cookie).toContain("HttpOnly");
  expect(cookie).toContain("SameSite=Lax");
  expect(cookie).toContain("Max-Age=15552000");
  const headers = { Cookie: cookie.split(";")[0]!, Origin: origin };
  const completed = await request("/account/guest", {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "本人名" }),
  });
  expect(completed.status).toBe(200);
  expect(await completed.json()).toMatchObject({ name: "本人名", nameCustomized: true });
  const hash = await guestTokenHash(new Request(origin, { headers }));
  await env.APP_DB.prepare("UPDATE guest_sessions SET expires_at_ms=? WHERE token_hash=?")
    .bind(Date.now() + 1000, hash)
    .run();
  const restored = await request("/account/session", { headers });
  expect(await restored.json()).toMatchObject({ user: { name: "本人名", isGuest: true } });
  const expiry = (await env.APP_DB.prepare(
    "SELECT expires_at_ms FROM guest_sessions WHERE token_hash=?",
  )
    .bind(hash)
    .first<{ expires_at_ms: number }>())!.expires_at_ms;
  expect(expiry).toBeGreaterThan(Date.now() + guestLifetimeMs - 10000);
  await env.APP_DB.prepare("UPDATE guest_sessions SET expires_at_ms=0 WHERE token_hash=?")
    .bind(hash)
    .run();
  expect(await (await request("/account/session", { headers })).json()).toEqual({ user: null });
});
for (const game of gameIds)
  test(`${game}: ゲスト本人として作成し、全ルーム共通1席制限を適用する`, async () => {
    const g = await guest();
    const created = await request("/rooms", {
      method: "POST",
      headers: g.headers,
      body: JSON.stringify({
        game,
        quickPlay: false,
        ...(gameCatalog[game].hasModes ? { mode: "singles" } : {}),
      }),
    });
    expect(created.status).toBe(201);
    const result = createRoomContract.response.parse(await created.json());
    createdRooms.add(result.room.id);
    expect(result.room.players[0]).toMatchObject({ name: g.user.name, isGuest: true });
    const duplicate = await request("/rooms", {
      method: "POST",
      headers: g.headers,
      body: JSON.stringify({
        game,
        quickPlay: false,
        ...(gameCatalog[game].hasModes ? { mode: "singles" } : {}),
      }),
    });
    expect(duplicate.status).toBe(409);
    expect(
      (
        await request("/auth/sign-in/social", {
          method: "POST",
          headers: g.headers,
          body: JSON.stringify({ provider: "google" }),
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await request(`/rooms/${result.room.id}/leave`, {
          method: "POST",
          headers: { ...g.headers, Authorization: `Bearer ${result.membership.token}` },
        })
      ).status,
    ).toBe(204);
    const hostResponse = await request("/rooms", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        game,
        name: "相手",
        quickPlay: false,
        ...(gameCatalog[game].hasModes ? { mode: "singles" } : {}),
      }),
    });
    const host = createRoomContract.response.parse(await hostResponse.json());
    createdRooms.add(host.room.id);
    const joinedResponse = await request(joinRoomContract.pathFor(host.room.id), {
      method: "POST",
      headers: g.headers,
      body: JSON.stringify({ instanceId: host.room.instanceId }),
    });
    expect(joinedResponse.status).toBe(200);
    const joined = (await joinedResponse.json()) as {
      room: { players: { name: string; isGuest?: boolean }[] };
      membership: { token: string };
    };
    expect(joined.room.players.find((p) => p.name === g.user.name)).toMatchObject({
      isGuest: true,
    });
    await request(`/rooms/${host.room.id}/leave`, {
      method: "POST",
      headers: { ...g.headers, Authorization: `Bearer ${joined.membership.token}` },
    });
    await request(`/rooms/${host.room.id}/leave`, {
      method: "POST",
      headers: { Origin: origin, Authorization: `Bearer ${host.membership.token}` },
    });
  });
test("ゲストの対人戦績・ランキング・公開カードを表示し、CPU戦は履歴だけにする", async () => {
  const g = await guest();
  await writeMatch(env.APP_DB, humanFixtureRecord(g.id, 1));
  await writeMatch(env.APP_DB, fixtureRecord(g.id, 2));
  const stats = await request("/account/stats?game=four-reversi", { headers: g.headers });
  expect(stats.status).toBe(200);
  expect(await stats.json()).toMatchObject({ singles: { total: 1 } });
  const history = await request("/account/matches?game=four-reversi&mode=singles", {
    headers: g.headers,
  });
  expect(history.status).toBe(200);
  expect(((await history.json()) as { matches: unknown[] }).matches).toHaveLength(2);
  const rankings = await request("/games/four-reversi/rankings?profilePreview=1");
  expect(rankings.status).toBe(200);
  const card = await request(
    `${getPlayerProfileContract.path}?source=profile&profileId=${g.user.profileId}&game=four-reversi&includeBadges=1`,
  );
  expect(card.status).toBe(200);
  expect(await card.json()).toMatchObject({
    kind: "account",
    isGuest: true,
    username: g.user.username,
    name: g.user.name,
  });
  expect(
    (
      await adminIdentity(new Request(origin, { headers: g.headers }), {
        ...env,
        ADMIN_ACCOUNT_IDS: JSON.stringify([g.id]),
      })
    ).status,
  ).toBe(401);
  expect(
    (
      await request("/lobby/chat", {
        method: "POST",
        headers: g.headers,
        body: JSON.stringify({ text: "投稿" }),
      })
    ).status,
  ).toBe(401);
});
for (const provider of ["google", "discord"])
  test(`${provider}: 新規連携は内部ID・名前・棋譜を保持して登録者へ切り替える`, async () => {
    const g = await guest(),
      record = humanFixtureRecord(g.id, 1);
    await writeMatch(env.APP_DB, record);
    const { target } = await link(g, false, provider);
    const user = await accountIdentity(new Request(origin, { headers: target.headers }), env);
    expect(user).toMatchObject({
      id: g.id,
      name: g.user.name,
      username: g.user.username,
      isAnonymous: 0,
      profileCompleted: 0,
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
test("既存アカウントへの統合は認証後の確認まで変更せず、本人だけが全記録を一度引き継ぐ", async () => {
  const g = await guest(),
    record = humanFixtureRecord(g.id, 1);
  await writeMatch(env.APP_DB, record);
  const { target, headers } = await link(g);
  expect(await (await request("/account/guest-merge", { headers })).json()).toEqual({
    pending: { guestName: g.user.name },
  });
  expect(await accountIdentity(new Request(origin, { headers: g.headers }), env)).toBeNull();
  expect(
    (await request("/account/guest-merge", { method: "POST", headers: g.headers })).status,
  ).toBe(401);
  const wrong = await accountFixture();
  expect(
    (
      await request("/account/guest-merge", {
        method: "POST",
        headers: { ...wrong.headers, Cookie: `${wrong.cookie}; ${g.cookie}` },
      })
    ).status,
  ).toBe(401);
  expect(
    (
      await request("/account/guest-merge", {
        method: "POST",
        headers: { ...headers, Origin: "https://wrong.test" },
      })
    ).status,
  ).toBe(403);
  expect((await request("/account/guest-merge", { method: "POST", headers })).status).toBe(200);
  expect(await accountIdentity(new Request(origin, { headers: g.headers }), env)).toBeNull();
  const saved = await env.APP_DB.prepare(
    "SELECT account_id FROM account_match_history WHERE match_id=?",
  )
    .bind(record.id)
    .first<{ account_id: string }>();
  expect(saved!.account_id).toBe(target.id);
  const stats = await request("/account/stats?game=four-reversi", { headers: target.headers });
  expect(await stats.json()).toMatchObject({ singles: { total: 1 } });
  expect((await request("/account/guest-merge", { method: "POST", headers })).status).toBe(401);
  // 統合前に作られた保存待ちの再送も、統合先へ記録します。
  const late = humanFixtureRecord(g.id, 2);
  await writeMatch(env.APP_DB, late);
  await writeMatch(env.APP_DB, late);
  expect(
    (await env.APP_DB.prepare("SELECT account_id FROM account_match_history WHERE match_id=?")
      .bind(late.id)
      .first<{ account_id: string }>())!.account_id,
  ).toBe(target.id);
  expect(
    await (await request("/account/stats?game=four-reversi", { headers: target.headers })).json(),
  ).toMatchObject({ singles: { total: 2 } });
});
test("同じ対局の複数席を統合せず、失敗時に記録と統合確認の資格を残す", async () => {
  const g = await guest();
  const { target, headers } = await link(g);
  const record = humanFixtureRecord(g.id, 1);
  const other = record.participants[1]!;
  if (other.kind !== "human") throw new Error();
  other.accountId = target.id;
  await writeMatch(env.APP_DB, record);
  expect((await request("/account/guest-merge", { method: "POST", headers })).status).toBe(409);
  expect(await accountIdentity(new Request(origin, { headers: g.headers }), env)).toBeNull();
  expect(await (await request("/account/guest-merge", { headers })).json()).toMatchObject({
    pending: { guestName: g.user.name },
  });
  expect(
    await env.APP_DB.prepare("SELECT guest_id FROM guest_account_merges WHERE guest_id=?")
      .bind(g.id)
      .first(),
  ).toBeNull();
});

const createdTournaments: string[] = [];
const createdRooms = new Set<string>();
afterEach(async () => {
  // 他のファイルの障害注入中に、このシナリオのAlarmを残しません。
  for (const id of createdRooms) {
    const stub = env.GAME_ROOM.getByName(id);
    await runInDurableObject(stub, async (_instance, ctx) => {
      await ctx.storage.deleteAll();
      await ctx.storage.deleteAlarm();
    });
    await evictDurableObject(stub);
  }
  createdRooms.clear();
  for (const key of createdTournaments.splice(0)) {
    const waiting = await env.APP_DB.prepare(
      "SELECT account_id FROM tournament_wait_reservations WHERE tournament_key=?",
    )
      .bind(key)
      .all<{ account_id: string }>();
    for (const row of waiting.results)
      await env.TOURNAMENT_COORDINATOR.getByName(key).cancelForAccount(row.account_id);
    await env.APP_DB.batch([
      env.APP_DB.prepare("DELETE FROM tournament_scores WHERE tournament_key=?").bind(key),
      env.APP_DB.prepare("DELETE FROM tournament_entries WHERE tournament_key=?").bind(key),
      env.APP_DB.prepare("DELETE FROM tournaments WHERE key=?").bind(key),
    ]);
  }
});
async function tournament() {
  const key = crypto.randomUUID(),
    now = Date.now();
  const id = (await env.APP_DB.prepare(
    "SELECT COALESCE(MAX(public_id),0)+1 AS n FROM tournaments",
  ).first<{ n: number }>())!.n;
  await env.APP_DB.prepare(
    "INSERT INTO tournaments(key,public_id,name,starts_at_ms,ends_at_ms,published,created_at_ms,updated_at_ms) VALUES(?,?,?,?,?,1,?,?)",
  )
    .bind(key, id, "ゲスト大会", now - 1000, now + 3600000, now, now)
    .run();
  createdTournaments.push(key);
  return { key, id };
}
test("ゲストも大会へエントリー・待機でき、同じ参加を重複登録しない", async () => {
  const g = await guest(),
    t = await tournament();
  for (let i = 0; i < 2; i++)
    expect(
      (await request(`/tournaments/${t.id}/entries`, { method: "POST", headers: g.headers }))
        .status,
    ).toBe(200);
  expect(
    (
      await env.APP_DB.prepare(
        "SELECT id FROM tournament_entries WHERE tournament_key=? AND account_id=?",
      )
        .bind(t.key, g.id)
        .all()
    ).results,
  ).toHaveLength(1);
  const operationId = crypto.randomUUID(),
    controllerId = crypto.randomUUID();
  expect(
    (
      await request(`/tournaments/${t.id}/queue`, {
        method: "POST",
        headers: g.headers,
        body: JSON.stringify({ operationId, controllerId, token: "ac".repeat(32) }),
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await request("/auth/sign-in/social", {
        method: "POST",
        headers: g.headers,
        body: JSON.stringify({ provider: "google" }),
      })
    ).status,
  ).toBe(409);
  await env.TOURNAMENT_COORDINATOR.getByName(t.key).cancelForAccount(g.id);
  expect(
    await env.APP_DB.prepare("SELECT 1 FROM tournament_wait_reservations WHERE account_id=?")
      .bind(g.id)
      .first(),
  ).toBeNull();
});
test("大会エントリーと得点の同一性を保って統合し、同じ大会の二重エントリーは拒否する", async () => {
  const g = await guest(),
    t = await tournament();
  await request(`/tournaments/${t.id}/entries`, { method: "POST", headers: g.headers });
  const entry = (await env.APP_DB.prepare(
    "SELECT id FROM tournament_entries WHERE tournament_key=? AND account_id=?",
  )
    .bind(t.key, g.id)
    .first<{ id: string }>())!.id;
  await env.APP_DB.prepare(
    "INSERT INTO tournament_scores(entry_id,tournament_key,points_units,games,first) VALUES(?,?,10,1,1)",
  )
    .bind(entry, t.key)
    .run();
  const linked = await link(g);
  expect(
    (await request("/account/guest-merge", { method: "POST", headers: linked.headers })).status,
  ).toBe(200);
  expect(
    await env.APP_DB.prepare("SELECT account_id FROM tournament_entries WHERE id=?")
      .bind(entry)
      .first(),
  ).toEqual({ account_id: linked.target.id });
  expect(
    await env.APP_DB.prepare("SELECT points_units,games FROM tournament_scores WHERE entry_id=?")
      .bind(entry)
      .first(),
  ).toEqual({ points_units: 10, games: 1 });
  const other = await guest();
  expect(
    (await request(`/tournaments/${t.id}/entries`, { method: "POST", headers: other.headers }))
      .status,
  ).toBe(200);
  const conflict = await link(other);
  await request(`/tournaments/${t.id}/entries`, {
    method: "POST",
    headers: conflict.target.headers,
  });
  expect(
    (await request("/account/guest-merge", { method: "POST", headers: conflict.headers })).status,
  ).toBe(409);
  expect(await accountIdentity(new Request(origin, { headers: other.headers }), env)).toBeNull();
  expect(
    await (await request("/account/guest-merge", { headers: conflict.headers })).json(),
  ).toMatchObject({ pending: { guestName: other.user.name } });
});
test("管理の参加者計測は、アカウントIDのあるゲストも開始時のゲスト区分で集計する", async () => {
  const g = await guest(),
    now = Date.now(),
    id = crypto.randomUUID(),
    day = japanDay(now);
  const query = {
    from: day,
    to: day,
    game: "all",
    bucket: "day",
    includeInternal: "true",
  } as const;
  const before = await readAnalytics(env, query);
  await writeAnalyticsMatch(env.APP_DB, {
    id,
    game: "four-reversi",
    mode: "singles",
    startedAtMs: now,
    endedAtMs: now + 1,
    status: "completed",
    cpuCount: 0,
    participants: [
      {
        playerId: crypto.randomUUID(),
        accountId: g.id,
        visitorId: crypto.randomUUID(),
        isTest: false,
        isGuest: true,
      },
    ],
  });
  const after = await readAnalytics(env, query);
  expect(after.summary.guestActive).toBe(before.summary.guestActive! + 1);
  expect(after.summary.registeredActive).toBe(before.summary.registeredActive);
  await link(g, false);
  expect((await readAnalytics(env, query)).summary.guestActive).toBe(after.summary.guestActive);
});
test("統合した戦績の合計でバッジを判定し、既存の獲得記録を二重作成しない", async () => {
  const g = await guest(),
    linked = await link(g);
  for (let i = 0; i < 4; i++)
    await writeMatch(env.APP_DB, humanFixtureRecord(linked.target.id, i + 1));
  await writeMatch(env.APP_DB, humanFixtureRecord(g.id, 1));
  expect(
    (await request("/account/guest-merge", { method: "POST", headers: linked.headers })).status,
  ).toBe(200);
  expect(
    await env.APP_DB.prepare(
      "SELECT COUNT(*) AS n FROM account_badge_awards WHERE account_id=? AND badge_id='games' AND tier=1",
    )
      .bind(linked.target.id)
      .first(),
  ).toEqual({ n: 1 });
});
test("統合後の退会で、元ゲストの保存待ち・遅延した棋譜からも名前と本人参照を除去する", async () => {
  const g = await guest(),
    linked = await link(g),
    roomId = `guest-privacy-${crypto.randomUUID()}`;
  createdRooms.add(roomId);
  const stub = env.GAME_ROOM.getByName(roomId),
    record = humanFixtureRecord(g.id, 1);
  await runInDurableObject(stub, (_instance, ctx) => {
    ctx.storage.kv.put("guest-record-fixture", { record });
  });
  await env.APP_DB.prepare("INSERT INTO privacy_room_accounts VALUES(?,?)")
    .bind(g.id, roomId)
    .run();
  expect(
    (await request("/account/guest-merge", { method: "POST", headers: linked.headers })).status,
  ).toBe(200);
  expect(await requestDeletion(env, linked.target.id, crypto.randomUUID())).toBe(true);
  await stub.purgeAccount(linked.target.id);
  const pending = await runInDurableObject(stub, (_instance, ctx) =>
    ctx.storage.kv.get<{ record: typeof record }>("guest-record-fixture"),
  );
  expect(pending!.record.participants[0]).toMatchObject({
    accountId: null,
    name: "退会したプレイヤー",
    retired: true,
  });
  await env.APP_DB.prepare("DELETE FROM user WHERE id=?").bind(linked.target.id).run();
  const late = humanFixtureRecord(g.id, 2);
  await writeMatch(env.APP_DB, late);
  const row = await env.APP_DB.prepare("SELECT record_json FROM matches WHERE id=?")
    .bind(late.id)
    .first<{ record_json: string }>();
  expect(JSON.parse(row!.record_json).participants[0]).toMatchObject({
    accountId: null,
    name: "退会したプレイヤー",
    retired: true,
  });
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
