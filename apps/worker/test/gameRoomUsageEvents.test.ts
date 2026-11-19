import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { expect, test, vi } from "vitest";
import { recordUsageEvents } from "./usageEventsRecorder";
import {
  registerGameRoomFixtures,
  startFourPlayerRoom,
  getRoom,
  fourPlayers,
  readyPlayers,
} from "./gameRoomFixtures";

registerGameRoomFixtures();

test("再起動時に旧計測の保存待ちだけを消し、進行中の対局と資格を保持する", async () => {
  const setup = await startFourPlayerRoom();
  const stub = env.GAME_ROOM.getByName(setup.id);
  const before = await runInDurableObject(stub, (_, state) => {
    state.storage.kv.delete("legacy-analytics-purged");
    const saved = [...state.storage.kv.list()];
    state.storage.kv.put("analytics-pending:first", { id: "old-match" });
    state.storage.kv.put("analytics-pending:second", { id: "other-match" });
    state.storage.kv.put("analytics-player-aliases", { old: "new" });
    return saved;
  });
  await evictDurableObject(stub);
  await stub.getShareMetadata(setup.room.instanceId);
  await runInDurableObject(stub, (_, state) => {
    expect([...state.storage.kv.list({ prefix: "analytics-pending:" })]).toEqual([]);
    expect(state.storage.kv.get("analytics-player-aliases")).toBeUndefined();
    expect(state.storage.kv.get("legacy-analytics-purged")).toBe(true);
    expect(
      [...state.storage.kv.list()].filter(([key]) => key !== "legacy-analytics-purged"),
    ).toEqual(before);
  });
  await evictDurableObject(stub);
  expect(await stub.getRoom()).toMatchObject({
    status: "playing",
    instanceId: setup.room.instanceId,
  });
});

test.each([false, true])(
  "Usage Events は対局の開始から完了までを記録し、書き込み失敗=%sでも続行する",
  async (fail) => {
    const events = recordUsageEvents(fail);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const setup = await startFourPlayerRoom();
    const active = await runInDurableObject(env.GAME_ROOM.getByName(setup.id), (_, state) =>
      state.storage.kv.get<import("../src/usageEvents/matches").AnalyticsMatch>("analytics-active"),
    );
    const matchId = active!.id;
    expect(events.filter((e) => e.name === "match_started" && e.matchId === matchId)).toEqual([
      {
        name: "match_started",
        game: "four-reversi",
        matchId,
        isTest: false,
        mode: "singles",
        matchKind: "normal",
        humans: 4,
        cpus: 0,
      },
    ]);
    expect(
      events.filter((e) => e.name === "match_participant" && e.matchId === matchId),
    ).toHaveLength(4);
    for (const participant of active!.participants)
      expect(
        events.filter((e) => e.name === "match_participant" && e.matchId === matchId),
      ).toContainEqual({
        name: "match_participant",
        game: "four-reversi",
        matchId,
        isTest: participant.isTest,
        browserId: participant.visitorId,
        accountId: participant.accountId,
        isGuest: participant.isGuest ?? false,
      });
    for (const color of ["black", "white", "red"]) {
      const index = setup.room.players.findIndex((p) => p.color === color);
      setup.connections[index].send({ type: "room.game.resign" });
      await setup.connections[0].nextSnapshotWhere((room) =>
        color === "red"
          ? room.status === "waiting"
          : room.status === "playing" &&
            room.game.eliminatedColors.includes(color as "black" | "white"),
      );
    }
    expect(events.filter((e) => e.name === "match_ended" && e.matchId === matchId)).toEqual([
      {
        name: "match_ended",
        game: "four-reversi",
        matchId,
        isTest: false,
        result: "completed",
        reason: "last_player",
        durationMs: expect.any(Number),
      },
    ]);
    expect(await getRoom(setup.id)).toMatchObject({ status: "waiting" });
    if (fail) expect(warn).toHaveBeenCalledWith("Usage event write failed");
  },
);

test.each([false, true])(
  "Usage Events は席ごとの識別情報を維持し、旧集計と同じ条件で対局をテスト扱いにする（全員テスト=%s）",
  async (allTest) => {
    const events = recordUsageEvents();
    const setup = await fourPlayers();
    const browserIds = setup.participants.map(() => crypto.randomUUID());
    await runInDurableObject(env.GAME_ROOM.getByName(setup.id), (_, state) => {
      for (const [index, participant] of setup.participants.entries()) {
        const key = `analytics-player:${participant.playerId}`;
        const identity =
          state.storage.kv.get<import("../src/usageEvents/matches").AnalyticsIdentity>(key);
        state.storage.kv.put(key, {
          ...identity,
          visitorId: browserIds[index],
          isTest: allTest || index === 0,
        });
      }
    });
    await readyPlayers(setup.id, setup.connections);
    setup.connections[0].send({ type: "room.game.start" });
    await setup.connections[0].nextSnapshotWhere((room) => room.status === "playing");
    const active = await runInDurableObject(env.GAME_ROOM.getByName(setup.id), (_, state) =>
      state.storage.kv.get<import("../src/usageEvents/matches").AnalyticsMatch>("analytics-active"),
    );
    const matchId = active!.id;
    const participants = events.filter(
      (e) => e.name === "match_participant" && e.matchId === matchId,
    );
    expect(participants).toHaveLength(browserIds.length);
    for (const [index, browserId] of browserIds.entries())
      expect(participants).toContainEqual(
        expect.objectContaining({ browserId, isTest: allTest || index === 0 }),
      );
    expect(events.filter((e) => e.name === "match_started" && e.matchId === matchId)).toEqual([
      expect.objectContaining({ name: "match_started", isTest: allTest }),
    ]);
  },
);
