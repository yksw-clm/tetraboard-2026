import { env } from "cloudflare:workers";
import { expect, test, vi } from "vitest";
import { registrationRoutes } from "../src/routes/registrationRoutes";
import { readRegistrationFlow } from "../src/flows/guestRegistration/account";
import { acceptMatchClaim } from "../src/flows/matchSave/claims";
import { accountFixture, origin } from "./accountFixtures";
import {
  registrationRequest,
  bind,
  headers,
  seedFlow,
  accountRequest,
  profileRequest,
  request,
  profileBody,
  session,
  useRegistrationApiRooms,
} from "./registrationApiFixtures";

const { setup } = useRegistrationApiRooms();

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

test.each(["profile", "claim"])(
  "%s の保存直前に失効した ISO session を拒否する",
  async (action) => {
    vi.spyOn(Date, "now").mockReturnValue(Date.now());
    const user = await accountFixture(action === "claim");
    const flow = await seedFlow(user.cookie);
    const db = beforeBatch(async () => {
      await env.APP_DB.prepare("UPDATE session SET expiresAt=? WHERE userId=?")
        .bind(new Date(Date.now() - 1).toISOString(), user.id)
        .run();
    });
    if (action === "profile") {
      const response = await accountRequest(profileRequest(flow, user.cookie), {
        ...env,
        APP_DB: db,
      });
      expect(response.status).toBe(401);
      expect(
        await env.APP_DB.prepare("SELECT profileCompleted FROM user WHERE id=?")
          .bind(user.id)
          .first("profileCompleted"),
      ).toBe(0);
    } else {
      const identity = await session(user.cookie);
      await expect(
        acceptMatchClaim(
          db,
          {
            matchId: crypto.randomUUID(),
            playerId: crypto.randomUUID(),
            accountId: user.id,
            roomId: "98123",
            instanceId: crypto.randomUUID(),
          },
          { registrationId: flow.registrationId, sessionId: identity.sessionId },
        ),
      ).rejects.toThrow("Match claim conflict");
    }
  },
);

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
