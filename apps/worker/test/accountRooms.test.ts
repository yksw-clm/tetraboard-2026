import { GameRoom } from "../src/rooms/gameRoom";
import { env, exports } from "cloudflare:workers";
import { runInDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { afterEach, expect, test, vi } from "vitest";
import { createInitialState, colors } from "@tetraboard/four-reversi";
import {
  createRoomContract,
  joinRoomContract,
  getRoomContract,
  fourReversiRoomSchema as roomSchema,
} from "@tetraboard/protocol";
import { accountFixture, origin } from "./accountFixtures";
import { accountIdentity, publicProfile } from "../src/accounts/auth";
import { reserveAccountSeat, recoverAccountReservations } from "../src/accounts/roomAccounts";
import { deleteUnusedAvatars } from "../src/accounts/accountRoutes";
import { prepareLegacyAccounts } from "../scripts/legacyAccountPlan";

const sockets: WebSocket[] = [];
afterEach(() => {
  for (const socket of sockets.splice(0)) socket.close();
  vi.restoreAllMocks();
});
const request = (path: string, init?: RequestInit) =>
  exports.default.fetch(new Request(`${origin}/api${path}`, init));
const create = (user?: Awaited<ReturnType<typeof accountFixture>>, extra = {}) =>
  request("/rooms", {
    method: "POST",
    headers: user?.headers ?? { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...(user ? {} : { name: "ゲスト" }),
      quickPlay: false,
      mode: "singles",
      ...extra,
    }),
  });
const join = (id: string, user?: Awaited<ReturnType<typeof accountFixture>>, extra = {}) =>
  request(`/rooms/${id}/players`, {
    method: "POST",
    headers: user?.headers ?? { "Content-Type": "application/json" },
    body: JSON.stringify({ ...(user ? {} : { name: "ゲスト" }), ...extra }),
  });
async function created(user?: Awaited<ReturnType<typeof accountFixture>>, extra = {}) {
  const response = await create(user, extra);
  expect(response.status).toBe(201);
  return createRoomContract.response.parse(await response.json());
}
async function snapshot(id: string) {
  return roomSchema.parse(
    getRoomContract.response.parse(await (await request(`/rooms/${id}`)).json()).room,
  );
}
async function leave(id: string, token: string) {
  expect(
    (
      await request(`/rooms/${id}/leave`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      })
    ).status,
  ).toBe(204);
}
async function expectSeated(response: Response) {
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ error: "account_seated" });
}
async function attachAvatar(user: Awaited<ReturnType<typeof accountFixture>>) {
  const key = `avatars/${crypto.randomUUID()}.webp`;
  await env.OBJECT_STORAGE.put(key, new Uint8Array([1, 2, 3]));
  await env.APP_DB.prepare("UPDATE user SET avatarKey = ?, image = ? WHERE id = ?")
    .bind(key, `/api/avatars/${key.slice(8, -5)}`, user.id)
    .run();
  return key;
}
function nextMessage(socket: WebSocket, predicate: (message: any) => boolean) {
  return new Promise<any>((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.removeEventListener("message", listener);
      reject(new Error("Socket message timeout"));
    }, 2000);
    const listener = (event: MessageEvent) => {
      const message = JSON.parse(String(event.data));
      if (predicate(message)) {
        clearTimeout(timeout);
        socket.removeEventListener("message", listener);
        resolve(message);
      }
    };
    socket.addEventListener("message", listener);
  });
}
async function connect(id: string, token: string) {
  const response = await request(`/rooms/${id}/ws`, { headers: { Upgrade: "websocket" } });
  const socket = response.webSocket!;
  socket.accept();
  sockets.push(socket);
  const auth = nextMessage(socket, (message) => message.type === "room.authenticated");
  socket.send(JSON.stringify({ type: "room.auth", token }));
  await auth;
  return socket;
}
async function expire(id: string, playerId: string) {
  await runInDurableObject(env.GAME_ROOM.getByName(id), (_instance, state) => {
    const room = roomSchema.parse(state.storage.kv.get("room"));
    state.storage.kv.put("disconnected-at:" + playerId, Date.now() - 30001);
    state.storage.kv.put(
      "room",
      roomSchema.parse({
        ...room,
        players: room.players.map((p) =>
          p.id === playerId ? { ...p, reconnectDeadline: Date.now() - 1 } : p,
        ),
      }),
    );
  });
  await runDurableObjectAlarm(env.GAME_ROOM.getByName(id));
}
async function playing(user: Awaited<ReturnType<typeof accountFixture>>) {
  const result = await created(user);
  for (let index = 0; index < 3; index++) expect((await join(result.room.id)).status).toBe(200);
  await runInDurableObject(env.GAME_ROOM.getByName(result.room.id), (_instance, state) => {
    const room = roomSchema.parse(state.storage.kv.get("room"));
    state.storage.kv.put(
      "room",
      roomSchema.parse({
        ...room,
        status: "playing",
        players: room.players.map((p, index) => ({ ...p, color: colors[index], ready: true })),
        game: createInitialState("singles"),
        clock: {
          remainingMainMs: { black: 300000, white: 300000, red: 300000, blue: 300000 },
          turnStartedAt: Date.now(),
          turnExpiresAt: Date.now() + 330000,
        },
      }),
    );
  });
  return result;
}

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
  const joined = joinRoomContract.response.parse(
    await (await join(other.room.id, await accountFixture())).json(),
  );
  expect(joined.room.players.at(-1)).toMatchObject({ name: "登録名", avatarUrl: null });
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
  const responses = await Promise.all([create(user), join(a.room.id, user), join(b.room.id, user)]);
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

test("プロフィール編集・画像削除・ログアウト後も席と画像を保持し、退室後に解放する", async () => {
  const user = await accountFixture();
  const key = await attachAvatar(user);
  const result = await created(user);
  const form = new FormData();
  form.set("name", "変更した名前");
  form.set("username", user.username);
  form.set("avatarAction", "remove");
  expect(
    (
      await request("/account/profile", {
        method: "PATCH",
        headers: { Cookie: user.cookie, Origin: origin },
        body: form,
      })
    ).status,
  ).toBe(200);
  await deleteUnusedAvatars(env);
  expect(await env.OBJECT_STORAGE.get(key)).not.toBeNull();
  expect((await snapshot(result.room.id)).players[0]).toMatchObject({
    name: "登録名",
    avatarUrl: `/api/avatars/${key.slice(8, -5)}`,
  });
  await request("/auth/sign-out", { method: "POST", headers: user.headers, body: "{}" });
  expect(
    (
      await request(`/rooms/${result.room.id}/me`, {
        headers: { Authorization: `Bearer ${result.membership.token}` },
      })
    ).status,
  ).toBe(200);
  await leave(result.room.id, result.membership.token);
  await env.GAME_ROOM.getByName(result.room.id).getRoom();
  await deleteUnusedAvatars(env);
  expect(await env.OBJECT_STORAGE.get(key)).toBeNull();
});

test("退室と待機中の復帰期限切れで制限を解除し、ホスト交代に画像を反映する", async () => {
  const host = await accountFixture();
  const result = await created(host);
  const successor = await accountFixture();
  const key = await attachAvatar(successor);
  const joined = joinRoomContract.response.parse(
    await (await join(result.room.id, successor)).json(),
  );
  await leave(result.room.id, result.membership.token);
  expect(await env.GAME_ROOM.getByName(result.room.id).getPublicMetadata()).toMatchObject({
    hostName: "登録名",
    hostAvatarUrl: `/api/avatars/${key.slice(8, -5)}`,
  });
  expect((await create(host)).status).toBe(201);
  await expire(result.room.id, joined.membership.playerId);
  expect((await create(successor)).status).toBe(201);
});

test("対局中の退室後もカードの画像を保持し、次の部屋には参加できる", async () => {
  const user = await accountFixture();
  const key = await attachAvatar(user);
  const result = await playing(user);
  await env.APP_DB.prepare("UPDATE user SET image = NULL, avatarKey = NULL WHERE id = ?")
    .bind(user.id)
    .run();
  await env.APP_DB.prepare("INSERT INTO avatar_deletions (key) VALUES (?)").bind(key).run();
  await leave(result.room.id, result.membership.token);
  await deleteUnusedAvatars(env);
  expect(await env.OBJECT_STORAGE.get(key)).not.toBeNull();
  expect((await snapshot(result.room.id)).players).toHaveLength(4);
  expect((await create(user)).status).toBe(201);
  await runInDurableObject(env.GAME_ROOM.getByName(result.room.id), (_instance, state) => {
    const room = roomSchema.parse(state.storage.kv.get("room"));
    state.storage.kv.put("room", { ...room, lastActivityAtMs: Date.now() - 86400001 });
  });
  await env.GAME_ROOM.getByName(result.room.id).getRoom();
  await deleteUnusedAvatars(env);
  expect(await env.OBJECT_STORAGE.get(key)).toBeNull();
});

test("投了後も在室中は制限し、復帰期限切れでは再脱落せず解除する", async () => {
  const user = await accountFixture();
  const result = await playing(user);
  const socket = await connect(result.room.id, result.membership.token);
  const resigned = nextMessage(
    socket,
    (m) => m.type === "room.snapshot" && m.room.game?.eliminatedColors.length === 1,
  );
  socket.send(JSON.stringify({ type: "room.game.resign" }));
  await resigned;
  await expectSeated(await create(user));
  socket.close();
  await expire(result.room.id, result.membership.playerId);
  const room = await snapshot(result.room.id);
  expect(room.status).toBe("playing");
  if (room.status === "playing") expect(room.game.eliminatedColors).toEqual(["black"]);
  expect((await create(user)).status).toBe(201);
  expect(
    (
      await request(`/rooms/${result.room.id}/me`, {
        headers: { Authorization: `Bearer ${result.membership.token}` },
      })
    ).status,
  ).toBe(200);
});

test("時間切れ後も在室中は制限を保持する", async () => {
  const user = await accountFixture();
  const result = await playing(user);
  await connect(result.room.id, result.membership.token);
  await runInDurableObject(env.GAME_ROOM.getByName(result.room.id), (_instance, state) => {
    const room = roomSchema.parse(state.storage.kv.get("room"));
    if (room.status !== "playing") throw new Error("Playing room expected");
    state.storage.kv.put("room", {
      ...room,
      clock: { ...room.clock, turnExpiresAt: Date.now() - 1 },
    });
  });
  await runDurableObjectAlarm(env.GAME_ROOM.getByName(result.room.id));
  await expectSeated(await create(user));
});

test("中断した予約を取消して回収し、遅延した参加RPCを拒否する", async () => {
  const user = await accountFixture();
  const result = await created();
  const req = new Request(`${origin}/api/rooms`, { headers: user.headers });
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

test("外部画像は公開せず、移行では未設定にする", async () => {
  const user = await accountFixture();
  await env.APP_DB.prepare("UPDATE user SET image = ? WHERE id = ?")
    .bind("https://example.test/image", user.id)
    .run();
  const identity = await accountIdentity(new Request(origin, { headers: user.headers }), env);
  expect(publicProfile(identity!).avatarUrl).toBeNull();
  const result = await created(user);
  expect(result.room.players[0]).toMatchObject({ avatarUrl: null });
  const legacy = {
    ...identity!,
    email: `${user.id}@example.test`,
    emailVerified: 1,
    createdAt: 1,
    updatedAt: 1,
  };
  const plan = prepareLegacyAccounts(
    {
      users: [legacy],
      accounts: [
        {
          id: "old-account",
          userId: user.id,
          providerId: "google",
          accountId: "google-id",
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    },
    { users: [], accounts: [] },
  );
  expect(plan.sql).not.toContain("https://");
  expect(plan.avatars).toEqual([]);
});

test("プロフィール編集が予約に先行した場合は再取得し、旧画像を参照しない", async () => {
  const user = await accountFixture();
  const key = await attachAvatar(user);
  const result = await created();
  const req = new Request(origin, { headers: user.headers });
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

async function resultRoom(
  user: Awaited<ReturnType<typeof accountFixture>>,
  game: "four-reversi" | "four-shogi",
) {
  const host = await created(user, { game });
  const guests = [];
  for (let i = 0; i < 3; i++)
    guests.push(joinRoomContract.response.parse(await (await join(host.room.id)).json()));
  const entries = [host, ...guests];
  const clients = [];
  for (const entry of entries) clients.push(await connect(host.room.id, entry.membership.token));
  const observer = clients[3]!;
  const ready = nextMessage(
    observer,
    (m) => m.type === "room.snapshot" && m.room.players.every((p: { ready: boolean }) => p.ready),
  );
  clients.forEach((client) => client.send(JSON.stringify({ type: "room.ready.set", ready: true })));
  await ready;
  const started = nextMessage(
    observer,
    (m) => m.type === "room.snapshot" && m.room.status === "playing",
  );
  clients[0]!.send(JSON.stringify({ type: "room.game.start" }));
  await started;
  return { host, guests, clients, observer };
}

for (const game of ["four-reversi", "four-shogi"] as const) {
  for (const releaseAt of ["nextRound", "close"] as const) {
    test(`${game}: 前局の退室者の画像を保持し、${releaseAt}で解放する`, async () => {
      const user = await accountFixture();
      const key = await attachAvatar(user);
      const prepared = await resultRoom(user, game);
      const id = prepared.host.room.id;
      const url = `/api/avatars/${key.slice(8, -5)}`;
      const form = new FormData();
      form.set("name", "変更後の名前");
      form.set("username", user.username);
      form.set("avatarAction", "remove");
      expect(
        (
          await request("/account/profile", {
            method: "PATCH",
            headers: { Cookie: user.cookie, Origin: origin },
            body: form,
          })
        ).status,
      ).toBe(200);
      await leave(id, prepared.host.membership.token);
      await leave(id, prepared.guests[0]!.membership.token);
      const finished = nextMessage(
        prepared.observer,
        (m) => m.type === "room.snapshot" && m.room.lastRound !== null,
      );
      await leave(id, prepared.guests[1]!.membership.token);
      const broadcast = await finished;
      const read = getRoomContract.response.parse(
        await (await request(`/rooms/${id}`)).json(),
      ).room;
      expect(read.lastRound).toEqual(broadcast.room.lastRound);
      expect(
        read.lastRound!.players.find((p) => p.id === prepared.host.membership.playerId),
      ).toMatchObject({ name: "登録名", appearance: { kind: "human", avatarUrl: url } });
      expect(read.players).toHaveLength(1);
      await deleteUnusedAvatars(env);
      expect(await env.OBJECT_STORAGE.get(key)).not.toBeNull();
      // 前局画像の保持中も席の予約は解放され、新しい部屋に参加できます。
      expect((await create(user)).status).toBe(201);
      await recoverAccountReservations(env);
      await deleteUnusedAvatars(env);
      expect(await env.OBJECT_STORAGE.get(key)).not.toBeNull();
      if (releaseAt === "close") {
        await leave(id, prepared.guests[2]!.membership.token);
      } else {
        const newcomers = [];
        for (let i = 0; i < 3; i++)
          newcomers.push(joinRoomContract.response.parse(await (await join(id)).json()));
        const nextClients = [prepared.observer];
        for (const newcomer of newcomers)
          nextClients.push(await connect(id, newcomer.membership.token));
        const ready = nextMessage(
          prepared.observer,
          (m) =>
            m.type === "room.snapshot" && m.room.players.every((p: { ready: boolean }) => p.ready),
        );
        nextClients.forEach((client) =>
          client.send(JSON.stringify({ type: "room.ready.set", ready: true })),
        );
        await ready;
        const started = nextMessage(
          prepared.observer,
          (m) => m.type === "room.snapshot" && m.room.status === "playing",
        );
        prepared.observer.send(JSON.stringify({ type: "room.game.start" }));
        expect((await started).room.lastRound).toBeNull();
      }
      await env.GAME_ROOM.getByName(id).getRoom();
      await deleteUnusedAvatars(env);
      expect(await env.OBJECT_STORAGE.get(key)).toBeNull();
      expect(
        await env.APP_DB.prepare("SELECT operation_id FROM room_avatar_refs WHERE avatar_key = ?")
          .bind(key)
          .first(),
      ).toBeNull();
    });
  }
}
