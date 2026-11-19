import type { AccountAdmission } from "../src/flows/accountSeats/types";
import { isReversiRoom } from "@tetraboard/protocol";
import { getLegalMoves } from "@tetraboard/reversi";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, test, vi } from "vitest";
import * as seats from "../src/adapters/room/seatReservations";
import { publicMetadata } from "../src/adapters/room/metadata";
import * as indexes from "../src/adapters/room/roomIndexWrite";
import { pendingTournamentStatePrefix } from "@tetraboard/context-tournament";
import * as tournaments from "../src/adapters/tournament/state";
import { RoomBoundaryFixtures } from "./roomBoundaryFixtures";

function holdWrite(kind: "index" | "cleanup" | "tournament") {
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const wait = async () => {
    started.resolve();
    await release.promise;
  };
  if (kind === "index") {
    const original = indexes.writeRoomIndex;
    const spy = vi.spyOn(indexes, "writeRoomIndex").mockImplementationOnce(async (...args) => {
      await wait();
      await original(...args);
    });
    return { started, release, spy };
  }
  if (kind === "cleanup") {
    const original = seats.releaseReservation;
    const spy = vi.spyOn(seats, "releaseReservation").mockImplementationOnce(async (...args) => {
      await wait();
      await original(...args);
    });
    return { started, release, spy };
  }
  const original = tournaments.writeTournamentState;
  const spy = vi
    .spyOn(tournaments, "writeTournamentState")
    .mockImplementationOnce(async (...args) => {
      await wait();
      await original(...args);
    });
  return { started, release, spy };
}

test("refreshLobbyIndexは前の索引反映のAlarm待ちに保存した新しい索引もD1へ書いてから戻る", async () => {
  const fixtures = new RoomBoundaryFixtures();
  const release = Promise.withResolvers<void>();
  try {
    const entry = await fixtures.create({ game: "reversi", name: "索引の更新", quickPlay: false });
    const stub = env.GAME_ROOM.getByName(entry.room.id);
    await runInDurableObject(stub, async (instance, ctx) => {
      await Reflect.get(instance, "runtime").jobs.roomIndexJob.running;
      const db: D1Database = Reflect.get(instance, "env").APP_DB;
      const revision = ctx.storage.kv.get<number>("room-index-revision")!;
      const finishing = Promise.withResolvers<void>();
      const alarms: { afterFlush(): Promise<void> } = Reflect.get(instance, "alarmEvents");
      const afterFlush = alarms.afterFlush.bind(alarms);
      vi.spyOn(alarms, "afterFlush").mockImplementationOnce(async () => {
        await afterFlush();
        finishing.resolve();
        await release.promise;
      });
      const first = instance.refreshLobbyIndex(entry.room.instanceId, revision);
      const requests = [first];
      try {
        await finishing.promise;
        expect(ctx.storage.kv.get("room-index-pending")).toBeUndefined();
        const next = instance.refreshLobbyIndex(entry.room.instanceId, revision + 1);
        requests.push(next);
        await vi.waitFor(() =>
          expect(ctx.storage.kv.get<{ revision: number }>("room-index-pending")?.revision).toBe(
            revision + 2,
          ),
        );
        release.resolve();
        await next;
        expect(
          await db
            .prepare("SELECT revision FROM room_index WHERE room_id=?")
            .bind(entry.room.id)
            .first(),
        ).toEqual({ revision: revision + 2 });
        expect(ctx.storage.kv.get("room-index-pending")).toBeUndefined();
      } finally {
        release.resolve();
        await Promise.all(requests);
      }
    });
  } finally {
    release.resolve();
    vi.restoreAllMocks();
    await fixtures.dispose();
  }
});

async function seedD1Rows(db: D1Database, roomId: string, instanceId: string) {
  const reservation: AccountAdmission = {
    accountId: crypto.randomUUID(),
    operationId: crypto.randomUUID(),
    roomId,
    instanceId,
    playerId: crypto.randomUUID(),
    name: "解放する本人",
    avatarKey: "job-test-image",
  };
  const tournamentKey = crypto.randomUUID(),
    matchId = crypto.randomUUID();
  await db.batch([
    db
      .prepare(`INSERT INTO account_room_seats
      (account_id,operation_id,room_id,instance_id,player_id,name,avatar_key,created_at_ms)
      VALUES (?,?,?,?,?,?,?,?)`)
      .bind(
        reservation.accountId,
        reservation.operationId,
        roomId,
        instanceId,
        reservation.playerId,
        reservation.name,
        reservation.avatarKey,
        Date.now(),
      ),
    db
      .prepare("INSERT INTO room_avatar_refs VALUES (?,?,?,?,?)")
      .bind(
        reservation.operationId,
        roomId,
        instanceId,
        reservation.playerId,
        reservation.avatarKey,
      ),
    db
      .prepare(
        "INSERT INTO tournaments(key,name,created_at_ms,updated_at_ms) VALUES (?,'反映確認',?,?)",
      )
      .bind(tournamentKey, Date.now(), Date.now()),
    db
      .prepare("INSERT INTO tournament_matches VALUES(?,?,?,?,'reserved',NULL,NULL,?)")
      .bind(matchId, tournamentKey, roomId, instanceId, Date.now()),
  ]);
  const cleanup = () =>
    db.batch([
      db.prepare("DELETE FROM room_avatar_refs WHERE operation_id=?").bind(reservation.operationId),
      db
        .prepare("DELETE FROM account_room_seats WHERE operation_id=?")
        .bind(reservation.operationId),
      db.prepare("DELETE FROM tournament_matches WHERE id=?").bind(matchId),
      db.prepare("DELETE FROM tournaments WHERE key=?").bind(tournamentKey),
    ]);
  return { reservation, tournamentKey, matchId, cleanup };
}

test.each(["index", "cleanup", "tournament"] as const)(
  "%s のD1反映を保留しても、次のGETとWebSocket着手の応答・配信が完了する",
  async (kind) => {
    const fixtures = new RoomBoundaryFixtures();
    let held: ReturnType<typeof holdWrite> | undefined;
    try {
      const entry = await fixtures.create({ game: "reversi", name: "本人", quickPlay: false });
      const guest = await fixtures.join(entry.room.id, "相手");
      const host = await fixtures.connect(entry),
        other = await fixtures.connect(guest);
      for (const socket of [host, other]) socket.send({ type: "room.ready.set", ready: true });
      await host.waitFor("room.snapshot", (m) => m.room.players.every((p) => p.ready));
      host.send({ type: "room.game.start" });
      const { room } = await host.waitFor("room.snapshot", (m) => m.room.status === "playing");
      if (!isReversiRoom(room) || room.status !== "playing") throw Error("not playing");
      const stub = env.GAME_ROOM.getByName(room.id);
      const jobName =
        kind === "index"
          ? "roomIndexJob"
          : kind === "cleanup"
            ? "accountCleanupJob"
            : "tournamentStateJob";
      let pendingKey = "";
      await runInDurableObject(stub, async (instance, ctx) => {
        await Reflect.get(instance, "runtime").jobs.roomIndexJob.running;
        const db: D1Database = Reflect.get(instance, "env").APP_DB;
        const rows = await seedD1Rows(db, room.id, room.instanceId);
        held = holdWrite(kind);
        ctx.storage.transactionSync(() => {
          if (kind === "index") {
            pendingKey = "room-index-pending";
            const revision = ctx.storage.kv.get<number>("room-index-revision")! + 1;
            ctx.storage.kv.put("room-index-revision", revision);
            ctx.storage.kv.put(pendingKey, {
              revision,
              closed: false,
              retryAtMs: Date.now(),
              metadata: publicMetadata(Reflect.get(instance, "runtime"), room),
            });
          } else if (kind === "cleanup") {
            pendingKey = "account-cleanups";
            ctx.storage.kv.put(pendingKey, [
              { reservation: rows.reservation, releaseAvatar: true, retryAtMs: Date.now() },
            ]);
          } else {
            pendingKey = pendingTournamentStatePrefix + rows.matchId;
            ctx.storage.kv.put(pendingKey, {
              phase: "playing",
              retryAtMs: Date.now(),
              reservation: {
                roomId: room.id,
                instanceId: room.instanceId,
                status: "playing",
                preparedAtMs: Date.now(),
                context: {
                  matchId: rows.matchId,
                  tournamentKey: rows.tournamentKey,
                  tournamentId: 1,
                  ruleVersion: 1,
                  startsAtMs: 0,
                  endsAtMs: Date.now() + 60_000,
                },
              },
            });
          }
        });
        Reflect.get(instance, "alarmEvents").mark();
        const gets: Promise<void>[] = [];
        try {
          let completedGets = 0;
          const first = fixtures.snapshot(room.id).then(() => {
            completedGets++;
          });
          gets.push(first);
          await held!.started.promise;
          const next = fixtures.snapshot(room.id).then(() => {
            completedGets++;
          });
          gets.push(next);
          await vi.waitFor(() => expect(completedGets).toBe(2));
          const current = room.players.find((p) => p.color === room.game.turn)!;
          const sockets = ctx.getWebSockets();
          const socket = sockets.find((socket) => {
            const attachment = socket.deserializeAttachment() as { tokenHash: string };
            return attachment.tokenHash === ctx.storage.kv.get(`player-token:${current.id}`);
          })!;
          const sends = sockets.map((socket) => vi.spyOn(socket, "send"));
          await instance.webSocketMessage(
            socket,
            JSON.stringify({
              type: "room.game.action",
              roundId: room.roundId,
              positionRevision: room.positionRevision,
              action: { type: "placeStone", position: getLegalMoves(room.game)[0]! },
            }),
          );
          for (const send of sends)
            expect(
              send.mock.calls.some(([message]) => {
                const value = JSON.parse(String(message));
                return value.type === "room.snapshot" && value.room.game.moveNumber === 1;
              }),
            ).toBe(true);
          expect(held!.spy).toHaveBeenCalledTimes(1);
          held!.release.resolve();
          await Promise.all([first, next]);
          await Reflect.get(instance, "runtime").jobs[jobName].running;
          const pending = ctx.storage.kv.get(pendingKey);
          expect(kind === "cleanup" ? pending : pending === undefined).toEqual(
            kind === "cleanup" ? [] : true,
          );
          if (kind === "index") {
            const indexed = await db
              .prepare("SELECT revision FROM room_index WHERE room_id=?")
              .bind(room.id)
              .first<{ revision: number }>();
            expect(indexed?.revision).toBe(ctx.storage.kv.get("room-index-revision"));
          } else if (kind === "cleanup") {
            expect(
              await db
                .prepare("SELECT 1 FROM account_room_seats WHERE operation_id=?")
                .bind(rows.reservation.operationId)
                .first(),
            ).toBeNull();
            expect(
              await db
                .prepare("SELECT 1 FROM room_avatar_refs WHERE operation_id=?")
                .bind(rows.reservation.operationId)
                .first(),
            ).toBeNull();
          } else {
            expect(
              await db
                .prepare("SELECT phase FROM tournament_matches WHERE id=?")
                .bind(rows.matchId)
                .first(),
            ).toEqual({ phase: "playing" });
          }
          // 着手による新しい索引の版は別に反映し、保留した同じジョブは再実行しません。
          const firstCall = held!.spy.mock.calls[0]!;
          expect(
            held!.spy.mock.calls.filter(
              (call) => JSON.stringify(call[1]) === JSON.stringify(firstCall[1]),
            ),
          ).toHaveLength(1);
        } finally {
          held!.release.resolve();
          await Promise.all(gets);
          await Reflect.get(instance, "runtime").jobs[jobName].running;
          await rows.cleanup();
        }
      });
    } finally {
      held?.release.resolve();
      vi.restoreAllMocks();
      await fixtures.dispose();
    }
  },
);
