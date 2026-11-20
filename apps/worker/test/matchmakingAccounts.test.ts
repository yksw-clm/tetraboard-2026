import { env, exports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect, test } from "vitest";
import { matchmakingStateSchema, roomSchema } from "@tetraboard/protocol";
import { accountFixture, origin } from "./accountFixtures";
import { AcceptedGameRequest } from "./acceptedGameRequest";
import { D1TournamentQueueStore } from "../src/adapters/tournament/queue";
import { requestDeletion } from "../src/flows/accountPurge/requestDeletion";
import { requireGuestIdle } from "../src/flows/guestRegistration/guestLink";
import { accountIdentity } from "../src/adapters/account/auth";
import { matchmakingRoutes } from "../src/routes/matchmaking";
import {
  useMatchmakingFixtures,
  stub,
  accounts,
  rooms,
  fixture,
  fill,
} from "./matchmakingFixtures";

useMatchmakingFixtures();

test("閲覧だけでゲストを作らず、名前確定したゲストは登録者と同じ列で参加できる", async () => {
  const count = () =>
    env.APP_DB.prepare("SELECT COUNT(*) AS n FROM user WHERE isAnonymous=1").first<{ n: number }>();
  const before = await count();
  const response = await exports.default.fetch(
    new AcceptedGameRequest(`${origin}/api/matchmaking/four-reversi`),
  );
  expect(response.status).toBe(200);
  expect((await count())?.n).toBe(before?.n);
  const registered = (await fixture(1))[0]!;
  const guest = await exports.default.fetch(
    new AcceptedGameRequest(`${origin}/api/account/guest`, {
      method: "POST",
      headers: {
        Origin: origin,
        "Content-Type": "application/json",
        "CF-Connecting-IP": crypto.randomUUID(),
      },
      body: JSON.stringify({ name: "ゲスト参加者" }),
    }),
  );
  expect(guest.status).toBe(201);
  const cookie = guest.headers
    .getSetCookie()
    .find((c) => c.startsWith("tetraboard-2026.guest="))!
    .split(";")[0]!;
  const user = await accountIdentity(new Request(origin, { headers: { Cookie: cookie } }), env);
  expect(user?.guestNameCustomized).toBeTruthy();
  accounts.push(user!.id);
  const rated = await exports.default.fetch(
    new AcceptedGameRequest(`${origin}/api/matchmaking/shogi/join`, {
      method: "POST",
      headers: { Origin: origin, Cookie: cookie },
    }),
  );
  expect(rated.status).toBe(403);
  expect(await rated.text()).toContain("登録アカウントが必要");
  const summary = await exports.default.fetch(
    new AcceptedGameRequest(`${origin}/api/matchmaking/shogi/rating`, {
      headers: { Cookie: cookie },
    }),
  );
  expect(summary.status).toBe(401);
  const operationId = crypto.randomUUID(),
    controllerId = crypto.randomUUID();
  expect((await stub().join(user!.id, operationId, controllerId)).ok).toBe(true);
  await fill();
  const matched = await stub().status(user!.id, controllerId);
  rooms.add(matched.assignment!.roomId);
  const room = roomSchema.parse(
    await env.GAME_ROOM.getByName(matched.assignment!.roomId).getRoom(),
  );
  expect(room.players.find((p) => p.name === "ゲスト参加者")).toMatchObject({
    kind: "human",
    isGuest: true,
  });
  expect(
    (await stub().status(registered.account.id, registered.controllerId)).assignment?.matchId,
  ).toBe(matched.assignment!.matchId);
});

test("将棋の待機APIは別キューを使い、四人リバーシとの二重待機を拒否する", async () => {
  const [user] = await fixture(1);
  const join = (account: Awaited<ReturnType<typeof accountFixture>>, enabled: "true" | "false") =>
    matchmakingRoutes.request(
      new AcceptedGameRequest(`${origin}/matchmaking/shogi/join`, {
        method: "POST",
        headers: account.headers,
        body: JSON.stringify({
          operationId: crypto.randomUUID(),
          controllerId: crypto.randomUUID(),
        }),
      }),
      undefined,
      {
        ...env,
        APP_ORIGIN: origin,
        SHOGI_MATCHMAKING_ENABLED: enabled,
        AI_SHOGI_ENABLED: "true",
        AI_SERVICE_URL: "https://ai.example.test",
        AI_SERVICE_TOKEN: "test-token-with-at-least-32-bytes",
      },
    );
  const disabled = await join(user!.account, "false");
  expect(disabled.status, await disabled.text()).toBe(503);
  expect((await join(user!.account, "true")).status).toBe(409);
  await stub().leaveAccount(user!.account.id);
  const response = await join(user!.account, "true");
  expect(response.status).toBe(200);
  expect(matchmakingStateSchema.parse(await response.json()).status).toBe("waiting");
});

test("大会待機との相互排他をD1で守り、取消後だけ待機先を切り替えられる", async () => {
  const [u] = await fixture(1);
  const key = crypto.randomUUID(),
    now = Date.now();
  await env.APP_DB.prepare(
    "INSERT INTO tournaments(key,public_id,name,starts_at_ms,ends_at_ms,published,created_at_ms,updated_at_ms) VALUES(?,(SELECT COALESCE(MAX(public_id),0)+1 FROM tournaments),'排他確認',?,?,1,?,?)",
  )
    .bind(key, now - 1, now + 60000, now, now)
    .run();
  const reserve = () =>
    new D1TournamentQueueStore(env.APP_DB).enqueue(
      {
        accountId: u!.account.id,
        operationId: crypto.randomUUID(),
        tokenHash: crypto.randomUUID(),
        expiresAtMs: now + 30000,
      },
      key,
    );
  try {
    await expect(reserve()).rejects.toThrow("matchmaking_waiting");
    await stub().control(
      u!.account.id,
      { operationId: u!.operationId, controllerId: u!.controllerId, version: 1 },
      "cancel",
    );
    await reserve();
    expect((await stub().join(u!.account.id, crypto.randomUUID(), u!.controllerId)).ok).toBe(false);
  } finally {
    await env.APP_DB.prepare("DELETE FROM tournament_wait_reservations WHERE account_id=?")
      .bind(u!.account.id)
      .run();
    await env.APP_DB.prepare("DELETE FROM tournaments WHERE key=?").bind(key).run();
  }
});

test("ログアウトで待機を解除し、退会・ゲスト連携は待機を越えて成立しない", async () => {
  const [u] = await fixture(1);
  await expect(requireGuestIdle(env, u!.account.id)).rejects.toThrow();
  const signedOut = await exports.default.fetch(
    new AcceptedGameRequest(`${origin}/api/auth/sign-out`, {
      method: "POST",
      headers: u!.account.headers,
      body: "{}",
    }),
  );
  expect(signedOut.status).toBe(200);
  expect((await stub().status(u!.account.id, u!.controllerId)).status).toBe("idle");
  const v = (await fixture(1))[0]!;
  expect(await requestDeletion(env, v.account.id, crypto.randomUUID())).toBe(true);
  await runInDurableObject(stub(), (instance) => instance.alarm());
  expect((await stub().status(v.account.id, v.controllerId)).status).toBe("idle");
  expect((await stub().join(v.account.id, crypto.randomUUID(), v.controllerId)).ok).toBe(false);
  await stub().purgeAccount(v.account.id);
});

test("待機中の通常ルーム参加を拒否し、取消後は参加できる", async () => {
  const [u] = await fixture(1);
  const create = () =>
    exports.default.fetch(
      new AcceptedGameRequest(`${origin}/api/rooms`, {
        method: "POST",
        headers: u!.account.headers,
        body: JSON.stringify({
          game: "four-reversi",
          mode: "singles",
          quickPlay: false,
          name: "参加者",
        }),
      }),
    );
  expect((await create()).status).toBe(409);
  expect(
    (
      await stub().control(
        u!.account.id,
        { operationId: u!.operationId, controllerId: u!.controllerId, version: 1 },
        "cancel",
      )
    ).ok,
  ).toBe(true);
  const response = await create();
  expect(response.status).toBe(201);
  const body = (await response.json()) as { room: { id: string } };
  rooms.add(body.room.id);
  expect((await stub().join(u!.account.id, crypto.randomUUID(), u!.controllerId)).ok).toBe(false);
});
