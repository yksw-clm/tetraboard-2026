import { env } from "cloudflare:workers";
import { runInDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { afterEach, beforeEach, expect, test } from "vitest";
import { gomokuRoomSchema, publicGomokuMatchDetailSchema } from "@tetraboard/protocol";
import { RoomBoundaryFixtures, boundaryRequest } from "./roomBoundaryFixtures";

let fixtures: RoomBoundaryFixtures;
beforeEach(() => {
  fixtures = new RoomBoundaryFixtures();
});
afterEach(async () => {
  await fixtures.dispose();
});

async function setup() {
  const entry = await fixtures.create({ game: "gomoku", name: "ホスト", quickPlay: false });
  const host = await fixtures.connect(entry);
  const joined = await fixtures.join(entry.room.id, "相手");
  const guest = await fixtures.connect(joined);
  host.send({ type: "room.ready.set", ready: true });
  guest.send({ type: "room.ready.set", ready: true });
  await host.waitFor("room.snapshot", (message) => message.room.players.every((p) => p.ready));
  host.send({ type: "room.game.start" });
  const room = gomokuRoomSchema.parse(
    (await host.waitFor("room.snapshot", (message) => message.room.status === "playing")).room,
  );
  if (room.status !== "playing") throw new Error("Expected playing room");
  const blackIsHost =
    room.players.find((p) => p.color === "black")!.id === entry.membership.playerId;
  return {
    entry,
    room,
    black: blackIsHost ? host : guest,
    white: blackIsHost ? guest : host,
    blackEntry: blackIsHost ? entry : joined,
  };
}

test("手番外かつ古い着手は stale_position を返し、盤面・時計・棋譜を変更しない", async () => {
  const { entry, room, white } = await setup();
  white.send({
    type: "room.game.action",
    roundId: room.roundId,
    positionRevision: room.positionRevision + 1,
    action: { type: "placeGomokuStone", position: { x: 7, y: 7 } },
  });
  expect((await white.waitFor("room.error")).error).toBe("stale_position");
  const updated = gomokuRoomSchema.parse((await fixtures.snapshot(entry.room.id)).room);
  expect(updated.game).toEqual(room.game);
  expect(updated.clock).toEqual(room.clock);
  expect(updated.positionRevision).toBe(room.positionRevision);
  await runInDurableObject(env.GAME_ROOM.getByName(entry.room.id), (_instance, state) => {
    expect(state.storage.kv.get<{ steps: unknown[] }>("round-replay")?.steps).toEqual([]);
  });
});

test.each(["left", "disconnected"] as const)(
  "%s による脱落の理由と盤面を棋譜・終局保存へ引き継ぐ",
  async (reason) => {
    const { entry, black, white, blackEntry } = await setup();
    const stub = env.GAME_ROOM.getByName(entry.room.id);
    if (reason === "left") {
      await fixtures.leave(blackEntry);
    } else {
      black.close();
      await white.waitFor("room.snapshot", (message) =>
        message.room.players.some(
          (p) => p.id === blackEntry.membership.playerId && p.reconnectDeadline !== null,
        ),
      );
      await runInDurableObject(stub, (_instance, state) => {
        const saved = gomokuRoomSchema.parse(state.storage.kv.get("room"));
        const player = saved.players.find((p) => p.id === blackEntry.membership.playerId)!;
        player.reconnectDeadline = Date.now() - 1;
        state.storage.kv.put("room", saved);
      });
      await runDurableObjectAlarm(stub);
    }
    const ended = gomokuRoomSchema.parse(
      (await white.waitFor("room.snapshot", (message) => message.room.lastRound !== null)).room,
    );
    expect(ended.players.some((p) => p.id === blackEntry.membership.playerId)).toBe(false);
    if (reason === "disconnected") fixtures.forgetDepartedPlayer(blackEntry.membership.playerId);
    expect(ended.lastRound?.game.result).toMatchObject({ winner: "white", reason: "last_player" });
    const replay = ended.lastRound!.replay;
    expect(replay.steps).toHaveLength(1);
    expect(replay.steps[0].action).toEqual({ type: "eliminate", color: "black", reason });
    expect(replay.steps[0].game).toEqual(ended.lastRound!.game);
    await fixtures.snapshot(entry.room.id);
    const response = await boundaryRequest(`/matches/${replay.id}`);
    expect(response.status).toBe(200);
    const { match } = (await response.json()) as { match: unknown };
    expect(publicGomokuMatchDetailSchema.parse(match).replay).toEqual(replay);
    await runDurableObjectAlarm(stub);
    const unchanged = gomokuRoomSchema.parse((await fixtures.snapshot(entry.room.id)).room);
    expect(unchanged.lastRound?.replay).toEqual(replay);
  },
);
