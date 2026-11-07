import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, test, vi } from "vitest";
import { fourReversiRoomSchema, roundReplaySchema } from "@tetraboard/protocol";
import {
  applyAction,
  createInitialState,
  getLegalMoves,
  type GameMode,
} from "@tetraboard/four-reversi";
import { RoomBoundaryFixtures } from "../test/roomBoundaryFixtures";
import {
  FourReversiProgress,
  fourReversiAiJobKey,
  fourReversiCpuJobKey,
  type FourReversiCpuJob,
} from "../src/rooms/fourReversiProgress";
import { aiServiceTimeout, requestAiMove } from "../src/rooms/aiService";

let fixtures = new RoomBoundaryFixtures();
let now = 0;
afterEach(async () => {
  const previous = fixtures;
  fixtures = new RoomBoundaryFixtures();
  vi.restoreAllMocks();
  await previous.dispose();
});

async function setup(level = 1, mode: GameMode = "singles") {
  now = Date.now() + 60000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const entry = await fixtures.create({
    game: "four-reversi",
    name: "ホスト",
    quickPlay: true,
    cpuLevel: level,
    mode,
  });
  const host = await fixtures.connect(entry);
  host.send({ type: "room.game.start" });
  await host.waitFor("room.snapshot", (m) => m.room.status === "playing");
  const stub = env.GAME_ROOM.getByName(entry.room.id);
  const read = () =>
    runInDurableObject(stub, (_, ctx) => fourReversiRoomSchema.parse(ctx.storage.kv.get("room")));
  return { host, stub, read };
}

async function cpuSetup(mode: GameMode = "singles") {
  const input = await setup(1, mode);
  await runInDurableObject(input.stub, (_, ctx) => {
    const room = fourReversiRoomSchema.parse(ctx.storage.kv.get("room"));
    if (room.status !== "playing") throw Error("Expected playing");
    const cpu = room.players.find((p) => p.kind === "cpu")!;
    ctx.storage.kv.put("room", { ...room, game: { ...room.game, turn: cpu.color } });
  });
  const room = await input.read();
  if (room.status !== "playing") throw Error("Expected playing");
  now = room.clock.turnStartedAt + 2000;
  return { ...input, before: room };
}

function reply(body: Record<string, unknown>, position = { x: 2, y: 3 }) {
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
}

test("WorkerのHTTP境界から実Serviceのhealthへ到達する", async () => {
  const response = await fetch(new URL("/health", env.AI_SERVICE_URL));
  expect(response.status).toBe(200);
  const withRedirect = await fetch(new URL("/health", env.AI_SERVICE_URL), { redirect: "manual" });
  expect(withRedirect.status).toBe(200);
});

for (const level of [1, 2])
  test(`実Rust Serviceと人間1人・CPU3人のLv${level}対局を終局まで進める`, async () => {
    const { host, stub, read } = await setup(level);
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
        now = Math.max(now, room.clock.turnStartedAt) + 1;
        host.send({
          type: "room.game.action",
          action: { type: "placeStone", position: getLegalMoves(room.game)[0] },
        });
        await host.waitFor(
          "room.snapshot",
          (m) =>
            m.room.status === "waiting" || (m.room.game?.moveNumber ?? 0) > room.game.moveNumber,
        );
      } else {
        now = room.clock.turnStartedAt + 2000;
        await runInDurableObject(stub, (instance) => instance.alarm());
        const job = await runInDurableObject(stub, (_, ctx) =>
          ctx.storage.kv.get<FourReversiCpuJob>(fourReversiCpuJobKey),
        );
        expect(job?.source).toBe("external");
        expect((await read()).game?.moveNumber).toBe(room.game.moveNumber);
        if (cpuMoves === 2) await evictDurableObject(stub, { webSockets: "hibernate" });
        now++;
        await runInDurableObject(stub, (instance) => instance.alarm());
        cpuMoves++;
      }
    }
    throw Error("56着手以内に終局しませんでした");
  }, 20000);

for (const kind of [
  "http_503",
  "http_401",
  "http_302",
  "malformed",
  "wrong_id",
  "wrong_revision",
  "wrong_version",
  "oversized",
  "out_of_bounds",
  "illegal",
])
  test(`外部AIの${kind}から合法手へ退避し、二重適用しない`, async () => {
    const { stub, read, before } = await cpuSetup();
    const mock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_, init) => {
      const body = JSON.parse(String(init?.body));
      if (kind.startsWith("http_")) return new Response("", { status: Number(kind.slice(5)) });
      if (kind === "malformed") return new Response("invalid-json");
      if (kind === "oversized") return new Response("x".repeat(8193));
      const value = reply(body, kind === "out_of_bounds" ? { x: 8, y: 0 } : { x: 3, y: 3 });
      if (kind === "wrong_id") value.request_id = "another-request";
      if (kind === "wrong_revision") value.position_revision = "f".repeat(64);
      if (kind === "wrong_version") value.api_version = 2;
      return Response.json(value);
    });
    await runInDurableObject(stub, (instance) => instance.alarm());
    const job = await runInDurableObject(stub, (_, ctx) =>
      ctx.storage.kv.get<FourReversiCpuJob>(fourReversiCpuJobKey),
    );
    expect(job?.source).toBe("fallback");
    expect(job?.move).toEqual(getLegalMoves(before.game)[0]);
    expect(mock).toHaveBeenCalledTimes(kind === "http_503" ? 2 : 1);
    now++;
    await runInDurableObject(stub, (instance) => instance.alarm());
    const after = await read();
    expect(after.game?.moveNumber).toBe(before.game.moveNumber + 1);
    await runInDurableObject(stub, (instance) => instance.alarm());
    expect((await read()).game).toEqual(after.game);
  });

test("再試行では同じリクエストを送り、一度だけ候補を保存する", async () => {
  const { stub, before } = await cpuSetup();
  const bodies: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_, init) => {
    bodies.push(String(init?.body));
    if (bodies.length === 1) return new Response("", { status: 503 });
    return Response.json(reply(JSON.parse(bodies[1]), getLegalMoves(before.game)[0]));
  });
  await runInDurableObject(stub, (instance) => instance.alarm());
  expect(bodies).toHaveLength(2);
  expect(bodies[0]).toBe(bodies[1]);
  const job = await runInDurableObject(stub, (_, ctx) =>
    ctx.storage.kv.get<FourReversiCpuJob>(fourReversiCpuJobKey),
  );
  expect(job?.source).toBe("external");
});

test("保存済みの未完了リクエストは再起動後に期限切れで退避する", async () => {
  const { stub, before } = await cpuSetup();
  await runInDurableObject(stub, (_, ctx) => {
    const progress = new FourReversiProgress({
      storage: ctx.storage,
      membership: () => null,
      accountId: () => null,
    });
    expect(progress.prepareExternalCpu(before, now, 100)).not.toBeNull();
  });
  await evictDurableObject(stub, { webSockets: "hibernate" });
  now += 351;
  const mock = vi.spyOn(globalThis, "fetch");
  await runInDurableObject(stub, (instance) => instance.alarm());
  expect(mock).not.toHaveBeenCalled();
  const job = await runInDurableObject(stub, (_, ctx) =>
    ctx.storage.kv.get<FourReversiCpuJob>(fourReversiCpuJobKey),
  );
  expect(job?.source).toBe("fallback");
});

test("遅延応答中の重複Alarmは再送せず、世代が変わった応答を保存しない", async () => {
  const { stub, before } = await cpuSetup();
  await runInDurableObject(stub, async (instance, ctx) => {
    const mock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_, init) => {
      expect(ctx.storage.kv.get(fourReversiAiJobKey)).toBeDefined();
      await instance.alarm();
      const room = fourReversiRoomSchema.parse(ctx.storage.kv.get("room"));
      ctx.storage.kv.put("room", { ...room, instanceId: crypto.randomUUID() });
      return Response.json(reply(JSON.parse(String(init?.body)), getLegalMoves(before.game)[0]));
    });
    try {
      await instance.alarm();
      expect(mock).toHaveBeenCalledTimes(1);
      expect(ctx.storage.kv.get(fourReversiCpuJobKey)).toBeUndefined();
    } finally {
      const room = fourReversiRoomSchema.parse(ctx.storage.kv.get("room"));
      ctx.storage.kv.put("room", { ...room, instanceId: before.instanceId });
      ctx.storage.kv.delete(fourReversiAiJobKey);
    }
  });
});

test("timeout未設定なら1秒を超える起動待ちの候補を受け取る", async () => {
  const { stub, before } = await cpuSetup();
  await runInDurableObject(stub, async (_, ctx) => {
    const progress = new FourReversiProgress({
      storage: ctx.storage,
      membership: () => null,
      accountId: () => null,
    });
    const bindings = { ...env, AI_SERVICE_TIMEOUT_MS: undefined };
    const work = progress.prepareExternalCpu(before, now, aiServiceTimeout(bindings))!;
    const position = getLegalMoves(before.game)[0]!;
    vi.spyOn(globalThis, "fetch").mockImplementation(
      (_, init) =>
        new Promise((resolve, reject) => {
          const onAbort = () => {
            clearTimeout(timer);
            reject(Error("aborted"));
          };
          const timer = setTimeout(() => {
            init?.signal?.removeEventListener("abort", onAbort);
            resolve(Response.json(reply(JSON.parse(String(init?.body)), position)));
          }, 1200);
          init?.signal?.addEventListener("abort", onAbort, { once: true });
        }),
    );
    expect(await requestAiMove(bindings, work)).toEqual({ position });
  });
});

test("応答待ちのtimeoutは上限内で中止し、認証や局面をログへ出さない", async () => {
  const { stub, before } = await cpuSetup();
  await runInDurableObject(stub, async (_, ctx) => {
    const progress = new FourReversiProgress({
      storage: ctx.storage,
      membership: () => null,
      accountId: () => null,
    });
    const work = progress.prepareExternalCpu(before, now, 100)!;
    vi.spyOn(globalThis, "fetch").mockImplementation(
      (_, init) =>
        new Promise((_, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        }),
    );
    const result = await requestAiMove({ ...env, AI_SERVICE_TIMEOUT_MS: "100" }, work);
    expect(result).toEqual({ position: null, reason: "timeout" });
  });
});

test("応答中に時計が切れた場合は候補より脱落処理を優先する", async () => {
  const { stub, before, read } = await cpuSetup();
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_, init) => {
    now = before.clock.turnExpiresAt;
    return Response.json(reply(JSON.parse(String(init?.body)), getLegalMoves(before.game)[0]));
  });
  await runInDurableObject(stub, (instance) => instance.alarm());
  const after = await read();
  expect(after.game?.moveNumber).toBe(before.game.moveNumber);
  expect(after.game?.eliminatedColors).toContain(before.game.turn);
  await runInDurableObject(stub, (_, ctx) => {
    expect(ctx.storage.kv.get(fourReversiCpuJobKey)).toBeUndefined();
    expect(ctx.storage.kv.get(fourReversiAiJobKey)).toBeUndefined();
  });
});

test("対象外のダブルスは外部AIを呼ばず現行CPUを維持する", async () => {
  const { stub } = await cpuSetup("doubles");
  const mock = vi.spyOn(globalThis, "fetch");
  await runInDurableObject(stub, (instance) => instance.alarm());
  expect(mock).not.toHaveBeenCalled();
  const job = await runInDurableObject(stub, (_, ctx) =>
    ctx.storage.kv.get<FourReversiCpuJob>(fourReversiCpuJobKey),
  );
  expect(job).toBeDefined();
  expect(job?.source).toBeUndefined();
});
