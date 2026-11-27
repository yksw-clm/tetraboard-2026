import { fixTestTime } from "./fixedTimeFixture";
import { adminIdentity } from "../src/admin/auth";
import { env, exports } from "cloudflare:workers";
import { expect, test, vi } from "vitest";
import { avatarPresets, getPlayerProfileContract } from "@tetraboard/protocol";
import { legalVersion } from "@tetraboard/protocol/privacy";
import { accountFixture, origin } from "./accountFixtures";
import { AcceptedGameRequest } from "./acceptedGameRequest";
import { withAccountSessionCookies } from "../src/adapters/account/auth";
import { createGuestAccount, guestTokenHash, guestLifetimeMs } from "../src/routes/guestSession";
import { humanFixtureRecord, fixtureRecord } from "./matchFixtures";
import { writeMatch } from "../src/flows/matchSave/snapshot";
import { request, guest } from "./guestAccountsFixtures";
import { publishedChatTournament } from "./tournamentChatFixtures";

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

test("ゲストIDは同名でも一意で、登録者IDとの衝突を再試行し、名前変更でも安定する", async () => {
  const g = await guest("同名"),
    other = await guest("同名"),
    registered = await accountFixture();
  expect(g.user.username).not.toBe(other.user.username);
  const collision = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const reserved = `guest_${collision.replaceAll("-", "").slice(0, 14)}`;
  await env.APP_DB.prepare("UPDATE user SET username=? WHERE id=?")
    .bind(reserved.toUpperCase(), registered.id)
    .run();
  const id = crypto.randomUUID(),
    profileId = crypto.randomUUID();
  const uuid = vi
    .spyOn(crypto, "randomUUID")
    .mockReturnValueOnce(id)
    .mockReturnValueOnce(profileId)
    .mockReturnValueOnce(collision);
  let created: Awaited<ReturnType<typeof createGuestAccount>>;
  try {
    created = await createGuestAccount(
      new AcceptedGameRequest(origin, { headers: { Origin: origin } }),
      env,
      "衝突後の名前",
    );
  } finally {
    uuid.mockRestore();
  }
  expect(created!.username).toMatch(/^guest_[a-f0-9]{14}$/);
  expect(created!.username).not.toBe(reserved);
  expect(await env.APP_DB.prepare("SELECT username FROM user WHERE id=?").bind(id).first()).toEqual(
    { username: created!.username },
  );
  expect(
    await env.APP_DB.prepare("SELECT COUNT(*) AS n FROM guest_sessions WHERE account_id=?")
      .bind(id)
      .first(),
  ).toEqual({ n: 1 });
  expect(
    await env.APP_DB.prepare("SELECT version FROM legal_consents WHERE account_id=?")
      .bind(id)
      .first(),
  ).toEqual({ version: legalVersion });
  const renamed = await request("/account/guest/name", {
    method: "PATCH",
    headers: g.headers,
    body: JSON.stringify({ name: "変更名" }),
  });
  expect(await renamed.json()).toMatchObject({ name: "変更名", username: g.user.username });
  expect((await request("/account/profile", { method: "PATCH", headers: g.headers })).status).toBe(
    403,
  );
});

test("ゲスト作成の同意保存に失敗しても利用者・ID・本人資格を部分保存しない", async () => {
  const id = crypto.randomUUID();
  const req = new AcceptedGameRequest(origin, { headers: { Origin: origin } });
  await env.APP_DB.prepare(
    `CREATE TRIGGER fail_guest_creation_consent BEFORE INSERT ON legal_consents
    WHEN NEW.account_id='${id}' BEGIN SELECT RAISE(ABORT,'Test guest consent failure'); END`,
  ).run();
  const uuid = vi.spyOn(crypto, "randomUUID").mockReturnValueOnce(id);
  try {
    const response = await withAccountSessionCookies(req, async () => {
      await expect(createGuestAccount(req, env, "作成失敗", avatarPresets[2].id)).rejects.toThrow(
        "Test guest consent failure",
      );
      return new Response(null, { status: 503 });
    });
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(await env.APP_DB.prepare("SELECT id FROM user WHERE id=?").bind(id).first()).toBeNull();
    expect(
      await env.APP_DB.prepare("SELECT account_id FROM guest_sessions WHERE account_id=?")
        .bind(id)
        .first(),
    ).toBeNull();
    expect(
      await env.APP_DB.prepare("SELECT account_id FROM legal_consents WHERE account_id=?")
        .bind(id)
        .first(),
    ).toBeNull();
  } finally {
    uuid.mockRestore();
    await env.APP_DB.exec("DROP TRIGGER fail_guest_creation_consent");
  }
});

test("ゲストIDの衝突が続いても未設定IDや本人資格を残さない", async () => {
  const registered = await accountFixture();
  const collision = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const reserved = `guest_${collision.replaceAll("-", "").slice(0, 14)}`;
  await env.APP_DB.prepare("UPDATE user SET username=? WHERE id=?")
    .bind(reserved, registered.id)
    .run();
  const id = crypto.randomUUID(),
    profileId = crypto.randomUUID();
  const uuid = vi
    .spyOn(crypto, "randomUUID")
    .mockReturnValue(collision)
    .mockReturnValueOnce(id)
    .mockReturnValueOnce(profileId);
  try {
    await expect(
      createGuestAccount(
        new AcceptedGameRequest(origin, { headers: { Origin: origin } }),
        env,
        "衝突が続く",
      ),
    ).rejects.toThrow("Guest username allocation failed");
    expect(await env.APP_DB.prepare("SELECT id FROM user WHERE id=?").bind(id).first()).toBeNull();
    expect(
      await env.APP_DB.prepare("SELECT account_id FROM guest_sessions WHERE account_id=?")
        .bind(id)
        .first(),
    ).toBeNull();
  } finally {
    uuid.mockRestore();
  }
});

test("既存ゲストのID未設定を本人・公開プロフィール・ランキング取得時に補完しない", async () => {
  const g = await guest("未設定のゲスト");
  await writeMatch(env.APP_DB, humanFixtureRecord(g.id, 1));
  await env.APP_DB.prepare("UPDATE user SET username=NULL WHERE id=?").bind(g.id).run();
  const card = await request(
    `${getPlayerProfileContract.path}?source=profile&profileId=${g.user.profileId}&game=four-reversi`,
  );
  expect(card.status).toBe(200);
  expect(await card.json()).toMatchObject({ username: null });
  const session = await request("/account/session", { headers: g.headers });
  expect(session.status).toBe(200);
  expect(await session.json()).toMatchObject({ user: { username: null } });
  const rankings = await request("/games/four-reversi/rankings?profilePreview=1");
  expect(rankings.status).toBe(200);
  const body = (await rankings.json()) as {
    singles: { total: { name: string; username: string | null }[] };
  };
  expect(body.singles.total.find((entry) => entry.name === g.user.name)).toMatchObject({
    username: null,
  });
  expect(
    await env.APP_DB.prepare("SELECT username FROM user WHERE id=?").bind(g.id).first(),
  ).toEqual({ username: null });
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
  fixTestTime();
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
    body: JSON.stringify({ name: "本人名", avatarPresetId: avatarPresets[4].id }),
  });
  expect(completed.status).toBe(200);
  expect(await completed.json()).toMatchObject({
    name: "本人名",
    nameCustomized: true,
    avatarPresetId: avatarPresets[4].id,
  });
  const repeated = await request("/account/guest", {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "別タブ", avatarPresetId: avatarPresets[1].id }),
  });
  expect(await repeated.json()).toMatchObject({
    name: "本人名",
    avatarPresetId: avatarPresets[4].id,
  });
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
});

test("名前設定済みゲストは大会へのエントリーを確定してから投稿できる", async () => {
  const id = 74205;
  const tournament = await publishedChatTournament(env.APP_DB, id);
  const g = await guest();
  const post = () =>
    request(tournament.path, {
      method: "POST",
      headers: g.headers,
      body: JSON.stringify({ text: "応援しています", requestId: crypto.randomUUID() }),
    });

  expect((await post()).status).toBe(403);
  expect(
    (await request(`/tournaments/${id}/entries`, { method: "POST", headers: g.headers })).status,
  ).toBe(200);
  expect((await post()).status).toBe(200);
});
