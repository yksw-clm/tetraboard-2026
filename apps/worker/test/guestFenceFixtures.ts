import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll } from "vitest";
import { accountFixture, origin } from "./accountFixtures";
import { D1RegistrationWrites } from "../src/adapters/account/registrationWrites";

const bindings = env as typeof env & {
  GUEST_FENCES_TEST_DB: D1Database;
  GUEST_FENCES_WITHOUT_TRIGGERS_TEST_DB: D1Database;
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};
export const guestFenceTriggers = [
  "guest_merge_fence",
  "matchmaking_guest_merge_fence",
  "guest_promotion_fence",
  "matchmaking_login_transition_fence",
  "guest_room_link_commit_fence",
  "guest_merged_seat_fence",
  "guest_merged_wait_fence",
  "guest_merged_entry_fence",
  "registration_deleted_account_insert",
  "registration_deleted_account_update",
];
const isolated = bindings.GUEST_FENCES_WITHOUT_TRIGGERS_TEST_DB;
export const guestFenceDatabases = [
  { db: bindings.GUEST_FENCES_TEST_DB, mode: "トリガーあり" },
  { db: isolated, mode: "トリガーなし" },
];
beforeAll(async () => {
  for (const { db } of guestFenceDatabases) await applyD1Migrations(db, bindings.TEST_MIGRATIONS);
  for (const name of guestFenceTriggers) await isolated.exec(`DROP TRIGGER ${name}`);
});

export async function guestFenceFixture(db: D1Database, promote = false) {
  const guest = await accountFixture(true, crypto.randomUUID(), db);
  const target = await accountFixture(!promote, crypto.randomUUID(), db);
  const { id: sessionId } = (await db
    .prepare("SELECT id FROM session WHERE userId=?")
    .bind(target.id)
    .first<{ id: string }>())!;
  const state = crypto.randomUUID();
  const token = crypto.randomUUID().replaceAll("-", "").repeat(2);
  const tokenHash = Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token))),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  const expires = Date.now() + 600_000;
  await db.batch([
    db.prepare("UPDATE user SET isAnonymous=1,guestNameCustomized=1 WHERE id=?").bind(guest.id),
    db
      .prepare("INSERT INTO guest_sessions(token_hash,account_id,expires_at_ms) VALUES(?,?,?)")
      .bind(tokenHash, guest.id, expires),
    db
      .prepare(`INSERT INTO guest_oauth_flows
        (state,guest_id,guest_token_hash,provider,started_at_ms,expires_at_ms,target_id,target_session_id,is_new_target)
        VALUES(?,?,?,'google',0,?,?,?,?)`)
      .bind(state, guest.id, tokenHash, expires, target.id, sessionId, Number(promote)),
  ]);
  const flow = {
    state,
    guest_id: guest.id,
    target_id: target.id,
    target_session_id: sessionId,
    name: "登録名",
    is_new_target: Number(promote),
  };
  const request = () =>
    new Request(`${origin}/account/guest-merge`, {
      method: "POST",
      headers: {
        ...target.headers,
        Cookie: `${target.cookie}; tetraboard-2026.guest=${token}`,
      },
    });
  return { guest, target, flow, tokenHash, request };
}

export type GuestFenceFixture = Awaited<ReturnType<typeof guestFenceFixture>>;

export function registrationCommand(guestAccountId: string | null = null) {
  return {
    registrationId: crypto.randomUUID(),
    secretHash: "secret-hash",
    roomId: "12345",
    instanceId: crypto.randomUUID(),
    matchId: crypto.randomUUID(),
    oldTokenHash: "old-hash",
    newTokenHash: "new-hash",
    guestAccountId,
    now: Date.now(),
  };
}

export async function heldGuestLink(db: D1Database, fixture: GuestFenceFixture) {
  const registration = registrationCommand(fixture.guest.id);
  const playerId = crypto.randomUUID();
  await new D1RegistrationWrites(db).create(registration);
  await db.batch([
    db
      .prepare(`UPDATE registration_flows SET player_id=?,account_id=?,session_id=? WHERE id=?`)
      .bind(
        playerId,
        fixture.target.id,
        fixture.flow.target_session_id,
        registration.registrationId,
      ),
    db
      .prepare("UPDATE guest_oauth_flows SET room_registration_id=? WHERE state=?")
      .bind(registration.registrationId, fixture.flow.state),
    db
      .prepare(`INSERT INTO account_room_seats(account_id,operation_id,room_id,instance_id,player_id,name,created_at_ms)
        VALUES(?,?,?,?,?,'登録名',1)`)
      .bind(
        fixture.guest.id,
        crypto.randomUUID(),
        registration.roomId,
        registration.instanceId,
        playerId,
      ),
    db
      .prepare("INSERT INTO privacy_room_accounts VALUES(?,?)")
      .bind(fixture.guest.id, registration.roomId),
    db
      .prepare("INSERT INTO privacy_room_players VALUES(?,?,?,?,NULL)")
      .bind(fixture.guest.id, registration.roomId, registration.instanceId, playerId),
  ]);
  const flow = { ...fixture.flow, room_registration_id: registration.registrationId };
  const room = {
    getGuestRegistration: async () => ({ state: "pending" }),
    guestMergeConflict: async () => false,
  };
  const roomBinding = { getByName: () => room } as unknown as Env["GAME_ROOM"];
  return { flow, env: { ...env, APP_DB: db, GAME_ROOM: roomBinding }, registration, playerId };
}

export async function tournamentFixture(db: D1Database) {
  const key = crypto.randomUUID();
  await db
    .prepare(`INSERT INTO tournaments(key,name,starts_at_ms,ends_at_ms,created_at_ms,updated_at_ms)
    VALUES(?,'フェンス検証',1,2,1,1)`)
    .bind(key)
    .run();
  return key;
}

export function withBatchInterleaving(db: D1Database, afterReject: () => Promise<void>) {
  return new Proxy(db, {
    get(target, property) {
      if (property === "batch")
        return async <T>(statements: D1PreparedStatement[]) => {
          try {
            return await db.batch<T>(statements);
          } catch (error) {
            await afterReject();
            throw error;
          }
        };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

export async function markDeleted(db: D1Database, accountId: string) {
  await db
    .prepare("INSERT INTO deleted_accounts(id,requested_at_ms,receipt_hash) VALUES(?,1,?)")
    .bind(accountId, crypto.randomUUID())
    .run();
}
