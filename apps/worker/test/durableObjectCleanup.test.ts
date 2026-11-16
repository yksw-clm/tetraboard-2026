import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect, test } from "vitest";
import { fourReversiRoomSchema } from "@tetraboard/protocol";
import { disposeDurableObjects, resetDurableObjectStorage } from "./durableObjectCleanup";
import { BoundarySocket, RoomBoundaryFixtures, boundaryRequest } from "./roomBoundaryFixtures";

test("後片づけはAlarmを止め、永続データを保持する", async () => {
  const stubs = [
    env.GAME_ROOM,
    env.MATCHMAKING_COORDINATOR,
    env.TOURNAMENT_COORDINATOR,
    env.CPU_CAPACITY,
  ].map((namespace) => ({
    namespace: namespace as DurableObjectNamespace,
    id: namespace.idFromName(crypto.randomUUID()),
  }));
  for (const { namespace, id } of stubs)
    await runInDurableObject(namespace.get(id), async (_, state) => {
      state.storage.kv.put("cleanup-marker", "saved");
      await state.storage.setAlarm(Date.now() + 60_000);
    });
  await disposeDurableObjects();
  for (const { namespace, id } of stubs) {
    const saved = await runInDurableObject(namespace.get(id), async (_, state) => ({
      marker: state.storage.kv.get("cleanup-marker"),
      alarm: await state.storage.getAlarm(),
    }));
    expect(saved).toEqual({ marker: "saved", alarm: null });
  }
});

test("残ったWebSocketの閉鎖を待ち、切断によるAlarmも次のテストへ残さない", async () => {
  const fixtures = new RoomBoundaryFixtures();
  const entry = await fixtures.create({ game: "shogi", name: "ホスト", quickPlay: true });
  const response = await boundaryRequest(`/rooms/${entry.room.id}/ws`, {
    headers: { Upgrade: "websocket" },
  });
  expect(response.status).toBe(101);
  const socket = response.webSocket!;
  const closed = new Promise<void>((resolve) => socket.addEventListener("close", () => resolve()));
  const client = new BoundarySocket(socket);
  client.send({ type: "room.auth", token: entry.membership.token });
  await client.waitFor("room.authenticated");
  await disposeDurableObjects();
  await closed;
  const remaining = await runInDurableObject(
    env.GAME_ROOM.getByName(entry.room.id),
    async (_, state) => ({
      sockets: state.getWebSockets().length,
      alarm: await state.storage.getAlarm(),
    }),
  );
  expect(remaining).toEqual({ sockets: 0, alarm: null });
});

test("ストレージを消したfixtureのインスタンスを残さず、次の将棋ルームを退室できる", async () => {
  const fixtures = new RoomBoundaryFixtures();
  const entry = await fixtures.create({ game: "shogi", name: "ホスト", quickPlay: true });
  const stub = env.GAME_ROOM.getByName(entry.room.id);
  const waiting = await runInDurableObject(stub, (_, state) => [...state.storage.kv.list()]);
  const host = await fixtures.connect(entry);
  host.send({ type: "room.game.start" });
  await host.waitFor("room.snapshot", (message) => message.room.status === "playing");
  await resetDurableObjectStorage(stub);
  await runInDurableObject(env.GAME_ROOM.get(stub.id), (_, state) => {
    for (const [key, value] of waiting) state.storage.kv.put(key, value);
  });
  await fixtures.leave(entry);
});

test("削除前に配信されたAlarmが後片づけ後に届いてもCPUの選択を始めない", async () => {
  const fixtures = new RoomBoundaryFixtures();
  const entry = await fixtures.create({
    game: "four-reversi",
    mode: "singles",
    name: "本人",
    quickPlay: true,
  });
  const host = await fixtures.connect(entry);
  host.send({ type: "room.game.start" });
  await host.waitFor("room.snapshot", (message) => message.room.status === "playing");
  await disposeDurableObjects();
  const before = await runInDurableObject(
    env.GAME_ROOM.getByName(entry.room.id),
    async (_, state) => {
      const room = fourReversiRoomSchema.parse(state.storage.kv.get("room"));
      if (room.status !== "playing") throw new Error("Expected playing");
      const cpu = room.players.find((player) => player.kind === "cpu")!;
      const next = {
        ...room,
        game: { ...room.game, turn: cpu.color },
        clock: { ...room.clock, turnStartedAt: Date.now() - 3000 },
      };
      state.storage.kv.put("room", next);
      state.storage.kv.delete("four-reversi-cpu-job");
      return next.game;
    },
  );
  const after = await runInDurableObject(
    env.GAME_ROOM.getByName(entry.room.id),
    async (instance, state) => {
      await instance.alarm();
      return {
        game: fourReversiRoomSchema.parse(state.storage.kv.get("room")).game,
        job: state.storage.kv.get("four-reversi-cpu-job"),
        alarm: await state.storage.getAlarm(),
      };
    },
  );
  expect(after).toEqual({ game: before, job: undefined, alarm: null });
});
