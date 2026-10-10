import { Hono } from "hono";
import {
  badgeNotificationClaimSchema,
  badgeNotificationOperationSchema,
  badgeNotificationResponseSchema,
  getBadgeIds,
} from "@tetraboard/protocol";
import { accountIdentity, type StoredProfile } from "./auth";

export const badgeNotificationLeaseMs = 15_000;
export const badgeNotificationRoutes = new Hono<{
  Bindings: Env;
  Variables: { user: StoredProfile };
}>();
badgeNotificationRoutes.use("/account/badge-notifications/*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  if (c.req.header("Origin") !== c.env.APP_ORIGIN)
    return c.json({ message: "操作元を確認できません。" }, 403);
  const user = await accountIdentity(c.req.raw, c.env);
  if (!user) return c.json({ message: "ログインしてください。" }, 401);
  c.set("user", user);
  await next();
});
badgeNotificationRoutes.onError((_error, c) => {
  console.error("Badge notification request failed");
  return c.json({ message: "通知を取得できませんでした。" }, 503);
});
badgeNotificationRoutes.post("/account/badge-notifications/claim", async (c) => {
  const input = badgeNotificationClaimSchema.safeParse(await c.req.json().catch(() => null));
  if (!input.success) return c.json({ message: "通知の取得条件が正しくありません。" }, 400);
  const now = Date.now();
  const accountId = c.get("user").id;
  // 最古の未表示グループだけを貸し出します。別端末が取得中なら次の局も待ちます。
  const claimed = await c.env.APP_DB.prepare(`UPDATE account_badge_notifications
    SET claim_token = ?, claim_until_ms = ?
    WHERE account_id = ? AND shown_at_ms IS NULL
      AND (claim_until_ms IS NULL OR claim_until_ms <= ? OR claim_token = ?)
      AND match_id = (SELECT match_id FROM account_badge_notifications
        WHERE account_id = ? AND shown_at_ms IS NULL ORDER BY created_at_ms, match_id LIMIT 1)
    RETURNING match_id AS id, game`)
    .bind(
      input.data.token,
      now + badgeNotificationLeaseMs,
      accountId,
      now,
      input.data.token,
      accountId,
    )
    .first<{ id: string; game: "four-reversi" | "four-shogi" }>();
  if (!claimed) return c.json({ notification: null });
  const rows = await c.env.APP_DB.prepare(`SELECT badge_id AS id, MAX(tier) AS tier,
      MIN(previous_tier) AS previousTier, MAX(value) AS value
    FROM account_badge_awards WHERE account_id = ? AND match_id = ? GROUP BY badge_id`)
    .bind(accountId, claimed.id)
    .all();
  const badges = getBadgeIds(claimed.game).flatMap((id) =>
    rows.results.filter((row) => row.id === id),
  );
  return c.json(badgeNotificationResponseSchema.parse({ notification: { ...claimed, badges } }));
});
for (const operation of ["shown", "renew", "release"] as const) {
  badgeNotificationRoutes.post(`/account/badge-notifications/${operation}`, async (c) => {
    const input = badgeNotificationOperationSchema.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ message: "通知の指定が正しくありません。" }, 400);
    const now = Date.now();
    const assignment =
      operation === "shown"
        ? "shown_at_ms = ?"
        : operation === "renew"
          ? "claim_until_ms = ?"
          : "claim_until_ms = ?, claim_token = NULL";
    const row = await c.env.APP_DB.prepare(`UPDATE account_badge_notifications SET ${assignment}
      WHERE account_id = ? AND match_id = ? AND claim_token = ?
        AND shown_at_ms IS NULL AND claim_until_ms > ? RETURNING match_id`)
      .bind(
        operation === "renew" ? now + badgeNotificationLeaseMs : operation === "release" ? 0 : now,
        c.get("user").id,
        input.data.id,
        input.data.token,
        now,
      )
      .first();
    if (!row && operation !== "release") {
      // 同じtokenの表示済み記録は、応答を失った再送でも成功扱いにします。
      const shown =
        operation === "shown" &&
        (await c.env.APP_DB.prepare(`SELECT match_id
        FROM account_badge_notifications WHERE account_id = ? AND match_id = ?
          AND claim_token = ? AND shown_at_ms IS NOT NULL`)
          .bind(c.get("user").id, input.data.id, input.data.token)
          .first());
      if (!shown) return c.json({ message: "通知の取得権が切れました。" }, 409);
    }
    return c.json({ ok: true });
  });
}
