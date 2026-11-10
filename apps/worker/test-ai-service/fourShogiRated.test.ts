import { env, exports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect, test, vi } from "vitest";
import {
  fourShogiRoomSchema,
  fourShogiRatedMatchmakingRules as rules,
  matchmakingStateSchema,
} from "@tetraboard/protocol";
import { accountFixture, origin } from "../test/accountFixtures";
import { AcceptedGameRequest } from "../test/acceptedGameRequest";
import { fourShogiAiJobKey, type ShogiCpuJob } from "../src/rooms/fourShogiProgress";
import { shogiCpuJobKey } from "../src/rooms/progressHelpers";
import { selectFourShogi } from "../src/matchmaking/fourShogiSelection";

const request = (path: string, init?: RequestInit) =>
  exports.default.fetch(new AcceptedGameRequest(`${origin}/api${path}`, init));
const base = "/matchmaking/four-shogi";

test("認定中は標準、認定済みは実力に最も近い四人将棋CPUを選ぶ", () => {
  for (const [rating, ratedGames, work] of [
    [20, 4, 16384],
    [20, 5, 4096],
    [25, 5, 16384],
    [28, 5, 65536],
  ]) {
    expect(selectFourShogi([{ rating, ratedGames }], 19_999)).toBeUndefined();
    expect(selectFourShogi([{ rating, ratedGames }], 20_000)?.rating.cpu?.profileId).toBe(
      `four-shogi-lv3-work${work}-v1`,
    );
  }
  expect(selectFourShogi([{}, {}, {}, {}], 0)?.rating.cpu).toBeUndefined();
});

test.each(["placement", "fifth", "fallback"] as const)(
  "CPU補充から終局・保存まで完走する（%s）",
  async (scenario) => {
    const fallback = scenario === "fallback";
    let now = Date.now() + 60_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
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
      const upgraded = await request(`/rooms/${roomId}/ws`, { headers: { Upgrade: "websocket" } });
      expect(upgraded.status).toBe(101);
      socket = upgraded.webSocket!;
      socket.accept();
      const ws = socket;
      const authed = new Promise<void>((resolve) =>
        ws.addEventListener("message", (event) => {
          if (JSON.parse(String(event.data)).type === "room.authenticated") resolve();
        }),
      );
      ws.send(JSON.stringify({ type: "room.auth", token }));
      await authed;
      let room = fourShogiRoomSchema.parse(await roomStub.getRoom());
      expect(room.matchmaking?.startsAtMs).toBe(now + rules.countdownMs);
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
      const cpuIds = room.players.filter((p) => p.kind === "cpu").map((p) => p.id);
      expect(cpuIds).toHaveLength(3);
      let cpuMoves = 0;
      for (let step = 0; step < 14 && room.status === "playing"; step++) {
        const turn = room.game.turn;
        const player = room.players.find((p) => p.side === turn)!;
        if (player.kind === "human" || cpuMoves >= 3) {
          now = room.clock.turnExpiresAt;
          await runInDurableObject(roomStub, (instance) => instance.alarm());
        } else {
          now = room.clock.turnStartedAt + 2_000;
          if (fallback && cpuMoves === 0) {
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
          await runInDurableObject(roomStub, (instance) => instance.alarm());
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
      // 再度Alarmを実行しても認定局数は増えず、予約が残りません。
      await runInDurableObject(roomStub, (instance) => instance.alarm());
      const summary = await (await request(`${base}/rating`, { headers: account.headers })).json();
      if (scenario === "fifth") {
        expect(summary).toMatchObject({
          status: "rated",
          rating: (saved as { rating: number }).rating,
          rank: expect.any(String),
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
