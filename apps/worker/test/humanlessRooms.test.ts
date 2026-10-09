import { isReversiRoom } from "@tetraboard/protocol";
import { env, exports } from "cloudflare:workers";
import { runInDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { afterEach, expect, test, vi } from "vitest";
import {
  createRoomContract,
  roomSchema,
  roomSocketContract,
  isFourShogiRoom,
  type RoomSocketClientMessage,
} from "@tetraboard/protocol";
import { eliminateSide, getLegalActions } from "@tetraboard/four-shogi";
import { eliminateColor } from "@tetraboard/four-reversi";
import { ShogiStore } from "../src/rooms/shogiStore";
import { accountFixture, origin } from "./accountFixtures";

type Game = "four-reversi" | "four-shogi";
const sockets: WebSocket[] = [];
afterEach(() => {
  for (const socket of sockets.splice(0)) socket.close();
});
const request = (path: string, init?: RequestInit) =>
  exports.default.fetch(new Request(origin + "/api" + path, init));
const post = (body: unknown) => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});
async function connect(id: string, token?: string) {
  const response = await request(`/rooms/${id}/ws`, { headers: { Upgrade: "websocket" } });
  expect(response.status).toBe(101);
  const socket = response.webSocket!;
  const authenticated = new Promise<void>((resolve) =>
    socket.addEventListener("message", (event) => {
      if (
        roomSocketContract.message.parse(JSON.parse(String(event.data))).type ===
        "room.authenticated"
      )
        resolve();
    }),
  );
  socket.accept();
  sockets.push(socket);
  if (token) {
    send(socket, { type: "room.auth", token });
    await authenticated;
  }
  return socket;
}
function send(socket: WebSocket, message: RoomSocketClientMessage) {
  socket.send(JSON.stringify(message));
}
async function setup(game: Game, mode: "singles" | "doubles" = "singles", account = false) {
  const user = account ? await accountFixture() : null;
  const response = await request("/rooms", {
    ...post({ game, mode, quickPlay: true, ...(user ? {} : { name: "ホスト" }) }),
    ...(user ? { headers: user.headers } : {}),
  });
  expect(response.status).toBe(201);
  const created = createRoomContract.response.parse(await response.json());
  const stub = env.GAME_ROOM.getByName(created.room.id);
  const host = await connect(created.room.id, created.membership.token);
  send(host, { type: "room.game.start" });
  await vi.waitFor(async () => expect((await stub.getRoom())?.status).toBe("playing"));
  const roundId = await runInDurableObject(stub, (_, state) => {
    const room = roomSchema.parse(state.storage.kv.get("room"));
    if (room.status !== "playing") throw new Error("Not playing");
    // Hold the turn on the host so unrelated CPU alarms cannot advance these boundary tests.
    if (isReversiRoom(room)) throw Error("Expected existing game fixture");
    if (isFourShogiRoom(room)) {
      room.game.turn = room.players[0].side;
      room.legalActions = getLegalActions({ ...room.game, repetitions: {} });
    } else room.game.turn = room.players[0].color;
    room.clock.turnStartedAt = Date.now();
    room.clock.turnExpiresAt = Date.now() + 300_000;
    state.storage.kv.put("room", roomSchema.parse(room));
    state.storage.kv.delete("shogi-cpu-job");
    const start = state.storage.kv.get<{ id?: string; start?: { id: string } }>(
      isFourShogiRoom(room) ? "shogi-match-start" : "match-start",
    )!;
    return isFourShogiRoom(room) ? room.roundId : start.id!;
  });
  return { ...created, stub, host, roundId, user };
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
type Prepared = Awaited<ReturnType<typeof setup>>;
async function closed(setup: Prepared) {
  expect((await request(`/rooms/${setup.room.id}`)).status).toBe(404);
  await vi.waitFor(async () =>
    expect(
      await env.APP_DB.prepare("SELECT closed FROM room_index WHERE room_id = ?")
        .bind(setup.room.id)
        .first(),
    ).toEqual({ closed: 1 }),
  );
  expect(
    await runInDurableObject(setup.stub, (_, state) => ({
      room: state.storage.kv.get("room"),
      replay: state.storage.kv.get("round-replay"),
      start: state.storage.kv.get("match-start"),
      shogiStart: state.storage.kv.get("shogi-match-start"),
      cpu: state.storage.kv.get("shogi-cpu-job"),
    })),
  ).toEqual({
    room: undefined,
    replay: undefined,
    start: undefined,
    shogiStart: undefined,
    cpu: undefined,
  });
}
async function notSaved(setup: Prepared) {
  expect(
    await env.APP_DB.prepare("SELECT COUNT(*) AS n FROM matches WHERE id = ?")
      .bind(setup.roundId)
      .first(),
  ).toEqual({ n: 0 });
  expect(
    await env.APP_DB.prepare("SELECT COUNT(*) AS n FROM account_match_history WHERE match_id = ?")
      .bind(setup.roundId)
      .first(),
  ).toEqual({ n: 0 });
  expect(
    await runInDurableObject(
      setup.stub,
      (_, state) =>
        [
          ...state.storage.kv.list({ prefix: "match-pending:" }),
          ...state.storage.kv.list({ prefix: "shogi-match-pending:" }),
        ].length,
    ),
  ).toBe(0);
}
async function expire(setup: Prepared) {
  await runInDurableObject(setup.stub, async (_, state) => {
    const room = roomSchema.parse(state.storage.kv.get("room"));
    const at = Date.now() - 1;
    room.players[0].reconnectDeadline = at;
    state.storage.kv.put("disconnected-at:" + room.players[0].id, at - 30_000);
    state.storage.kv.put("room", room);
    await state.storage.setAlarm(Date.now() + 60_000);
  });
  await runDurableObjectAlarm(setup.stub);
}

for (const game of ["four-reversi", "four-shogi"] as const) {
  for (const account of [false, true]) {
    test(`${game}: 最後の${account ? "ログイン者" : "ゲスト"}の退室で未決着を破棄し観戦接続も閉じる`, async () => {
      const prepared = await setup(game, "singles", account);
      const observer = await connect(prepared.room.id);
      await leave(prepared.room.id, prepared.membership.token);
      await closed(prepared);
      await notSaved(prepared);
      await vi.waitFor(() => expect(observer.readyState).toBe(WebSocket.CLOSED));
      expect(
        (
          await request(`/rooms/${prepared.room.id}/leave`, {
            method: "POST",
            headers: { Authorization: `Bearer ${prepared.membership.token}` },
          })
        ).status,
      ).toBe(404);
      await runInDurableObject(prepared.stub, (instance) => instance.alarm());
      await notSaved(prepared);
      if (prepared.user)
        await vi.waitFor(async () =>
          expect(
            await env.APP_DB.prepare(
              "SELECT COUNT(*) AS n FROM account_room_seats WHERE account_id = ?",
            )
              .bind(prepared.user!.id)
              .first(),
          ).toEqual({ n: 0 }),
        );
    });
  }

  test(`${game}: 復帰待ちは部屋を維持し、期限前に復帰でき、最後の期限切れで閉鎖する`, async () => {
    const prepared = await setup(game);
    const observer = await connect(prepared.room.id);
    prepared.host.close();
    await vi.waitFor(async () =>
      expect((await prepared.stub.getRoom())!.players[0].reconnectDeadline).toBeGreaterThan(
        Date.now(),
      ),
    );
    const reconnected = await connect(prepared.room.id, prepared.membership.token);
    expect((await prepared.stub.getRoom())!.players[0].reconnectDeadline).toBeNull();
    reconnected.close();
    await vi.waitFor(async () =>
      expect((await prepared.stub.getRoom())!.players[0].reconnectDeadline).not.toBeNull(),
    );
    await expire(prepared);
    await closed(prepared);
    await notSaved(prepared);
    await vi.waitFor(() => expect(observer.readyState).toBe(WebSocket.CLOSED));
  });

  test(`${game}: 投了後のゲストも在室と復帰待ちを維持し、期限切れで二重脱落せず閉鎖する`, async () => {
    const prepared = await setup(game);
    send(prepared.host, { type: "room.game.resign" });
    await vi.waitFor(async () =>
      expect((await prepared.stub.getRoom())?.eliminations).toHaveLength(1),
    );
    expect((await prepared.stub.getRoom())?.status).toBe("playing");
    prepared.host.close();
    await vi.waitFor(async () =>
      expect((await prepared.stub.getRoom())!.players[0].reconnectDeadline).toBeGreaterThan(
        Date.now(),
      ),
    );
    await expire(prepared);
    await closed(prepared);
    await notSaved(prepared);
  });

  test(`${game}: 投了後も在室する最後の参加者の明示退室で閉鎖する`, async () => {
    const prepared = await setup(game);
    send(prepared.host, { type: "room.game.resign" });
    await vi.waitFor(async () =>
      expect((await prepared.stub.getRoom())?.eliminations).toHaveLength(1),
    );
    await leave(prepared.room.id, prepared.membership.token);
    await closed(prepared);
    await notSaved(prepared);
  });

  test(`${game}: 全員の復帰待ち中もCPUは進行し、在室資格を保持する`, async () => {
    const prepared = await setup(game);
    prepared.host.close();
    await vi.waitFor(async () =>
      expect((await prepared.stub.getRoom())!.players[0].reconnectDeadline).toBeGreaterThan(
        Date.now(),
      ),
    );
    const before = await runInDurableObject(prepared.stub, async (_, state) => {
      const room = roomSchema.parse(state.storage.kv.get("room"));
      if (room.status !== "playing") throw new Error("Not playing");
      if (isReversiRoom(room)) throw Error("Expected existing game fixture");
      if (isFourShogiRoom(room)) {
        room.game.turn = room.players.find((player) => player.kind === "cpu")!.side;
        room.legalActions = getLegalActions({ ...room.game, repetitions: {} });
      } else room.game.turn = room.players.find((player) => player.kind === "cpu")!.color;
      room.clock.turnStartedAt = Date.now() - 1000;
      state.storage.kv.put("room", roomSchema.parse(room));
      await state.storage.setAlarm(Date.now() + 60_000);
      return room.game.moveNumber;
    });
    await runDurableObjectAlarm(prepared.stub);
    if (game === "four-shogi") {
      await runInDurableObject(prepared.stub, async (_, state) => {
        const job = state.storage.kv.get<{ applyAt: number }>("shogi-cpu-job")!;
        state.storage.kv.put("shogi-cpu-job", { ...job, applyAt: Date.now() - 1 });
        await state.storage.setAlarm(Date.now() + 60_000);
      });
      await runDurableObjectAlarm(prepared.stub);
    }
    const advanced = await prepared.stub.getRoom();
    if (!advanced || advanced.status !== "playing")
      throw new Error("Room stopped during grace period");
    expect(advanced.game.moveNumber).toBeGreaterThan(before);
    expect(advanced.players[0].reconnectDeadline).toBeGreaterThan(Date.now());
    await connect(prepared.room.id, prepared.membership.token);
    await leave(prepared.room.id, prepared.membership.token);
  });

  test(`${game}: 同じ参加資格の別接続があれば切断扱いにしない`, async () => {
    const prepared = await setup(game);
    const other = await connect(prepared.room.id, prepared.membership.token);
    prepared.host.close();
    await vi.waitFor(async () =>
      expect((await prepared.stub.getRoom())!.players[0].reconnectDeadline).toBeNull(),
    );
    expect(other.readyState).toBe(WebSocket.OPEN);
    await leave(prepared.room.id, prepared.membership.token);
    await closed(prepared);
  });

  test(`${game}: ダブルスの退室による即時決着は部屋閉鎖後も保存する`, async () => {
    const prepared = await setup(game, "doubles");
    await leave(prepared.room.id, prepared.membership.token);
    await closed(prepared);
    await vi.waitFor(async () =>
      expect(
        await env.APP_DB.prepare("SELECT id FROM matches WHERE id = ?")
          .bind(prepared.roundId)
          .first(),
      ).toEqual({ id: prepared.roundId }),
    );
  });

  test(`${game}: 過去の人間不在状態は次のAlarmで破棄し、期限切れの閲覧資格では維持しない`, async () => {
    const prepared = await setup(game);
    await runInDurableObject(prepared.stub, async (_, state) => {
      state.storage.kv.put("departed:" + prepared.membership.playerId, true);
      let room = roomSchema.parse(state.storage.kv.get("room"));
      if (room.status !== "playing") throw new Error("Not playing");
      // A former CPU-only round with two survivors must not finish via an overdue CPU timeout.
      if (isReversiRoom(room)) throw Error("Expected existing game fixture");
      if (isFourShogiRoom(room)) {
        const store = new ShogiStore(state.storage.sql);
        const first = eliminateSide(
          store.loadState(room.roundId, room.game),
          room.players[0].side,
          "left",
        );
        if (!first.ok) throw new Error("Cannot eliminate host");
        const second = eliminateSide(first.state, room.players[1].side, "timeout");
        if (!second.ok || second.state.status !== "playing")
          throw new Error("Cannot prepare CPU survivors");
        room = roomSchema.parse({
          ...room,
          game: store.saveState(room.roundId, second.state),
          eliminations: second.state.eliminations,
          legalActions: getLegalActions(second.state),
        });
      } else {
        const first = eliminateColor(room.game, room.players[0].color);
        if (!first.ok) throw new Error("Cannot eliminate host");
        const second = eliminateColor(first.state, room.players[1].color);
        if (!second.ok || second.state.status !== "playing")
          throw new Error("Cannot prepare CPU survivors");
        room = roomSchema.parse({ ...room, game: second.state });
      }
      if (room.status !== "playing") throw new Error("Not playing");
      room.clock.turnStartedAt = Date.now() - 1000;
      room.clock.turnExpiresAt = Date.now() - 1;
      state.storage.kv.put("room", roomSchema.parse(room));
      if (isFourShogiRoom(room) && room.status === "playing") {
        const cpu = room.players.find((player) => player.side === room.game!.turn)!;
        room.game.turn = cpu.side;
        room.legalActions = getLegalActions({ ...room.game, repetitions: {} });
        state.storage.kv.put("shogi-cpu-job", {
          roundId: room.roundId,
          positionRevision: room.positionRevision,
          side: cpu.side,
          action: room.legalActions[0],
          applyAt: Date.now() - 1,
        });
        room.clock.turnStartedAt = Date.now() - 1000;
        state.storage.kv.put("room", roomSchema.parse(room));
      }
      await state.storage.setAlarm(Date.now() + 60_000);
    });
    await runDurableObjectAlarm(prepared.stub);
    await closed(prepared);
    await notSaved(prepared);
  });
}
