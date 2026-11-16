import { env } from "cloudflare:workers";
import { expect, vi } from "vitest";
import { isFourShogiRoom, type GameId, type RatedMatchmakingGame } from "@tetraboard/protocol";
import type { PlayingFor } from "../src/rooms/gameProgress";
import type { ActiveShogiMatch } from "../src/rooms/shogiMatchStore";
import { selectFourShogi } from "../src/matchmaking/fourShogiSelection";
import { cpuAiReply } from "./cpuAiReplies";

export function prepareExternalCpuRoom(
  ctx: DurableObjectState,
  room: PlayingFor<GameId>,
  at: number,
) {
  if (!isFourShogiRoom(room)) return;
  const rating = selectFourShogi([{}], 20_000)!.rating;
  const active = ctx.storage.kv.get<ActiveShogiMatch>("shogi-match-start")!;
  active.start.fourShogiRating = {
    method: "openskill-5.0.1-plackett-luce",
    calibrationVersion: rating.calibrationVersion,
    cpu: Object.fromEntries(
      room.players.flatMap((player) => (player.kind === "cpu" ? [[player.side, rating.cpu!]] : [])),
    ),
  };
  ctx.storage.kv.put("shogi-match-start", active);
  ctx.storage.kv.put("room", {
    ...room,
    matchmaking: { id: room.roundId, preparedAtMs: at, rated: true },
  });
}

async function releaseExternalCpuRoom(
  ctx: DurableObjectState,
  room: PlayingFor<GameId>,
  game: RatedMatchmakingGame,
) {
  const capacity = ctx.storage.kv.get<{ sequence: number }>("external-cpu-capacity");
  if (capacity) {
    await env.CPU_CAPACITY.getByName(game).release(room.id, capacity.sequence);
    ctx.storage.kv.delete("external-cpu-capacity");
  }
  const saved = ctx.storage.kv.get<Record<string, unknown>>("room");
  if (saved && isFourShogiRoom(room)) {
    delete saved.matchmaking;
    ctx.storage.kv.put("room", saved);
  }
}

export function externalCpuEnvironment(
  instance: object,
  ctx: DurableObjectState,
  room: PlayingFor<GameId>,
  options: { game: RatedMatchmakingGame; key: string; at: number; fallback: boolean },
) {
  const { game, key, at, fallback } = options;
  const clock = vi.spyOn(Date, "now").mockReturnValue(at + 2000);
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const info = vi.spyOn(console, "info").mockImplementation(() => {});
  const gateway = vi.fn(async (request: Request) => {
    const pending = ctx.storage.kv.get<{ expiresAt: number }>(key);
    expect(pending?.expiresAt).toBe(at + (game === "four-reversi" ? 7250 : 7000));
    expect(await ctx.storage.getAlarm()).toBe(pending!.expiresAt);
    return fallback ? new Response(null, { status: 401 }) : cpuAiReply(request, room);
  });
  const original = Reflect.get(instance, "env");
  Reflect.set(instance, "env", {
    ...original,
    AI_GATEWAY: { fetch: gateway },
    AI_SERVICE_TOKEN: "cpu-adapter-test-token-at-least-32-characters",
    AI_SHOGI_ENABLED: "true",
    AI_REVERSI_ENABLED: "true",
    FOUR_SHOGI_DIAGNOSTICS: "true",
  });
  return {
    clock,
    warn,
    info,
    gateway,
    restore: async () => {
      try {
        await releaseExternalCpuRoom(ctx, room, game);
      } finally {
        Reflect.set(instance, "env", original);
        clock.mockRestore();
        warn.mockRestore();
        info.mockRestore();
      }
    },
  };
}
