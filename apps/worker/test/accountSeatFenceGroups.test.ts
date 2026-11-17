import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { beforeAll, expect, test } from "vitest";
import {
  prepare,
  type Group as MatchmakingGroup,
  type State as MatchmakingState,
} from "@tetraboard/context-matchmaking";
import {
  transfer,
  type Group as TournamentGroup,
  type State as TournamentState,
} from "@tetraboard/context-tournament";
import { matchmakingQueues } from "@tetraboard/protocol";
import { ratedMatchmakingPolicy } from "../src/adapters/matchmaking/ratedMatchmaking";
import { createMatchmakingRuntime } from "../src/adapters/matchmaking/runtime";
import { createTournamentRuntime } from "../src/adapters/tournament/runtime";
import {
  fenceDatabases,
  initializeFenceDatabase,
  fenceFixture,
  waiting,
} from "./accountSeatFenceFixtures";
import { matchmakingFenceRoom, tournamentFenceRoom } from "./accountSeatFenceRooms";

beforeAll(initializeFenceDatabase);
for (const [label, db] of fenceDatabases) {
  for (const kind of ["matchmaking", "tournament"] as const) {
    test(`${label}: ${kind}の4人中1人がフェンスに当たると全席を回収します`, async () => {
      const f = await fenceFixture(db, 5);
      const players = f.users.slice(0, 4).map((u) => u.player);
      const id = crypto.randomUUID(),
        instanceId = crypto.randomUUID();
      const roomId = String(crypto.getRandomValues(new Uint32Array(1))[0]! % 100000).padStart(
        5,
        "0",
      );
      const now = Date.now();
      const policy = ratedMatchmakingPolicy("four-reversi");
      const rules = matchmakingQueues["four-reversi"];
      for (let i = 0; i < 4; i++) {
        players[i]!.admission = { ...players[i]!.admission, roomId, instanceId };
        if (kind === "matchmaking") await f.matchmaking.join(players[i]!, rules.key, "retired");
        else await waiting(f, kind, i);
      }
      const other = kind === "matchmaking" ? "tournament" : "matchmaking";
      await waiting(f, other, 4);
      // INSERTのフェンスで通常は作れない競合をUPDATEで注入し、席の拒否と補償を検証します。
      await db
        .prepare(`UPDATE ${other}_wait_reservations SET account_id=? WHERE account_id=?`)
        .bind(players[0]!.accountId, f.users[4]!.id)
        .run();

      let preparationStatus: string | undefined;
      let insertedAccounts: string[] | undefined;
      const afterCommit = async () => {
        const rows = (
          await db
            .prepare("SELECT account_id FROM account_room_seats WHERE instance_id=?")
            .bind(instanceId)
            .all<{ account_id: string }>()
        ).results;
        insertedAccounts = rows.map((r) => r.account_id).sort();
        expect(insertedAccounts).toEqual(
          players
            .slice(1)
            .map((p) => p.accountId)
            .sort(),
        );
        // 相手の待機がここで取消されても、欠けた席を使ってルームを開始してはいけません。
        await db
          .prepare(`DELETE FROM ${other}_wait_reservations WHERE account_id=?`)
          .bind(players[0]!.accountId)
          .run();
      };
      if (kind === "matchmaking") {
        const group: MatchmakingGroup = {
          id,
          instanceId,
          roomId,
          players,
          preparedAtMs: now,
          rating: policy.select(
            players.map((p) => ({ ...p, rating: 25 })),
            0,
          )!.rating,
          expiresAtMs: now + rules.connectionGraceMs,
          phase: "preparing",
        };
        const state: MatchmakingState = {
          key: rules.key,
          waiting: [],
          groups: [group],
          nextSequence: 4,
        };
        await runInDurableObject(
          env.MATCHMAKING_COORDINATOR.getByName(crypto.randomUUID()),
          async (_instance, ctx) => {
            const r = createMatchmakingRuntime(ctx, f.env);
            r.room = matchmakingFenceRoom(f.env);
            const commit = r.store.commit.bind(r.store);
            r.store.commit = async (writes) => {
              await commit(writes);
              await afterCommit();
            };
            const room = r.room;
            r.room = (name) => {
              const target = room(name);
              return {
                ...target,
                prepareMatchmakingRoom: async (input) => {
                  const result = await target.prepareMatchmakingRoom(input);
                  preparationStatus = result.status;
                  expect(result.status).toBe("invalid");
                  return result;
                },
              };
            };
            await prepare(r, state, group);
          },
        );
        expect(state.groups).toEqual([]);
        expect(state.waiting.map((p) => p.accountId).sort()).toEqual(
          players.map((p) => p.accountId).sort(),
        );
      } else {
        await db
          .prepare(
            "UPDATE tournaments SET published=1,public_id=(SELECT COALESCE(MAX(public_id),0)+1 FROM tournaments) WHERE key=?",
          )
          .bind(f.key)
          .run();
        const group: TournamentGroup = {
          id,
          instanceId,
          roomId,
          players,
          expiresAtMs: now + 60000,
          phase: "preparing",
        };
        const state: TournamentState = { key: f.key, waiting: [], groups: [group] };
        await runInDurableObject(
          env.TOURNAMENT_COORDINATOR.getByName(crypto.randomUUID()),
          async (_instance, ctx) => {
            const r = createTournamentRuntime(ctx, f.env);
            r.room = tournamentFenceRoom(f.env);
            await r.store.ensureGroup(state, group);
            const commit = r.store.commit.bind(r.store);
            r.store.commit = async (writes) => {
              await commit(writes);
              await afterCommit();
            };
            const room = r.room;
            r.room = (name) => {
              const target = room(name);
              return {
                ...target,
                prepareTournamentRoom: async (input) => {
                  const result = await target.prepareTournamentRoom(input);
                  preparationStatus = result.status;
                  expect(result.status).toBe("invalid_reservation");
                  return result;
                },
              };
            };
            await transfer(r, state, group, (await r.read(f.key))!);
          },
        );
        expect(state.groups).toEqual([]);
        expect(state.waiting.map((p) => p.accountId).sort()).toEqual(
          players.map((p) => p.accountId).sort(),
        );
        expect(
          await db.prepare("SELECT phase FROM tournament_matches WHERE id=?").bind(id).first(),
        ).toEqual({ phase: "aborted" });
      }
      expect(preparationStatus).toBe(kind === "matchmaking" ? "invalid" : "invalid_reservation");
      expect(insertedAccounts).toEqual(
        players
          .slice(1)
          .map((p) => p.accountId)
          .sort(),
      );
      expect(
        (await db.prepare("SELECT 1 FROM skill_rating_pending WHERE match_id=?").bind(id).all())
          .results,
      ).toEqual([]);
      expect(
        (
          await db
            .prepare("SELECT 1 FROM account_room_seats WHERE instance_id=?")
            .bind(instanceId)
            .all()
        ).results,
      ).toEqual([]);
      expect(
        (
          await db
            .prepare("SELECT 1 FROM room_avatar_refs WHERE instance_id=?")
            .bind(instanceId)
            .all()
        ).results,
      ).toEqual([]);
      const reservations = (
        await db
          .prepare(
            `SELECT account_id,match_operation_id FROM ${kind}_wait_reservations WHERE account_id IN (?,?,?,?)`,
          )
          .bind(...players.map((p) => p.accountId))
          .all<{ account_id: string; match_operation_id: string | null }>()
      ).results;
      expect(reservations).toHaveLength(4);
      expect(reservations.every((r) => r.match_operation_id === null)).toBe(true);
      expect(new Set(reservations.map((r) => r.account_id)).size).toBe(4);
    });
  }
}
