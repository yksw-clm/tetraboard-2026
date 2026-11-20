import cpuFixture from "../../../test-fixtures/matches/standard-shogi-cpu-1.json";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, expect, test } from "vitest";
import { shogiRoomSchema, shogiReplayEventSchema, type ShogiRoom } from "@tetraboard/protocol";
import {
  chooseCpuAction,
  createInitialState,
  getActionAvailability,
  getCheckState,
  type ShogiState,
} from "@tetraboard/shogi";
import { shogiDefinition as definition, usiMove } from "@tetraboard/shogi/definition";
import { ShogiProgress, type ShogiCpuJob } from "../src/adapters/room/games/shogi/progress";
import { requestShogiAiMove, type ShogiAiWork } from "../src/adapters/room/ai/shogiAi";
import { shogiCpuProfile, selectShogiCpu } from "@tetraboard/context-matchmaking";
import { enteringState } from "./standardShogiFixtures";
import { RoomBoundaryFixtures } from "./roomBoundaryFixtures";

let fixtures = new RoomBoundaryFixtures();
afterEach(async () => {
  await fixtures.dispose();
  fixtures = new RoomBoundaryFixtures();
});
type Playing = Extract<ShogiRoom, { status: "playing" }>;

async function setup() {
  const entry = await fixtures.create({
    game: "shogi",
    name: "人間",
    quickPlay: true,
    cpuLevel: 2,
  });
  return { entry, stub: env.GAME_ROOM.getByName(entry.room.id) };
}
function cpuTurn(progress: ShogiProgress, room: Playing): Playing {
  const cpu = room.players.find((p) => p.kind === "cpu")!;
  if (cpu.side === room.game.turn) return room;
  const result = progress.play(room, "human", {
    type: "room.game.action",
    roundId: room.roundId,
    positionRevision: room.positionRevision,
    action: room.legalActions[0],
  });
  if (result.kind !== "playing") throw new Error("Expected human opening");
  return result.room;
}

test("全操作が共通の確認順を使い、投了は局面照合を不要とする", async () => {
  const { entry, stub } = await setup();
  await runInDurableObject(stub, (_, ctx) => {
    const progress = new ShogiProgress({
      storage: ctx.storage,
      membership: (token) =>
        token === "human" ? { playerId: entry.membership.playerId, role: "host" } : null,
      accountId: () => null,
    });
    const waiting = shogiRoomSchema.parse(entry.room);
    if (waiting.status !== "waiting") throw new Error("Expected waiting");
    const room = progress.start(waiting).room;
    const expired = { ...room, clock: { ...room.clock, turnExpiresAt: Date.now() - 1 } };
    const command = { roundId: "old", positionRevision: -1 };
    const calls = (input: ShogiRoom, token: string) => [
      progress.play(input, token, {
        type: "room.game.action",
        ...command,
        action: room.legalActions[0],
      }),
      progress.draw(input, token, { type: "room.game.draw.set", ...command, proposed: true }),
      progress.declare(input, token, { type: "room.game.declare", ...command }),
    ];
    for (const result of calls(waiting, "unknown"))
      expect(result).toEqual({ kind: "rejected", error: "game_not_started" });
    for (const result of calls(expired, "unknown"))
      expect(result).toEqual({ kind: "rejected", error: "unauthorized" });
    for (const result of calls(expired, "human"))
      expect(result).toEqual({ kind: "rejected", error: "stale_position" });
    expect(progress.resign(expired, "unknown")).toEqual({
      kind: "rejected",
      error: "unauthorized",
    });
    expect(progress.resign(expired, "human")).toEqual({ kind: "rejected", error: "time_expired" });
    const human = room.players.find((p) => p.kind === "human")!;
    const onTurn = { ...room, game: { ...room.game, turn: human.side } };
    expect(progress.resign(onTurn, "human").kind).toBe("finished");
  });
});

test("持将棋提案は脱落と手番を飛ばし、時計・千日手・手数を保持する", async () => {
  const { entry, stub } = await setup();
  await runInDurableObject(stub, (_, ctx) => {
    const progress = new ShogiProgress({
      storage: ctx.storage,
      membership: () => ({ playerId: entry.membership.playerId, role: "host" }),
      accountId: () => null,
    });
    const waiting = shogiRoomSchema.parse(entry.room);
    if (waiting.status !== "waiting") throw new Error("Expected waiting");
    const started = progress.start(waiting).room;
    const human = started.players.find((p) => p.kind === "human")!;
    const turn = human.side === "south" ? "north" : "south";
    const state: ShogiState = {
      ...enteringState(started.game.players),
      turn,
      status: "playing",
      result: null,
      eliminations: [
        { side: human.side, reason: "left" as const, rank: 2 as const, group: 0 as const },
      ],
    };
    const room = shogiRoomSchema.parse({
      ...started,
      game: progress.store().saveState(started.roundId, state),
      ...getActionAvailability(state),
      checkState: getCheckState(state),
    });
    if (room.status !== "playing") throw new Error("Expected playing");
    const command = {
      type: "room.game.draw.set" as const,
      roundId: room.roundId,
      positionRevision: room.positionRevision,
      proposed: true,
    };
    const result = progress.draw(room, "human", command);
    if (result.kind !== "playing") throw new Error("Expected off-turn proposal");
    expect(result.room.clock).toEqual(room.clock);
    expect(result.room.game.moveNumber).toBe(room.game.moveNumber);
    expect(result.room.game.nonChecks).toEqual(room.game.nonChecks);
    expect(result.room.game.drawProposals).toEqual([human.side]);
    expect(progress.store().replayEvents(room.roundId, 0)).toEqual([
      { type: "drawProposal", side: human.side, proposed: true },
    ]);
    expect(
      progress.draw(
        { ...room, clock: { ...room.clock, turnExpiresAt: Date.now() - 1 } },
        "human",
        command,
      ),
    ).toEqual({ kind: "rejected", error: "time_expired" });
    expect(
      progress.play(room, "human", {
        type: "room.game.action",
        roundId: room.roundId,
        positionRevision: room.positionRevision,
        action: room.legalActions[0],
      }),
    ).toEqual({ kind: "rejected", error: "already_eliminated" });
  });
});

test.each(["legal", "illegal", "invalid", "timeout", "missing"] as const)(
  "共通の外部AI処理: %s を既存のKV形のCPUジョブへ一度だけ保存する",
  async (scenario) => {
    const { entry, stub } = await setup();
    await runInDurableObject(stub, (_, ctx) => {
      const progress = new ShogiProgress({
        storage: ctx.storage,
        membership: () => ({ playerId: entry.membership.playerId, role: "host" }),
        accountId: () => null,
      });
      const waiting = shogiRoomSchema.parse(entry.room);
      if (waiting.status !== "waiting") throw new Error("Expected waiting");
      const room = cpuTurn(progress, progress.start(waiting).room);
      const now = Date.now();
      const work = progress.prepareExternalCpu(room, now, 1000)!;
      expect(work).not.toBeNull();
      expect(ctx.storage.kv.get("standard-shogi-external-cpu-job")).toEqual(work.job);
      expect(Object.keys(work.job).sort()).toEqual([
        "expiresAt",
        "positionRevision",
        "requestId",
        "roundId",
      ]);
      const legal = room.legalActions[0];
      const move =
        scenario === "legal" || scenario === "timeout"
          ? usiMove(legal)
          : scenario === "illegal"
            ? "7g7a"
            : scenario === "invalid"
              ? "broken"
              : null;
      progress.completeExternalCpu(
        room,
        { ...work, job: { ...work.job, requestId: crypto.randomUUID() } },
        move,
        now,
      );
      expect(ctx.storage.kv.get("standard-shogi-cpu-job")).toBeUndefined();
      progress.completeExternalCpu(
        room,
        work,
        move,
        scenario === "timeout" ? work.job.expiresAt : now,
      );
      const job = ctx.storage.kv.get<ShogiCpuJob>("standard-shogi-cpu-job")!;
      expect(job).toBeDefined();
      expect(room.legalActions).toContainEqual(job.action);
      expect(job.external).toBe(scenario === "legal" ? true : undefined);
      expect(ctx.storage.kv.get("standard-shogi-external-cpu-job")).toBeUndefined();
      if (scenario === "legal") expect(job.action).toEqual(legal);
      else {
        const { state, repetitionLookup } = progress
          .store()
          .loadTransition(room.roundId, room.game);
        expect(job.action).toEqual(chooseCpuAction(state, 2, Math.random, repetitionLookup));
      }
      progress.completeExternalCpu(room, work, usiMove(legal), now);
      expect(ctx.storage.kv.get("standard-shogi-cpu-job")).toEqual(job);
      expect(progress.cpu(room, job.applyAt).kind).toBe("playing");
    });
  },
);

test.each([false, true])(
  "外部AIの本文と全手順は従来と同じ（プロファイル=%s）",
  async (profiled) => {
    const { entry, stub } = await setup();
    const work = await runInDurableObject(stub, (_, ctx) => {
      const progress = new ShogiProgress({
        storage: ctx.storage,
        membership: () => ({ playerId: entry.membership.playerId, role: "host" }),
        accountId: () => null,
      });
      const waiting = shogiRoomSchema.parse({
        ...entry.room,
        settings: { game: "shogi", timeControl: { mainTimeMs: 600000, byoyomiMs: 0 } },
      });
      if (waiting.status !== "waiting") throw new Error("Expected waiting");
      const source = selectShogiCpu(1365);
      let room = progress.start(waiting, profiled ? source : undefined).room;
      if (profiled)
        room = {
          ...room,
          matchmaking: { id: room.roundId, preparedAtMs: Date.now(), opponent: "cpu" },
        };
      const cpu = room.players.find((p) => p.kind === "cpu")!;
      const count = cpu.side === "south" ? 102 : 103;
      const events = cpuFixture.events.slice(0, count).map((e) => shogiReplayEventSchema.parse(e));
      const frames = definition.replay({ players: room.game.players }, events);
      for (const event of events) progress.store().appendEvent(room.roundId, event);
      progress
        .store()
        .appendEvent(room.roundId, { type: "drawProposal", side: room.game.turn, proposed: false });
      const state = frames.at(-1)!;
      const updated = shogiRoomSchema.parse({
        ...room,
        game: progress.store().saveState(room.roundId, state),
        ...getActionAvailability(state),
        checkState: getCheckState(state),
      });
      if (updated.status !== "playing") throw new Error("Expected playing CPU");
      room = updated;
      const work = progress.prepareExternalCpu(room, Date.now(), 4000);
      if (!work) throw new Error("Expected external work");
      const expectedMoves = progress
        .store()
        .replayEvents(room.roundId, 0)
        .concat(progress.store().replayEvents(room.roundId, 100))
        .flatMap((e) => (e.type === "action" ? [usiMove(e.action)] : []));
      expect(work.moves).toEqual(expectedMoves);
      expect(work.moves).toHaveLength(count);
      if (source.kind !== "cpu") throw new Error("Expected CPU profile");
      expect({ nodes: work.nodes, standardBook: work.standardBook }).toEqual(
        profiled
          ? shogiCpuProfile(source.profileId)
          : { nodes: undefined, standardBook: undefined },
      );
      return work;
    });
    await expectRequest(work);
  },
);

async function expectRequest(work: ShogiAiWork) {
  const revision = Array.from(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(
          JSON.stringify([work.job.roundId, work.job.positionRevision, work.moves]),
        ),
      ),
    ),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
  const nodes = work.nodes ?? 256;
  const openingBook = work.standardBook && work.moves.length < 2 ? "standard-v1" : undefined;
  let calls = 0;
  const result = await requestShogiAiMove(
    {
      AI_SHOGI_ENABLED: "true",
      AI_SERVICE_TOKEN: "test-token-at-least-32-characters-long",
      AI_GATEWAY: {
        fetch: async (request: Request) => {
          calls++;
          expect(await request.json()).toEqual({
            request_id: work.job.requestId,
            position_revision: revision,
            nodes,
            moves: work.moves,
            ...(openingBook ? { opening_book: openingBook } : {}),
          });
          return Response.json({
            request_id: work.job.requestId,
            position_revision: revision,
            engine_version: "yaneuraou-material-faeb37f0",
            nodes,
            best_move: "7g7f",
            ...(openingBook ? { opening_book: openingBook } : {}),
          });
        },
      },
    },
    work,
  );
  expect(result).toBe("7g7f");
  expect(calls).toBe(1);
  expect(
    definition.cpu.external!.createRequest(
      createInitialState({ players: { south: "south", north: "north" } }),
      "south",
      2,
      work,
    ),
  ).toEqual({
    nodes,
    moves: work.moves,
    ...(openingBook ? { opening_book: openingBook } : {}),
  });
}
