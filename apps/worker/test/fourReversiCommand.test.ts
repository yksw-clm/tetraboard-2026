import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, expect, test } from "vitest";
import {
  fourReversiRoomSchema,
  type FourReversiRoom,
  type GameActionCommandFor,
} from "@tetraboard/protocol";
import { getLegalMoves } from "@tetraboard/four-reversi";
import { FourReversiProgress } from "../src/rooms/fourReversiProgress";
import { RoomBoundaryFixtures } from "./roomBoundaryFixtures";

let fixtures = new RoomBoundaryFixtures();
afterEach(async () => {
  await fixtures.dispose();
  fixtures = new RoomBoundaryFixtures();
});

test("着手と投了は状態・本人・時計・脱落・手番の順で拒否し、拒否で棋譜を変えない", async () => {
  const entry = await fixtures.create({
    game: "four-reversi",
    name: "ホスト",
    quickPlay: true,
    cpuLevel: 1,
    mode: "singles",
  });
  await runInDurableObject(env.GAME_ROOM.getByName(entry.room.id), (_, ctx) => {
    const waiting = fourReversiRoomSchema.parse(ctx.storage.kv.get("room"));
    if (waiting.status !== "waiting") throw Error("Expected waiting");
    const progress = new FourReversiProgress({
      storage: ctx.storage,
      accountId: () => null,
      membership: (id) => (id === "unknown" ? null : { playerId: id, role: "player" }),
    });
    const { room } = progress.start(waiting);
    const current = room.players.find((p) => p.color === room.game.turn)!;
    const other = room.players.find((p) => p.color !== room.game.turn)!;
    const expired = { ...room, clock: { ...room.clock, turnExpiresAt: Date.now() } };
    const command: GameActionCommandFor<"four-reversi"> = {
      type: "room.game.action",
      action: { type: "placeStone", position: getLegalMoves(room.game)[0]! },
    };
    const before = ctx.storage.kv.get("round-replay");
    const cases: [FourReversiRoom, string, string][] = [
      [waiting, "unknown", "game_not_started"],
      [expired, "unknown", "unauthorized"],
      [expired, "missing-player", "unauthorized"],
      [expired, other.id, "time_expired"],
      [
        { ...expired, game: { ...expired.game, eliminatedColors: [other.color] } },
        other.id,
        "time_expired",
      ],
      [
        { ...room, game: { ...room.game, eliminatedColors: [other.color] } },
        other.id,
        "already_eliminated",
      ],
      [room, other.id, "not_your_turn"],
    ];
    for (const [input, token, error] of cases) {
      expect(progress.play(input, token, command)).toEqual({ kind: "rejected", error });
      expect(progress.resign(input, token)).toEqual({ kind: "rejected", error });
    }
    expect(ctx.storage.kv.get("round-replay")).toEqual(before);
    expect(progress.play(room, current.id, command).kind).toBe("playing");
  });
});
