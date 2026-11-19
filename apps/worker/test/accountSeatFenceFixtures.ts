import { env } from "cloudflare:workers";
import { afterEach } from "vitest";
import { accountFixture, origin } from "./accountFixtures";
import { reserveAccountSeat } from "../src/flows/accountSeats/reserve";
import type { StoredProfile } from "../src/adapters/account/auth";
import { D1MatchmakingStore } from "../src/adapters/matchmaking/store";
import { D1TournamentQueueStore } from "../src/adapters/tournament/queue";

export const fenceTriggers = [
  "matchmaking_room_fence",
  "tournament_room_fence",
  "matchmaking_wait_fence",
  "matchmaking_tournament_fence",
  "tournament_wait_fence",
];
const fixtures: { db: D1Database; key: string; ids: string[] }[] = [];
afterEach(async () => {
  for (const { db, key, ids } of fixtures.splice(0)) {
    for (const id of ids)
      await db.batch([
        ...[
          "account_room_seats",
          "matchmaking_wait_reservations",
          "tournament_wait_reservations",
        ].map((table) => db.prepare(`DELETE FROM ${table} WHERE account_id=?`).bind(id)),
        db.prepare("DELETE FROM guest_account_merges WHERE guest_id=?").bind(id),
        db.prepare("DELETE FROM deleted_accounts WHERE id=?").bind(id),
      ]);
    await db.batch([
      db
        .prepare(
          "DELETE FROM tournament_match_players WHERE match_id IN (SELECT id FROM tournament_matches WHERE tournament_key=?)",
        )
        .bind(key),
      db.prepare("DELETE FROM tournament_matches WHERE tournament_key=?").bind(key),
      db.prepare("DELETE FROM tournament_entries WHERE tournament_key=?").bind(key),
      db.prepare("DELETE FROM tournaments WHERE key=?").bind(key),
    ]);
  }
});
export async function fenceFixture(db: D1Database, count = 1) {
  const key = crypto.randomUUID();
  const scopedEnv = { ...env, APP_DB: db };
  const users = [];
  const record = { db, key, ids: [] as string[] };
  fixtures.push(record);
  await db
    .prepare(
      "INSERT INTO tournaments(key,name,starts_at_ms,ends_at_ms,created_at_ms,updated_at_ms) VALUES(?,'フェンス検証',?,?,1,1)",
    )
    .bind(key, Date.now() - 60000, Date.now() + 3600000)
    .run();
  for (let i = 0; i < count; i++) {
    const user = await accountFixture(true, crypto.randomUUID(), db);
    record.ids.push(user.id);
    const profile = (await db
      .prepare("SELECT * FROM user WHERE id=?")
      .bind(user.id)
      .first<StoredProfile>())!;
    const entryId = crypto.randomUUID();
    await db
      .prepare(
        "INSERT INTO tournament_entries(id,tournament_key,account_id,entered_at_ms) VALUES(?,?,?,1)",
      )
      .bind(entryId, key, user.id)
      .run();
    const player = {
      accountId: user.id,
      operationId: crypto.randomUUID(),
      controllerId: crypto.randomUUID(),
      version: 0,
      sequence: i,
      joinedAtMs: Date.now(),
      expiresAtMs: Date.now() + 60000,
      entryId,
      tokenHash: crypto.randomUUID().replaceAll("-", "").repeat(2),
      admission: {
        accountId: user.id,
        operationId: crypto.randomUUID(),
        roomId: "12345",
        instanceId: crypto.randomUUID(),
        playerId: crypto.randomUUID(),
        name: profile.name,
        avatarKey: null,
        avatarPresetId: null,
      },
    };
    const request = new Request(origin, { headers: user.headers });
    users.push({ ...user, profile, player, request });
  }
  const first = users[0]!;
  return {
    ...first,
    users,
    db,
    key,
    env: scopedEnv,
    matchmaking: new D1MatchmakingStore(db, undefined),
    tournament: new D1TournamentQueueStore(db),
    seat: () =>
      reserveAccountSeat(
        first.request,
        scopedEnv,
        first.profile,
        { id: "12345", instanceId: crypto.randomUUID() },
        crypto.randomUUID(),
      ),
  };
}
export type FenceFixture = Awaited<ReturnType<typeof fenceFixture>>;
export async function waiting(f: FenceFixture, kind: "matchmaking" | "tournament", index = 0) {
  const player = f.users[index]!.player;
  if (kind === "matchmaking") await f.matchmaking.join(player, "fence-test", "retired");
  else await f.tournament.enqueue(player, f.key);
}
export async function deleted(f: FenceFixture) {
  await f.db
    .prepare("INSERT INTO deleted_accounts(id,requested_at_ms,receipt_hash) VALUES(?,1,?)")
    .bind(f.id, crypto.randomUUID())
    .run();
}
export async function occupancy(f: FenceFixture) {
  return (
    await f.db
      .prepare(`SELECT 'seat' AS kind FROM account_room_seats WHERE account_id=?
    UNION ALL SELECT 'matchmaking' FROM matchmaking_wait_reservations WHERE account_id=?
    UNION ALL SELECT 'tournament' FROM tournament_wait_reservations WHERE account_id=?`)
      .bind(f.id, f.id, f.id)
      .all<{ kind: string }>()
  ).results.map((row) => row.kind);
}
