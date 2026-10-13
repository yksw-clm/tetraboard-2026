import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { legalVersion } from "@tetraboard/protocol/privacy";
import {
  createRoomContract,
  joinRoomContract,
  registrationStatusSchema,
} from "@tetraboard/protocol";
import { registrationRoutes } from "../src/accounts/registrationRoutes";
import { accountRoutes } from "../src/accounts/accountRoutes";
import { readRegistrationFlow } from "../src/accounts/registrationFlows";
import { accountSessionIdentity } from "../src/accounts/auth";
import { digest } from "../src/privacy/deletion";
import { applyMatchClaims } from "../src/accounts/matchClaims";
import { accountFixture, origin } from "./accountFixtures";
import { boundaryRequest, RoomBoundaryFixtures } from "./roomBoundaryFixtures";
const request = (path: string, init?: RequestInit) =>
  boundaryRequest(path, { redirect: "manual", ...init });

let fixtures: RoomBoundaryFixtures;
beforeEach(() => {
  fixtures = new RoomBoundaryFixtures();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fixtures.dispose();
});
const cookies = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((v) => v.split(";")[0])
    .join("; ");
const credential = () => ({
  registrationId: crypto.randomUUID(),
  secret: crypto.randomUUID().replaceAll("-", "").repeat(2),
});
type Credential = ReturnType<typeof credential>;
const headers = (flow: Credential, cookie?: string) => ({
  Origin: origin,
  Authorization: `Bearer ${flow.secret}`,
  ...(cookie ? { Cookie: cookie } : {}),
});
const registrationRequest = (
  flow: Credential,
  action: "complete" | "cancel" | "",
  cookie?: string,
  body?: unknown,
) =>
  request(`/registrations/${flow.registrationId}${action ? `/${action}` : ""}`, {
    method: action ? "POST" : "GET",
    headers: headers(flow, cookie),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
async function session(cookie: string) {
  return (await accountSessionIdentity(new Request(origin, { headers: { Cookie: cookie } }), env))!;
}
async function bind(flow: Credential, cookie: string) {
  const identity = await session(cookie);
  await env.APP_DB.prepare("UPDATE registration_flows SET account_id=?,session_id=? WHERE id=?")
    .bind(identity.user.id, identity.sessionId, flow.registrationId)
    .run();
  return identity;
}
async function seedFlow(cookie?: string) {
  const flow = credential();
  const now = Date.now();
  await env.APP_DB.prepare(`INSERT INTO registration_flows
    (id,secret_hash,room_id,instance_id,match_id,player_id,old_token_hash,new_token_hash,created_at_ms,hold_until_ms,claim_until_ms)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(
      flow.registrationId,
      await digest(flow.secret),
      "98123",
      crypto.randomUUID(),
      crypto.randomUUID(),
      crypto.randomUUID(),
      "a".repeat(64),
      "b".repeat(64),
      now,
      now + 600_000,
      now + 3_600_000,
    )
    .run();
  if (cookie) await bind(flow, cookie);
  return flow;
}
async function setup(opponentCookie?: string) {
  const entry = await fixtures.create({ game: "reversi", name: "ゲスト本人", quickPlay: false });
  const host = await fixtures.connect(entry);
  const other = opponentCookie
    ? joinRoomContract.response.parse(
        await (
          await request(`/rooms/${entry.room.id}/players`, {
            method: "POST",
            headers: { Cookie: opponentCookie, Origin: origin, "Content-Type": "application/json" },
            body: "{}",
          })
        ).json(),
      )
    : await fixtures.join(entry.room.id, "対戦相手");
  const client = await fixtures.open(entry.room.id);
  client.send({ type: "room.auth", token: other.membership.token });
  await client.waitFor("room.authenticated");
  host.send({ type: "room.ready.set", ready: true });
  client.send({ type: "room.ready.set", ready: true });
  await host.waitFor("room.snapshot", (m) => m.room.players.every((p) => p.ready));
  host.send({ type: "room.game.start" });
  await host.waitFor("room.snapshot", (m) => m.room.status === "playing");
  expect(
    (
      await request(`/rooms/${entry.room.id}/leave`, {
        method: "POST",
        headers: { Origin: origin, Authorization: `Bearer ${other.membership.token}` },
      })
    ).status,
  ).toBe(204);
  fixtures.forgetDepartedPlayer(other.membership.playerId);
  const room = (await host.waitFor("room.snapshot", (m) => m.room.lastRound !== null)).room;
  const last = room.lastRound!;
  const matchId = "roundId" in last ? last.roundId : last.replay!.id;
  const flow = credential();
  const nextToken = "ac".repeat(32);
  const body = {
    ...flow,
    instanceId: room.instanceId,
    matchId,
    newTokenHash: await digest(nextToken),
  };
  const response = await request(`/rooms/${room.id}/registration`, {
    method: "POST",
    headers: {
      Origin: origin,
      Authorization: `Bearer ${entry.membership.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(200);
  const status = registrationStatusSchema.parse(await response.json());
  return { flow, entry, host, room, matchId, body, nextToken, status };
}
const signIn = (flow?: Credential, extra: Record<string, unknown> = {}) =>
  request("/auth/sign-in/social", {
    method: "POST",
    headers: {
      Origin: origin,
      "Content-Type": "application/json",
      "X-Legal-Consent": legalVersion,
    },
    body: JSON.stringify({
      provider: "discord",
      ...(flow ? { registration: flow } : {}),
      ...extra,
    }),
  });
async function startOAuth(flow?: Credential, extra?: Record<string, unknown>) {
  const response = await signIn(flow, extra);
  expect(response.status).toBe(200);
  const url = new URL(((await response.json()) as { url: string }).url);
  return { state: url.searchParams.get("state")!, cookie: cookies(response) };
}
const callback = (auth: Awaited<ReturnType<typeof startOAuth>>, query = "code=code") =>
  request(`/auth/callback/discord?${query}&state=${encodeURIComponent(auth.state)}`, {
    headers: { Cookie: auth.cookie },
  });
function discord() {
  const id = `${Date.now()}${Math.floor(Math.random() * 100000)}`;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url === "https://discord.com/api/oauth2/token")
      return Response.json({
        access_token: "mock-token",
        token_type: "Bearer",
        expires_in: 3600,
        scope: "identify email",
      });
    if (decodeURIComponent(url) === "https://discord.com/api/users/@me")
      return Response.json({
        id,
        email: `${id}@example.test`,
        username: "外部名",
        global_name: "外部名",
        avatar: null,
        discriminator: "0",
        verified: true,
      });
    throw new Error(`Unexpected OAuth request: ${url}`);
  });
}
function profileBody() {
  const data = new FormData();
  data.set("name", "登録した本人");
  data.set("username", `u_${crypto.randomUUID().slice(0, 8)}`);
  data.set("avatarAction", "keep");
  data.set("consentVersion", legalVersion);
  return data;
}
function profileRequest(flow: Credential, cookie: string) {
  return new Request(`${origin}/account/setup`, {
    method: "POST",
    headers: {
      Origin: origin,
      Cookie: cookie,
      "X-Registration-Id": flow.registrationId,
      "X-Registration-Secret": flow.secret,
    },
    body: profileBody(),
  });
}
async function accountRequest(request: Request, bindings = env) {
  const ctx = createExecutionContext();
  const response = await accountRoutes.fetch(request, bindings, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

test("開始資格の拒否と別Originでは未認証フローを残さず、資格は他人へ公開しない", async () => {
  const entry = await fixtures.create({ game: "reversi", name: "ゲスト", quickPlay: false });
  const flow = credential();
  const body = {
    ...flow,
    instanceId: entry.room.instanceId,
    matchId: crypto.randomUUID(),
    newTokenHash: "ab".repeat(32),
  };
  const response = await request(`/rooms/${entry.room.id}/registration`, {
    method: "POST",
    headers: { Origin: origin, Authorization: `Bearer ${"aa".repeat(32)}` },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(401);
  expect(await readRegistrationFlow(env.APP_DB, flow.registrationId)).toBeNull();
  expect(
    (
      await request(`/rooms/${entry.room.id}/registration`, {
        method: "POST",
        headers: { Origin: "https://evil.test" },
        body: JSON.stringify(body),
      })
    ).status,
  ).toBe(403);
  expect((await registrationRequest(flow, "")).status).toBe(401);
});

test("実OAuth stateから新規プロフィールを作成し、選択局・同じ席を引き継いで再送できる", async () => {
  const prepared = await setup();
  discord();
  const authenticated = await callback(await startOAuth(prepared.flow));
  expect(authenticated.headers.get("Location")).toContain("/account/setup");
  const cookie = cookies(authenticated);
  const identity = await session(cookie);
  expect(await readRegistrationFlow(env.APP_DB, prepared.flow.registrationId)).toMatchObject({
    account_id: identity.user.id,
    session_id: identity.sessionId,
  });
  expect(await (await registrationRequest(prepared.flow, "", cookie)).json()).toMatchObject({
    identity: "profile_required",
    record: "unclaimed",
    seat: "held",
  });
  const saved = await accountRequest(profileRequest(prepared.flow, cookie));
  expect(saved.status).toBe(200);
  const original = await env.APP_DB.prepare("SELECT record_json FROM matches WHERE id=?")
    .bind(prepared.matchId)
    .first();
  const completed = await registrationRequest(prepared.flow, "complete", cookie);
  expect(completed.status).toBe(200);
  expect(await completed.json()).toMatchObject({
    identity: "ready",
    record: "complete",
    seat: "complete",
  });
  prepared.entry.membership.token = prepared.nextToken;
  expect(await (await registrationRequest(prepared.flow, "complete", cookie)).json()).toMatchObject(
    { record: "complete", seat: "complete" },
  );
  expect(
    await env.APP_DB.prepare("SELECT record_json FROM matches WHERE id=?")
      .bind(prepared.matchId)
      .first(),
  ).toEqual(original);
  expect(
    await env.APP_DB.prepare(
      "SELECT COUNT(*) AS count FROM account_match_history WHERE account_id=? AND match_id=?",
    )
      .bind(identity.user.id, prepared.matchId)
      .first(),
  ).toEqual({ count: 1 });
  expect((await fixtures.snapshot(prepared.room.id)).room.players[0]).toMatchObject({
    id: prepared.entry.membership.playerId,
    name: "登録した本人",
    ready: false,
  });
  expect(
    (await registrationRequest(prepared.flow, "cancel", cookie, { signOut: true })).status,
  ).toBe(409);
  expect(await session(cookie)).not.toBeNull();
});

test("固定したaccount/session以外とCookie喪失を区別し、同account再OAuthも再固定しない", async () => {
  discord();
  const flow = await seedFlow();
  const first = await callback(await startOAuth(flow));
  const firstCookie = cookies(first);
  const fixed = await readRegistrationFlow(env.APP_DB, flow.registrationId);
  const second = await callback(await startOAuth());
  const secondCookie = cookies(second);
  expect((await session(firstCookie)).user.id).toBe((await session(secondCookie)).user.id);
  expect((await session(firstCookie)).sessionId).not.toBe((await session(secondCookie)).sessionId);
  const other = await accountFixture(false);
  for (const cookie of [secondCookie, other.cookie]) {
    expect(await (await registrationRequest(flow, "", cookie)).json()).toMatchObject({
      identity: "mismatch",
    });
    expect((await registrationRequest(flow, "complete", cookie)).status).toBe(409);
    expect((await accountRequest(profileRequest(flow, cookie))).status).toBe(409);
  }
  expect(await (await registrationRequest(flow, "")).json()).toMatchObject({
    identity: "mismatch",
  });
  expect((await signIn(flow)).status).toBe(409);
  expect(await readRegistrationFlow(env.APP_DB, flow.registrationId)).toEqual(fixed);
  expect(
    (await registrationRequest({ ...flow, secret: "ff".repeat(32) }, "", firstCookie)).status,
  ).toBe(401);
});

test.each(["superseded", "cancelled", "expired"])(
  "OAuth callbackは%sのstateから帰属を確定しない",
  async (condition) => {
    discord();
    const flow = await seedFlow();
    const auth = await startOAuth(flow);
    if (condition === "superseded") await startOAuth(flow);
    if (condition === "cancelled")
      expect((await registrationRequest(flow, "cancel")).status).toBe(200);
    if (condition === "expired")
      await env.APP_DB.prepare("UPDATE registration_flows SET claim_until_ms=? WHERE id=?")
        .bind(Date.now(), flow.registrationId)
        .run();
    await callback(auth);
    expect(await readRegistrationFlow(env.APP_DB, flow.registrationId)).toMatchObject({
      account_id: null,
      session_id: null,
    });
  },
);

test.each(["same", "other-account", "other-session", "keep-login"])(
  "取消は固定sessionだけを終了し現在の別ログインを維持する: %s",
  async (kind) => {
    discord();
    const flow = await seedFlow();
    const firstCookie = cookies(await callback(await startOAuth(flow)));
    const fixed = await session(firstCookie);
    const currentCookie =
      kind === "other-session"
        ? cookies(await callback(await startOAuth()))
        : kind === "other-account"
          ? (await accountFixture()).cookie
          : firstCookie;
    const current = await session(currentCookie);
    const response = await registrationRequest(flow, "cancel", currentCookie, {
      signOut: kind !== "keep-login",
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ seat: "cancelled" });
    expect(
      await env.APP_DB.prepare("SELECT id FROM session WHERE id=?").bind(fixed.sessionId).first(),
    ).toEqual(kind === "keep-login" ? { id: fixed.sessionId } : null);
    if (kind === "other-account" || kind === "other-session")
      expect(
        await env.APP_DB.prepare("SELECT id FROM session WHERE id=?")
          .bind(current.sessionId)
          .first(),
      ).toEqual({ id: current.sessionId });
    expect(
      response.headers
        .getSetCookie()
        .some((v) => v.includes("session_token=;") && v.includes("Max-Age=0")),
    ).toBe(kind === "same");
  },
);

test("既存アカウントの古い席予約を回収後も同意済みの引継ぎで同じ席へ切り替える", async () => {
  const prepared = await setup();
  const user = await accountFixture();
  await bind(prepared.flow, user.cookie);
  await env.APP_DB.prepare(`INSERT INTO account_room_seats (account_id,operation_id,room_id,instance_id,player_id,name,avatar_key,created_at_ms)
    VALUES (?,?,?,?,?,?,NULL,?)`)
    .bind(
      user.id,
      crypto.randomUUID(),
      "98456",
      crypto.randomUUID(),
      crypto.randomUUID(),
      "登録名",
      Date.now() - 60_000,
    )
    .run();
  const response = await registrationRequest(prepared.flow, "complete", user.cookie);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ record: "complete", seat: "complete" });
  prepared.entry.membership.token = prepared.nextToken;
});

test("未保存局の受付後は部屋閉鎖と1時間経過から独立して保存・再送できる", async () => {
  const prepared = await setup();
  const user = await accountFixture();
  await bind(prepared.flow, user.cookie);
  const stored = await env.APP_DB.prepare("SELECT * FROM matches WHERE id=?")
    .bind(prepared.matchId)
    .first<Record<string, string | number | null>>();
  expect(stored).not.toBeNull();
  await env.APP_DB.prepare("DELETE FROM matches WHERE id=?").bind(prepared.matchId).run();
  expect(
    (
      await request(`/rooms/${prepared.room.id}/leave`, {
        method: "POST",
        headers: { Origin: origin, Authorization: `Bearer ${prepared.entry.membership.token}` },
      })
    ).status,
  ).toBe(204);
  fixtures.forgetClosedRoom(prepared.room.id);
  const response = await registrationRequest(prepared.flow, "complete", user.cookie);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ record: "pending", seat: "unavailable" });
  await env.APP_DB.prepare("UPDATE registration_flows SET claim_until_ms=? WHERE id=?")
    .bind(Date.now(), prepared.flow.registrationId)
    .run();
  // 応答喪失時にはマーカー更新前でも帰属対応表が受付の正本になります。
  await env.APP_DB.prepare("UPDATE registration_flows SET record_accepted_at_ms=NULL WHERE id=?")
    .bind(prepared.flow.registrationId)
    .run();
  expect((await registrationRequest(prepared.flow, "complete", user.cookie)).status).toBe(200);
  const columns = Object.keys(stored!);
  await env.APP_DB.prepare(
    `INSERT INTO matches (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
  )
    .bind(...columns.map((key) => stored![key]))
    .run();
  await applyMatchClaims(env.APP_DB, prepared.matchId);
  expect(await (await registrationRequest(prepared.flow, "", user.cookie)).json()).toMatchObject({
    record: "complete",
  });
});

test("受付期限ちょうどでは新規受付・OAuth・プロフィールを拒否する", async () => {
  vi.spyOn(Date, "now").mockReturnValue(Date.now());
  const user = await accountFixture(false);
  const flow = await seedFlow(user.cookie);
  await env.APP_DB.prepare("UPDATE registration_flows SET claim_until_ms=? WHERE id=?")
    .bind(Date.now(), flow.registrationId)
    .run();
  expect((await accountRequest(profileRequest(flow, user.cookie))).status).toBe(410);
  expect((await signIn(flow)).status).toBe(410);
  await env.APP_DB.prepare("UPDATE user SET profileCompleted=1 WHERE id=?").bind(user.id).run();
  await env.APP_DB.prepare("INSERT INTO legal_consents VALUES (?,?,?)")
    .bind(user.id, legalVersion, Date.now())
    .run();
  expect((await registrationRequest(flow, "complete", user.cookie)).status).toBe(410);
  expect(await (await registrationRequest(flow, "", user.cookie)).json()).toMatchObject({
    record: "expired",
  });
});

test("別ルームの使用中席は記録受付を妨げず、退室後の同じフローで席を切り替える", async () => {
  const prepared = await setup();
  const user = await accountFixture();
  await bind(prepared.flow, user.cookie);
  const elsewhere = createRoomContract.response.parse(
    await (
      await request("/rooms", {
        method: "POST",
        headers: user.headers,
        body: JSON.stringify({ game: "reversi", quickPlay: false }),
      })
    ).json(),
  );
  try {
    const response = await registrationRequest(prepared.flow, "complete", user.cookie);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ record: "complete", seat: "conflict" });
    expect(
      (
        await request(`/rooms/${elsewhere.room.id}/leave`, {
          method: "POST",
          headers: { Origin: origin, Authorization: `Bearer ${elsewhere.membership.token}` },
        })
      ).status,
    ).toBe(204);
    const retried = await registrationRequest(prepared.flow, "complete", user.cookie);
    expect(retried.status).toBe(200);
    expect(await retried.json()).toMatchObject({ record: "complete", seat: "complete" });
    prepared.entry.membership.token = prepared.nextToken;
    expect(
      await env.APP_DB.prepare(
        "SELECT COUNT(*) AS count FROM account_match_history WHERE account_id=? AND match_id=?",
      )
        .bind(user.id, prepared.matchId)
        .first(),
    ).toEqual({ count: 1 });
  } finally {
    await request(`/rooms/${elsewhere.room.id}/leave`, {
      method: "POST",
      headers: { Origin: origin, Authorization: `Bearer ${elsewhere.membership.token}` },
    });
  }
});

test("元局に登録済みの別席があるアカウントには、保存前でも二席目を帰属させない", async () => {
  const user = await accountFixture();
  const prepared = await setup(user.cookie);
  await bind(prepared.flow, user.cookie);
  await env.APP_DB.prepare("DELETE FROM account_match_history WHERE match_id=?")
    .bind(prepared.matchId)
    .run();
  await env.APP_DB.prepare("DELETE FROM matches WHERE id=?").bind(prepared.matchId).run();
  const response = await registrationRequest(prepared.flow, "complete", user.cookie);
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ error: "conflict" });
  expect(
    await env.APP_DB.prepare("SELECT 1 FROM match_participant_accounts WHERE match_id=?")
      .bind(prepared.matchId)
      .first(),
  ).toBeNull();
});

function beforeBatch(action: () => Promise<void>): D1Database {
  let pending = true;
  return new Proxy(env.APP_DB, {
    get(target, key) {
      if (key === "batch")
        return async (statements: D1PreparedStatement[]) => {
          if (pending) {
            pending = false;
            await action();
          }
          return target.batch(statements);
        };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

test("開始RPC直後の取消は未確定でも204で完了し、遅れた開始応答で復活しない", async () => {
  const prepared = await setup();
  await env.APP_DB.prepare("UPDATE registration_flows SET player_id=NULL WHERE id=?")
    .bind(prepared.flow.registrationId)
    .run();
  const db = new Proxy(env.APP_DB, {
    get(target, key) {
      if (key === "prepare")
        return (sql: string) => {
          const statement = target.prepare(sql);
          if (!sql.startsWith("UPDATE registration_flows SET player_id=")) return statement;
          return {
            bind(...values: unknown[]) {
              const bound = statement.bind(...values);
              return {
                async run() {
                  expect((await registrationRequest(prepared.flow, "cancel")).status).toBe(204);
                  return bound.run();
                },
              };
            },
          };
        };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const response = await registrationRoutes.request(
    `${origin}/rooms/${prepared.room.id}/registration`,
    {
      method: "POST",
      headers: { Origin: origin, Authorization: `Bearer ${prepared.entry.membership.token}` },
      body: JSON.stringify(prepared.body),
    },
    { ...env, APP_DB: db },
  );
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ error: "cancelled" });
  expect(await readRegistrationFlow(env.APP_DB, prepared.flow.registrationId)).toMatchObject({
    player_id: null,
    seat_state: "cancelled",
  });
  expect((await registrationRequest(prepared.flow, "cancel")).status).toBe(204);
  expect((await registrationRequest(prepared.flow, "")).status).toBe(409);
  expect(
    await env.GAME_ROOM.getByName(prepared.room.id).getGuestRegistration(
      prepared.flow.registrationId,
    ),
  ).toMatchObject({ state: "cancelled" });
});
test("取消がD1保存に先行した場合は確認済み要求からも新規claimを作らない", async () => {
  const prepared = await setup();
  const user = await accountFixture();
  await bind(prepared.flow, user.cookie);
  const db = beforeBatch(async () => {
    expect((await registrationRequest(prepared.flow, "cancel", user.cookie)).status).toBe(200);
  });
  const response = await registrationRoutes.request(
    `${origin}/registrations/${prepared.flow.registrationId}/complete`,
    { method: "POST", headers: headers(prepared.flow, user.cookie) },
    { ...env, APP_DB: db },
  );
  expect(response.status).toBe(409);
  expect(
    await env.APP_DB.prepare("SELECT 1 FROM match_participant_accounts WHERE match_id=?")
      .bind(prepared.matchId)
      .first(),
  ).toBeNull();
});

test("プロフィール入力読込後の取消もUPDATE条件で拒否し通常setupは影響を受けない", async () => {
  const user = await accountFixture(false);
  const flow = await seedFlow(user.cookie);
  const db = beforeBatch(async () => {
    await env.APP_DB.prepare("UPDATE registration_flows SET cancelled_at_ms=? WHERE id=?")
      .bind(Date.now(), flow.registrationId)
      .run();
  });
  const response = await accountRequest(profileRequest(flow, user.cookie), { ...env, APP_DB: db });
  expect(response.status).toBe(409);
  expect(
    await env.APP_DB.prepare("SELECT profileCompleted FROM user WHERE id=?").bind(user.id).first(),
  ).toEqual({ profileCompleted: 0 });
  expect(
    (
      await request("/account/setup", {
        method: "POST",
        headers: { Cookie: user.cookie, Origin: origin },
        body: profileBody(),
      })
    ).status,
  ).toBe(200);
});

test("取消処理の待機中にOAuthが固定したセッションも同じ取消で終了する", async () => {
  const user = await accountFixture();
  const flow = await seedFlow();
  const identity = await session(user.cookie);
  const db = beforeBatch(async () => {
    await bind(flow, user.cookie);
  });
  const response = await registrationRoutes.request(
    `${origin}/registrations/${flow.registrationId}/cancel`,
    {
      method: "POST",
      headers: headers(flow, user.cookie),
      body: JSON.stringify({ signOut: true }),
    },
    { ...env, APP_DB: db },
  );
  expect(response.status).toBe(200);
  expect(
    await env.APP_DB.prepare("SELECT id FROM session WHERE id=?").bind(identity.sessionId).first(),
  ).toBeNull();
  expect(
    response.headers
      .getSetCookie()
      .some((v) => v.includes("session_token=;") && v.includes("Max-Age=0")),
  ).toBe(true);
});

test("通常・管理者OAuthへ登録資格を混ぜず、失敗callbackはフローを未認証で保つ", async () => {
  const flow = await seedFlow();
  expect((await signIn(flow, { provider: "google", destination: "admin" })).status).toBe(400);
  const normal = await startOAuth();
  expect(
    await env.APP_DB.prepare("SELECT 1 FROM registration_oauth_states WHERE state=?")
      .bind(normal.state)
      .first(),
  ).toBeNull();
  const admin = await startOAuth(undefined, { provider: "google", destination: "admin" });
  expect(
    await env.APP_DB.prepare("SELECT 1 FROM registration_oauth_states WHERE state=?")
      .bind(admin.state)
      .first(),
  ).toBeNull();
  const failed = await callback(await startOAuth(flow), "error=access_denied");
  expect(failed.headers.get("Location")).toContain("/login?error=");
  expect(await readRegistrationFlow(env.APP_DB, flow.registrationId)).toMatchObject({
    account_id: null,
    session_id: null,
  });
});
