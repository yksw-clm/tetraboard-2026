import { fixTestTime } from "./fixedTimeFixture";
import { expectVersionedRoom } from "./roomStateVersionAssertions";
import { roomSchema, type TournamentSettings } from "@tetraboard/protocol";
import { isTournamentGameRoom } from "@tetraboard/context-tournament";
import { pendingMatchPrefix, type PendingMatch } from "../src/adapters/record/matchStore";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect, test, vi } from "vitest";
import { tournamentRules } from "@tetraboard/protocol";
import {
  pendingShogiMatchPrefix,
  type PendingShogiMatch,
} from "../src/adapters/record/shogiMatchStore";
import {
  useTournamentRoomFixtures,
  fixture,
  connect,
  alarmAt,
  flushSaves,
} from "./tournamentRoomFixtures";

useTournamentRoomFixtures();

for (const game of ["four-reversi", "four-gomoku", "four-shogi"] as const) {
  const settings: TournamentSettings =
    game === "four-shogi"
      ? {
          game,
          mode: "singles",
          timeControl: { mainTimeMs: 180000, byoyomiMs: 10000 },
          threePlayerAttackProhibited: false,
        }
      : { game, mode: "singles", timeControl: { mainTimeMs: 180000, byoyomiMs: 10000 } };

  test(`${game}の大会で全員が接続していない開始待ちをAlarmで解除して待機を保つ`, async () => {
    const prepared = await fixture(3600000, settings);
    expect(await prepared.stub.prepareTournamentRoom(prepared.input)).toEqual({
      status: "prepared",
    });
    for (const credential of prepared.tokens.slice(0, 3))
      await connect(prepared.input.roomId, credential);
    const startsAtMs = Date.now() + tournamentRules.startCountdownMs;
    const initialRoom = await runInDurableObject(prepared.stub, async (_instance, state) => {
      const room = roomSchema.parse(state.storage.kv.get("room"));
      expect(room.status).toBe("waiting");
      expect(room).not.toHaveProperty("tournamentStartsAtMs");
      state.storage.kv.put("room", roomSchema.parse({ ...room, tournamentStartsAtMs: startsAtMs }));
      await state.storage.setAlarm(startsAtMs);
      return room;
    });

    try {
      await expect(alarmAt(prepared, startsAtMs)).resolves.toBeUndefined();

      const room = roomSchema.parse(
        await runInDurableObject(prepared.stub, (_instance, state) => state.storage.kv.get("room")),
      );
      expect(room).not.toHaveProperty("tournamentStartsAtMs");
      expect(room.status).toBe("waiting");
      expect(
        await prepared.stub.getTournamentReservationState(prepared.input.context.matchId),
      ).toMatchObject({ status: "waiting" });
    } finally {
      // Alarmが失敗しても、後片付けが同じ期限処理で失敗しないように戻します。
      await runInDurableObject(prepared.stub, (_instance, state) =>
        state.storage.kv.put("room", initialRoom),
      );
    }
  });

  test(`${game}の版2大会で設定どおり開始し、終局保存の再試行でも同じ対局へ一度だけ加点する`, async () => {
    const prepared = await fixture(3600000, settings);
    expect(await prepared.stub.prepareTournamentRoom(prepared.input)).toEqual({
      status: "prepared",
    });
    const clients = [];
    for (const credential of prepared.tokens)
      clients.push(await connect(prepared.input.roomId, credential));
    let room = roomSchema.parse(await prepared.stub.getRoom());
    if (!isTournamentGameRoom(room) || room.status !== "waiting")
      throw new Error("Missing tournament waiting room");
    expect(room.settings).toEqual(settings);
    expect(room.tournamentId).toBe(prepared.input.context.tournamentId);
    const startsAtMs = room.tournamentStartsAtMs!;
    await alarmAt(prepared, startsAtMs - 1);
    expect(
      (await prepared.stub.getTournamentReservationState(prepared.input.context.matchId)).status,
    ).toBe("waiting");
    await alarmAt(prepared, startsAtMs);
    fixTestTime(startsAtMs);
    room = roomSchema.parse(await prepared.stub.getRoom());
    expect(room.status).toBe("playing");
    expect(room).not.toHaveProperty("tournamentStartsAtMs");
    // 相手がそろった後の設定変更もサーバーで拒否します。
    clients[0]!.send({
      type: "room.time-control.set",
      timeControl: { mainTimeMs: 60000, byoyomiMs: 30000 },
    });
    expect(await clients[0]!.until((message) => message.type === "room.error")).toEqual({
      type: "room.error",
      error: "forbidden",
    });
    await env.APP_DB.exec(
      "ALTER TABLE tournament_point_events RENAME TO tournament_points_unavailable",
    );
    try {
      while (room.status === "playing" && isTournamentGameRoom(room)) {
        const turn = room.game.turn;
        const player = room.players.find((p) => ("side" in p ? p.side : p.color) === turn)!;
        const client =
          clients[prepared.input.players.findIndex((p) => p.admission.playerId === player.id)]!;
        const previous = room.eliminations.length;
        client.send({ type: "room.game.resign" });
        const message = await client.until(
          (value) =>
            value.type === "room.snapshot" &&
            ((value.room.status === "waiting" && value.room.lastRound !== null) ||
              value.room.eliminations.length > previous),
        );
        if (message.type !== "room.snapshot") throw new Error("Missing result");
        room = message.room;
      }
      await vi.waitFor(async () => {
        const retrying = await runInDurableObject(prepared.stub, (_instance, state) =>
          [
            ...state.storage.kv.list<PendingShogiMatch | PendingMatch>({
              prefix: game === "four-shogi" ? pendingShogiMatchPrefix : pendingMatchPrefix,
            }),
          ].some(([, job]) => job.retryAtMs > Date.now()),
        );
        expect(retrying).toBe(true);
      });
      expect(
        await env.APP_DB.prepare("SELECT 1 FROM matches WHERE id=?")
          .bind(prepared.input.context.matchId)
          .first(),
      ).toBeNull();
    } finally {
      await env.APP_DB.exec(
        "ALTER TABLE tournament_points_unavailable RENAME TO tournament_point_events",
      );
    }
    await flushSaves(prepared);
    const saved = await vi.waitFor(async () => {
      const value = await env.APP_DB.prepare("SELECT game,record_json FROM matches WHERE id=?")
        .bind(prepared.input.context.matchId)
        .first<{ game: string; record_json: string }>();
      if (!value) throw new Error("Match save has not completed");
      return value;
    });
    expect(saved?.game).toBe(game);
    expect(JSON.parse(saved!.record_json).settings).toEqual(settings);
    expect(JSON.parse(saved!.record_json).id).toBe(prepared.input.context.matchId);
    if (game !== "four-shogi")
      expect(JSON.parse(saved!.record_json).replay.id).toBe(prepared.input.context.matchId);
    const totals = () =>
      env.APP_DB.prepare(
        "SELECT SUM(points_units) AS points,SUM(games) AS games FROM tournament_scores WHERE tournament_key=?",
      )
        .bind(prepared.input.context.tournamentKey)
        .first();
    expect(await totals()).toEqual({ points: 84, games: 4 });
    await flushSaves(prepared);
    expect(await totals()).toEqual({ points: 84, games: 4 });
    expect(
      (
        await env.APP_DB.prepare("SELECT phase FROM tournament_matches WHERE id=?")
          .bind(prepared.input.context.matchId)
          .first()
      )?.phase,
    ).toBe("saved");
  });
}

test("大会ルームは作成時に現在の版を持ち、読み込みは移行せず、中止で版も消す", async () => {
  const prepared = await fixture();
  expect(await prepared.stub.prepareTournamentRoom(prepared.input)).toEqual({ status: "prepared" });
  await expectVersionedRoom(prepared.stub);
  expect(await prepared.stub.abortTournamentRoom(prepared.input.context.matchId)).toEqual({
    status: "cancelled",
  });
  await runInDurableObject(prepared.stub, (_, ctx) => {
    expect(ctx.storage.kv.get("room")).toBeUndefined();
    expect(ctx.storage.kv.get("room-state-version")).toBeUndefined();
  });
});
