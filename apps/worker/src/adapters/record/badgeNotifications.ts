import type { BadgeNotificationStore } from "@tetraboard/context-record";

export function badgeNotificationStore(db: D1Database): BadgeNotificationStore {
  return {
    // 最古の未表示グループだけを貸し出します。別端末が取得中なら次の局も待ちます。
    claim: ({ token, accountId }, now, until) =>
      db
        .prepare(`UPDATE account_badge_notifications
    SET claim_token = ?, claim_until_ms = ?
    WHERE account_id = ? AND shown_at_ms IS NULL
      AND (claim_until_ms IS NULL OR claim_until_ms <= ? OR claim_token = ?)
      AND match_id = (SELECT match_id FROM account_badge_notifications
        WHERE account_id = ? AND shown_at_ms IS NULL ORDER BY created_at_ms, match_id LIMIT 1)
    RETURNING match_id AS id, game`)
        .bind(token, until, accountId, now, token, accountId)
        .first<{ id: string; game: "four-reversi" | "four-shogi" }>(),
    async readAwards(accountId, matchId) {
      const rows = await db
        .prepare(`SELECT badge_id AS id, MAX(tier) AS tier,
      MIN(previous_tier) AS previousTier, MAX(value) AS value
    FROM account_badge_awards WHERE account_id = ? AND match_id = ? GROUP BY badge_id`)
        .bind(accountId, matchId)
        .all<{ id: string; tier: number; previousTier: number; value: number }>();
      return rows.results;
    },
    async update(operation, { accountId, id, token }, now, value) {
      const assignment =
        operation === "shown"
          ? "shown_at_ms = ?"
          : operation === "renew"
            ? "claim_until_ms = ?"
            : "claim_until_ms = ?, claim_token = NULL";
      return Boolean(
        await db
          .prepare(`UPDATE account_badge_notifications SET ${assignment}
      WHERE account_id = ? AND match_id = ? AND claim_token = ?
        AND shown_at_ms IS NULL AND claim_until_ms > ? RETURNING match_id`)
          .bind(value, accountId, id, token, now)
          .first(),
      );
    },
    async wasShown({ accountId, id, token }) {
      return Boolean(
        await db
          .prepare(`SELECT match_id
        FROM account_badge_notifications WHERE account_id = ? AND match_id = ?
          AND claim_token = ? AND shown_at_ms IS NOT NULL`)
          .bind(accountId, id, token)
          .first(),
      );
    },
  };
}
