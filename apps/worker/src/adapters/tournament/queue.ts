import type {
  TournamentQueueStore,
  Waiting,
  Player,
  Group,
  State,
  ParticipationProfile,
  WaitingProfile,
  TournamentCoordinatorWrite,
} from "@tetraboard/context-tournament";
import { prepareTournamentPlayer } from "./seatWrites";
import { ensureTournamentGroup } from "./groupWrites";
export class D1TournamentQueueStore implements TournamentQueueStore {
  constructor(private db: D1Database) {}
  async waitingProfiles(key: string) {
    const rows = await this.db
      .prepare(`SELECT u.id,u.name,u.avatarKey,u.avatarPresetId,u.isAnonymous,e.id AS entryId,
      w.operation_id AS operationId FROM tournament_wait_reservations w
      JOIN tournament_entries e ON e.account_id=w.account_id AND e.tournament_key=w.tournament_key AND e.deleted=0
      JOIN user u ON u.id=w.account_id AND u.profileCompleted=1
      WHERE w.tournament_key=? AND w.lease_until_ms>?
      AND NOT EXISTS(SELECT 1 FROM deleted_accounts d WHERE d.id=u.id)`)
      .bind(key, Date.now())
      .all<{
        id: string;
        name: string;
        isAnonymous: number | null;
        avatarKey: string | null;
        avatarPresetId: string | null;
        entryId: string;
        operationId: string;
      }>();
    return new Map(rows.results.map((row) => [row.operationId, row]));
  }
  async leaseValid(wait: Waiting, key: string) {
    return !!(await this.db
      .prepare(`SELECT 1 FROM tournament_wait_reservations w
      JOIN tournament_entries e ON e.account_id=w.account_id AND e.tournament_key=w.tournament_key AND e.deleted=0
      JOIN user u ON u.id=w.account_id AND u.profileCompleted=1
      WHERE w.account_id=? AND w.tournament_key=? AND w.operation_id=? AND w.lease_until_ms>?
      AND NOT EXISTS(SELECT 1 FROM deleted_accounts d WHERE d.id=w.account_id)`)
      .bind(wait.accountId, key, wait.operationId, Date.now())
      .first());
  }
  async forget(wait: Waiting) {
    await this.db
      .prepare("DELETE FROM tournament_wait_reservations WHERE account_id=? AND operation_id=?")
      .bind(wait.accountId, wait.operationId)
      .run();
  }
  async restore(player: Player, key: string) {
    await this.db
      .prepare(`INSERT INTO tournament_wait_reservations(account_id,tournament_key,operation_id,lease_until_ms)
        VALUES(?,?,?,?) ON CONFLICT(account_id) DO UPDATE SET match_operation_id=NULL,lease_until_ms=excluded.lease_until_ms
        WHERE tournament_wait_reservations.operation_id=excluded.operation_id`)
      .bind(player.accountId, key, player.operationId, player.expiresAtMs)
      .run();
  }
  preparePlayer(player: Player, profile: WaitingProfile, key: string) {
    return prepareTournamentPlayer(this.db, player, profile, key);
  }
  async commit(writes: TournamentCoordinatorWrite[]) {
    await this.db.batch(writes.map((write) => write.value as D1PreparedStatement));
  }
  ensureGroup(state: State, group: Group) {
    return ensureTournamentGroup(this.db, state, group);
  }
  async releaseWaiting(players: Player[]) {
    await this.db.batch(
      players.map((p) =>
        this.db
          .prepare("DELETE FROM tournament_wait_reservations WHERE account_id=? AND operation_id=?")
          .bind(p.accountId, p.operationId),
      ),
    );
  }
  async roomUsed(roomId: string) {
    return !!(await this.db
      .prepare(
        "SELECT 1 FROM room_index WHERE room_id=? AND closed=0 UNION ALL SELECT 1 FROM tournament_matches WHERE room_id=? AND phase IN ('reserved','playing','saving') LIMIT 1",
      )
      .bind(roomId, roomId)
      .first());
  }
  async markAborted(group: Group) {
    await this.db
      .prepare(
        "UPDATE tournament_matches SET phase='aborted',finished_at_ms=?,updated_at_ms=? WHERE id=? AND phase='reserved'",
      )
      .bind(Date.now(), Date.now(), group.id)
      .run();
  }
  async markPlaying(group: Group, startedAtMs: number) {
    await this.db
      .prepare(
        "UPDATE tournament_matches SET phase='playing',started_at_ms=?,updated_at_ms=? WHERE id=? AND phase='reserved'",
      )
      .bind(startedAtMs, Date.now(), group.id)
      .run();
  }
  async ledgerPhase(group: Group) {
    return await this.db
      .prepare("SELECT phase FROM tournament_matches WHERE id=?")
      .bind(group.id)
      .first<{ phase: string }>();
  }
  async occupied(group: Group) {
    return !!(await this.db
      .prepare("SELECT 1 FROM account_room_seats WHERE instance_id=? LIMIT 1")
      .bind(group.instanceId)
      .first());
  }
  async participation(key: string, accountId: string) {
    return await this.db
      .prepare(`SELECT w.operation_id AS waitingOperation,
      w.lease_until_ms AS leaseUntilMs,s.operation_id AS seatOperation,t.ends_at_ms AS endsAtMs
      FROM tournament_entries e JOIN user u ON u.id=e.account_id AND u.profileCompleted=1
      JOIN tournaments t ON t.key=e.tournament_key AND t.published=1
      LEFT JOIN tournament_wait_reservations w ON w.account_id=u.id AND w.tournament_key=e.tournament_key
      LEFT JOIN account_room_seats s ON s.account_id=u.id
      WHERE e.tournament_key=? AND e.account_id=? AND e.deleted=0
      AND NOT EXISTS(SELECT 1 FROM deleted_accounts d WHERE d.id=u.id)`)
      .bind(key, accountId)
      .first<ParticipationProfile>();
  }
  async enqueue(wait: Waiting, key: string) {
    await this.db.batch([
      this.db
        .prepare(
          "DELETE FROM matchmaking_wait_reservations WHERE account_id=? AND lease_until_ms<=? AND match_operation_id IS NULL",
        )
        .bind(wait.accountId, Date.now()),
      this.db
        .prepare(
          "DELETE FROM tournament_wait_reservations WHERE account_id=? AND lease_until_ms<=? AND match_operation_id IS NULL",
        )
        .bind(wait.accountId, Date.now()),
      this.db
        .prepare(
          "INSERT INTO tournament_wait_reservations(account_id,tournament_key,operation_id,lease_until_ms) VALUES(?,?,?,?)",
        )
        .bind(wait.accountId, key, wait.operationId, wait.expiresAtMs),
    ]);
  }
  async heartbeat(wait: Waiting, expiresAtMs: number) {
    const updated = await this.db
      .prepare(
        `UPDATE tournament_wait_reservations SET lease_until_ms=? WHERE account_id=? AND operation_id=?
          AND lease_until_ms>? AND EXISTS(SELECT 1 FROM tournaments t JOIN tournament_entries e ON e.tournament_key=t.key
            JOIN user u ON u.id=e.account_id AND u.profileCompleted=1
            WHERE t.key=tournament_wait_reservations.tournament_key AND e.account_id=tournament_wait_reservations.account_id
            AND e.deleted=0 AND t.published=1 AND t.starts_at_ms<=? AND t.ends_at_ms>?
            AND NOT EXISTS(SELECT 1 FROM deleted_accounts d WHERE d.id=u.id))`,
      )
      .bind(expiresAtMs, wait.accountId, wait.operationId, Date.now(), Date.now(), Date.now())
      .run();
    return !!updated.meta.changes;
  }
  async latestPublished() {
    return await this.db
      .prepare(
        "SELECT MAX(public_id) AS id,MAX(ends_at_ms) AS ends FROM tournaments WHERE published=1",
      )
      .first<{ id: number | null; ends: number | null }>();
  }
  async publish(key: string, version: number, publicId: number, now: number) {
    const changed = await this.db
      .prepare(
        "UPDATE tournaments SET public_id=?,published=1,version=version+1,updated_at_ms=? WHERE key=? AND version=? AND published=0",
      )
      .bind(publicId, now, key, version)
      .run();
    return !!changed.meta.changes;
  }
}
