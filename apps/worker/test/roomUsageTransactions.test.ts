import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect, test } from "vitest";
import type { Room } from "@tetraboard/protocol";
import { analyticsActiveKey, type AnalyticsMatch } from "../src/usageEvents/matches";
import { recordUsageEvents } from "./usageEventsRecorder";
import { RoomBoundaryFixtures } from "./roomBoundaryFixtures";

test.each(["start", "end"] as const)(
  "%s のtransactionが戻ったら利用イベントを捨て、再試行で一度だけ書く",
  async (phase) => {
    const fixtures = new RoomBoundaryFixtures();
    const events = recordUsageEvents();
    try {
      const entry = await fixtures.create({ game: "reversi", name: "本人", quickPlay: true });
      await runInDurableObject(env.GAME_ROOM.getByName(entry.room.id), (instance, ctx) => {
        const room = ctx.storage.kv.get<Room>("room")!;
        const matchId = crypto.randomUUID();
        const start = () =>
          Reflect.get(instance, "startAnalyticsMatch").call(instance, matchId, room, Date.now());
        const end = () =>
          Reflect.get(instance, "endAnalyticsMatch").call(instance, "completed", Date.now());
        if (phase === "end") start();
        const action = phase === "start" ? start : end;
        const transaction = (callback: () => void) =>
          Reflect.get(instance, "withIndexTransaction").call(instance, callback);
        expect(() =>
          transaction(() => {
            action();
            throw new Error("rollback usage events");
          }),
        ).toThrow("rollback usage events");
        const named = () =>
          events.filter((event) => "matchId" in event && event.matchId === matchId);
        const ofType = (name: string) => named().filter((event) => event.name === name);
        expect(ofType(phase === "start" ? "match_started" : "match_ended")).toHaveLength(0);
        if (phase === "start") expect(ofType("match_participant")).toHaveLength(0);
        expect(Boolean(ctx.storage.kv.get(analyticsActiveKey))).toBe(phase === "end");
        transaction(action);
        expect(ofType("match_started")).toHaveLength(1);
        expect(ofType("match_participant")).toHaveLength(1);
        if (phase === "end") {
          transaction(end);
          expect(ofType("match_ended")).toHaveLength(1);
          expect(ctx.storage.kv.get(analyticsActiveKey)).toBeUndefined();
        } else {
          expect(ctx.storage.kv.get<AnalyticsMatch>(analyticsActiveKey)?.id).toBe(matchId);
          end();
          expect(ofType("match_ended")).toHaveLength(1);
        }
      });
    } finally {
      await fixtures.dispose();
    }
  },
);

test("マッチングの開始イベントと検索情報の消去も、transactionの確定まで待つ", async () => {
  const fixtures = new RoomBoundaryFixtures();
  const events = recordUsageEvents();
  try {
    const entry = await fixtures.create({ game: "reversi", name: "本人", quickPlay: true });
    await runInDurableObject(env.GAME_ROOM.getByName(entry.room.id), (instance, ctx) => {
      const saved = ctx.storage.kv.get<Room>("room")!;
      const matchId = crypto.randomUUID(),
        operationId = crypto.randomUUID(),
        at = Date.now();
      const playerId = entry.membership.playerId;
      const reservation: import("../src/matchmaking/coordinator").MatchmakingRoomReservation = {
        matchId,
        roomId: saved.id,
        instanceId: saved.instanceId,
        preparedAtMs: at,
        expiresAtMs: at + 60_000,
        phase: "playing",
        players: [
          {
            admission: {
              accountId: "account",
              operationId: "seat-operation",
              roomId: saved.id,
              instanceId: saved.instanceId,
              playerId,
              name: "本人",
              avatarKey: null,
            },
            tokenHash: ctx.storage.kv.get<string>(`player-token:${playerId}`)!,
            version: 0,
            search: { operationId, joinedAtMs: at - 1000, isTest: false },
          },
        ],
      };
      const key = `matchmaking:${matchId}`;
      ctx.storage.kv.put(key, reservation);
      ctx.storage.kv.put(`analytics-player:${playerId}`, {
        accountId: "account",
        visitorId: null,
        isTest: false,
        isGuest: false,
      });
      const room = { ...saved, matchmaking: { id: matchId, preparedAtMs: at, rated: true } };
      const start = () =>
        Reflect.get(instance, "startAnalyticsMatch").call(instance, matchId, room, at);
      const transaction = (action: () => void) =>
        Reflect.get(instance, "withIndexTransaction").call(instance, action);
      expect(() =>
        transaction(() => {
          start();
          throw new Error("rollback");
        }),
      ).toThrow();
      const searches = () =>
        events.filter((event) => event.name === "matchmaking" && event.operationId === operationId);
      expect(searches()).toHaveLength(0);
      expect(ctx.storage.kv.get(key)).toEqual(reservation);
      transaction(start);
      expect(searches()).toEqual([expect.objectContaining({ stage: "started", rated: true })]);
      for (const name of ["match_started", "match_participant"])
        expect(
          events.filter(
            (event) => event.name === name && "matchId" in event && event.matchId === matchId,
          ),
        ).toHaveLength(1);
      const committed = ctx.storage.kv.get<typeof reservation>(key)!;
      expect(committed.players[0]!.search).toBeUndefined();
    });
  } finally {
    await fixtures.dispose();
  }
});
