import { hasProfileRating } from "@tetraboard/context-rating";
import type {
  PlayerProfilePorts,
  PlayerProfileQuery,
  ProfileSource,
} from "@tetraboard/context-account";
import {
  cpuPlayerAppearance,
  getEarnedBadges,
  profileInputSchema,
  type ProfileRating,
} from "@tetraboard/protocol";
import { readMatchProfileRating, readProfileRating } from "../rating/profileRatings";
import { readStoredMatch } from "../record/matchDataContracts";
import { readAccountStats } from "../record/stats";
import { resolveMatchParticipants } from "../record/matchProfiles";
import { readPublicReversiRating } from "../../rooms/reversiRating";
import { readPublicShogiRating } from "../../rooms/shogiRating";
import { D1AccountProfiles } from "./profiles";
import { profilePolicy } from "./profilePolicy";
export function playerProfilePorts(env: Env): PlayerProfilePorts {
  return {
    profiles: new D1AccountProfiles(env.APP_DB),
    policy: profilePolicy,
    validProfile: (profile) => profileInputSchema.safeParse(profile).success,
    source: (target) => readSource(env, target),
    stats: (accountId, game) => readAccountStats(env.APP_DB, accountId, game),
    rating: async (accountId, game) =>
      hasProfileRating(game)
        ? readProfileRating(env.APP_DB, accountId, game, "current")
        : undefined,
    shogiRating: (accountId) => readPublicShogiRating(env.APP_DB, accountId),
    reversiRating: (accountId) => readPublicReversiRating(env.APP_DB, accountId),
    badges: getEarnedBadges,
  };
}
async function readSource(
  env: Env,
  target: Exclude<PlayerProfileQuery, { source: "profile" }>,
): Promise<ProfileSource> {
  let player, accountId: string | null, rating: ProfileRating | undefined;
  if (target.source === "room") {
    const resolved = await env.GAME_ROOM.getByName(target.roomId).resolvePlayerProfile(
      target.instanceId,
      target.playerId,
    );
    if (resolved.status === "room_changed")
      return { status: 410, message: "ルームが変更されています。" };
    if (resolved.status !== "found")
      return { status: 404, message: "プロフィールを表示できません。" };
    if (resolved.game !== target.game) return { status: 400, message: "ゲームが一致しません。" };
    player = resolved.player;
    accountId = resolved.accountId;
    if (target.includeRating === "1") rating = resolved.profileRating;
  } else {
    const row = await env.APP_DB.prepare("SELECT game, record_json FROM matches WHERE id = ?")
      .bind(target.matchId)
      .first<{ game: string; record_json: string }>();
    if (!row) return { status: 404, message: "プロフィールを表示できません。" };
    if (row.game !== target.game) return { status: 400, message: "ゲームが一致しません。" };
    const record = readStoredMatch(row.record_json, row.game);
    await resolveMatchParticipants(env.APP_DB, record);
    player = record.record.participants.find((p) => p.id === target.playerId);
    if (!player) return { status: 404, message: "プロフィールを表示できません。" };
    accountId = player.kind === "human" ? player.accountId : null;
    if (target.includeRating === "1")
      rating = await readMatchProfileRating(env.APP_DB, record, player.id);
  }
  return {
    accountId,
    rating,
    ...(player.kind === "cpu"
      ? { appearance: { ...cpuPlayerAppearance(player), ...(rating ? { rating } : {}) } }
      : {
          appearance: { kind: "guest", name: player.name, avatarUrl: null },
          retired: "retired" in player && Boolean(player.retired),
        }),
  };
}
