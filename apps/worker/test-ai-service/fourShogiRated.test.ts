import { env, exports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect, test, vi } from "vitest";
import {
  fourShogiRoomSchema,
  getPublicMatchContract,
  fourShogiRatedMatchmakingRules as rules,
  matchmakingStateSchema,
} from "@tetraboard/protocol";
import { accountFixture, origin } from "../test/accountFixtures";
import { AcceptedGameRequest } from "../test/acceptedGameRequest";
import { fourShogiAiJobKey, type ShogiCpuJob } from "../src/rooms/fourShogiProgress";
import { shogiCpuJobKey } from "../src/rooms/progressHelpers";
import { requestFourShogiAiMove } from "../src/rooms/aiService";
import { calibratedFourShogiProfile, selectFourShogi } from "../src/matchmaking/fourShogiSelection";

const request = (path: string, init?: RequestInit) =>
  exports.default.fetch(new AcceptedGameRequest(`${origin}/api${path}`, init));
const base = "/matchmaking/four-shogi";

test("認定中は標準、認定済みは実力に最も近い四人将棋CPUを選ぶ", () => {
  for (const [rating, ratedGames, work, name] of [
    [20, 4, 16384, "シテン"],
    [20, 5, 4096, "ヨツメ"],
    [25, 5, 16384, "シテン"],
    [28, 5, 65536, "カコイ"],
  ] as const) {
    expect(selectFourShogi([{ rating, ratedGames }], 19_999)).toBeUndefined();
    const reference = selectFourShogi([{ rating, ratedGames }], 20_000)?.rating.cpu;
    expect(reference?.profileId).toBe(`four-shogi-lv3-work${work}-v1`);
    expect(reference && calibratedFourShogiProfile(reference)?.name).toBe(name);
  }
  expect(selectFourShogi([{}, {}, {}, {}], 0)?.rating.cpu).toBeUndefined();
});

test.each([
  { humans: 2, names: ["シテン1", "シテン2"] },
  { humans: 3, names: ["シテン"] },
])("四人将棋の補充席数に合わせて名前を付ける（人間$humans人）", async ({ humans, names }) => {
  let now = Date.now() + 60_000;
  const accounts = await Promise.all(Array.from({ length: humans }, () => accountFixture()));
  const controllerId = crypto.randomUUID();
  const coordinator = env.MATCHMAKING_COORDINATOR.getByName(rules.key);
  vi.spyOn(Date, "now").mockImplementation(() => now);
  try {
    for (const account of accounts) {
      const joined = await request(`${base}/join`, {
        method: "POST",
        headers: account.headers,
        body: JSON.stringify({ operationId: crypto.randomUUID(), controllerId }),
      });
      expect(joined.status).toBe(200);
      expect(matchmakingStateSchema.parse(await joined.json()).status).toBe("waiting");
    }
    now += rules.fillAfterMs;
    await runInDurableObject(coordinator, (instance) => instance.alarm());
    const assigned = (await coordinator.status(accounts[0]!.id, controllerId)).assignment!;
    const room = fourShogiRoomSchema.parse(
      await env.GAME_ROOM.getByName(assigned.roomId).getRoom(),
    );
    expect(
      room.players.filter((player) => player.kind === "cpu").map((player) => player.name),
    ).toEqual(names);
  } finally {
    for (const account of accounts) await coordinator.leaveAccount(account.id);
    vi.restoreAllMocks();
  }
});

test.each([
  { mode: "auth", reason: "http_401", requests: 1 },
  { mode: "invalid", reason: "invalid_response", requests: 1 },
  { mode: "expired", reason: "timeout", requests: 0 },
  { mode: "late_error", reason: "timeout", requests: 1 },
  { mode: "late_success", reason: "timeout", requests: 1 },
  { mode: "busy", reason: undefined, requests: 2 },
  { mode: "network", reason: undefined, requests: 2 },
])("四人将棋の着手要求の終了条件（$mode）", async ({ mode, reason, requests }) => {
  let now = Date.now();
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const expiresAt = now + (mode === "expired" ? 0 : 5000);
  let calls = 0;
  const fetchAi = vi.spyOn(globalThis, "fetch").mockImplementation(async (_, init) => {
    calls++;
    if (mode.startsWith("late_")) now = expiresAt;
    if (mode === "auth") return new Response(null, { status: 401 });
    if (mode === "invalid") return Response.json({});
    if (mode === "late_error") return new Response(null, { status: 500 });
    if (mode === "busy" && calls === 1) return new Response(null, { status: 429 });
    if (mode === "network" && calls === 1) throw new TypeError("fetch failed");
    const body = JSON.parse(String(init?.body));
    return Response.json({
      api_version: 1,
      rules_version: 1,
      request_id: body.request_id,
      position_revision: body.position_revision,
      profile_id: body.profile_id,
      engine_version: "four-shogi-lv3-v1",
      max_work: 16384,
      max_time_ms: 500,
      diagnostics: { work: 100 },
      action: { type: "movePiece", from: { x: 4, y: 7 }, to: { x: 4, y: 6 }, promote: false },
    });
  });
  try {
    const profile = calibratedFourShogiProfile(
      selectFourShogi([{}], rules.fillAfterMs)!.rating.cpu!,
    )!;
    const result = await requestFourShogiAiMove(env, {
      job: {
        requestId: crypto.randomUUID(),
        roundId: crypto.randomUUID(),
        positionRevision: 0,
        side: "south",
        expiresAt,
      },
      profile,
      events: [],
    });
    expect(fetchAi).toHaveBeenCalledTimes(requests);
    if (reason) expect(result).toEqual({ action: null, reason });
    else expect(result).toMatchObject({ action: { type: "movePiece" }, retried: true });
  } finally {
    vi.restoreAllMocks();
  }
});

test("Service Bindingがある場合は公開URLへのfetchを使わず着手を受け取る", async () => {
  const publicFetch = vi.spyOn(globalThis, "fetch");
  const boundFetch = vi.fn(async (request: Request) => {
    expect(new URL(request.url).pathname).toBe("/v1/four-shogi/move");
    expect(request.method).toBe("POST");
    const body = await request.json<{
      request_id: string;
      position_revision: string;
      profile_id: string;
    }>();
    expect(request.headers.get("x-tetraboard-ai-request-id")).toBe(body.request_id);
    return Response.json({
      api_version: 1,
      rules_version: 1,
      request_id: body.request_id,
      position_revision: body.position_revision,
      profile_id: body.profile_id,
      engine_version: "four-shogi-lv3-v1",
      max_work: 16384,
      max_time_ms: 500,
      diagnostics: { work: 100 },
      action: { type: "movePiece", from: { x: 4, y: 7 }, to: { x: 4, y: 6 }, promote: false },
    });
  });
  try {
    const profile = calibratedFourShogiProfile(
      selectFourShogi([{}], rules.fillAfterMs)!.rating.cpu!,
    )!;
    const result = await requestFourShogiAiMove(
      { ...env, AI_GATEWAY: { fetch: boundFetch } },
      {
        job: {
          requestId: crypto.randomUUID(),
          roundId: crypto.randomUUID(),
          positionRevision: 0,
          side: "south",
          expiresAt: Date.now() + 5000,
        },
        profile,
        events: [],
      },
    );
    expect(result.action?.type).toBe("movePiece");
    expect(boundFetch).toHaveBeenCalledTimes(1);
    expect(publicFetch).not.toHaveBeenCalled();
  } finally {
    publicFetch.mockRestore();
  }
});

test.each(["placement", "fifth", "fallback", "retry", "retry_failed", "timeout_retry"] as const)(
  "CPU補充から終局・保存まで完走する（%s）",
  async (scenario) => {
    const fallback = scenario === "fallback" || scenario === "retry_failed";
    const testRetry =
      scenario === "retry" || scenario === "retry_failed" || scenario === "timeout_retry";
    let now = Date.now() + 60_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const logs: Record<string, unknown>[] = [];
    vi.spyOn(console, "info").mockImplementation((entry: unknown) => {
      if (entry && typeof entry === "object") logs.push(entry as Record<string, unknown>);
    });
    const account = await accountFixture();
    const operationId = crypto.randomUUID();
    const controllerId = crypto.randomUUID();
    const coordinator = env.MATCHMAKING_COORDINATOR.getByName(rules.key);
    let socket: WebSocket | undefined;
    let roomId: string | undefined;
    let token: string | undefined;
    try {
      if (scenario === "fifth") {
        for (let count = 1; count <= 4; count++) {
          const id = crypto.randomUUID();
          await env.APP_DB.batch([
            env.APP_DB.prepare(
              "INSERT INTO matches VALUES (?, 'four-shogi', 'singles', ?, ?, '{}')",
            ).bind(id, now - 2000, now - 1000),
            env.APP_DB.prepare(
              "INSERT INTO four_shogi_rating_changes VALUES (?, ?, 25, 8, 25, 8, ?, 0)",
            ).bind(id, account.id, count),
          ]);
        }
      }
      const joined = await request(`${base}/join`, {
        method: "POST",
        headers: account.headers,
        body: JSON.stringify({ operationId, controllerId }),
      });
      expect(joined.status).toBe(200);
      expect(matchmakingStateSchema.parse(await joined.json()).status).toBe("waiting");
      now += rules.fillAfterMs - 1;
      expect((await coordinator.status(account.id, controllerId)).status).toBe("waiting");
      now++;
      await runInDurableObject(coordinator, (instance) => instance.alarm());
      const assigned = (await coordinator.status(account.id, controllerId)).assignment!;
      expect(assigned.opponent).toBe("cpu");
      roomId = assigned.roomId;
      token = assigned.membership.token;
      const roomStub = env.GAME_ROOM.getByName(roomId);
      const connect = async () => {
        const upgraded = await request(`/rooms/${roomId}/ws`, {
          headers: { Upgrade: "websocket" },
        });
        expect(upgraded.status).toBe(101);
        const ws = upgraded.webSocket!;
        socket = ws;
        ws.accept();
        const authed = new Promise<void>((resolve) =>
          ws.addEventListener("message", (event) => {
            if (JSON.parse(String(event.data)).type === "room.authenticated") resolve();
          }),
        );
        ws.send(JSON.stringify({ type: "room.auth", token }));
        await authed;
      };
      await connect();
      let room = fourShogiRoomSchema.parse(await roomStub.getRoom());
      expect(room.matchmaking?.startsAtMs).toBe(now + rules.countdownMs);
      if (scenario === "retry") {
        now++;
        await runInDurableObject(roomStub, async (instance, state) => {
          await instance.webSocketClose(state.getWebSockets()[0]!, 1000, "");
        });
        const disconnected = fourShogiRoomSchema.parse(await roomStub.getRoom());
        expect(disconnected.matchmaking?.startsAtMs).toBeUndefined();
        now++;
        await connect();
        room = fourShogiRoomSchema.parse(await roomStub.getRoom());
        expect(room.matchmaking?.startsAtMs).toBe(now + rules.countdownMs);
      }
      expect(room.settings).toMatchObject({
        mode: "singles",
        threePlayerAttackProhibited: true,
        timeControl: rules.timeControl,
      });
      now += rules.countdownMs;
      room = fourShogiRoomSchema.parse(await roomStub.getRoom());
      expect(room.status).toBe("playing");
      if (room.status !== "playing") throw Error("未開始");
      expect(room.roundId).toBe(assigned.matchId);
      if (scenario === "retry") {
        await roomStub.getRoom();
        const timeline = logs.filter((entry) => entry.matchId === assigned.matchId);
        const accepted = logs.find((entry) => entry.event === "four_shogi_queue_accepted");
        expect(timeline.map((entry) => entry.event)).toEqual([
          "four_shogi_assigned",
          "four_shogi_connected",
          "four_shogi_countdown_reset",
          "four_shogi_connected",
          "four_shogi_started",
        ]);
        expect(accepted?.diagnosticId).toEqual(expect.any(String));
        expect(timeline[0]?.diagnosticId).toBe(accepted?.diagnosticId);
        expect(Number(timeline[0]?.atMs) - Number(accepted?.atMs)).toBe(rules.fillAfterMs);
        expect(Number(timeline[4]?.atMs) - Number(timeline[3]?.atMs)).toBe(rules.countdownMs);
      }
      const cpuIds = room.players.filter((p) => p.kind === "cpu").map((p) => p.id);
      expect(room.players.filter((p) => p.kind === "cpu").map((p) => p.name)).toEqual([
        "シテン1",
        "シテン2",
        "シテン3",
      ]);
      let cpuMoves = 0;
      for (let step = 0; step < 14 && room.status === "playing"; step++) {
        const turn = room.game.turn;
        const player = room.players.find((p) => p.side === turn)!;
        if (player.kind === "human" || cpuMoves >= 3) {
          now = room.clock.turnExpiresAt;
          await runInDurableObject(roomStub, (instance) => instance.alarm());
        } else {
          now = room.clock.turnStartedAt + 2_000;
          if (scenario === "fallback" && cpuMoves === 0) {
            const { roundId, positionRevision } = room;
            await runInDurableObject(roomStub, (_, context) =>
              context.storage.kv.put(fourShogiAiJobKey, {
                requestId: crypto.randomUUID(),
                roundId,
                positionRevision,
                side: turn,
                expiresAt: now,
              }),
            );
          }
          const moveNumber = room.game.moveNumber;
          if (cpuMoves === 0 && testRetry) {
            const fetchReal = globalThis.fetch;
            const bodies: unknown[] = [];
            let firstSignal: AbortSignal | null | undefined;
            const fetchAi = vi
              .spyOn(globalThis, "fetch")
              .mockImplementation(async (input, init) => {
                if (new URL(String(input)).pathname !== "/v1/four-shogi/move")
                  return fetchReal(input, init);
                bodies.push(init?.body);
                if (scenario === "timeout_retry") {
                  if (bodies.length === 1) {
                    firstSignal = init?.signal;
                    // 中断通知を受けてもfetchが戻らない状況を再現します。
                    return new Promise<Response>(() => {});
                  }
                  expect(firstSignal?.aborted).toBe(true);
                }
                if (bodies.length === 1 || scenario === "retry_failed")
                  return new Response(null, { status: 500 });
                return fetchReal(input, init);
              });
            try {
              await runInDurableObject(roomStub, (instance) => instance.alarm());
            } finally {
              fetchAi.mockRestore();
            }
            expect(bodies).toHaveLength(2);
            expect(bodies[0]).toBe(bodies[1]);
          } else {
            await runInDurableObject(roomStub, (instance) => instance.alarm());
          }
          const job = await runInDurableObject(roomStub, (_, context) =>
            context.storage.kv.get<ShogiCpuJob>(shogiCpuJobKey),
          );
          expect(job?.action).toBeDefined();
          expect(job?.fallback === true).toBe(fallback && cpuMoves === 0);
          now++;
          await runInDurableObject(roomStub, (instance) => instance.alarm());
          const advanced = fourShogiRoomSchema.parse(await roomStub.getRoom());
          expect(advanced.status === "playing" && advanced.game.moveNumber).toBe(moveNumber + 1);
          cpuMoves++;
        }
        room = fourShogiRoomSchema.parse(await roomStub.getRoom());
      }
      expect(cpuMoves).toBe(3);
      expect(room.lastRound?.roundId).toBe(assigned.matchId);
      expect(
        room.lastRound?.players
          .filter((player) => player.appearance?.kind === "cpu")
          .map((player) => player.name)
          .sort(),
      ).toEqual(["シテン1", "シテン2", "シテン3"]);
      if (testRetry) {
        const failed = logs.find((entry) => entry.event === "four_shogi_ai_attempt_failed");
        expect(failed).toMatchObject({
          matchId: assigned.matchId,
          attempt: 1,
          reason: scenario === "timeout_retry" ? "timeout" : "http_500",
          willRetry: true,
        });
        expect(logs).toContainEqual(
          expect.objectContaining({
            event: fallback ? "four_shogi_ai_fallback_applied" : "four_shogi_ai_retry_applied",
            matchId: assigned.matchId,
            requestId: failed?.requestId,
          }),
        );
      }
      const resultPath = `${base}/results/${assigned.matchId}?includeOpponent=1`;
      const result = async () => (await request(resultPath, { headers: account.headers })).json();
      for (let i = 0; i < 8; i++) {
        const current = (await result()) as { status: string };
        if (current.status !== "pending") break;
        now++;
        await runInDurableObject(roomStub, (instance) => instance.alarm());
      }
      const players = Object.fromEntries(cpuIds.map((id) => [id, { status: "cpu", rating: 1500 }]));
      const saved = await result();
      if (scenario === "fifth") {
        expect(saved).toMatchObject({
          status: "rated",
          rating: expect.any(Number),
          previousRating: 1500,
          placementCompleted: true,
          humanPlayed: false,
          players,
        });
      } else {
        expect(saved).toEqual(
          fallback
            ? { status: "excluded", reason: "ai_fallback" }
            : { status: "placement", games: 1, players },
        );
      }
      const replay = await request(`/matches/${assigned.matchId}`);
      expect(replay.status).toBe(200);
      const { match } = getPublicMatchContract.response.parse(await replay.json());
      expect(
        match.participants.filter((player) => player.kind === "cpu").map((player) => player.name),
      ).toEqual(["シテン1", "シテン2", "シテン3"]);
      for (const player of match.participants) {
        const query = new URLSearchParams({
          source: "match",
          matchId: match.id,
          playerId: player.id,
          game: "four-shogi",
          includeRating: "1",
        });
        const response = await request(`/player-profile?${query}`);
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({
          rating:
            player.kind === "cpu"
              ? { timing: "reference", status: "rated", rating: 1500 }
              : { timing: "before", status: "placement" },
        });
      }
      // 再度Alarmを実行しても認定局数は増えず、予約が残りません。
      await runInDurableObject(roomStub, (instance) => instance.alarm());
      const summary = await (await request(`${base}/rating`, { headers: account.headers })).json();
      if (scenario === "fifth") {
        expect(summary).toEqual({
          status: "rated",
          rating: (saved as { rating: number }).rating,
          humanPlayed: false,
        });
        expect(
          await env.APP_DB.prepare(
            "SELECT MAX(rated_games) AS games FROM four_shogi_rating_changes WHERE account_id=?",
          )
            .bind(account.id)
            .first("games"),
        ).toBe(5);
      } else {
        expect(summary).toEqual({ status: "placement", games: fallback ? 0 : 1 });
      }
      expect(
        await env.APP_DB.prepare("SELECT 1 FROM four_shogi_rating_pending WHERE match_id=?")
          .bind(assigned.matchId)
          .first(),
      ).toBeNull();
    } finally {
      vi.restoreAllMocks();
      socket?.close();
      if (roomId && token) {
        const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
        await env.GAME_ROOM.getByName(roomId).leaveRoom(
          Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, "0")).join(""),
        );
      }
      await coordinator.leaveAccount(account.id);
    }
  },
  30_000,
);
