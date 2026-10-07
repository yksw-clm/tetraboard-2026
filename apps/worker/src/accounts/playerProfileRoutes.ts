import { Hono } from "hono";
import { getPlayerProfileContract, profileInputSchema } from "@tetraboard/protocol";
import { readStoredMatch } from "./matchDataContracts";
import { readCurrentProfiles, ensurePublicProfileId } from "./currentProfiles";
import { readAccountStats } from "./statsRoutes";
export const playerProfileRoutes = new Hono<{ Bindings: Env }>();
playerProfileRoutes.get(getPlayerProfileContract.path, async (c) => {
  c.header("Cache-Control", "no-store");
  const query = getPlayerProfileContract.query.safeParse(c.req.query());
  if (!query.success)
    return c.json({ message: "プレイヤー情報の取得条件が正しくありません。" }, 400);
  const target = query.data;
  try {
    let accountId: string | null = null;
    if (target.source === "profile") {
      accountId =
        (
          await c.env.APP_DB.prepare("SELECT id FROM user WHERE publicProfileId = ?")
            .bind(target.profileId)
            .first<{ id: string }>()
        )?.id ?? null;
    } else {
      let player;
      if (target.source === "room") {
        const resolved = await c.env.GAME_ROOM.getByName(target.roomId).resolvePlayerProfile(
          target.instanceId,
          target.playerId,
        );
        if (resolved.status === "room_changed")
          return c.json({ message: "ルームが変更されています。" }, 410);
        if (resolved.status !== "found")
          return c.json({ message: "プロフィールを表示できません。" }, 404);
        if (resolved.game !== target.game)
          return c.json({ message: "ゲームが一致しません。" }, 400);
        player = resolved.player;
        accountId = resolved.accountId;
      } else {
        const row = await c.env.APP_DB.prepare("SELECT game, record_json FROM matches WHERE id = ?")
          .bind(target.matchId)
          .first<{ game: string; record_json: string }>();
        if (!row) return c.json({ message: "プロフィールを表示できません。" }, 404);
        if (row.game !== target.game) return c.json({ message: "ゲームが一致しません。" }, 400);
        const record = readStoredMatch(row.record_json, row.game);
        player = record.record.participants.find((p) => p.id === target.playerId);
        if (!player) return c.json({ message: "プロフィールを表示できません。" }, 404);
        accountId = player.kind === "human" ? player.accountId : null;
      }
      if (player.kind === "cpu")
        return c.json(
          getPlayerProfileContract.response.parse({ kind: "cpu", level: player.level }),
        );
      if (!accountId)
        return c.json(
          getPlayerProfileContract.response.parse({
            kind: "guest",
            name: player.name,
            avatarUrl: null,
          }),
        );
    }
    const profile = accountId
      ? (await readCurrentProfiles(c.env.APP_DB, [accountId])).get(accountId)
      : undefined;
    if (
      !accountId ||
      !profile ||
      !profile.profileCompleted ||
      profile.isAnonymous ||
      !profileInputSchema.safeParse(profile).success
    )
      return c.json({ message: "プロフィールを表示できません。" }, 404);
    const profileId =
      profile.publicProfileId ?? (await ensurePublicProfileId(c.env.APP_DB, accountId));
    const stats = await readAccountStats(c.env.APP_DB, accountId, target.game);
    return c.json(
      getPlayerProfileContract.response.parse({
        kind: "account",
        profileId,
        name: profile.name,
        username: profile.username,
        avatarUrl: profile.avatarUrl,
        game: target.game,
        stats: {
          singles: { total: stats.singles.total, first: stats.singles.first },
          doubles: { total: stats.doubles.total, wins: stats.doubles.wins },
        },
      }),
    );
  } catch {
    console.error("Player profile request failed");
    return c.json({ message: "プレイヤー情報を取得できませんでした。" }, 503);
  }
});
