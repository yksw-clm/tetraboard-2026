import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { expect, test, vi } from "vitest";
import { fourReversiRoomSchema } from "@tetraboard/protocol";
import { getLegalMoves } from "@tetraboard/four-reversi";
import {
  FourReversiProgress,
  fourReversiAiJobKey,
  fourReversiCpuJobKey,
  type FourReversiCpuJob,
} from "../src/adapters/room/games/four-reversi/progress";
import { aiServiceTimeout } from "../src/adapters/room/ai/aiService";
import { requestAiMove } from "../src/adapters/room/ai/fourReversiAi";
import { profileIdSchema, profileMetadata } from "../src/adapters/room/ai/aiServiceProfiles";
import { FourReversiAiFixture } from "./fourReversiAiFixture";

const { cpuSetup, reply, alarmWithProfile, clock } = new FourReversiAiFixture();

test("WorkerのHTTP境界から実Serviceのhealthへ到達する", async () => {
  const response = await fetch(new URL("/health", env.AI_SERVICE_URL));
  expect(response.status).toBe(200);
  const withRedirect = await fetch(new URL("/health", env.AI_SERVICE_URL), { redirect: "manual" });
  expect(withRedirect.status).toBe(200);
});

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
    clock.now++;
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
    expect(progress.prepareExternalCpu(before, clock.now, 100)).not.toBeNull();
  });
  await evictDurableObject(stub, { webSockets: "hibernate" });
  clock.now += 351;
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
    const work = progress.prepareExternalCpu(before, clock.now, aiServiceTimeout(bindings))!;
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
    const work = progress.prepareExternalCpu(before, clock.now, 100)!;
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

test("四人リバーシ専用の10秒設定で5秒を超えた候補を採用する", async () => {
  const { stub, before } = await cpuSetup();
  const requestAt = clock.now;
  const position = getLegalMoves(before.game)[0]!;
  await runInDurableObject(stub, async (instance, ctx) => {
    const original = Reflect.get(instance, "env");
    const bindings = {
      ...original,
      AI_SERVICE_TIMEOUT_MS: "5000",
      AI_FOUR_REVERSI_TIMEOUT_MS: "10000",
    };
    expect(aiServiceTimeout(bindings)).toBe(5000);
    Reflect.set(instance, "env", bindings);
    const timer = vi.spyOn(globalThis, "setTimeout");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_, init) => {
      expect(timer.mock.calls.at(-1)?.[1]).toBe(10_000);
      expect(ctx.storage.kv.get(fourReversiAiJobKey)).toMatchObject({
        expiresAt: requestAt + 10_250,
      });
      clock.now = requestAt + 7500;
      return Response.json(reply(JSON.parse(String(init?.body)), position));
    });
    try {
      await instance.alarm();
      expect(ctx.storage.kv.get(fourReversiCpuJobKey)).toMatchObject({
        source: "external",
        move: position,
      });
    } finally {
      fetchMock.mockRestore();
      timer.mockRestore();
      Reflect.set(instance, "env", original);
    }
  });
});

test("応答中に時計が切れた場合は候補より脱落処理を優先する", async () => {
  const { stub, before, read } = await cpuSetup();
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_, init) => {
    clock.now = before.clock.turnExpiresAt;
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

function profileReply(body: Record<string, unknown>, position: { x: number; y: number }) {
  return {
    ...reply(body, position),
    api_version: 2,
    profile_id: body.profile_id,
    profile_hash: profileMetadata(profileIdSchema.parse(body.profile_id)).profile_hash,
    agent_id: "four-reversi-mcts-v1",
    effective_limits: { max_iterations: 4, max_nodes: 256 },
    reproducible: true,
    diagnostics: {
      nodes: 1,
      completed_depth: 0,
      interrupted: true,
      mcts: { iterations_started: 1, trials: 0, max_tree_depth: 1, stop_reason: "node_limit" },
    },
  };
}

for (const kind of ["profile", "hash", "limits", "reproducible", "trials"])
  test(`API v2の不正な${kind}を適用せず合法手へ退避する`, async () => {
    const { stub, before } = await cpuSetup("singles", 2);
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_, init) => {
      const body = JSON.parse(String(init?.body));
      const response = profileReply(body, getLegalMoves(before.game)[0]!);
      if (kind === "profile") response.profile_id = "lv4-v1";
      if (kind === "hash") response.profile_hash = "0".repeat(64);
      if (kind === "limits") response.effective_limits.max_nodes = 65536;
      if (kind === "reproducible") response.reproducible = false;
      if (kind === "trials") response.diagnostics.mcts.trials = 2;
      return Response.json(response);
    });
    await alarmWithProfile(stub, {
      profile_id: "lv5-v1",
      limits: { max_iterations: 4, max_nodes: 256 },
    });
    const job = await runInDurableObject(stub, (_, ctx) =>
      ctx.storage.kv.get<FourReversiCpuJob>(fourReversiCpuJobKey),
    );
    expect(job?.source).toBe("fallback");
    expect(job?.move).toEqual(getLegalMoves(before.game)[0]);
  });

test("不正な開発用profile設定ではHTTP送信せず合法手へ退避する", async () => {
  const { stub } = await cpuSetup("singles", 2);
  const mock = vi.spyOn(globalThis, "fetch");
  await alarmWithProfile(stub, { profile_id: "unknown" });
  expect(mock).not.toHaveBeenCalled();
  const job = await runInDurableObject(stub, (_, ctx) =>
    ctx.storage.kv.get<FourReversiCpuJob>(fourReversiCpuJobKey),
  );
  expect(job?.source).toBe("fallback");
});

test("同じ要求IDでも保存profileが変わった応答は適用しない", async () => {
  const { stub, before } = await cpuSetup("singles", 2);
  await runInDurableObject(stub, async (instance, ctx) => {
    const original = Reflect.get(instance, "env");
    Reflect.set(instance, "env", {
      ...original,
      AI_SERVICE_LEVEL2_PROFILE: "lv5-v1",
      AI_SERVICE_LEVEL2_LIMITS: JSON.stringify({ max_iterations: 4, max_nodes: 256 }),
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_, init) => {
      const pending = ctx.storage.kv.get<Record<string, unknown>>(fourReversiAiJobKey)!;
      ctx.storage.kv.put(fourReversiAiJobKey, {
        ...pending,
        serviceProfile: { profile_id: "lv4-v1" },
      });
      return Response.json(
        profileReply(JSON.parse(String(init?.body)), getLegalMoves(before.game)[0]!),
      );
    });
    try {
      await instance.alarm();
      expect(ctx.storage.kv.get(fourReversiCpuJobKey)).toBeUndefined();
    } finally {
      Reflect.set(instance, "env", original);
      ctx.storage.kv.delete(fourReversiAiJobKey);
    }
  });
});
