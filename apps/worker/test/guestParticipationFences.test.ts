import { env } from "cloudflare:workers";
import { expect, test } from "vitest";
import type { StoredProfile } from "../src/accounts/auth";
import { preparePlayerWrites } from "../src/adapters/matchmaking/seatWrites";
import type { Group } from "@tetraboard/context-matchmaking";
import { D1TournamentEntries } from "../src/adapters/tournament/entries";
import { D1TournamentQueueStore } from "../src/adapters/tournament/queue";
import { reserveAccountSeat } from "../src/flows/accountSeats/reserve";
import {
  guestFenceDatabases,
  guestFenceFixture,
  tournamentFixture,
  withBatchInterleaving,
} from "./guestFenceFixtures";

async function mergedGuest(db: D1Database) {
  const { guest, target } = await guestFenceFixture(db);
  const key = await tournamentFixture(db);
  const entryId = crypto.randomUUID();
  await db.batch([
    db.prepare("INSERT INTO tournament_entries VALUES(?,?,?,?,0)").bind(entryId, key, guest.id, 1),
    db
      .prepare("INSERT INTO guest_account_merges VALUES(?,?,?)")
      .bind(guest.id, target.id, Date.now()),
  ]);
  const profile = (await db
    .prepare("SELECT * FROM user WHERE id=?")
    .bind(guest.id)
    .first<StoredProfile>())!;
  const admission = {
    accountId: guest.id,
    operationId: crypto.randomUUID(),
    roomId: "12345",
    instanceId: crypto.randomUUID(),
    playerId: crypto.randomUUID(),
    name: profile.name,
    avatarKey: profile.avatarKey,
    avatarPresetId: profile.avatarPresetId ?? null,
  };
  const player = {
    accountId: guest.id,
    operationId: crypto.randomUUID(),
    tokenHash: "hash",
    controllerId: crypto.randomUUID(),
    version: 0,
    expiresAtMs: 1,
    joinedAtMs: 1,
    sequence: 0,
    entryId,
    admission,
  };
  return { guest, target, key, player, profile };
}

type Queue = "matchmaking" | "tournament";
async function staleWait(db: D1Database, f: Awaited<ReturnType<typeof mergedGuest>>, kind: Queue) {
  // 統合後に残った待機を UPDATE で作り、席の付け替え開始時点の競合を再現します。
  const key = kind === "matchmaking" ? "rated-test" : f.key;
  const table = `${kind}_wait_reservations`;
  await db.batch([
    db
      .prepare(`INSERT INTO ${table} VALUES(?,?,?,?,NULL)`)
      .bind(f.target.id, key, f.player.operationId, f.player.expiresAtMs),
    db.prepare(`UPDATE ${table} SET account_id=? WHERE account_id=?`).bind(f.guest.id, f.target.id),
  ]);
  return () => db.prepare(`SELECT * FROM ${table} WHERE account_id=?`).bind(f.guest.id).first();
}

for (const [index, { db, mode }] of guestFenceDatabases.entries()) {
  test(`${mode}のguest_merged_entry_fenceは成立済みの行を変更せず新規エントリーを拒否します`, async () => {
    const { guest, key } = await mergedGuest(db);
    const otherKey = await tournamentFixture(db);
    const id = crypto.randomUUID();
    const store = new D1TournamentEntries(db);
    if (index === 0) {
      await expect(
        db
          .prepare("INSERT OR IGNORE INTO tournament_entries VALUES(?,?,?,?,0)")
          .bind(id, otherKey, guest.id, 1)
          .run(),
      ).rejects.toThrow("guest_merged");
    }
    await expect(store.insert(otherKey, guest.id, id, 1)).rejects.toThrow("guest_merged");
    expect(await store.eligible(guest.id, otherKey)).toBeNull();
    expect(await store.eligible(guest.id, key)).toBeTruthy();
  });

  test(`${mode}のguest_merged_seat_fenceは通常席を拒否し期限切れ待機の削除も取り消します`, async () => {
    const f = await mergedGuest(db);
    const { guest, player, profile } = f;
    const wait = await staleWait(db, f, "matchmaking");
    const before = await wait();
    if (index === 0) {
      const a = player.admission;
      await expect(
        db
          .prepare(`INSERT OR IGNORE INTO account_room_seats
        (account_id,operation_id,room_id,instance_id,player_id,name,created_at_ms)
        VALUES(?,?,?,?,?,'登録名',1)`)
          .bind(guest.id, a.operationId, a.roomId, a.instanceId, a.playerId)
          .run(),
      ).rejects.toThrow("guest_merged");
    }
    await expect(
      reserveAccountSeat(
        new Request(env.APP_ORIGIN),
        { ...env, APP_DB: db },
        profile,
        { id: player.admission.roomId, instanceId: player.admission.instanceId },
        player.admission.playerId,
      ),
    ).rejects.toThrow("guest_merged");
    expect(await wait()).toEqual(before);
    expect(
      await db
        .prepare("SELECT 1 FROM account_room_seats WHERE account_id=?")
        .bind(guest.id)
        .first(),
    ).toBeNull();
  });

  for (const kind of ["matchmaking", "tournament"] as const) {
    test(`${mode}のguest_merged_seat_fenceは${kind}の席確定と待機の変更を取り消します`, async () => {
      const f = await mergedGuest(db);
      const { player, profile } = f;
      const wait = await staleWait(db, f, kind);
      const before = await wait();
      const group: Group = {
        id: crypto.randomUUID(),
        roomId: player.admission.roomId,
        instanceId: player.admission.instanceId,
        players: [player],
        preparedAtMs: 1,
        expiresAtMs: 1,
        phase: "preparing",
      };
      const writes =
        kind === "matchmaking"
          ? preparePlayerWrites(db, undefined, player, group, 1)
          : new D1TournamentQueueStore(db).preparePlayer(
              player,
              {
                ...profile,
                isAnonymous: 1,
                avatarPresetId: profile.avatarPresetId ?? null,
                entryId: player.entryId,
                operationId: player.operationId,
              },
              f.key,
            );
      await expect(
        db.batch(writes.map(({ value }) => value as D1PreparedStatement)),
      ).rejects.toThrow("guest_merged");
      expect(await wait()).toEqual(before);
      expect(
        await db
          .prepare("SELECT 1 FROM account_room_seats WHERE account_id=?")
          .bind(f.guest.id)
          .first(),
      ).toBeNull();
    });
  }

  for (const method of ["enqueue", "restore"] as const) {
    test(`${mode}のguest_merged_wait_fenceは${method}を拒否し待機を変更しません`, async () => {
      const f = await mergedGuest(db);
      const wait = await staleWait(db, f, "tournament");
      const before = await wait();
      if (index === 0) {
        await expect(
          db
            .prepare("INSERT INTO tournament_wait_reservations VALUES(?,?,?,?,NULL)")
            .bind(f.guest.id, f.key, crypto.randomUUID(), 1)
            .run(),
        ).rejects.toThrow("guest_merged");
      }
      await expect(
        new D1TournamentQueueStore(db)[method](
          { ...f.player, expiresAtMs: Date.now() + 60_000 },
          f.key,
        ),
      ).rejects.toThrow("guest_merged");
      expect(await wait()).toEqual(before);
    });
  }

  test(`${mode}の大会待機でbatch後に統合の行が消えてもguest_mergedを返します`, async () => {
    const f = await mergedGuest(db);
    const afterReject = async () => {
      await db.prepare("DELETE FROM guest_account_merges WHERE guest_id=?").bind(f.guest.id).run();
    };
    const store = new D1TournamentQueueStore(withBatchInterleaving(db, afterReject));
    await expect(store.enqueue(f.player, f.key)).rejects.toThrow("guest_merged");
    expect(
      await db
        .prepare("SELECT 1 FROM guest_account_merges WHERE guest_id=?")
        .bind(f.guest.id)
        .first(),
    ).toBeNull();
    expect(
      await db
        .prepare("SELECT 1 FROM tournament_wait_reservations WHERE account_id=?")
        .bind(f.guest.id)
        .first(),
    ).toBeNull();
  });
}
