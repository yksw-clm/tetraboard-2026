import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, expect, test, vi } from "vitest";
import { fourShogiRoomSchema, type FourShogiRoom } from "@tetraboard/protocol";
import { getActionAvailability } from "@tetraboard/four-shogi";
import {
  FourShogiProgress,
  fourShogiAiJobKey,
  type ShogiCpuJob,
} from "../src/rooms/fourShogiProgress";
import type { FourShogiCpuResponse } from "../src/rooms/fourShogiCpu";
import { selectFourShogi } from "../src/adapters/matchmaking/fourShogiSelection";
import { shogiCpuJobKey } from "../src/rooms/progressHelpers";
import { shogiMatchStartKey, type ActiveShogiMatch } from "../src/adapters/record/shogiMatchStore";
import { RoomBoundaryFixtures } from "./roomBoundaryFixtures";

let fixtures = new RoomBoundaryFixtures();
afterEach(async () => {
  vi.restoreAllMocks();
  await fixtures.dispose();
  fixtures = new RoomBoundaryFixtures();
});
type Playing = Extract<FourShogiRoom, { status: "playing" }>;
async function setup() {
  const entry = await fixtures.create({
    game: "four-shogi",
    name: "人間",
    quickPlay: true,
    cpuLevel: 2,
    mode: "singles",
  });
  return { entry, stub: env.GAME_ROOM.getByName(entry.room.id) };
}
function cpuTurn(progress: FourShogiProgress, room: Playing): Playing {
  const cpu = room.players.find((p) => p.kind === "cpu")!;
  const state = { ...room.game, repetitions: {}, turn: cpu.side };
  return {
    ...room,
    game: progress.store().saveState(room.roundId, state),
    ...getActionAvailability(state),
  } as Playing;
}
const rating = selectFourShogi([{}], 20_000)!.rating;

test("着手・引分提案・投了が共通の確認順に従う", async () => {
  const { entry, stub } = await setup();
  await runInDurableObject(stub, (_, ctx) => {
    const progress = new FourShogiProgress({
      storage: ctx.storage,
      membership: (token) =>
        token === "human" ? { playerId: entry.membership.playerId, role: "host" } : null,
      accountId: () => null,
    });
    const waiting = fourShogiRoomSchema.parse(entry.room);
    if (waiting.status !== "waiting") throw Error("Expected waiting");
    const room = progress.start(waiting).room;
    const human = room.players.find((p) => p.kind === "human")!;
    const onTurn = { ...room, game: { ...room.game, turn: human.side } };
    const expired = { ...onTurn, clock: { ...room.clock, turnExpiresAt: Date.now() - 1 } };
    const calls = (input: FourShogiRoom, token: string, roundId = room.roundId) => [
      progress.play(input, token, {
        type: "room.game.action",
        roundId,
        positionRevision: 0,
        action: room.legalActions[0],
      }),
      progress.draw(input, token, {
        type: "room.game.draw.set",
        roundId,
        positionRevision: 0,
        proposed: true,
      }),
    ];
    for (const result of calls(waiting, "unknown"))
      expect(result).toEqual({ kind: "rejected", error: "game_not_started" });
    for (const result of calls(expired, "unknown", "old"))
      expect(result).toEqual({ kind: "rejected", error: "unauthorized" });
    for (const result of calls(expired, "human", "old"))
      expect(result).toEqual({ kind: "rejected", error: "stale_position" });
    for (const result of calls(expired, "human"))
      expect(result).toEqual({ kind: "rejected", error: "time_expired" });
    expect(progress.resign(expired, "unknown")).toEqual({
      kind: "rejected",
      error: "unauthorized",
    });
    expect(progress.resign(expired, "human")).toEqual({ kind: "rejected", error: "time_expired" });
    const eliminated = {
      ...onTurn,
      game: {
        ...onTurn.game,
        turn: room.players.find((p) => p.kind === "cpu")!.side,
        eliminations: [{ side: human.side, reason: "left" as const, rank: 4 as const, group: 1 }],
      },
    };
    for (const result of calls(eliminated, "human"))
      expect(result).toEqual({ kind: "rejected", error: "already_eliminated" });
    expect(progress.resign(eliminated, "human")).toEqual({
      kind: "rejected",
      error: "already_eliminated",
    });
    const offTurn = { ...onTurn, game: { ...onTurn.game, turn: eliminated.game.turn } };
    for (const result of calls(offTurn, "human"))
      expect(result).toEqual({ kind: "rejected", error: "not_your_turn" });
    expect(progress.resign(offTurn, "human")).toEqual({ kind: "rejected", error: "not_your_turn" });
    expect(
      progress.draw({ ...expired, tournamentId: 1 }, "unknown", {
        type: "room.game.draw.set",
        roundId: "old",
        positionRevision: -1,
        proposed: true,
      }),
    ).toEqual({ kind: "rejected", error: "forbidden" });
    expect(progress.resign(onTurn, "human").kind).toBe("playing");
  });
});

const preparations = [
  { profile: false, unavailable: null, count: 0, reason: "invalid_profile" },
  { profile: false, unavailable: "configuration", count: 1601, reason: "invalid_profile" },
  { profile: true, unavailable: "configuration", count: 1601, reason: "configuration" },
  {
    profile: true,
    unavailable: "capacity_unavailable",
    count: 1601,
    reason: "capacity_unavailable",
  },
  { profile: true, unavailable: null, count: 1601, reason: "replay_too_long" },
  { profile: true, unavailable: null, count: 1600, reason: null },
] as const;
test.each(preparations)(
  "外部AIの準備時の診断と優先順位を保つ: $reason / $count",
  async (scenario) => {
    const { entry, stub } = await setup();
    await runInDurableObject(stub, (_, ctx) => {
      const progress = new FourShogiProgress({
        storage: ctx.storage,
        membership: () => null,
        accountId: () => null,
      });
      const waiting = fourShogiRoomSchema.parse(entry.room);
      if (waiting.status !== "waiting") throw Error("Expected waiting");
      const room = cpuTurn(
        progress,
        progress.start(waiting, undefined, scenario.profile ? rating : undefined).room,
      );
      for (let i = 0; i < scenario.count; i++)
        progress.store().appendEvent(room.roundId, {
          type: "drawProposal",
          side: room.game.turn,
          proposed: true,
        });
      const now = room.clock.turnStartedAt + 1;
      const work = progress.prepareExternalCpu(room, now, 5000, scenario.unavailable);
      const job = ctx.storage.kv.get<ShogiCpuJob>(shogiCpuJobKey);
      if (scenario.reason) {
        expect(work).toBeNull();
        expect(job).toMatchObject({
          action: room.legalActions[0],
          fallback: true,
          applyAt: now + 1,
          aiDiagnostic: { reason: scenario.reason },
        });
        expect(ctx.storage.kv.get(fourShogiAiJobKey)).toBeUndefined();
      } else {
        expect(work?.events).toHaveLength(1600);
        expect(job).toBeUndefined();
        expect(progress.externalCpuJob(room)).toEqual(work?.job);
      }
    });
  },
);

const completions = [
  "success",
  "retried",
  "illegal_move",
  "timeout",
  "expired_job",
  "network",
  "invalid_response",
  "http_503",
] as const;
test.each(completions)("外部AIの応答の診断・再試行・代替手を保つ: %s", async (scenario) => {
  const { entry, stub } = await setup();
  await runInDurableObject(stub, (_, ctx) => {
    const progress = new FourShogiProgress({
      storage: ctx.storage,
      membership: () => null,
      accountId: () => null,
    });
    const waiting = fourShogiRoomSchema.parse(entry.room);
    if (waiting.status !== "waiting") throw Error("Expected waiting");
    const room = cpuTurn(progress, progress.start(waiting, undefined, rating).room);
    const now = room.clock.turnStartedAt + 1;
    const work = progress.prepareExternalCpu(room, now, 5000, null)!;
    const action = room.legalActions.at(-1)!;
    const response: FourShogiCpuResponse =
      scenario === "success" ||
      scenario === "retried" ||
      scenario === "timeout" ||
      scenario === "expired_job"
        ? { action, ...(scenario === "retried" ? { retried: true as const } : {}) }
        : scenario === "illegal_move"
          ? { action: { type: "dropPiece", pieceKind: "rook", to: { x: 4, y: 4 } } }
          : { action: null, reason: scenario };
    const at = scenario === "timeout" || scenario === "expired_job" ? work.job.expiresAt : now;
    if (scenario === "expired_job")
      expect(progress.prepareExternalCpu(room, at, 5000, null)).toBeNull();
    else progress.completeExternalCpu(room, work.job, response, at);
    const job = ctx.storage.kv.get<ShogiCpuJob>(shogiCpuJobKey)!;
    const fallback = scenario !== "success" && scenario !== "retried";
    expect(job.action).toEqual(fallback ? room.legalActions[0] : action);
    expect(job.fallback).toBe(fallback ? true : undefined);
    expect(job.aiDiagnostic).toEqual(
      scenario === "success"
        ? undefined
        : {
            requestId: work.job.requestId,
            ...(scenario === "retried" ? {} : { reason: scenario }),
          },
    );
    expect(job.applyAt).toBe(at + 1);
    expect(ctx.storage.kv.get(fourShogiAiJobKey)).toBeUndefined();
    expect(progress.cpu(room, at + 1).kind).toBe("playing");
    expect(
      ctx.storage.kv.get<ActiveShogiMatch>(shogiMatchStartKey)?.start.fourShogiRating?.usedFallback,
    ).toBe(fallback ? true : undefined);
  });
});
