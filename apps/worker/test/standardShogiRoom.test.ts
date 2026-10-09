import { env } from "cloudflare:workers";
import { evictDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  isShogiRoom,
  publicShogiMatchDetailSchema,
  getShogiReplayContract,
  type ShogiRoom,
} from "@tetraboard/protocol";
import { RoomBoundaryFixtures, boundaryRequest, boundaryJson } from "./roomBoundaryFixtures";
let fixtures: RoomBoundaryFixtures;
beforeEach(() => {
  fixtures = new RoomBoundaryFixtures();
});
afterEach(async () => {
  await fixtures.dispose();
});
function shogi(room: Awaited<ReturnType<RoomBoundaryFixtures["snapshot"]>>["room"]): ShogiRoom {
  if (!isShogiRoom(room)) throw new Error("Expected shogi");
  return room;
}
async function setup() {
  const entry = await fixtures.create({ game: "shogi", name: "先輩", quickPlay: false });
  const host = await fixtures.connect(entry);
  const joined = await fixtures.join(entry.room.id, "後輩");
  const guest = await fixtures.connect(joined);
  for (const [client, id] of [
    [host, entry.membership.playerId],
    [guest, joined.membership.playerId],
  ] as const) {
    client.send({ type: "room.ready.set", ready: true });
    await host.waitFor(
      "room.snapshot",
      (m) => m.room.players.find((p) => p.id === id)?.ready === true,
    );
  }
  host.send({ type: "room.game.start" });
  const room = shogi(
    (await host.waitFor("room.snapshot", (m) => m.room.status === "playing")).room,
  );
  if (room.status !== "playing") throw Error("Expected playing");
  const first = room.game.players.south === entry.membership.playerId ? host : guest;
  const second = first === host ? guest : host;
  return { entry, joined, host, guest, first, second, room };
}
test("通常将棋はモードなしの2席で3人目とモード設定を拒否する", async () => {
  const entry = await fixtures.create({ game: "shogi", name: "ホスト", quickPlay: false });
  const host = await fixtures.connect(entry);
  expect(entry.room.settings).not.toHaveProperty("mode");
  await fixtures.join(entry.room.id, "相手");
  expect(
    (await boundaryRequest(`/rooms/${entry.room.id}/players`, boundaryJson({ name: "3人目" })))
      .status,
  ).toBe(409);
  host.send({ type: "room.mode.set", mode: "doubles" });
  expect((await host.waitFor("room.error")).error).toBe("forbidden");
  for (const mode of ["singles", "doubles"])
    expect(
      (
        await boundaryRequest(
          "/rooms",
          boundaryJson({ game: "shogi", name: "不正", quickPlay: false, mode }),
        )
      ).status,
    ).toBe(400);
  const response = await boundaryRequest("/rooms?game=shogi");
  expect(response.status).toBe(200);
  const data = (await response.json()) as {
    rooms: { id: string; capacity: number; mode?: string }[];
  };
  const listed = data.rooms.find((r) => r.id === entry.room.id);
  expect(listed).toMatchObject({ capacity: 2 });
  expect(listed).not.toHaveProperty("mode");
});
test("通常将棋の着手・古い局面拒否・休止復帰・投了を記録し、棋譜と再戦を保持する", async () => {
  const { entry, host, guest, first, second, room } = await setup();
  expect(room.game.board.flat().filter(Boolean)).toHaveLength(40);
  const action = room.legalActions[0];
  const command = {
    type: "room.game.action" as const,
    roundId: room.roundId,
    positionRevision: 0,
    action,
  };
  first.send(command);
  const played = shogi(
    (
      await host.waitFor(
        "room.snapshot",
        (m) => isShogiRoom(m.room) && m.room.positionRevision === 1,
      )
    ).room,
  );
  expect(played.game?.moveNumber).toBe(1);
  first.send(command);
  expect((await first.waitFor("room.error")).error).toBe("stale_position");
  const stub = env.GAME_ROOM.getByName(entry.room.id);
  await evictDurableObject(stub, { webSockets: "hibernate" });
  expect((await fixtures.snapshot(entry.room.id)).room).toEqual(played);
  first.send({ type: "room.game.resign" });
  expect((await first.waitFor("room.error")).error).toBe("not_your_turn");
  second.send({ type: "room.game.resign" });
  const ended = shogi(
    (await host.waitFor("room.snapshot", (m) => m.room.status === "waiting")).room,
  );
  expect(ended.lastRound?.game.result).toEqual({ winner: "south", reason: "resigned" });
  expect(ended.players).toHaveLength(2);
  expect(ended.players.every((p) => !p.ready)).toBe(true);
  const last = ended.lastRound!;
  await fixtures.snapshot(entry.room.id);
  const replayResponse = await boundaryRequest(
    `${getShogiReplayContract.pathFor(entry.room.id, last.roundId)}?instanceId=${room.instanceId}`,
  );
  expect(replayResponse.status).toBe(200);
  const replay = getShogiReplayContract.response.parse(await replayResponse.json());
  expect(replay.events.map((e) => e.event.type)).toEqual(["action", "eliminate"]);
  const savedResponse = await boundaryRequest(`/matches/${last.roundId}`);
  expect(savedResponse.status).toBe(200);
  const saved = publicShogiMatchDetailSchema.parse(
    ((await savedResponse.json()) as { match: unknown }).match,
  );
  expect(saved.game).toEqual(last.game);
  expect(saved.settings).not.toHaveProperty("mode");
  const savedReplay = await boundaryRequest(`/matches/${last.roundId}/replay`);
  expect(savedReplay.status).toBe(200);
  host.send({ type: "room.ready.set", ready: true });
  guest.send({ type: "room.ready.set", ready: true });
  await host.waitFor("room.snapshot", (m) => m.room.players.every((p) => p.ready));
  host.send({ type: "room.game.start" });
  const next = shogi(
    (await host.waitFor("room.snapshot", (m) => m.room.status === "playing")).room,
  );
  expect(next.lastRound).toBeNull();
  if (next.status !== "playing") throw Error("Expected playing");
  expect(next.roundId).not.toBe(room.roundId);
  expect(next.game.drawProposals).toEqual([]);
  expect(next.game.moveNumber).toBe(0);
});
