import { deletedAccountExistsSql } from "../../db/deletionGuard";
import { prepareFenceAbort } from "../../db/fenceAbort";
import { guestMerged } from "../../flows/accountSeats/fences";
import type { TournamentEntryStore } from "@tetraboard/context-tournament";
export class D1TournamentEntries implements TournamentEntryStore {
  constructor(private db: D1Database) {}
  async eligible(accountId: string, key: string) {
    return this.db
      .prepare(`SELECT u.id,u.name,u.avatarKey,u.avatarPresetId,u.isAnonymous,e.id AS entryId FROM user u
      JOIN tournament_entries e ON e.account_id=u.id AND e.tournament_key=? AND e.deleted=0
      WHERE u.id=? AND u.profileCompleted=1 AND NOT EXISTS(SELECT 1 FROM deleted_accounts d WHERE d.id=u.id)`)
      .bind(key, accountId)
      .first<{
        id: string;
        name: string;
        avatarKey: string | null;
        avatarPresetId: string | null;
        entryId: string;
      }>();
  }
  async insert(key: string, accountId: string, id: string, now: number) {
    const candidate = `FROM user WHERE id=? AND profileCompleted=1`;
    await this.db.batch([
      this.db
        .prepare(`INSERT OR IGNORE INTO tournament_entries(id,tournament_key,account_id,entered_at_ms)
          SELECT ?,?,id,? ${candidate} AND NOT ${deletedAccountExistsSql("user.id")} AND NOT ${guestMerged("user.id")}`)
        .bind(id, key, now, accountId),
      prepareFenceAbort(
        this.db,
        {
          when: `changes()=0 AND EXISTS(SELECT 1 ${candidate} AND ${deletedAccountExistsSql("user.id")})`,
          values: [accountId],
          code: "account_deleted",
        },
        {
          when: `changes()=0 AND EXISTS(SELECT 1 ${candidate} AND ${guestMerged("user.id")})`,
          values: [accountId],
          code: "guest_merged",
        },
      ),
    ]);
  }
}
