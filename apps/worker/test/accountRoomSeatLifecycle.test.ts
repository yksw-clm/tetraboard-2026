import { env } from "cloudflare:workers";
import { runInDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { expect, test } from "vitest";
import { createInitialState, colors } from "@tetraboard/four-reversi";
import {
  joinRoomContract,
  getRoomContract,
  fourReversiRoomSchema as roomSchema,
} from "@tetraboard/protocol";
import { accountFixture, origin } from "./accountFixtures";
import { recoverAccountReservations } from "../src/flows/accountSeats/reserve";
import { deleteUnusedAvatars } from "../src/routes/accountAvatars";
import {
  registerAccountRoomsFixtures,
  created,
  attachAvatar,
  join,
  leave,
  create,
  snapshot,
  connect,
  nextMessage,
  expectSeated,
  request,
} from "./accountRoomsFixtures";

registerAccountRoomsFixtures();

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
        roundId: crypto.randomUUID(),
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
