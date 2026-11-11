import { Hono } from "hono";
import {
  cpuPlayerAppearance,
  getEarnedBadges,
  getPlayerProfileContract,
  profileInputSchema,
} from "@tetraboard/protocol";
import { readStoredMatch } from "./matchDataContracts";
import { readCurrentProfiles } from "./currentProfiles";
import { readAccountStats } from "./statsRoutes";
import { resolveMatchParticipants } from "./matchClaims";
import { readPublicReversiRating } from "../rooms/reversiRating";
import { readPublicShogiRating } from "../rooms/shogiRating";
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
        await resolveMatchParticipants(c.env.APP_DB, record);
        player = record.record.participants.find((p) => p.id === target.playerId);
        if (!player) return c.json({ message: "プロフィールを表示できません。" }, 404);
        accountId = player.kind === "human" ? player.accountId : null;
      }
      if (player.kind === "cpu")
        return c.json(getPlayerProfileContract.response.parse(cpuPlayerAppearance(player)));
      if ("retired" in player && player.retired)
        return c.json({ message: "退会したプレイヤーです。" }, 404);
      if (!accountId)
        return c.json(
          getPlayerProfileContract.response.parse({
            kind: "guest",
            name: player.name,
            avatarUrl: null,
          }),
        );
    }
    if (accountId)
      accountId =
        (
          await c.env.APP_DB.prepare("SELECT account_id FROM guest_account_merges WHERE guest_id=?")
            .bind(accountId)
            .first<{ account_id: string }>()
        )?.account_id ?? accountId;
    const profile = accountId
      ? (await readCurrentProfiles(c.env.APP_DB, [accountId])).get(accountId)
      : undefined;
    if (
      !accountId ||
      !profile ||
      !profile.profileCompleted ||
      (!profile.isAnonymous && !profileInputSchema.safeParse(profile).success)
    )
      return c.json({ message: "プロフィールを表示できません。" }, 404);
    const profileId = profile.publicProfileId;
    if (!profileId) throw new Error("Public profile ID is missing");
    const stats = await readAccountStats(c.env.APP_DB, accountId, target.game);
    const shogiRating =
      target.game === "shogi" && target.includeShogiRating === "1" && !profile.isAnonymous
        ? await readPublicShogiRating(c.env.APP_DB, accountId)
        : undefined;
    const reversiRating =
      target.game === "reversi" && target.includeReversiRating === "1" && !profile.isAnonymous
        ? await readPublicReversiRating(c.env.APP_DB, accountId)
        : undefined;
    return c.json(
      getPlayerProfileContract.response.parse({
        kind: "account",
        ...(profile.isAnonymous ? { isGuest: true } : {}),
        profileId,
        name: profile.name,
        username: profile.username,
        avatarUrl: profile.avatarUrl,
        ...(target.includeDetails === "1" && !profile.isAnonymous
          ? { profileMessage: profile.profileMessage, favoriteGames: profile.favoriteGames }
          : {}),
        game: target.game,
        ...(shogiRating ? { shogiRating } : {}),
        ...(reversiRating ? { reversiRating } : {}),
        ...(target.includeBadges === "1" ? { badges: getEarnedBadges(target.game, stats) } : {}),
        stats:
          target.includeStats === "1" || "wins" in stats
            ? stats
            : {
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
