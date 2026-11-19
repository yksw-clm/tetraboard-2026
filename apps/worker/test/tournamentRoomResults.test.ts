import { fixTestTime } from "./fixedTimeFixture";
import { writeTournamentState } from "../src/adapters/tournament/state";
import { env } from "cloudflare:workers";
import { runInDurableObject, applyD1Migrations } from "cloudflare:test";
import { expect, test, vi } from "vitest";
import {
  fourShogiRoomSchema,
  isFourShogiRoom,
  tournamentControllerResponseSchema,
} from "@tetraboard/protocol";
import { accountFixture } from "./accountFixtures";
import {
  pendingShogiMatchPrefix,
  type PendingShogiMatch,
  readShogiMatchRecord,
} from "../src/rooms/shogiMatchStore";
import { processDeletions } from "../src/flows/accountPurge/processDeletions";
import { requestDeletion } from "../src/flows/accountPurge/requestDeletion";
import {
  useTournamentRoomFixtures,
  request,
  fixture,
  playing,
  flushSaves,
} from "./tournamentRoomFixtures";

useTournamentRoomFixtures();

test("終局保存と大会得点を一括確定し、保存再送・閉鎖後も同局を二重加算しない", async () => {
  const prepared = await playing();
  fixTestTime(prepared.startsAtMs);
  await env.APP_DB.exec(
    "ALTER TABLE tournament_point_events RENAME TO tournament_points_unavailable",
  );
  let room = fourShogiRoomSchema.parse(await prepared.stub.getRoom());
  try {
    while (room.status === "playing") {
      const turn = room.game.turn;
      const player = room.players.find((candidate) => candidate.side === turn)!;
      const client =
        prepared.clients[
          prepared.input.players.findIndex((seat) => seat.admission.playerId === player.id)
        ]!;
      client.send({ type: "room.game.resign" });
      const previous = room.positionRevision;
      const message = await client.until(
        (value) =>
          value.type === "room.snapshot" &&
          isFourShogiRoom(value.room) &&
          ((value.room.status === "waiting" &&
            value.room.lastRound?.roundId === prepared.input.context.matchId) ||
            (value.room.status === "playing" &&
              "positionRevision" in value.room &&
              value.room.positionRevision > previous)),
      );
      if (message.type !== "room.snapshot") throw new Error("Missing room");
      room = fourShogiRoomSchema.parse(message.room);
    }
    await vi.waitFor(async () => {
      const jobs = await runInDurableObject(prepared.stub, (_instance, state) =>
        [...state.storage.kv.list<PendingShogiMatch>({ prefix: pendingShogiMatchPrefix })].map(
          ([, job]) => job,
        ),
      );
      expect(jobs.some((job) => job.retryAtMs > Date.now())).toBe(true);
    });
    expect(
      await env.APP_DB.prepare("SELECT 1 FROM matches WHERE id=?")
        .bind(prepared.input.context.matchId)
        .first(),
    ).toBeNull();
    expect(
      await env.APP_DB.prepare("SELECT COUNT(*) AS n FROM account_match_history WHERE match_id=?")
        .bind(prepared.input.context.matchId)
        .first(),
    ).toEqual({ n: 0 });
  } finally {
    await env.APP_DB.exec(
      "ALTER TABLE tournament_points_unavailable RENAME TO tournament_point_events",
    );
  }
  await flushSaves(prepared);
  let saved: { record_json: string } | null = null;
  await vi.waitFor(async () => {
    saved = await env.APP_DB.prepare("SELECT record_json FROM matches WHERE id=?")
      .bind(prepared.input.context.matchId)
      .first<{ record_json: string }>();
    expect(saved).not.toBeNull();
  });
  expect(readShogiMatchRecord(saved!.record_json).id).toBe(prepared.input.context.matchId);
  for (const phase of ["playing", "saving"] as const) {
    await writeTournamentState(env.APP_DB, {
      reservation: {
        context: prepared.input.context,
        roomId: prepared.input.roomId,
        instanceId: prepared.input.instanceId,
        status: "playing",
        preparedAtMs: Date.now(),
        startedAtMs: readShogiMatchRecord(saved!.record_json).startedAtMs,
      },
      phase,
      retryAtMs: Date.now(),
    });
  }
  expect(
    await env.APP_DB.prepare("SELECT phase FROM tournament_matches WHERE id=?")
      .bind(prepared.input.context.matchId)
      .first(),
  ).toEqual({ phase: "saved" });
  expect(
    await env.APP_DB.prepare(
      "SELECT COUNT(*) AS n,SUM(points_units) AS points FROM tournament_point_events WHERE match_id=?",
    )
      .bind(prepared.input.context.matchId)
      .first(),
  ).toEqual({ n: 4, points: 84 });
  prepared.coordinator = env.TOURNAMENT_COORDINATOR.getByName(prepared.input.context.tournamentKey);
  const entryIds = (
    await env.APP_DB.prepare("SELECT id,account_id FROM tournament_entries WHERE tournament_key=?")
      .bind(prepared.input.context.tournamentKey)
      .all<{ id: string; account_id: string }>()
  ).results;
  await runInDurableObject(prepared.coordinator, (_instance, state) => {
    state.storage.kv.put("state", {
      key: prepared.input.context.tournamentKey,
      waiting: [],
      groups: [
        {
          id: prepared.input.context.matchId,
          roomId: prepared.input.roomId,
          instanceId: prepared.input.instanceId,
          phase: "playing",
          expiresAtMs: Date.now() + 30000,
          players: prepared.input.players.map((player) => ({
            accountId: player.admission.accountId,
            operationId: player.admission.operationId,
            tokenHash: player.tokenHash,
            expiresAtMs: Date.now() + 30000,
            controllerId: crypto.randomUUID(),
            controllerVersion: 1,
            entryId: entryIds.find((entry) => entry.account_id === player.admission.accountId)!.id,
            admission: player.admission,
          })),
        },
      ],
    });
  });
  const recoveredResponse = await request(
    `/api/tournaments/${prepared.input.context.tournamentId}/controller`,
    {
      method: "POST",
      headers: prepared.accounts[0]!.headers,
      body: JSON.stringify({
        operationId: prepared.input.players[0]!.admission.operationId,
        controllerId: crypto.randomUUID(),
        takeover: true,
        expectedControllerVersion: 1,
      }),
    },
  );
  expect(recoveredResponse.status).toBe(200);
  const recovered = tournamentControllerResponseSchema.parse(await recoveredResponse.json());
  expect(recovered.participation.status).toBe("playing");
  expect(
    (
      await request(`/api/rooms/${room.id}/me`, {
        headers: { Authorization: `Bearer ${recovered.token}` },
      })
    ).status,
  ).toBe(200);
  prepared.tokens[0] = recovered.token;
  prepared.input.players[0]!.tokenHash = Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(recovered.token)),
    ),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  prepared.clients[1].send({ type: "room.game.start" });
  expect(await prepared.clients[1].until((message) => message.type === "room.error")).toEqual({
    type: "room.error",
    error: "forbidden",
  });
  for (const credential of prepared.tokens)
    expect(
      (
        await request(`/api/rooms/${room.id}/leave`, {
          method: "POST",
          headers: { Authorization: `Bearer ${credential}` },
        })
      ).status,
    ).toBe(204);
  expect(
    await env.APP_DB.prepare("SELECT COUNT(*) AS n FROM account_room_seats WHERE instance_id=?")
      .bind(prepared.input.instanceId)
      .first(),
  ).toEqual({ n: 0 });
  await flushSaves(prepared);
  expect(
    await env.APP_DB.prepare("SELECT COUNT(*) AS n FROM tournament_point_events WHERE match_id=?")
      .bind(prepared.input.context.matchId)
      .first(),
  ).toEqual({ n: 4 });
});

test("大会待機中の通常ルーム作成をaccount_busyで拒否し、退会は待機を削除して確定順位を匿名化する", async () => {
  const prepared = await fixture();
  const account = await accountFixture();
  const entryId = crypto.randomUUID();
  await env.APP_DB.batch([
    env.APP_DB.prepare("INSERT INTO tournament_entries VALUES(?,?,?,?,0)").bind(
      entryId,
      prepared.input.context.tournamentKey,
      account.id,
      Date.now(),
    ),
    env.APP_DB.prepare("INSERT INTO tournament_wait_reservations VALUES(?,?,?,?,NULL)").bind(
      account.id,
      prepared.input.context.tournamentKey,
      crypto.randomUUID(),
      Date.now() + 30_000,
    ),
    env.APP_DB.prepare(
      "INSERT INTO tournament_scores(entry_id,tournament_key,points_units,games,first,final_rank) VALUES(?,?,48,1,1,1)",
    ).bind(entryId, prepared.input.context.tournamentKey),
  ]);
  const result = await request("/api/rooms", {
    method: "POST",
    headers: { ...account.headers, "Content-Type": "application/json" },
    body: JSON.stringify({ game: "four-shogi", quickPlay: false, mode: "singles" }),
  });
  expect(result.status).toBe(409);
  expect(await result.json()).toEqual({ error: "account_busy" });
  const expired = await accountFixture();
  await env.APP_DB.prepare("INSERT INTO tournament_wait_reservations VALUES(?,?,?,?,NULL)")
    .bind(expired.id, prepared.input.context.tournamentKey, crypto.randomUUID(), Date.now() - 1)
    .run();
  const admitted = await request("/api/rooms", {
    method: "POST",
    headers: { ...expired.headers, "Content-Type": "application/json" },
    body: JSON.stringify({ game: "four-shogi", quickPlay: false, mode: "singles" }),
  });
  expect(admitted.status).toBe(201);
  const ordinary = (await admitted.json()) as {
    room: { id: string };
    membership: { token: string };
  };
  await request(`/api/rooms/${ordinary.room.id}/leave`, {
    method: "POST",
    headers: { Authorization: `Bearer ${ordinary.membership.token}` },
  });
  expect(
    await env.APP_DB.prepare("SELECT 1 FROM tournament_wait_reservations WHERE account_id=?")
      .bind(expired.id)
      .first(),
  ).toBeNull();
  await env.APP_DB.prepare("DELETE FROM tournament_wait_reservations WHERE account_id=?")
    .bind(account.id)
    .run();
  const deletionDb = (env as unknown as { TOURNAMENT_PRIVACY_TEST_DB: D1Database })
    .TOURNAMENT_PRIVACY_TEST_DB;
  const migrations = (
    env as unknown as { TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1] }
  ).TEST_MIGRATIONS;
  await applyD1Migrations(deletionDb, migrations);
  const deleting = await accountFixture(true, crypto.randomUUID(), deletionDb);
  const deletingKey = crypto.randomUUID();
  const deletingEntry = crypto.randomUUID();
  await deletionDb.batch([
    deletionDb
      .prepare(
        "INSERT INTO tournaments(key,name,created_at_ms,updated_at_ms) VALUES(?,'退会対象大会',?,?)",
      )
      .bind(deletingKey, Date.now(), Date.now()),
    deletionDb
      .prepare("INSERT INTO tournament_entries VALUES(?,?,?,?,0)")
      .bind(deletingEntry, deletingKey, deleting.id, Date.now()),
    deletionDb
      .prepare("INSERT INTO tournament_wait_reservations VALUES(?,?,?,?,NULL)")
      .bind(deleting.id, deletingKey, crypto.randomUUID(), Date.now() + 30_000),
    deletionDb
      .prepare(
        "INSERT INTO tournament_scores(entry_id,tournament_key,points_units,games,first,final_rank) VALUES(?,?,48,1,1,1)",
      )
      .bind(deletingEntry, deletingKey),
  ]);
  const deletionEnv = { ...env, APP_DB: deletionDb };
  expect(await requestDeletion(deletionEnv, deleting.id, crypto.randomUUID())).toBe(true);
  expect(
    await deletionDb
      .prepare("SELECT deleted FROM tournament_entries WHERE id=?")
      .bind(deletingEntry)
      .first(),
  ).toEqual({ deleted: 1 });
  expect(
    await deletionDb
      .prepare("SELECT 1 FROM tournament_wait_reservations WHERE account_id=?")
      .bind(deleting.id)
      .first(),
  ).toBeNull();
  await processDeletions(deletionEnv);
  expect(
    await deletionDb
      .prepare("SELECT account_id,deleted FROM tournament_entries WHERE id=?")
      .bind(deletingEntry)
      .first(),
  ).toEqual({ account_id: null, deleted: 1 });
  expect(
    await deletionDb
      .prepare("SELECT final_rank,points_units FROM tournament_scores WHERE entry_id=?")
      .bind(deletingEntry)
      .first(),
  ).toEqual({ final_rank: 1, points_units: 48 });
});
