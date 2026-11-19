import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, vi } from "vitest";
import { fourReversiRoomSchema, roundReplaySchema } from "@tetraboard/protocol";
import {
  applyAction,
  createInitialState,
  getLegalMoves,
  type GameMode,
} from "@tetraboard/four-reversi";
import { RoomBoundaryFixtures } from "../test/roomBoundaryFixtures";
import {
  fourReversiCpuJobKey,
  type FourReversiCpuJob,
} from "../src/adapters/room/games/four-reversi/progress";

export class FourReversiAiFixture {
  fixtures = new RoomBoundaryFixtures();
  readonly clock = { now: 0 };

  constructor() {
    afterEach(async () => {
      const previous = this.fixtures;
      this.fixtures = new RoomBoundaryFixtures();
      vi.restoreAllMocks();
      await previous.dispose();
    });
  }

  private setup = async (level = 1, mode: GameMode = "singles") => {
    this.clock.now = Date.now() + 60000;
    vi.spyOn(Date, "now").mockImplementation(() => this.clock.now);
    const entry = await this.fixtures.create({
      game: "four-reversi",
      name: "ホスト",
      quickPlay: true,
      cpuLevel: level,
      mode,
    });
    const host = await this.fixtures.connect(entry);
    host.send({ type: "room.game.start" });
    await host.waitFor("room.snapshot", (m) => m.room.status === "playing");
    const stub = env.GAME_ROOM.getByName(entry.room.id);
    const read = () =>
      runInDurableObject(stub, (_, ctx) => fourReversiRoomSchema.parse(ctx.storage.kv.get("room")));
    return { host, stub, read };
  };

  cpuSetup = async (mode: GameMode = "singles", level = 1, consecutive = false) => {
    const input = await this.setup(level, mode);
    await runInDurableObject(input.stub, (_, ctx) => {
      const room = fourReversiRoomSchema.parse(ctx.storage.kv.get("room"));
      if (room.status !== "playing") throw Error("Expected playing");
      const human = room.players.find((p) => p.kind === "human")!;
      const colors = ["black", "white", "red", "blue"] as const;
      const nextColor = colors[(colors.indexOf(human.color!) + 1) % colors.length];
      const cpu = room.players.find(
        (p) => p.kind === "cpu" && (!consecutive || p.color === nextColor),
      )!;
      ctx.storage.kv.put("room", { ...room, game: { ...room.game, turn: cpu.color } });
    });
    const room = await input.read();
    if (room.status !== "playing") throw Error("Expected playing");
    this.clock.now = room.clock.turnStartedAt + 2000;
    return { ...input, before: room };
  };

  reply = (body: Record<string, unknown>, position = { x: 2, y: 3 }) => {
    return {
      api_version: 1,
      game_id: "four-reversi",
      ruleset_version: "four-reversi-singles-v1",
      state_version: 1,
      request_id: body.request_id,
      position_revision: body.position_revision,
      agent_id: body.agent_id,
      engine_version: "0.1.0",
      position,
      diagnostics: { nodes: 0, completed_depth: 0, interrupted: false },
    };
  };

  alarmWithProfile = async (
    stub: ReturnType<typeof env.GAME_ROOM.getByName>,
    selected?: { profile_id: string; limits?: { max_iterations: number; max_nodes: number } },
  ) => {
    await runInDurableObject(stub, async (instance) => {
      const original = Reflect.get(instance, "env");
      if (selected)
        Reflect.set(instance, "env", {
          ...original,
          AI_SERVICE_LEVEL2_PROFILE: selected.profile_id,
          AI_SERVICE_LEVEL2_LIMITS: selected.limits ? JSON.stringify(selected.limits) : "",
        });
      try {
        await instance.alarm();
      } finally {
        if (selected) Reflect.set(instance, "env", original);
      }
    });
  };

  completeGame = async (
    level: number,
    selected?: { profile_id: string; limits?: { max_iterations: number; max_nodes: number } },
  ) => {
    const { host, stub, read } = await this.setup(level);
    let cpuMoves = 0;
    for (let step = 0; step < 57; step++) {
      const room = await read();
      if (room.status !== "playing") {
        const replay = roundReplaySchema.parse(room.lastRound?.replay);
        let game = createInitialState("singles");
        for (const entry of replay.steps) {
          if (entry.action.type !== "place") throw Error("Unexpected elimination");
          const next = applyAction(game, { type: "placeStone", position: entry.action.position });
          if (!next.ok) throw Error("Invalid saved move");
          expect(next.state).toEqual(entry.game);
          game = next.state;
        }
        expect(game.status).toBe("finished");
        expect(cpuMoves).toBeGreaterThan(0);
        return;
      }
      const player = room.players.find((p) => p.color === room.game.turn)!;
      if (player.kind === "human") {
        this.clock.now = Math.max(this.clock.now, room.clock.turnStartedAt) + 1;
        host.send({
          type: "room.game.action",
          roundId: room.roundId,
          positionRevision: room.positionRevision,
          action: { type: "placeStone", position: getLegalMoves(room.game)[0] },
        });
        await host.waitFor(
          "room.snapshot",
          (m) =>
            m.room.status === "waiting" || (m.room.game?.moveNumber ?? 0) > room.game.moveNumber,
        );
      } else {
        this.clock.now = room.clock.turnStartedAt + 2000;
        await this.alarmWithProfile(stub, selected);
        const job = await runInDurableObject(stub, (_, ctx) =>
          ctx.storage.kv.get<FourReversiCpuJob>(fourReversiCpuJobKey),
        );
        expect(job?.source).toBe("external");
        if (selected) expect(job?.serviceProfile).toEqual(expect.objectContaining(selected));
        expect((await read()).game?.moveNumber).toBe(room.game.moveNumber);
        if (cpuMoves === 2) await evictDurableObject(stub, { webSockets: "hibernate" });
        this.clock.now++;
        await runInDurableObject(stub, (instance) => instance.alarm());
        cpuMoves++;
      }
    }
    throw Error("56着手以内に終局しませんでした");
  };
}
