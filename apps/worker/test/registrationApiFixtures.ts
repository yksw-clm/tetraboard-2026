import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, expect, vi } from "vitest";
import { legalVersion } from "@tetraboard/protocol/privacy";
import { joinRoomContract, registrationStatusSchema } from "@tetraboard/protocol";
import { accountRoutes } from "../src/routes/accountRoutes";
import { accountSessionIdentity } from "../src/adapters/account/auth";
import { digest } from "../src/crypto";
import { origin } from "./accountFixtures";
import { boundaryRequest, RoomBoundaryFixtures } from "./roomBoundaryFixtures";

export const request = (path: string, init?: RequestInit) =>
  boundaryRequest(path, { redirect: "manual", ...init });

export const credential = () => ({
  registrationId: crypto.randomUUID(),
  secret: crypto.randomUUID().replaceAll("-", "").repeat(2),
});

export type Credential = ReturnType<typeof credential>;

export const headers = (flow: Credential, cookie?: string) => ({
  Origin: origin,
  Authorization: `Bearer ${flow.secret}`,
  ...(cookie ? { Cookie: cookie } : {}),
});

export const registrationRequest = (
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

export async function session(cookie: string) {
  return (await accountSessionIdentity(new Request(origin, { headers: { Cookie: cookie } }), env))!;
}

export async function bind(flow: Credential, cookie: string) {
  const identity = await session(cookie);
  await env.APP_DB.prepare("UPDATE registration_flows SET account_id=?,session_id=? WHERE id=?")
    .bind(identity.user.id, identity.sessionId, flow.registrationId)
    .run();
  return identity;
}

export async function seedFlow(cookie?: string) {
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

export function useRegistrationApiRooms() {
  let fixtures: RoomBoundaryFixtures;

  beforeEach(() => {
    fixtures = new RoomBoundaryFixtures();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fixtures.dispose();
  });

  async function setup(opponentCookie?: string, guestCookie?: string) {
    const entry = await fixtures.create(
      { game: "reversi", name: "ゲスト本人", quickPlay: false },
      guestCookie,
    );
    const host = await fixtures.open(entry.room.id);
    host.send({ type: "room.auth", token: entry.membership.token });
    await host.waitFor("room.authenticated");
    const other = opponentCookie
      ? joinRoomContract.response.parse(
          await (
            await request(`/rooms/${entry.room.id}/players`, {
              method: "POST",
              headers: {
                Cookie: opponentCookie,
                Origin: origin,
                "Content-Type": "application/json",
              },
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
      ...(guestCookie ? { linkGuest: true } : {}),
    };
    const response = await request(`/rooms/${room.id}/registration`, {
      method: "POST",
      headers: {
        Origin: origin,
        Authorization: `Bearer ${entry.membership.token}`,
        "Content-Type": "application/json",
        ...(guestCookie ? { Cookie: guestCookie } : {}),
      },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(200);
    const status = registrationStatusSchema.parse(await response.json());
    return { flow, entry, host, room, matchId, body, nextToken, status };
  }

  return { rooms: () => fixtures, setup };
}

export const signIn = (
  flow?: Credential,
  extra: Record<string, unknown> = {},
  guestCookie?: string,
) =>
  request("/auth/sign-in/social", {
    method: "POST",
    headers: {
      Origin: origin,
      "Content-Type": "application/json",
      "X-Legal-Consent": legalVersion,
      ...(guestCookie ? { Cookie: guestCookie } : {}),
    },
    body: JSON.stringify({
      provider: "discord",
      ...(flow ? { registration: flow } : {}),
      ...extra,
    }),
  });

export function profileBody() {
  const data = new FormData();
  data.set("name", "登録した本人");
  data.set("username", `u_${crypto.randomUUID().slice(0, 8)}`);
  data.set("avatarAction", "keep");
  data.set("consentVersion", legalVersion);
  return data;
}

export function profileRequest(flow: Credential, cookie: string) {
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

export async function accountRequest(request: Request, bindings = env) {
  const ctx = createExecutionContext();
  const response = await accountRoutes.fetch(request, bindings, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}
