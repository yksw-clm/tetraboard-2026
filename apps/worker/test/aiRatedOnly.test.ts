import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, expect, test, vi } from "vitest";
import {
  isFourReversiRoom,
  isFourShogiRoom,
  isReversiRoom,
  isShogiRoom,
} from "@tetraboard/protocol";
import { getLegalMoves as fourMoves } from "@tetraboard/four-reversi";
import { getLegalMoves as reversiMoves } from "@tetraboard/reversi";
import { roomAiAllowed } from "../src/rooms/aiService";
import { RoomBoundaryFixtures } from "./roomBoundaryFixtures";

let fixtures = new RoomBoundaryFixtures();
afterEach(async () => {
  vi.restoreAllMocks();
  await fixtures.dispose();
  fixtures = new RoomBoundaryFixtures();
  for (const game of ["four-reversi", "four-shogi", "shogi", "reversi"])
    await runInDurableObject(env.CPU_CAPACITY.getByName(game), (_, ctx) => ctx.storage.deleteAll());
});

test("本番の外部AIは二人・四人のレート戦だけに許可し、旧ランダムマッチを除外する", async () => {
  const four = (
    await fixtures.create({ game: "four-reversi", mode: "singles", name: "四人", quickPlay: false })
  ).room;
  const two = (await fixtures.create({ game: "shogi", name: "二人", quickPlay: false })).room;
  if (!isFourReversiRoom(four) || !isShogiRoom(two)) throw Error("Expected fixture games");
  const context = { id: crypto.randomUUID(), preparedAtMs: Date.now() };
  expect(roomAiAllowed({ AI_RATED_ONLY: "true" }, four)).toBe(false);
  expect(roomAiAllowed({ AI_RATED_ONLY: "true" }, { ...four, matchmaking: context })).toBe(false);
  expect(
    roomAiAllowed({ AI_RATED_ONLY: "true" }, { ...four, matchmaking: { ...context, rated: true } }),
  ).toBe(true);
  expect(
    roomAiAllowed(
      { AI_RATED_ONLY: "true" },
      { ...two, matchmaking: { ...context, opponent: "cpu" } },
    ),
  ).toBe(true);
  expect(roomAiAllowed({}, four)).toBe(true);
  expect(roomAiAllowed({ AI_RATED_ONLY: "false" }, four)).toBe(true);
});

test.each(["four-reversi", "four-shogi", "shogi", "reversi"] as const)(
  "%sの通常ルームはAI枠が満杯でも開始し、外部要求なしで従来CPUが着手する",
  async (game) => {
    let now = Date.now() + 60_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const capacity = env.CPU_CAPACITY.getByName(game);
    for (let i = 0; i < 4; i++) expect(await capacity.reserve(`busy-${i}`, 1, 1)).toBe(true);
    const entry = await fixtures.create({
      game,
      name: "人間",
      quickPlay: true,
      cpuLevel: 2,
      ...(["four-shogi", "four-reversi"].includes(game) ? { mode: "singles" } : {}),
    });
    const host = await fixtures.connect(entry);
    const stub = env.GAME_ROOM.getByName(entry.room.id);
    const fetchAi = vi.fn(async () => {
      throw Error("通常ルームからの外部AI要求");
    });
    const original = await runInDurableObject(stub, (instance) => {
      const original = Reflect.get(instance, "env");
      Reflect.set(instance, "env", {
        ...original,
        AI_RATED_ONLY: "true",
        AI_SHOGI_ENABLED: "true",
        AI_REVERSI_ENABLED: "true",
        AI_SERVICE_TOKEN: "rated-only-test-token-at-least-32-characters",
        AI_GATEWAY: { fetch: fetchAi },
      });
      return original;
    });
    try {
      host.send({ type: "room.game.start" });
      await host.waitFor("room.snapshot", (m) => m.room.status === "playing");
      let room = await stub.getRoom();
      if (!room || room.status !== "playing") throw Error("Expected playing room");
      const turn = room.game.turn;
      const humanTurn = room.players.some(
        (p) =>
          p.id === entry.membership.playerId &&
          ("side" in p ? p.side : "color" in p ? p.color : null) === turn,
      );
      if (humanTurn) {
        if (isShogiRoom(room) || isFourShogiRoom(room)) {
          host.send({
            type: "room.game.action",
            roundId: room.roundId,
            positionRevision: room.positionRevision,
            action: room.legalActions[0]!,
          });
        } else if (isFourReversiRoom(room) || isReversiRoom(room)) {
          const position = isFourReversiRoom(room)
            ? fourMoves(room.game)[0]!
            : reversiMoves(room.game)[0]!;
          host.send({ type: "room.game.action", action: { type: "placeStone", position } });
        }
        await host.waitFor("room.snapshot", (m) => (m.room.game?.moveNumber ?? 0) > 0);
        room = await stub.getRoom();
      }
      if (!room || room.status !== "playing") throw Error("Expected CPU turn");
      const moveNumber = room.game.moveNumber;
      now = room.clock.turnStartedAt + 2000;
      await runInDurableObject(stub, (instance) => instance.alarm());
      now += 2000;
      await runInDurableObject(stub, (instance) => instance.alarm());
      expect((await stub.getRoom())?.game?.moveNumber).toBeGreaterThan(moveNumber);
      expect(fetchAi).not.toHaveBeenCalled();
      expect(await capacity.availableSeats()).toBe(0);
    } finally {
      await runInDurableObject(stub, (instance) => Reflect.set(instance, "env", original));
    }
  },
);
