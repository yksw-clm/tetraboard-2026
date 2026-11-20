import { runInDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { expect, test } from "vitest";
import {
  leaveRoomContract,
  isFourShogiRoom,
  fourShogiRoomSchema,
  type GameId,
} from "@tetraboard/protocol";
import { boundaryRequest } from "./roomBoundaryFixtures";
import { origin } from "./accountFixtures";
import {
  registerRoomDeadlineBoundaryFixtures,
  start,
  snapshot,
  roomSchema,
  connect,
} from "./roomDeadlineBoundaryFixtures";

registerRoomDeadlineBoundaryFixtures();

test.each(["同時刻", "切断が先", "時計が先", "切断同士"])(
  "将棋: %s の期限を確定時刻と席順で処理する",
  async (ordering) => {
    const prepared = await start("four-shogi");
    const started = fourShogiRoomSchema.parse(prepared.room);
    if (started.status !== "playing") throw new Error("Not playing");
    const selected =
      ordering === "切断同士"
        ? started.players.filter((player) => player.side === "west" || player.side === "north")
        : started.players.filter((player) => player.side === "east");
    const at = Date.now() - 10;
    await runInDurableObject(prepared.stub, (_instance, state) => {
      const room = fourShogiRoomSchema.parse(state.storage.kv.get("room"));
      if (room.status !== "playing") throw new Error("Not playing");
      state.storage.kv.put(
        "room",
        fourShogiRoomSchema.parse({
          ...room,
          clock: {
            ...room.clock,
            turnExpiresAt:
              ordering === "切断同士"
                ? Date.now() + 60_000
                : at + (ordering === "切断が先" ? 1 : 0),
          },
          players: room.players.map((player) =>
            selected.some((entry) => entry.id === player.id)
              ? { ...player, reconnectDeadline: at + (ordering === "時計が先" ? 1 : 0) }
              : player,
          ),
        }),
      );
    });
    expect(await runDurableObjectAlarm(prepared.stub)).toBe(true);
    const result = fourShogiRoomSchema.parse((await snapshot(started.id)).room);
    if (result.status !== "playing") throw new Error("Ended early");
    const expected =
      ordering === "切断同士"
        ? selected.map((player) => ({ side: player.side, reason: "disconnected" }))
        : ordering === "切断が先"
          ? [
              { side: "east", reason: "disconnected" },
              { side: "south", reason: "timeout" },
            ]
          : [
              { side: "south", reason: "timeout" },
              { side: "east", reason: "disconnected" },
            ];
    expect(result.game.eliminations.map(({ side, reason }) => ({ side, reason }))).toEqual(
      expected,
    );
    expect(result.positionRevision).toBe(2);
  },
);

for (const game of ["four-reversi", "four-shogi"] satisfies GameId[]) {
  test.each(["着手", "投了"])(
    `${game}: 保存期限後の%sは既存のエラーを返し、時間切れを一度だけ確定する`,
    async (operation) => {
      const prepared = await start(game);
      const playing = prepared.room;
      const current = isFourShogiRoom(playing)
        ? playing.players.find((player) => player.side === playing.game.turn)
        : playing.players.find((player) => player.color === playing.game.turn);
      const index = prepared.members.findIndex(
        (entry) => entry.membership.playerId === current?.id,
      );
      if (index < 0) throw new Error("Missing current player");
      await runInDurableObject(prepared.stub, (_instance, state) => {
        state.storage.kv.put(
          "room",
          roomSchema.parse({
            ...playing,
            clock: { ...playing.clock, turnExpiresAt: Date.now() - 1 },
          }),
        );
      });
      if (operation === "投了") prepared.clients[index].send({ type: "room.game.resign" });
      else if (isFourShogiRoom(playing)) {
        const action = playing.legalActions[0];
        if (!action) throw new Error("Missing action");
        prepared.clients[index].send({
          type: "room.game.action",
          action,
          roundId: playing.roundId,
          positionRevision: playing.positionRevision,
        });
      } else
        prepared.clients[index].send({
          type: "room.game.action",
          roundId: playing.roundId,
          positionRevision: playing.positionRevision,
          action: { type: "placeStone", position: { x: 0, y: 0 } },
        });
      expect((await prepared.clients[index].waitFor("room.error")).error).toBe(
        operation === "着手" ? "stale_position" : "already_eliminated",
      );
      const result = (await snapshot(playing.id)).room;
      if (result.status !== "playing") throw new Error("Ended early");
      if (isFourShogiRoom(result)) {
        expect(result.positionRevision).toBe(1);
        expect(result.game.eliminations).toMatchObject([
          { side: playing.game.turn, reason: "timeout" },
        ]);
      } else expect(result.eliminations).toEqual([{ color: playing.game.turn, reason: "timeout" }]);
      expect(result.game.moveNumber).toBe(0);
    },
  );
}

test.each(["four-reversi", "four-shogi"] as const)(
  "%s: 同じ資格の複数接続は最後の切断まで復帰期限を付けない",
  async (game) => {
    const prepared = await start(game);
    const second = await connect(prepared.members[0]);
    prepared.clients[0].close();
    const connected = await snapshot(prepared.room.id);
    expect(connected.presence.connectedPlayerIds).toContain(
      prepared.members[0].membership.playerId,
    );
    expect(
      connected.room.players.find((p) => p.id === prepared.members[0].membership.playerId)
        ?.reconnectDeadline,
    ).toBeNull();
    second.close();
    const message = await prepared.clients[1].waitFor(
      "room.snapshot",
      (event) =>
        !event.presence.connectedPlayerIds.includes(prepared.members[0].membership.playerId),
    );
    expect(
      message.room.players.find((p) => p.id === prepared.members[0].membership.playerId)
        ?.reconnectDeadline,
    ).toBeTypeOf("number");
  },
);

test("将棋: 再戦待機へ移行しても切断からの元の復帰期限を保持する", async () => {
  const prepared = await start("four-shogi");
  const disconnectedId = prepared.members[3].membership.playerId;
  prepared.clients[3].close();
  const disconnected = await prepared.clients[0].waitFor(
    "room.snapshot",
    (message) => !message.presence.connectedPlayerIds.includes(disconnectedId),
  );
  const deadline = disconnected.room.players.find(
    (player) => player.id === disconnectedId,
  )?.reconnectDeadline;
  expect(deadline).toBeTypeOf("number");
  for (const member of prepared.members.slice(0, 3)) {
    const response = await boundaryRequest(leaveRoomContract.pathFor(prepared.room.id), {
      method: "POST",
      headers: { Origin: origin, Authorization: `Bearer ${member.membership.token}` },
    });
    expect(response.status).toBe(204);
  }
  const waiting = await snapshot(prepared.room.id);
  expect(waiting.room.status).toBe("waiting");
  expect(waiting.room.players.map((player) => player.id)).toEqual([disconnectedId]);
  expect(waiting.room.players[0].reconnectDeadline).toBe(deadline);
  expect(waiting.room.players[0].ready).toBe(false);
  await connect(prepared.members[3]);
  const restored = await snapshot(prepared.room.id);
  expect(restored.room.players[0].reconnectDeadline).toBeNull();
});
