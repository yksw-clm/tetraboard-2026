import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { getLegalActions } from "@tetraboard/four-shogi";
import { getActionAvailability } from "@tetraboard/shogi";
import { isFourShogiRoom, isShogiRoom, roomSchema, type GameId } from "@tetraboard/protocol";
import { ShogiStore } from "../src/rooms/shogiStore";
import { StandardShogiStore } from "../src/rooms/standardShogiStore";
import type { RoomBoundaryFixtures } from "./roomBoundaryFixtures";

export async function startCpuRoom(fixtures: RoomBoundaryFixtures, game: GameId, level = 1) {
  const entry = await fixtures.create({
    game,
    name: "本人",
    quickPlay: true,
    cpuLevel: level,
    ...(game.startsWith("four-") ? { mode: "singles" } : {}),
  });
  const host = await fixtures.connect(entry);
  host.send({ type: "room.game.start" });
  await host.waitFor("room.snapshot", (message) => message.room.status === "playing");
  const stub = env.GAME_ROOM.getByName(entry.room.id);
  const at = Date.now() + 60_000;
  const room = await runInDurableObject(stub, (_, ctx) => {
    let saved = roomSchema.parse(ctx.storage.kv.get("room"));
    if (saved.status !== "playing") throw Error("Expected playing");
    if (isFourShogiRoom(saved)) {
      const cpu = saved.players.find((player) => player.kind === "cpu")!;
      const store = new ShogiStore(ctx.storage.sql);
      const state = store.loadState(saved.roundId, saved.game);
      if (state.status !== "playing") throw Error("Expected playing");
      const next = { ...state, turn: cpu.side };
      saved = roomSchema.parse({
        ...saved,
        game: store.saveState(saved.roundId, next),
        legalActions: getLegalActions(next),
      });
    } else if (isShogiRoom(saved)) {
      const cpu = saved.players.find((player) => player.kind === "cpu")!;
      const store = new StandardShogiStore(ctx.storage.sql);
      const { state } = store.loadTransition(saved.roundId, saved.game);
      if (state.status !== "playing") throw Error("Expected playing");
      const next = { ...state, turn: cpu.side };
      saved = roomSchema.parse({
        ...saved,
        game: store.saveState(saved.roundId, next),
        ...getActionAvailability(next),
      });
    } else {
      const cpu = saved.players.find((player) => player.kind === "cpu")!;
      saved = roomSchema.parse({ ...saved, game: { ...saved.game, turn: cpu.color } });
    }
    if (saved.status !== "playing") throw Error("Expected playing");
    saved.clock.turnStartedAt = at;
    saved.clock.turnExpiresAt = at + 300_000;
    ctx.storage.kv.put("room", saved);
    return saved;
  });
  return { stub, at, room };
}
