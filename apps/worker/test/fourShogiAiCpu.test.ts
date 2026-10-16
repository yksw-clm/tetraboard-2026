import { env } from "cloudflare:workers";
import { afterEach, expect, test, vi } from "vitest";
import { accountFixture, origin } from "./accountFixtures";
import { fourShogiAiRoutes } from "../src/fourShogiAi/routes";

test("許可アカウントのCPU試用設定も任意の予算や不完全な入力を受け付けない", async () => {
  const user = await accountFixture();
  const response = await fourShogiAiRoutes.fetch(
    new Request(origin + "/four-shogi-ai/rooms/12345/cpu", {
      method: "POST",
      headers: { ...user.headers, Origin: origin },
      body: JSON.stringify({ timeBudgetMs: 30000 }),
    }),
    {
      ...env,
      FOUR_SHOGI_AI_URL: "https://ai.test",
      FOUR_SHOGI_AI_SHARED_SECRET: "test-only-ai-cpu-secret-at-least-32-characters",
      FOUR_SHOGI_AI_ACCOUNT_IDS: JSON.stringify([user.id]),
      FOUR_SHOGI_AI_MODEL_ID: "four-shogi-tiny-policy-value-v1:" + "b".repeat(64),
      FOUR_SHOGI_AI_CODE_VERSION: "a".repeat(40),
    },
  );
  expect(response.status).toBe(400);
});

import { runInDurableObject } from "cloudflare:test";
import { createRoomContract, fourShogiRoomSchema, type FourShogiRoom } from "@tetraboard/protocol";
import {
  aiRequestFingerprint,
  type AiJobRequest,
  type AiJobSnapshot,
} from "@tetraboard/protocol/four-shogi-ai";
import {
  restoreAnalysisPosition,
  getAnalysisLegalActions,
  getAnalysisStateHash,
} from "@tetraboard/four-shogi/analysis";
import { GameRoom } from "../src/rooms/gameRoom";
import { FourShogiProgress } from "../src/rooms/fourShogiProgress";
import { ShogiStore } from "../src/rooms/shogiStore";
import { RoomBoundaryFixtures, boundaryRequest } from "./roomBoundaryFixtures";
import {
  trialCpuJobKey,
  trialCpuSettingsKey,
  trialCpuDiagnosticsKey,
} from "../src/fourShogiAi/cpu";

const fixtures = new RoomBoundaryFixtures();
const closers: (() => void)[] = [];
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) close();
  try {
    for (const clear of cleanup.splice(0)) await clear();
  } finally {
    vi.restoreAllMocks();
  }
  await fixtures.dispose();
});
const model = "four-shogi-tiny-policy-value-v1:" + "b".repeat(64),
  code = "a".repeat(40);
const serviceInstanceId = "00000000-0000-4000-8000-000000000099";
function config(id: string) {
  return {
    ...env,
    FOUR_SHOGI_AI_URL: "https://ai.test",
    FOUR_SHOGI_AI_SHARED_SECRET: "test-only-ai-cpu-secret-at-least-32-characters",
    FOUR_SHOGI_AI_ACCOUNT_IDS: JSON.stringify([id]),
    FOUR_SHOGI_AI_MODEL_ID: model,
    FOUR_SHOGI_AI_CODE_VERSION: code,
  };
}
function serviceHealth() {
  return {
    schemaVersion: 1,
    serviceInstanceId,
    requestWindow: 0,
    codeVersion: code,
    engineVersion: "tetraboard-four-shogi-rules-v1",
    modelId: model,
    status: "ready",
    workers: 2,
    running: 0,
    queued: 0,
    cpuReserved: 1,
    memory: { observedBytes: 100, peakBytes: 100, limitBytes: 939524096 },
  };
}
async function snapshot(
  request: AiJobRequest,
  status: "queued" | "completed" = "completed",
): Promise<AiJobSnapshot> {
  const position = await restoreAnalysisPosition(request.position);
  expect(position.stateHash).toBe(request.stateHash);
  return {
    schemaVersion: 1,
    serviceInstanceId,
    jobId: "00000000-0000-4000-8000-000000000098",
    requestId: request.requestId,
    stateHash: request.stateHash,
    inputHash: await aiRequestFingerprint(request),
    codeVersion: code,
    engineVersion: request.engineVersion,
    modelId: model,
    context: request.context,
    status,
    error: null,
    timing: { queueMs: 1, restoreMs: 1, searchMs: 2, inferenceMs: 3, computeMs: 6 },
    result:
      status === "queued"
        ? null
        : {
            input: {
              stateHash: request.stateHash,
              eventOffset: request.position.eventOffset,
              rootSide: position.state.turn,
              rulesVersion: 1,
              threePlayerAttackProhibited: position.state.threePlayerAttackProhibited,
            },
            versions: { codeVersion: code, engineVersion: request.engineVersion },
            evaluation: { probabilities: null },
            recommendedAction: getAnalysisLegalActions(position)[0],
            model: {
              requestedModelId: model,
              loadedModelId: model,
              usedModelId: model,
              inferenceCount: 2,
              fallbackReason: null,
            },
          },
  };
}
async function setup(prohibited = true, profile: "trial-100ms" | "trial-500ms" = "trial-500ms") {
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + 86400000);
  const user = await accountFixture();
  const created = await boundaryRequest("/rooms", {
    method: "POST",
    headers: user.headers,
    body: JSON.stringify({ game: "four-shogi", mode: "singles", quickPlay: true, cpuLevel: 2 }),
  });
  expect(created.status).toBe(201);
  const entry = createRoomContract.response.parse(await created.json());
  const client = await fixtures.open(entry.room.id);
  client.send({ type: "room.auth", token: entry.membership.token });
  expect((await client.waitFor("room.authenticated")).membership).toMatchObject({
    playerId: entry.membership.playerId,
    accountLinked: true,
  });
  // 接続とアカウント資格は通常経路、局面と時計は既存の保存境界で用意します。
  const stub = env.GAME_ROOM.getByName(entry.room.id),
    configured = config(user.id);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(entry.membership.token),
  );
  const tokenHash = [...new Uint8Array(digest)]
    .map((n) => n.toString(16).padStart(2, "0"))
    .join("");
  await runInDurableObject(stub, async (_instance, ctx) => {
    // VPS設定は外部接続の境界だけで注入し、通常のDO本体も同じ設定を使います。
    const bindings = (_instance as unknown as { env: Env & Record<string, unknown> }).env;
    const names = Object.keys(configured).filter((name) => name.startsWith("FOUR_SHOGI_AI_"));
    const original = names.map((name) => [name, bindings[name]] as const);
    Object.assign(bindings, configured);
    cleanup.push(async () => {
      await runInDurableObject(stub, async (_instance, current) => {
        await current.storage.deleteAlarm();
        await current.storage.deleteAll();
      });
      await env.APP_DB.prepare("DELETE FROM room_index WHERE room_id=?").bind(entry.room.id).run();
      await env.APP_DB.prepare("DELETE FROM account_room_seats WHERE account_id=?")
        .bind(user.id)
        .run();
      for (const [name, value] of original) {
        if (value === undefined) delete bindings[name];
        else bindings[name] = value;
      }
    });
    const waiting = fourShogiRoomSchema.parse(ctx.storage.kv.get("room"));
    const cpu = waiting.players.find((p) => p.kind === "cpu")!;
    expect(
      await new GameRoom(ctx, configured).configureTrialCpu(
        user.id,
        tokenHash,
        waiting.instanceId,
        cpu.id,
        profile,
      ),
    ).toHaveProperty("settings");
    if (waiting.status !== "waiting") throw Error("Expected waiting");
    waiting.settings.threePlayerAttackProhibited = prohibited;
    const progress = new FourShogiProgress({
      storage: ctx.storage,
      membership: () => null,
      accountId: () => user.id,
    });
    let room = progress.start(waiting).room;
    // 南をCPUへ割り当て、実際の初期状態と棋譜初期席をそろえます。
    const south = room.players.find((p) => p.side === "south")!;
    const selected = room.players.find((p) => p.id === cpu.id)!;
    const oldSide = selected.side;
    room.players = room.players.map((p) => ({
      ...p,
      side: p.id === selected.id ? "south" : p.id === south.id ? oldSide : p.side,
    }));
    const players = Object.fromEntries(
      room.players.map((p) => [p.side, p.id]),
    ) as typeof room.game.players;
    room = fourShogiRoomSchema.parse({ ...room, game: { ...room.game, players } }) as typeof room;
    const active = ctx.storage.kv.get<{ start: { participants: { id: string; side: string }[] } }>(
      "shogi-match-start",
    )!;
    active.start.participants = active.start.participants.map((participant) => ({
      ...participant,
      side: room.players.find((player) => player.id === participant.id)!.side,
    }));
    ctx.storage.kv.put("shogi-match-start", active);
    const store = progress.store();
    const full = store.loadState(room.roundId, room.game);
    const initial = { ...store.replayInfo(room.roundId), players };
    store.startReplay(room.roundId, initial);
    store.saveState(room.roundId, full);
    room.clock.turnStartedAt = Date.now() - 2000;
    room.clock.turnExpiresAt = Date.now() + 300000;
    ctx.storage.kv.put("room", room);
  });
  closers.push(() => client.close());
  return {
    user,
    entry,
    client,
    stub,
    configured,
    tokenHash,
    alarm: () =>
      runInDurableObject(stub, async (_instance, ctx) => new GameRoom(ctx, configured).alarm()),
    room: () =>
      runInDurableObject(stub, (_instance, ctx) =>
        fourShogiRoomSchema.parse(ctx.storage.kv.get("room")),
      ),
    job: () =>
      runInDurableObject(stub, (_instance, ctx) =>
        ctx.storage.kv.get<{
          action: unknown;
          reason: string;
          snapshot: AiJobSnapshot;
          request: AiJobRequest;
          nextAt: number;
          fallbackAt: number;
        }>(trialCpuJobKey),
      ),
    diagnostics: () =>
      runInDurableObject(
        stub,
        (_instance, ctx) =>
          ctx.storage.kv.get<Record<string, unknown>[]>(trialCpuDiagnosticsKey) ?? [],
      ),
  };
}
async function awaitAction(p: Awaited<ReturnType<typeof setup>>) {
  await vi.waitFor(async () => expect((await p.job())?.action).toBeTruthy(), {
    interval: 1,
    timeout: 1500,
  });
}
async function apply(p: Awaited<ReturnType<typeof setup>>) {
  const job = await p.job();
  const at = Math.max(Date.now(), (job?.nextAt ?? 0) + 1);
  const clock = vi.spyOn(Date, "now").mockReturnValue(at);
  try {
    await p.alarm();
  } finally {
    clock.mockRestore();
  }
}
for (const [prohibited, profile] of [
  [true, "trial-100ms"],
  [false, "trial-500ms"],
] as const) {
  test(`CPU試用 ${profile}・禁止${prohibited}: 正本の完全状態を転送し合法手を一度だけ通常確定する`, async () => {
    const p = await setup(prohibited, profile),
      before = await p.room();
    const requests: AiJobRequest[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      if (!init?.body) return Response.json(serviceHealth());
      const request = JSON.parse(String(init.body)) as AiJobRequest;
      requests.push(request);
      return Response.json(await snapshot(request));
    });
    await p.alarm();
    await awaitAction(p);
    expect((await p.room()).positionRevision).toBe(before.positionRevision);
    await apply(p);
    const after = await p.room();
    expect(after.positionRevision).toBe(before.positionRevision + 1);
    if (before.status !== "playing" || after.status !== "playing") throw Error();
    expect(after.clock.remainingMainMs.south).toBeLessThanOrEqual(
      before.clock.remainingMainMs.south - 2000,
    );
    expect(requests).toHaveLength(1);
    expect(requests[0].budget.timeBudgetMs).toBe(profile === "trial-100ms" ? 100 : 500);
    expect(requests[0].position.initial.players).toEqual({
      south: "south",
      west: "west",
      north: "north",
      east: "east",
    });
    expect(JSON.stringify(requests[0])).not.toContain(p.user.id);
    expect(JSON.stringify(requests[0])).not.toContain(p.user.username);
    expect((await p.diagnostics())[0]?.reason).toBeNull();
    expect(await p.diagnostics()).toMatchObject([
      { source: "model", usedModelId: model, inferenceCount: 2, outcome: "applied" },
    ]);
    await p.alarm();
    expect((await p.room()).positionRevision).toBe(before.positionRevision + 1);
    await runInDurableObject(p.stub, (_instance, ctx) =>
      expect(new ShogiStore(ctx.storage.sql).eventCount(before.roundId!)).toBe(1),
    );
  });
}
test("2秒未満では送信も着手も行わず、時計と操作受付を維持する", async () => {
  const p = await setup();
  await runInDurableObject(p.stub, (_instance, ctx) => {
    const room = fourShogiRoomSchema.parse(ctx.storage.kv.get("room"));
    if (room.status !== "playing") throw Error();
    room.clock.turnStartedAt = Date.now();
    ctx.storage.kv.put("room", room);
  });
  const spy = vi.spyOn(globalThis, "fetch");
  await p.alarm();
  expect(spy).not.toHaveBeenCalled();
  expect(await p.job()).toBeUndefined();
  expect((await p.room()).positionRevision).toBe(0);
});
test("待ち行列の間もチャットを受理し、DO再生成後は同じ要求の結果を取得する", async () => {
  const p = await setup();
  let request: AiJobRequest | null = null;
  let posts = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    if (String(url).endsWith("health")) return Response.json(serviceHealth());
    if (init?.body) {
      request = JSON.parse(String(init.body));
      posts++;
      return Response.json(await snapshot(request!, "queued"));
    }
    return Response.json(await snapshot(request!));
  });
  await p.alarm();
  await vi.waitFor(async () => expect((await p.job())?.snapshot?.status).toBe("queued"), {
    interval: 1,
  });
  p.client.send({ type: "room.chat.send", text: "思考中です" });
  expect(
    await p.client.waitFor("room.chat.snapshot", (m) =>
      m.messages.some((entry) => entry.kind === "player" && entry.text === "思考中です"),
    ),
  ).toBeTruthy();
  const job = await p.job();
  const clock = vi.spyOn(Date, "now").mockReturnValue(job!.nextAt + 1);
  try {
    await p.alarm();
    await awaitAction(p);
  } finally {
    clock.mockRestore();
  }
  await apply(p);
  expect(posts).toBe(1);
  expect((await p.room()).positionRevision).toBe(1);
});
for (const reason of ["unavailable", "bad_hash", "bad_model", "illegal_action"] as const) {
  test(`障害${reason}: モデル着手と偽装せず期限内のLv2へ切り替える`, async () => {
    const p = await setup();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      if (reason === "unavailable") return Response.json({ error: "unavailable" }, { status: 503 });
      if (!init?.body) return Response.json(serviceHealth());
      const result = await snapshot(JSON.parse(String(init.body)));
      if (reason === "bad_hash") result.inputHash = "f".repeat(64);
      if (reason === "bad_model")
        (result.result as { model: { usedModelId: string } }).model.usedModelId = "wrong";
      if (reason === "illegal_action")
        (result.result as { recommendedAction: unknown }).recommendedAction = {
          type: "move",
          from: { x: 0, y: 0 },
          to: { x: 0, y: 1 },
          promote: false,
        };
      return Response.json(result);
    });
    await p.alarm();
    await vi.waitFor(
      async () => {
        const job = await p.job();
        expect(job?.reason || job?.action).toBeTruthy();
      },
      { interval: 1 },
    );
    await apply(p);
    if (reason === "illegal_action") await apply(p);
    await apply(p);
    expect((await p.room()).positionRevision).toBe(1);
    expect(await p.diagnostics()).toMatchObject([
      { source: "lv2", usedModelId: null, inferenceCount: 0, outcome: "applied" },
    ]);
  });
}
for (const change of [
  "revision",
  "round",
  "instance",
  "clock",
  "level",
  "eliminate",
  "state",
] as const) {
  test(`遅延応答中の${change}変更では旧要求を破棄する`, async () => {
    const p = await setup();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let sent!: () => void;
    const sending = new Promise<void>((resolve) => {
      sent = resolve;
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      if (!init?.body) return Response.json(serviceHealth());
      const request = JSON.parse(String(init.body));
      sent();
      await gate;
      return Response.json(await snapshot(request));
    });
    await p.alarm();
    await sending;
    await runInDurableObject(p.stub, async (_instance, ctx) => {
      let room = fourShogiRoomSchema.parse(ctx.storage.kv.get("room"));
      if (room.status !== "playing") throw Error();
      if (change === "revision") room.positionRevision++;
      if (change === "state") room.game.drawProposals = ["south"];
      if (change === "round") room.roundId = crypto.randomUUID();
      if (change === "instance") room.instanceId = crypto.randomUUID();
      if (change === "clock") room.clock.turnExpiresAt++;
      const turn = room.game.turn;
      if (change === "level")
        room.players = room.players.map((player) =>
          player.kind === "cpu" && player.side === turn ? { ...player, level: 1 } : player,
        );
      if (change === "eliminate") {
        const cpu = room.players.find((player) => player.kind === "cpu" && player.side !== turn)!;
        const result = new FourShogiProgress({
          storage: ctx.storage,
          membership: () => null,
          accountId: () => p.user.id,
        }).eliminate(room, cpu.id, "left", Date.now());
        if (result.kind !== "playing") throw Error();
        room = result.room;
      }
      ctx.storage.kv.put("room", room);
      await new GameRoom(ctx, p.configured).getRoom();
    });
    release();
    await vi.waitFor(async () => expect(await p.job()).toBeUndefined(), { interval: 1 });
    expect((await p.room()).game?.moveNumber).toBe(0);
    expect(await p.diagnostics()).toMatchObject([
      { outcome: "discarded", reason: "stale_context" },
    ]);
  });
}
test("時計期限ではfallbackも指さず時間切れを通常処理する", async () => {
  const p = await setup();
  vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
    Response.json({ error: "unavailable" }, { status: 503 }),
  );
  await p.alarm();
  await vi.waitFor(async () => expect((await p.job())?.reason).toBeTruthy(), { interval: 1 });
  const before = await p.room();
  if (before.status !== "playing") throw Error();
  const clock = vi.spyOn(Date, "now").mockReturnValue(before.clock.turnExpiresAt);
  try {
    await p.alarm();
  } finally {
    clock.mockRestore();
  }
  const after = await p.room();
  expect(after.game?.moveNumber).toBe(0);
  expect(after.eliminations).toContainEqual(
    expect.objectContaining({ side: before.game.turn, reason: "timeout" }),
  );
});
test("正本のhashは本人IDに依存せず、保存した完全状態と再生状態で一致する", async () => {
  const p = await setup();
  await runInDurableObject(p.stub, async (_instance, ctx) => {
    const room = fourShogiRoomSchema.parse(ctx.storage.kv.get("room"));
    if (room.status !== "playing") throw Error();
    const state = new ShogiStore(ctx.storage.sql).loadState(room.roundId, room.game);
    const a = await getAnalysisStateHash(state),
      b = await getAnalysisStateHash({
        ...state,
        players: { south: "south", west: "west", north: "north", east: "east" },
      });
    expect(a).toBe(b);
  });
});

test("試用設定は部屋の世代・ホスト資格・待機中に限定し、診断も許可参加者だけへ返す", async () => {
  const p = await setup(),
    room = await p.room();
  await runInDurableObject(p.stub, async (instance, ctx) => {
    expect(
      await instance.configureTrialCpu(
        p.user.id,
        "f".repeat(64),
        room.instanceId,
        room.players[1].id,
        "trial-500ms",
      ),
    ).toEqual({ error: "trial_forbidden" });
    expect(
      await instance.configureTrialCpu(
        p.user.id,
        p.tokenHash,
        crypto.randomUUID(),
        room.players[1].id,
        "trial-500ms",
      ),
    ).toEqual({ error: "room_not_found" });
    expect(
      await instance.configureTrialCpu(
        p.user.id,
        p.tokenHash,
        room.instanceId,
        room.players[1].id,
        "trial-500ms",
      ),
    ).toEqual({ error: "unsupported_room" });
    expect(instance.trialCpuDiagnostics("someone-else", room.instanceId)).toBeNull();
    expect(ctx.storage.kv.get(trialCpuSettingsKey)).toMatchObject({
      instanceId: room.instanceId,
      ownerId: p.user.id,
    });
  });
});
test("古い順序のGET応答は保存済みモデル候補を上書きせず、同じ手を二重確定しない", async () => {
  const p = await setup();
  let request!: AiJobRequest;
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => {
      release = resolve;
    }),
    fetching = new Promise<void>((resolve) => {
      entered = resolve;
    });
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    if (String(url).endsWith("health")) return Response.json(serviceHealth());
    if (init?.body) {
      request = JSON.parse(String(init.body));
      return Response.json(await snapshot(request, "queued"));
    }
    entered();
    await gate;
    return Response.json(await snapshot(request, "queued"));
  });
  await p.alarm();
  await vi.waitFor(async () => expect((await p.job())?.snapshot).toBeTruthy(), { interval: 1 });
  const first = await p.job();
  const time = vi.spyOn(Date, "now").mockReturnValue(first!.nextAt + 1);
  await p.alarm();
  await fetching;
  await runInDurableObject(p.stub, async (_instance, ctx) => {
    const job = ctx.storage.kv.get<Record<string, unknown>>(trialCpuJobKey)!;
    const completed = await snapshot(request);
    ctx.storage.kv.put(trialCpuJobKey, {
      ...job,
      snapshot: completed,
      action: (completed.result as { recommendedAction: unknown }).recommendedAction,
      source: "model",
      nextAt: Date.now() + 1,
    });
  });
  release();
  await vi.waitFor(async () => expect((await p.job())?.action).toBeTruthy(), { interval: 1 });
  time.mockRestore();
  await apply(p);
  await p.alarm();
  expect((await p.room()).positionRevision).toBe(1);
  expect(await p.diagnostics()).toMatchObject([{ source: "model", outcome: "applied" }]);
});

// 実PyTorchは専用コマンドからだけ実行し、通常checkへネットワークと重い推論を加えません。
const smoke = env as typeof env & {
  AI_CPU_SMOKE_URL?: string;
  AI_CPU_SMOKE_SECRET?: string;
  AI_CPU_SMOKE_MODEL_ID?: string;
  AI_CPU_SMOKE_CODE_VERSION?: string;
};
if (smoke.AI_CPU_SMOKE_URL)
  for (const prohibited of [false, true])
    for (const profile of ["trial-100ms", "trial-500ms"] as const) {
      test(`実モデルCPU ${profile} 禁止${prohibited}: Linux応答を通常着手へ確定する`, async () => {
        const p = await setup(prohibited, profile);
        const configured = {
          ...p.configured,
          FOUR_SHOGI_AI_URL: smoke.AI_CPU_SMOKE_URL!,
          FOUR_SHOGI_AI_SHARED_SECRET: smoke.AI_CPU_SMOKE_SECRET!,
          FOUR_SHOGI_AI_MODEL_ID: smoke.AI_CPU_SMOKE_MODEL_ID!,
          FOUR_SHOGI_AI_CODE_VERSION: smoke.AI_CPU_SMOKE_CODE_VERSION!,
        };
        await runInDurableObject(p.stub, (instance) =>
          Object.assign((instance as unknown as { env: Env }).env, configured),
        );
        Object.assign(p.configured, configured);
        await p.alarm();
        await awaitAction(p);
        await apply(p);
        expect((await p.room()).positionRevision).toBe(1);
        const diagnostics = await p.diagnostics();
        expect(diagnostics).toMatchObject([
          { source: "model", outcome: "applied", usedModelId: configured.FOUR_SHOGI_AI_MODEL_ID },
        ]);
        expect(Number(diagnostics[0].inferenceCount)).toBeGreaterThan(0);
        console.info("AI_CPU_MODEL_SMOKE " + JSON.stringify({ prohibited, profile, diagnostics }));
      }, 10000);
    }

test("期限までの余裕が100ms以下なら確保した合法手を使い、VPS通信を始めない", async () => {
  const p = await setup();
  await runInDurableObject(p.stub, (_instance, ctx) => {
    const room = fourShogiRoomSchema.parse(ctx.storage.kv.get("room"));
    if (room.status !== "playing") throw Error();
    room.clock.turnExpiresAt = Date.now() + 50;
    ctx.storage.kv.put("room", room);
  });
  const spy = vi.spyOn(globalThis, "fetch");
  await p.alarm();
  await apply(p);
  expect(spy).not.toHaveBeenCalled();
  expect((await p.room()).positionRevision).toBe(1);
  expect(await p.diagnostics()).toMatchObject([
    { source: "legal", usedModelId: null, outcome: "applied" },
  ]);
});
test("モデルを使わない終局宣言は正本で終局しなければ着手に採用しない", async () => {
  const p = await setup();
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    if (!init?.body) return Response.json(serviceHealth());
    const value = await snapshot(JSON.parse(String(init.body)));
    const result = value.result as {
      evaluation: { evaluationKind: string };
      model: { usedModelId: string | null; inferenceCount: number };
    };
    result.evaluation.evaluationKind = "terminal";
    result.model.usedModelId = null;
    result.model.inferenceCount = 0;
    return Response.json(value);
  });
  await p.alarm();
  await awaitAction(p);
  await apply(p);
  expect((await p.room()).game?.moveNumber).toBe(0);
  await apply(p);
  await apply(p);
  expect(await p.diagnostics()).toMatchObject([
    { source: "lv2", reason: "illegal_action", outcome: "applied" },
  ]);
});
test("期限切れから通常終局・再戦した後の前局応答を確定しない", async () => {
  const p = await setup(),
    before = await p.room();
  let release!: () => void;
  let sent!: () => void;
  const gate = new Promise<void>((resolve) => {
      release = resolve;
    }),
    sending = new Promise<void>((resolve) => {
      sent = resolve;
    });
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    if (!init?.body) return Response.json(serviceHealth());
    const request = JSON.parse(String(init.body));
    sent();
    await gate;
    return Response.json(await snapshot(request));
  });
  await p.alarm();
  await sending;
  for (let count = 0; count < 4; count++) {
    const room = await p.room();
    if (room.status === "waiting") break;
    if (room.status !== "playing") throw Error();
    vi.spyOn(Date, "now").mockReturnValue(room.clock.turnExpiresAt);
    await p.alarm();
  }
  expect((await p.room()).status).toBe("waiting");
  p.client.send({ type: "room.ready.set", ready: true });
  await p.client.waitFor(
    "room.snapshot",
    (m) => m.room.status === "waiting" && m.room.players.every((player) => player.ready),
  );
  p.client.send({ type: "room.game.start" });
  const next = await p.client.waitFor(
    "room.snapshot",
    (m) => m.room.status === "playing" && "roundId" in m.room && m.room.roundId !== before.roundId,
  );
  release();
  await vi.waitFor(async () => expect(await p.job()).toBeUndefined(), { interval: 1 });
  const after = await p.room();
  expect(after.roundId).toBe(fourShogiRoomSchema.parse(next.room).roundId);
  expect(after.game?.moveNumber).toBe(0);
  expect(after.positionRevision).toBe(0);
  expect(await p.diagnostics()).toMatchObject([{ outcome: "discarded" }]);
});

test("試用CPUは障害時も人間の引分提案へ自動同意しない", async () => {
  const p = await setup();
  await runInDurableObject(p.stub, (_instance, ctx) => {
    const room = fourShogiRoomSchema.parse(ctx.storage.kv.get("room"));
    if (room.status !== "playing") throw Error();
    room.game.drawProposals = room.players
      .filter((player) => player.kind === "human")
      .map((player) => player.side);
    ctx.storage.kv.put("room", room);
  });
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json({ error: "unavailable" }, { status: 503 }),
  );
  await p.alarm();
  await vi.waitFor(async () => expect((await p.job())?.reason).toBeTruthy(), { interval: 1 });
  await apply(p);
  await apply(p);
  const room = await p.room();
  if (room.status !== "playing") throw Error();
  expect(room.game.drawProposals).not.toContain("south");
  await runInDurableObject(p.stub, (_instance, ctx) => {
    const store = new ShogiStore(ctx.storage.sql);
    expect(store.replayEvents(room.roundId, 0).map((event) => event.type)).toEqual(["action"]);
  });
});
