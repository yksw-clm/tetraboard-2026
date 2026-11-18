import { redactParticipants as redactRecord } from "@tetraboard/context-privacy";
import { readDeletedAccounts } from "../../adapters/privacy/identity";

export function redactParticipants<
  T extends {
    id?: string;
    participants: { id?: string; kind: string; name: string; accountId?: string | null }[];
  },
>(db: D1Database, record: T): Promise<T> {
  return redactRecord(
    {
      async readCanonicalAccounts(guestIds) {
        const links = await db
          .prepare(
            `SELECT guest_id,account_id FROM guest_account_merges WHERE guest_id IN (${guestIds.map(() => "?").join(",")})`,
          )
          .bind(...guestIds)
          .all<{ guest_id: string; account_id: string }>();
        return new Map(links.results.map((link) => [link.guest_id, link.account_id]));
      },
      async readRetiredPlayers(matchId) {
        const claims = await db
          .prepare(
            "SELECT player_id FROM match_participant_accounts WHERE match_id=? AND state='retired'",
          )
          .bind(matchId)
          .all<{ player_id: string }>();
        return new Set(claims.results.map((row) => row.player_id));
      },
      readDeletedAccounts: (ids) => readDeletedAccounts(db, ids),
    },
    record,
  );
}
