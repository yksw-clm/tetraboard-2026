import { legalVersion } from "@tetraboard/protocol/privacy";
import {
  applyD1Migrations,
  createExecutionContext,
  env,
  runInDurableObject,
  waitOnExecutionContext,
} from "cloudflare:test";
import { beforeAll, describe, expect, test } from "vitest";
import type { Group } from "@tetraboard/context-matchmaking";
import { preparePlayerWrites } from "../src/adapters/matchmaking/seatWrites";
import { D1DeletionConfirmation } from "../src/adapters/privacy/deletionConfirmation";
import { guestPrivacyTransferStatements } from "../src/adapters/privacy/guestMergeWrites";
import { D1MatchClaimStore } from "../src/adapters/record/matchClaimStore";
import { seatReferenceStatements } from "../src/adapters/room/seatReservations";
import { D1TournamentEntries } from "../src/adapters/tournament/entries";
import { reserveAccountSeat } from "../src/flows/accountSeats/reserve";
import worker from "../src/worker";
import { AcceptedGameRequest } from "./acceptedGameRequest";
import { accountFixture, origin } from "./accountFixtures";
import {
  deleted,
  fenceFixture,
  occupancy,
  waiting,
  type FenceFixture,
} from "./accountSeatFenceFixtures";

const bindings = env as typeof env & {
  TB_158_TEST_DB: D1Database;
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};

const triggers = [
  "privacy_fence_account_room_seats",
  "privacy_fence_privacy_room_accounts",
  "privacy_fence_room_players",
  "tournament_entry_deleted_fence",
  "privacy_challenge_limit",
];

beforeAll(async () => {
  const db = bindings.TB_158_TEST_DB;
  await applyD1Migrations(db, bindings.TEST_MIGRATIONS);
  await db.batch(triggers.map((name) => db.prepare(`DROP TRIGGER ${name}`)));
});

async function markDeletedWithLegacyRows(db: D1Database, accountId: string) {
  const id = crypto.randomUUID();
  // 退会済み ID と、旧データから戻ったプロフィールや参照が共存する状態を作ります。
  await db.batch([
    db
      .prepare("INSERT INTO deleted_accounts(id,requested_at_ms,receipt_hash) VALUES(?,1,?)")
      .bind(id, crypto.randomUUID()),
    db.prepare("UPDATE deleted_accounts SET id=? WHERE id=?").bind(accountId, id),
  ]);
}

function privacyRooms(db: D1Database, accountId: string) {
  return db
    .prepare(`SELECT 'account' AS kind, room_id FROM privacy_room_accounts WHERE account_id=?
    UNION ALL SELECT 'player', room_id FROM privacy_room_players WHERE account_id=? ORDER BY kind,room_id`)
    .bind(accountId, accountId)
    .all<{ kind: string; room_id: string }>();
}

async function writeWaitingSeat(f: FenceFixture, kind: "matchmaking" | "tournament") {
  const { player, profile, db } = f;
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
      : f.tournament.preparePlayer(
          player,
          {
            ...profile,
            isAnonymous: 0,
            avatarPresetId: profile.avatarPresetId ?? null,
            entryId: player.entryId,
            operationId: player.operationId,
          },
          f.key,
        );
  return db.batch(writes.map(({ value }) => value as D1PreparedStatement));
}

async function post(scopedEnv: Env, path: string, headers: HeadersInit) {
  const context = createExecutionContext();
  const response = await worker.fetch(
    new Request(`${origin}/api${path}`, { method: "POST", headers }),
    scopedEnv,
    context,
  );
  await waitOnExecutionContext(context);
  return response;
}

async function tournamentEntryAfterDeletion(f: FenceFixture) {
  const { db, key } = f;
  const publicId = (await db
    .prepare(`UPDATE tournaments SET published=1,
    public_id=(SELECT COALESCE(MAX(public_id),0)+1 FROM tournaments) WHERE key=? RETURNING public_id`)
    .bind(key)
    .first<number>("public_id"))!;
  const namespace = env.TOURNAMENT_COORDINATOR;
  const stub = namespace.getByName(key);
  const coordinator = new Proxy(namespace, {
    get(target, property, receiver) {
      if (property !== "getByName") return Reflect.get(target, property, receiver);
      return () => ({
        enroll: async (key: string, accountId: string) => {
          await markDeletedWithLegacyRows(db, accountId);
          return runInDurableObject(stub, async (instance, state) => {
            const local = instance as unknown as { env: Env };
            const previous = local.env;
            local.env = { ...previous, APP_DB: db };
            try {
              return await instance.enroll(key, accountId);
            } finally {
              local.env = previous;
              await state.storage.deleteAlarm();
            }
          });
        },
      });
    },
  });
  return post(
    { ...env, APP_DB: db, TOURNAMENT_COORDINATOR: coordinator },
    `/tournaments/${publicId}/entries`,
    {
      ...f.headers,
      "X-Legal-Consent": legalVersion,
    },
  );
}

describe.each([
  { label: "トリガーあり", db: env.APP_DB },
  { label: "トリガーなし", db: bindings.TB_158_TEST_DB },
])("$label", ({ db }) => {
  test("通常ルームで退会済みの席を作らず従来の403を返します", async () => {
    const f = await fenceFixture(db);
    const { roomId, instanceId, playerId } = f.player.admission;
    await markDeletedWithLegacyRows(db, f.id);
    await expect(
      reserveAccountSeat(
        new AcceptedGameRequest(f.request),
        f.env,
        f.profile,
        { id: roomId, instanceId },
        playerId,
      ),
    ).rejects.toMatchObject({ code: "unauthorized", status: 403 });
    expect(await occupancy(f)).toEqual([]);
  });

  test.each(["matchmaking", "tournament"] as const)(
    "%sの席確定で退会済みの席を作りません",
    async (kind) => {
      const f = await fenceFixture(db);
      await waiting(f, kind);
      await markDeletedWithLegacyRows(db, f.id);
      const writes = await writeWaitingSeat(f, kind);
      expect(writes.slice(0, 2).map(({ meta }) => meta.changes)).toEqual([1, 0]);
      expect(await occupancy(f)).toEqual([kind]);
    },
  );

  test("退会済みの旧席は画像の参照だけを追加します", async () => {
    const f = await fenceFixture(db);
    const a = f.player.admission;
    await db
      .prepare(`INSERT INTO account_room_seats(account_id,operation_id,room_id,instance_id,player_id,name,avatar_key,created_at_ms)
      VALUES(?,?,?,?,?,?,?,1)`)
      .bind(f.id, a.operationId, a.roomId, a.instanceId, a.playerId, a.name, "legacy-avatar")
      .run();
    await deleted(f);
    const writes = await db.batch(seatReferenceStatements(db, a.operationId));
    expect(writes.map(({ meta }) => meta.changes)).toEqual([1, 0, 0]);
    expect((await privacyRooms(db, f.id)).results).toEqual([]);
  });

  test("ゲスト統合の索引転送は退会済みの統合先を除外し、元の索引を消します", async () => {
    const [guest, target] = Array.from({ length: 2 }, () => crypto.randomUUID());
    const roomId = crypto.randomUUID();
    await db.batch([
      db.prepare("INSERT INTO privacy_room_accounts VALUES(?,?)").bind(guest, roomId),
      db
        .prepare("INSERT INTO privacy_room_players VALUES(?,?,?,?,'legacy-avatar')")
        .bind(guest, roomId, crypto.randomUUID(), crypto.randomUUID()),
    ]);
    await markDeletedWithLegacyRows(db, target!);
    const writes = await db.batch(guestPrivacyTransferStatements(db, guest!, target!));
    expect(writes.map(({ meta }) => meta.changes)).toEqual([0, 0, 1, 1]);
    expect((await privacyRooms(db, target!)).results).toEqual([]);
    expect((await privacyRooms(db, guest!)).results).toEqual([]);
  });

  test("棋譜の引き継ぎを再送しても退会済みの旧受付から索引を追加しません", async () => {
    const { id: accountId } = await accountFixture(true, crypto.randomUUID(), db);
    const input = {
      accountId,
      matchId: crypto.randomUUID(),
      playerId: crypto.randomUUID(),
      roomId: "12345",
      instanceId: crypto.randomUUID(),
    };
    const store = new D1MatchClaimStore(db, () => []);
    await store.accept(input, 1);
    expect((await privacyRooms(db, accountId)).results).toEqual([
      { kind: "account", room_id: input.roomId },
    ]);
    await db.prepare("DELETE FROM privacy_room_accounts WHERE account_id=?").bind(accountId).run();
    await markDeletedWithLegacyRows(db, accountId);
    await store.accept(input, 2);
    expect((await privacyRooms(db, accountId)).results).toEqual([]);
  });

  test("大会エントリーのbatchは退会済みの候補をaccount_deletedで拒否します", async () => {
    const f = await fenceFixture(db);
    await db.prepare("DELETE FROM tournament_entries WHERE tournament_key=?").bind(f.key).run();
    await markDeletedWithLegacyRows(db, f.id);
    await expect(
      new D1TournamentEntries(db).insert(f.key, f.id, crypto.randomUUID(), 1),
    ).rejects.toThrow("account_deleted");
    expect(
      await db
        .prepare("SELECT 1 FROM tournament_entries WHERE tournament_key=?")
        .bind(f.key)
        .first(),
    ).toBeNull();
  });

  test("本人確認の直後に退会した大会エントリーは従来のHTTP 403を返します", async () => {
    const f = await fenceFixture(db);
    await db.prepare("DELETE FROM tournament_entries WHERE tournament_key=?").bind(f.key).run();
    const response = await tournamentEntryAfterDeletion(f);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ message: "プロフィール登録を完了してください。" });
    expect(
      await db
        .prepare("SELECT 1 FROM tournament_entries WHERE tournament_key=?")
        .bind(f.key)
        .first(),
    ).toBeNull();
  });

  test("退会確認の同時要求は5件だけ保存し、残りをHTTP 429で拒否します", async () => {
    const user = await accountFixture(true, crypto.randomUUID(), db);
    await db
      .prepare(`INSERT INTO account(id,accountId,providerId,userId,createdAt,updatedAt)
      VALUES(?,?,'google',?,1,1)`)
      .bind(crypto.randomUUID(), crypto.randomUUID(), user.id)
      .run();
    const responses = await Promise.all(
      Array.from({ length: 6 }, () =>
        post({ ...env, APP_DB: db }, "/account/deletion/reauth", user.headers),
      ),
    );
    expect(responses.filter(({ status }) => status === 200)).toHaveLength(5);
    const rejected = responses.filter(({ status }) => status === 429);
    expect(rejected).toHaveLength(1);
    expect(await rejected[0]!.json()).toEqual({ message: "1分ほど待ってください。" });
    expect(await new D1DeletionConfirmation(db).countRecentChallenges(user.id, 0)).toBe(5);
  });

  test("退会確認は60秒前ちょうどと別アカウントの行を数えません", async () => {
    const store = new D1DeletionConfirmation(db);
    const accountId = crypto.randomUUID();
    const other = crypto.randomUUID();
    const now = 100_000;
    const create = (id: string, at: number) =>
      store.createChallenge(crypto.randomUUID(), id, "google", at, at + 600_000);
    for (const at of [now - 60_000, now - 4, now - 3, now - 2, now - 1])
      expect(await create(accountId, at)).toBe(true);
    expect(await create(accountId, now)).toBe(true);
    expect(await create(accountId, now)).toBe(false);
    expect(await create(other, now)).toBe(true);
  });
});
