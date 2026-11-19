import { fixTestTime } from "./fixedTimeFixture";
import { AcceptedGameRequest } from "./acceptedGameRequest";
import { GameRoom } from "../src/durableObjects/gameRoom/gameRoom";
import { env } from "cloudflare:workers";
import { runInDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { expect, test, vi } from "vitest";
import { accountAvatarPresetId, avatarPresetUrl, joinRoomContract } from "@tetraboard/protocol";
import { accountFixture, origin } from "./accountFixtures";
import { accountIdentity } from "../src/adapters/account/auth";
import { reserveAccountSeat, recoverAccountReservations } from "../src/flows/accountSeats/reserve";
import { dispatchInTestContext } from "./dispatchInTestContext";
import {
  registerAccountRoomsFixtures,
  attachAvatar,
  created,
  request,
  create,
  join,
  expectSeated,
  snapshot,
  connect,
  leave,
} from "./accountRoomsFixtures";

registerAccountRoomsFixtures();

test("入室時に本人の名前・画像を取得し、偽装入力と初回設定未完了を拒否する", async () => {
  const user = await accountFixture();
  const key = await attachAvatar(user);
  const result = await created(user, { name: "偽の名前" });
  expect(result.room.players[0]).toMatchObject({
    name: "登録名",
    avatarUrl: `/api/avatars/${key.slice(8, -5)}`,
  });
  const publicJson = JSON.stringify(await (await request(`/rooms/${result.room.id}`)).json());
  expect(publicJson).not.toContain(user.id);
  expect(publicJson).not.toContain(result.membership.token);
  expect((await create(await accountFixture(false))).status).toBe(403);
  expect(
    (
      await create(await accountFixture(), {
        accountId: user.id,
        avatarUrl: "https://example.test/image",
      })
    ).status,
  ).toBe(400);
  expect((await create(undefined, { name: undefined })).status).toBe(400);
  const other = await created();
  const joining = await accountFixture();
  const joined = joinRoomContract.response.parse(await (await join(other.room.id, joining)).json());
  expect(joined.room.players.at(-1)).toMatchObject({
    name: "登録名",
    avatarUrl: avatarPresetUrl(accountAvatarPresetId(joining.id)),
  });
});

test("同じアカウントの同一・別ルームへの参加と作成を拒否する", async () => {
  const user = await accountFixture();
  const first = await created(user);
  const other = await created();
  await expectSeated(await join(first.room.id, user));
  await expectSeated(await join(other.room.id, user));
  await expectSeated(await create(user, { quickPlay: true }));
  const me = await request(`/rooms/${first.room.id}/me`, {
    headers: { ...user.headers, Authorization: `Bearer ${first.membership.token}` },
  });
  expect(me.status).toBe(200);
  expect((await snapshot(first.room.id)).players).toHaveLength(1);
});

test("同時の複数ルーム作成・参加では1席だけを確定する", async () => {
  const user = await accountFixture();
  const a = await created();
  const b = await created();
  const requests = [
    new AcceptedGameRequest(`${origin}/api/rooms`, {
      method: "POST",
      headers: user.headers,
      body: JSON.stringify({ quickPlay: false, mode: "singles" }),
    }),
    ...[a, b].map(
      (entry) =>
        new AcceptedGameRequest(`${origin}/api/rooms/${entry.room.id}/players`, {
          method: "POST",
          headers: user.headers,
          body: "{}",
        }),
    ),
  ];
  const responses = await Promise.all(requests.map(dispatchInTestContext));
  expect(responses.filter((r) => r.status === 200 || r.status === 201)).toHaveLength(1);
  expect(responses.filter((r) => r.status === 409)).toHaveLength(2);
  expect(
    (
      await env.APP_DB.prepare("SELECT COUNT(*) AS n FROM account_room_seats WHERE account_id = ?")
        .bind(user.id)
        .first<{ n: number }>()
    )?.n,
  ).toBe(1);
});

test("中断した予約を取消して回収し、遅延した参加RPCを拒否する", async () => {
  const user = await accountFixture();
  const result = await created();
  const req = new AcceptedGameRequest(`${origin}/api/rooms`, { headers: user.headers });
  const profile = await accountIdentity(req, env);
  const admission = await reserveAccountSeat(req, env, profile!, result.room, crypto.randomUUID());
  await env.APP_DB.prepare("UPDATE account_room_seats SET created_at_ms = 0 WHERE operation_id = ?")
    .bind(admission.operationId)
    .run();
  await recoverAccountReservations(env);
  expect(
    await env.GAME_ROOM.getByName(result.room.id).joinRoom(
      admission.name,
      "c".repeat(64),
      result.room.instanceId,
      admission,
    ),
  ).toEqual({ status: "account_reservation_invalid" });
  expect((await create(user)).status).toBe(201);
});

test("確定済みの席は予約時刻が古くても回収しない", async () => {
  const user = await accountFixture();
  const result = await created(user);
  await connect(result.room.id, result.membership.token);
  await env.APP_DB.prepare("UPDATE account_room_seats SET created_at_ms = 0 WHERE account_id = ?")
    .bind(user.id)
    .run();
  await recoverAccountReservations(env);
  await expectSeated(await create(user));
});

test("プロフィール編集が予約に先行した場合は再取得し、旧画像を参照しない", async () => {
  const user = await accountFixture();
  const key = await attachAvatar(user);
  const result = await created();
  const req = new AcceptedGameRequest(origin, { headers: user.headers });
  const initial = await accountIdentity(req, env);
  const batch = env.APP_DB.batch.bind(env.APP_DB);
  vi.spyOn(env.APP_DB, "batch").mockImplementationOnce(async (statements) => {
    await env.APP_DB.prepare(
      "UPDATE user SET name = ?, image = NULL, avatarKey = NULL WHERE id = ?",
    )
      .bind("編集後", user.id)
      .run();
    return batch(statements);
  });
  const admission = await reserveAccountSeat(req, env, initial!, result.room, crypto.randomUUID());
  expect(admission).toMatchObject({ name: "編集後", avatarKey: null });
  expect(
    await env.APP_DB.prepare("SELECT operation_id FROM room_avatar_refs WHERE avatar_key = ?")
      .bind(key)
      .first(),
  ).toBeNull();
  const joined = await env.GAME_ROOM.getByName(result.room.id).joinRoom(
    admission.name,
    "d".repeat(64),
    result.room.instanceId,
    admission,
  );
  expect(joined.status).toBe("joined");
});

test("D1解放失敗を永続化して再試行し、古い処理で新しい席を削除しない", async () => {
  fixTestTime();
  const user = await accountFixture();
  const result = await created(user);
  expect((await join(result.room.id)).status).toBe(200);
  const stub = env.GAME_ROOM.getByName(result.room.id);
  const originalDb = env.APP_DB;
  try {
    await runInDurableObject(stub, (instance) => {
      const bindings = (instance as unknown as { env: Env }).env;
      const db = bindings.APP_DB;
      bindings.APP_DB = new Proxy(db, {
        get(target, property) {
          if (property === "batch")
            return async () => {
              throw new Error("Test D1 outage");
            };
          const value = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    });
    await leave(result.room.id, result.membership.token);
    await stub.getRoom();
    await runInDurableObject(stub, (_instance, state) => {
      const jobs = state.storage.kv.get<{ retryAtMs: number }[]>("account-cleanups");
      expect(jobs).toHaveLength(1);
      expect(jobs![0].retryAtMs).toBeGreaterThan(Date.now());
    });
  } finally {
    env.APP_DB = originalDb;
  }
  // The target room confirms release while persisted cleanup is still pending.
  const next = await created(user);
  await runInDurableObject(stub, (_instance, state) => {
    const jobs = state.storage.kv.get<{ retryAtMs: number }[]>("account-cleanups")!;
    state.storage.kv.put(
      "account-cleanups",
      jobs.map((job) => ({ ...job, retryAtMs: Date.now() - 1 })),
    );
  });
  await runDurableObjectAlarm(stub);
  expect(
    await env.APP_DB.prepare("SELECT room_id FROM account_room_seats WHERE account_id = ?")
      .bind(user.id)
      .first(),
  ).toEqual({ room_id: next.room.id });
  await runInDurableObject(stub, (_instance, state) =>
    expect(state.storage.kv.get("account-cleanups")).toEqual([]),
  );
});

test("DOのメモリを再生成しても席の帰属・プロフィール・トークンを保持する", async () => {
  const user = await accountFixture();
  const key = await attachAvatar(user);
  const result = await created(user);
  await runInDurableObject(env.GAME_ROOM.getByName(result.room.id), async (_instance, state) => {
    const restarted = new GameRoom(state, env);
    const room = await restarted.getRoom();
    expect(room?.players[0]).toMatchObject({
      name: "登録名",
      avatarUrl: `/api/avatars/${key.slice(8, -5)}`,
    });
    const hash = state.storage.kv.get<string>(`player-token:${result.membership.playerId}`)!;
    expect(await restarted.getRoomMembership(hash)).toMatchObject({
      status: "found",
      membership: { playerId: result.membership.playerId, role: "host" },
    });
  });
  await expectSeated(await create(user));
});
