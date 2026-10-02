import { Hono } from "hono";
import { listMatchesContract, type RoomMode } from "@tetraboard/protocol";
import { accountIdentity, profileAvatarUrl } from "./auth";
import { type MatchRecord } from "../rooms/matchStore";

export async function listMatches(
  db: D1Database,
  accountId: string,
  mode: RoomMode,
  cursor: { startedAtMs: number; id: string } | null,
) {
  const sql = `SELECT m.record_json FROM account_match_history h
    JOIN matches m ON m.id = h.match_id WHERE h.account_id = ? AND h.mode = ?`;
  const statement = cursor
    ? db
        .prepare(`${sql} AND (h.started_at_ms < ? OR (h.started_at_ms = ? AND h.match_id < ?))
      ORDER BY h.started_at_ms DESC, h.match_id DESC LIMIT 21`)
        .bind(accountId, mode, cursor.startedAtMs, cursor.startedAtMs, cursor.id)
    : db
        .prepare(`${sql} ORDER BY h.started_at_ms DESC, h.match_id DESC LIMIT 21`)
        .bind(accountId, mode);
  const rows = await statement.all<{ record_json: string }>();
  const records = rows.results
    .slice(0, 20)
    .map((row) => JSON.parse(row.record_json) as MatchRecord);
  const accountIds = [
    ...new Set(
      records.flatMap((record) =>
        record.participants.flatMap((p) =>
          p.kind === "human" && p.accountId ? [p.accountId] : [],
        ),
      ),
    ),
  ];
  const avatars = new Map<string, string | null>();
  if (accountIds.length) {
    const profiles = await db
      .prepare(
        `SELECT id, avatarKey FROM user WHERE id IN (${accountIds.map(() => "?").join(",")})`,
      )
      .bind(...accountIds)
      .all<{ id: string; avatarKey: string | null }>();
    for (const profile of profiles.results)
      avatars.set(profile.id, profileAvatarUrl(profile.avatarKey));
  }
  const matches = records.map((record) => ({
    id: record.id,
    game: record.settings.game,
    mode: record.settings.mode,
    startedAtMs: record.startedAtMs,
    endedAtMs: record.endedAtMs,
    participants: record.participants.map((p) => ({
      id: p.id,
      name: p.name,
      color: p.color,
      seat: p.seat,
      ...(p.kind === "cpu"
        ? { kind: "cpu" as const, level: p.level }
        : {
            kind: "human" as const,
            avatarUrl: p.accountId ? (avatars.get(p.accountId) ?? null) : null,
          }),
    })),
    result: record.game.result,
  }));
  const last = matches.at(-1);
  return listMatchesContract.response.parse({
    matches,
    nextCursor: rows.results.length > 20 && last ? `${last.startedAtMs}:${last.id}` : null,
  });
}

export const matchRoutes = new Hono<{ Bindings: Env }>();
matchRoutes.get(listMatchesContract.path, async (c) => {
  c.header("Cache-Control", "no-store");
  try {
    const user = await accountIdentity(c.req.raw, c.env);
    if (!user) return c.json({ message: "ログインしてください。" }, 401);
    const query = listMatchesContract.query.safeParse({
      mode: c.req.query("mode"),
      cursor: c.req.query("cursor"),
    });
    if (!query.success) return c.json({ message: "履歴の取得条件が正しくありません。" }, 400);
    return c.json(
      await listMatches(c.env.APP_DB, user.id, query.data.mode, query.data.cursor ?? null),
    );
  } catch {
    console.error("Match history request failed");
    return c.json({ message: "対局履歴を取得できませんでした。もう一度お試しください。" }, 503);
  }
});
