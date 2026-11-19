import { env } from "cloudflare:workers";
import { expect, test, vi } from "vitest";
import { legalVersion } from "@tetraboard/protocol/privacy";
import { readRegistrationFlow } from "../src/flows/guestRegistration/account";
import { accountFixture, origin } from "./accountFixtures";
import {
  type Credential,
  signIn,
  request,
  session,
  registrationRequest,
  accountRequest,
  profileRequest,
  seedFlow,
  useRegistrationApiRooms,
} from "./registrationApiFixtures";

const { rooms, setup } = useRegistrationApiRooms();

const cookies = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((v) => v.split(";")[0])
    .join("; ");

async function startOAuth(
  flow?: Credential,
  extra?: Record<string, unknown>,
  guestCookie?: string,
) {
  const response = await signIn(flow, extra, guestCookie);
  expect(response.status).toBe(200);
  const url = new URL(((await response.json()) as { url: string }).url);
  return {
    state: url.searchParams.get("state")!,
    cookie: [cookies(response), guestCookie].filter(Boolean).join("; "),
  };
}

const callback = (auth: Awaited<ReturnType<typeof startOAuth>>, query = "code=code") =>
  request(`/auth/callback/discord?${query}&state=${encodeURIComponent(auth.state)}`, {
    headers: { Cookie: auth.cookie },
  });

function discord(email?: string) {
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
        email: email ?? `${id}@example.test`,
        username: "外部名",
        global_name: "外部名",
        avatar: null,
        discriminator: "0",
        verified: true,
      });
    throw new Error(`Unexpected OAuth request: ${url}`);
  });
  return id;
}

async function guestCookie() {
  const response = await request("/account/guest", {
    method: "POST",
    headers: {
      Origin: origin,
      "Content-Type": "application/json",
      "X-Legal-Consent": legalVersion,
    },
    body: JSON.stringify({ name: "ゲスト本人" }),
  });
  expect(response.status).toBe(201);
  return cookies(response);
}

test.each([false, true])(
  "ゲストアカウントは退室せず全記録と同じ席を連携する（既存登録先 %s）",
  async (existing) => {
    const guest = await guestCookie();
    const prepared = await setup(undefined, guest);
    const before = (await readRegistrationFlow(env.APP_DB, prepared.flow.registrationId))!;
    expect(before.guest_account_id).toBeTypeOf("string");
    const target = existing ? await accountFixture() : null;
    const providerId = discord(target ? `${target.id}@example.test` : undefined);
    if (target)
      await env.APP_DB.prepare(
        "INSERT INTO account(id,accountId,providerId,userId,createdAt,updatedAt) VALUES(?,?,'discord',?,?,?)",
      )
        .bind(crypto.randomUUID(), providerId, target.id, Date.now(), Date.now())
        .run();
    expect((await signIn(prepared.flow)).status).toBe(409);
    const auth = await startOAuth(prepared.flow, {}, guest);
    const redirected = await callback(auth);
    expect(redirected.status).toBe(302);
    const cookie = [cookies(redirected), guest].filter(Boolean).join("; ");
    const registered = await session(cookie);
    expect(registered.user.id).toBe(target?.id ?? before.guest_account_id);
    if (target) {
      expect(redirected.headers.get("Location")).toBe("/account?guestMerge=1");
      expect((await registrationRequest(prepared.flow, "complete", cookie)).status).toBe(409);
      const merge = () =>
        request("/account/guest-merge", {
          method: "POST",
          headers: { Origin: origin, Cookie: cookie },
        });
      const otherRoom = await rooms().create({ game: "reversi", quickPlay: false }, target.cookie);
      expect((await merge()).status).toBe(409);
      expect((await rooms().snapshot(prepared.room.id)).room.players[0]?.id).toBe(
        prepared.entry.membership.playerId,
      );
      expect(
        (
          await request(`/rooms/${otherRoom.room.id}/leave`, {
            method: "POST",
            headers: { Origin: origin, Authorization: `Bearer ${otherRoom.membership.token}` },
          })
        ).status,
      ).toBe(204);
      rooms().forgetClosedRoom(otherRoom.room.id);
      const response = await merge();
      expect(response.status).toBe(200);
    } else {
      const saved = await accountRequest(profileRequest(prepared.flow, cookie));
      expect(saved.status).toBe(200);
    }
    const finished = await registrationRequest(prepared.flow, "complete", cookie);
    expect(finished.status).toBe(200);
    expect(await finished.json()).toMatchObject({
      identity: "ready",
      record: "complete",
      seat: "complete",
    });
    expect(
      await (await registrationRequest(prepared.flow, "complete", cookie)).json(),
    ).toMatchObject({
      seat: "complete",
    });
    expect(
      (
        await request(`/rooms/${prepared.room.id}/me`, {
          headers: { Authorization: `Bearer ${prepared.entry.membership.token}` },
        })
      ).status,
    ).toBe(401);
    prepared.entry.membership.token = prepared.nextToken;
    expect(
      (
        await request(`/rooms/${prepared.room.id}/me`, {
          headers: { Authorization: `Bearer ${prepared.nextToken}` },
        })
      ).status,
    ).toBe(200);
    expect((await rooms().snapshot(prepared.room.id)).room.players[0]).toMatchObject({
      id: prepared.entry.membership.playerId,
      name: target ? "登録名" : "登録した本人",
      ready: false,
    });
    expect((await rooms().snapshot(prepared.room.id)).room.players[0]).not.toHaveProperty(
      "isGuest",
    );
    expect(
      await env.APP_DB.prepare("SELECT account_id FROM account_room_seats WHERE room_id=?")
        .bind(prepared.room.id)
        .first(),
    ).toEqual({ account_id: registered.user.id });
    expect(
      await env.APP_DB.prepare(
        "SELECT COUNT(*) AS n FROM match_participant_accounts WHERE match_id=?",
      )
        .bind(prepared.matchId)
        .first(),
    ).toEqual({ n: 0 });
  },
);

test("ゲストがOAuthを中止すると席を保持したまま準備待ちに戻り、遅れた認証を反映しない", async () => {
  discord();
  const guest = await guestCookie();
  const prepared = await setup(undefined, guest);
  const auth = await startOAuth(prepared.flow, {}, guest);
  expect((await registrationRequest(prepared.flow, "cancel", guest)).status).toBe(200);
  expect((await rooms().snapshot(prepared.room.id)).room.players[0]).toMatchObject({
    id: prepared.entry.membership.playerId,
    isGuest: true,
    ready: false,
  });
  expect((await rooms().snapshot(prepared.room.id)).room.players[0]).not.toHaveProperty(
    "registrationPendingUntilMs",
  );
  const delayed = await callback(auth);
  expect(delayed.headers.get("Location")).toBe("/login?error=guest_room_link_expired");
  expect(cookies(delayed)).not.toContain("tetraboard-2026.session_token=");
  expect(
    await (await request("/account/session", { headers: { Cookie: guest } })).json(),
  ).toMatchObject({ user: { isGuest: true } });
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
  expect((await rooms().snapshot(prepared.room.id)).room.players[0]).toMatchObject({
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
