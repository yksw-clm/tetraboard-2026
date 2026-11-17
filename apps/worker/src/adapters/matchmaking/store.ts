import type {
  MatchmakingStore,
  MatchmakingWrite,
  Wait,
  Group,
  Player,
  Profile,
} from "@tetraboard/context-matchmaking";
import { readPendingRatingAccounts } from "@tetraboard/context-rating";
import { D1RatingReader } from "../rating/reader";
import { ratedMatchmakingPolicy } from "./ratedMatchmaking";
import { preparePlayerWrites } from "./seatWrites";
import { joinWait } from "./joinWrites";
export class D1MatchmakingStore implements MatchmakingStore {
  constructor(
    private db: D1Database,
    private policy: ReturnType<typeof ratedMatchmakingPolicy> | undefined,
  ) {}
  async profile(accountId: string, rated: boolean) {
    return this.db
      .prepare(
        `SELECT id,name,avatarKey,avatarPresetId,isAnonymous,isTestUser AS isTest FROM user WHERE id=? AND profileCompleted=1 AND (?=0 OR COALESCE(isAnonymous,0)=0) AND NOT EXISTS(SELECT 1 FROM deleted_accounts WHERE id=user.id) AND NOT EXISTS(SELECT 1 FROM guest_account_merges WHERE guest_id=user.id)`,
      )
      .bind(accountId, Number(rated))
      .first<Profile>();
  }
  async forget(wait: Wait) {
    await this.db
      .prepare("DELETE FROM matchmaking_wait_reservations WHERE account_id=? AND operation_id=?")
      .bind(wait.accountId, wait.operationId)
      .run();
  }
  async restore(wait: Wait) {
    const updated = await this.db
      .prepare(
        "UPDATE matchmaking_wait_reservations SET match_operation_id=NULL,lease_until_ms=? WHERE account_id=? AND operation_id=?",
      )
      .bind(wait.expiresAtMs, wait.accountId, wait.operationId)
      .run();
    return !!updated.meta.changes;
  }
  async releaseWaiting(group: Group) {
    await this.db.batch(
      group.players.map((p) =>
        this.db
          .prepare(
            "DELETE FROM matchmaking_wait_reservations WHERE account_id=? AND operation_id=?",
          )
          .bind(p.accountId, p.operationId),
      ),
    );
  }
  async hasSeat(accountId: string, operationId: string) {
    return !!(await this.db
      .prepare("SELECT 1 FROM account_room_seats WHERE account_id=? AND operation_id=?")
      .bind(accountId, operationId)
      .first());
  }
  async hasLease(accountId: string, operationId: string, now: number) {
    return !!(await this.db
      .prepare(
        "SELECT 1 FROM matchmaking_wait_reservations WHERE account_id=? AND operation_id=? AND lease_until_ms>?",
      )
      .bind(accountId, operationId, now)
      .first());
  }
  preparePlayer(player: Player, group: Group, now: number) {
    return preparePlayerWrites(this.db, this.policy, player, group, now);
  }
  async commit(writes: MatchmakingWrite[]) {
    await this.db.batch(writes.map((write) => write.value as D1PreparedStatement));
  }
  async clearPending(matchId: string) {
    await this.policy!.store.clearPending(this.db, matchId).run();
  }
  pendingAccounts(accountIds: string[]) {
    return readPendingRatingAccounts(new D1RatingReader(this.db), accountIds);
  }
  async validWaits(key: string, now: number) {
    const rows = await this.db
      .prepare(
        `SELECT w.operation_id AS operationId FROM matchmaking_wait_reservations w JOIN user u ON u.id=w.account_id WHERE w.queue_key=? AND w.lease_until_ms>? AND u.profileCompleted=1 AND NOT EXISTS(SELECT 1 FROM deleted_accounts d WHERE d.id=u.id) AND NOT EXISTS(SELECT 1 FROM guest_account_merges m WHERE m.guest_id=u.id)`,
      )
      .bind(key, now)
      .all<{ operationId: string }>();
    return rows.results;
  }
  join(wait: Wait, key: string, retiredKey: string) {
    return joinWait(this.db, this.policy, wait, key, retiredKey);
  }
  async heartbeat(wait: Wait) {
    await this.db
      .prepare(
        "UPDATE matchmaking_wait_reservations SET lease_until_ms=? WHERE account_id=? AND operation_id=?",
      )
      .bind(wait.expiresAtMs, wait.accountId, wait.operationId)
      .run();
  }
  async occupiedOperations(operationIds: string[]) {
    const rows = await this.db
      .prepare(
        `SELECT operation_id FROM account_room_seats WHERE operation_id IN(${operationIds.map(() => "?").join(",")})`,
      )
      .bind(...operationIds)
      .all<{ operation_id: string }>();
    return rows.results.map((row) => row.operation_id);
  }
}
