import { isReversiRoom, isShogiRoom } from "@tetraboard/protocol";
import { gameProgress } from "../src/adapters/room/games/gameProgress";
import { pendingMatchPrefix } from "../src/adapters/record/matchStore";
import { pendingShogiMatchPrefix } from "../src/adapters/record/shogiMatchStore";
import type { AccountAdmission } from "../src/flows/accountSeats/types";
import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { expect, test, vi } from "vitest";
import { roomMembershipSchema, isFourShogiRoom, type GameId } from "@tetraboard/protocol";
import {
  registerRoomDeadlineBoundaryFixtures,
  start,
  snapshot,
  connect,
  roomSchema,
} from "./roomDeadlineBoundaryFixtures";

registerRoomDeadlineBoundaryFixtures();

for (const game of ["four-reversi", "four-shogi"] satisfies GameId[]) {
  test(`${game}: hibernation後も進行局・時計・資格・認証済み配信を保持する`, async () => {
    const prepared = await start(game);
    await evictDurableObject(prepared.stub, { webSockets: "hibernate" });
    const restored = await snapshot(prepared.room.id);
    expect(restored.room).toEqual(prepared.room);
    expect(restored.presence.connectedPlayerIds.toSorted()).toEqual(
      prepared.members.map((entry) => entry.membership.playerId).toSorted(),
    );
    // 再認証を送らず既存ソケットで投了し、復元したattachmentと全接続への配信を検証。
    const playing = prepared.room;
    const currentPlayer = isFourShogiRoom(playing)
      ? playing.players.find((player) => player.side === playing.game.turn)
      : playing.players.find((player) => player.color === playing.game.turn);
    const index = prepared.members.findIndex(
      (entry) => entry.membership.playerId === currentPlayer?.id,
    );
    if (index < 0) throw new Error("Missing current player");
    prepared.clients[index].send({ type: "room.game.resign" });
    for (const client of prepared.clients) {
      const { room } = await client.waitFor(
        "room.snapshot",
        (message) =>
          message.room.status === "playing" &&
          !isShogiRoom(message.room) &&
          (isFourShogiRoom(message.room)
            ? message.room.positionRevision === 1
            : message.room.game.eliminatedColors.length === 1),
      );
      expect(room.players.map((player) => player.id)).toEqual(
        prepared.room.players.map((player) => player.id),
      );
    }
  });

  test(`${game}: 接続を閉じるDO再生成は復帰期限を付け、同じ資格で同じ席へ戻す`, async () => {
    const prepared = await start(game);
    await evictDurableObject(prepared.stub, { webSockets: "close" });
    const disconnected = await snapshot(prepared.room.id);
    expect(disconnected.presence.connectedPlayerIds).toEqual([]);
    for (const player of disconnected.room.players)
      expect(player.reconnectDeadline).toBeTypeOf("number");
    expect(disconnected.room.game).toEqual(prepared.room.game);
    expect(disconnected.room.clock).toEqual(prepared.room.clock);
    await connect(prepared.members[0]);
    const restored = await snapshot(prepared.room.id);
    expect(restored.room.players[0]).toEqual({
      ...prepared.room.players[0],
      reconnectDeadline: null,
    });
    expect(restored.room.players).toHaveLength(4);
    expect(restored.presence.connectedPlayerIds).toEqual([prepared.members[0].membership.playerId]);
    expect(restored.room.game).toEqual(prepared.room.game);
    expect(restored.room.clock).toEqual(prepared.room.clock);
  });

  test(`${game}: 遅延AlarmとDO復元を繰り返しても終局・保存・本人索引・計測を重複させない`, async () => {
    const prepared = await start(game);
    const roundId = await runInDurableObject(prepared.stub, (_instance, state) => {
      const room = roomSchema.parse(state.storage.kv.get("room"));
      if (room.status !== "playing") throw new Error("Not playing");
      const deadline = Date.now() - 90_001;
      // 全席の基本時間を消費済みとし、保存された期限から3人分を連続処理。
      const remainingMainMs = isFourShogiRoom(room)
        ? { south: 0, west: 0, north: 0, east: 0 }
        : { black: 0, white: 0, red: 0, blue: 0 };
      state.storage.kv.put(
        "room",
        roomSchema.parse({
          ...room,
          clock: { remainingMainMs, turnStartedAt: deadline - 30_000, turnExpiresAt: deadline },
        }),
      );
      const active = state.storage.kv.get<{ id: string }>("match-start");
      if (!isFourShogiRoom(room) && !active) throw new Error("Missing match");
      return isFourShogiRoom(room) ? room.roundId : active?.id;
    });
    if (!roundId) throw new Error("Missing round ID");
    await evictDurableObject(prepared.stub, { webSockets: "hibernate" });
    expect(await runDurableObjectAlarm(prepared.stub)).toBe(true);
    const finished = (await snapshot(prepared.room.id)).room;
    expect(finished.status).toBe("waiting");
    expect(finished.clock).toBeNull();
    if (!finished.lastRound) throw new Error("Missing last round");
    if (isFourShogiRoom(finished)) {
      expect(
        finished.lastRound.game.eliminations.map(({ side, reason }) => ({ side, reason })),
      ).toEqual([
        { side: "south", reason: "timeout" },
        { side: "west", reason: "timeout" },
        { side: "north", reason: "timeout" },
      ]);
    } else expect(finished.lastRound.game.eliminatedColors).toEqual(["black", "white", "red"]);
    const persisted = async () => {
      const match = await env.APP_DB.prepare("SELECT record_json FROM matches WHERE id = ?")
        .bind(roundId)
        .first<{ record_json: string }>();
      expect(match).not.toBeNull();
      expect(
        await env.APP_DB.prepare(
          "SELECT COUNT(*) AS n FROM account_match_history WHERE match_id = ?",
        )
          .bind(roundId)
          .first(),
      ).toEqual({ n: 4 });
      return match;
    };
    await vi.waitFor(persisted);
    const record = await persisted();
    for (let index = 0; index < 2; index++) {
      await evictDurableObject(prepared.stub, { webSockets: "hibernate" });
      expect(await runDurableObjectAlarm(prepared.stub)).toBe(true);
      expect((await snapshot(prepared.room.id)).room).toEqual(finished);
      expect(await persisted()).toEqual(record);
      await runInDurableObject(prepared.stub, (_instance, state) => {
        expect(Array.from(state.storage.kv.list({ prefix: "match-pending:" })).length).toBe(0);
        expect(Array.from(state.storage.kv.list({ prefix: "shogi-match-pending:" })).length).toBe(
          0,
        );
      });
    }
  });
}

for (const game of ["four-reversi", "four-shogi"] satisfies GameId[]) {
  test(`${game}: 抽出した進行・終局のKVとSQLite更新はtransaction例外で全て戻る`, async () => {
    const prepared = await start(game);
    await runInDurableObject(prepared.stub, (_instance, state) => {
      const capture = () => ({
        kv: [...state.storage.kv.list()],
        sql:
          game === "four-shogi"
            ? {
                repetitions: state.storage.sql
                  .exec("SELECT * FROM shogi_repetitions ORDER BY round_id, position_key")
                  .toArray(),
                rounds: state.storage.sql
                  .exec("SELECT * FROM shogi_rounds ORDER BY round_id")
                  .toArray(),
                events: state.storage.sql
                  .exec("SELECT * FROM shogi_events ORDER BY round_id, event_index")
                  .toArray(),
                archives: state.storage.sql
                  .exec("SELECT * FROM shogi_archives ORDER BY round_id")
                  .toArray(),
              }
            : null,
      });
      const before = capture();
      const dependencies = {
        storage: state.storage,
        membership: (hash: string) => {
          const value = state.storage.kv.get(`membership:${hash}`);
          return value === undefined ? null : roomMembershipSchema.parse(value);
        },
        accountId: (playerId: string) =>
          state.storage.kv.get<AccountAdmission>(`seat-account:${playerId}`)?.accountId ?? null,
      };
      expect(() =>
        state.storage.transactionSync(() => {
          let room = roomSchema.parse(state.storage.kv.get("room"));
          if (isReversiRoom(room) || isShogiRoom(room))
            throw Error("Expected existing game fixture");
          if (isFourShogiRoom(room)) {
            const progress = gameProgress["four-shogi"].create(dependencies);
            for (let count = 0; count < 3; count++) {
              if (room.status !== "playing") throw new Error("Expected playing room");
              const turn = room.game.turn;
              const player = room.players.find((entry) => entry.side === turn);
              if (!player) throw new Error("Missing player");
              const result = progress.eliminate(room, player.id, "timeout", Date.now());
              if (result.kind === "finished") {
                const lastRound = progress.finalize(result);
                expect(
                  state.storage.kv.get(pendingShogiMatchPrefix + result.room.roundId),
                ).toBeDefined();
                expect(progress.store().eventCount(result.room.roundId)).toBe(3);
                expect(
                  state.storage.sql.exec("SELECT * FROM shogi_archives").toArray(),
                ).toHaveLength(1);
                state.storage.kv.put(
                  "room",
                  progress.waiting({ ...result, lastRound }, result.room.players),
                );
              } else if (result.kind === "playing") {
                room = result.room;
                state.storage.kv.put("room", room);
              } else throw new Error("Unexpected transition");
            }
          } else {
            const progress = gameProgress["four-reversi"].create(dependencies);
            for (let count = 0; count < 3; count++) {
              if (room.status !== "playing") throw new Error("Expected playing room");
              const turn = room.game.turn;
              const player = room.players.find((entry) => entry.color === turn);
              if (!player) throw new Error("Missing player");
              const result = progress.eliminate(room, player.id, "timeout", Date.now());
              if (result.kind === "finished") {
                const lastRound = progress.finalize(result);
                expect(lastRound.replay?.steps).toHaveLength(3);
                expect([...state.storage.kv.list({ prefix: pendingMatchPrefix })]).toHaveLength(1);
                state.storage.kv.put(
                  "room",
                  progress.waiting({ ...result, lastRound }, result.room.players),
                );
              } else if (result.kind === "playing") {
                room = result.room;
                state.storage.kv.put("room", room);
              } else throw new Error("Unexpected transition");
            }
          }
          throw new Error("Rollback game transition");
        }),
      ).toThrow("Rollback game transition");
      expect(capture()).toEqual(before);
    });
    expect((await snapshot(prepared.room.id)).room).toEqual(prepared.room);
  });
}
