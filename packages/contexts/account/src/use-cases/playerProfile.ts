import type {
  GameId,
  PlayerProfile,
  PlayerProfileTarget,
  ProfileRating,
  AccountStats,
} from "@tetraboard/protocol";
import type { CurrentProfile } from "../domain/currentProfiles";
import type { ProfilePolicy } from "../domain/profile";
import type { AccountProfiles } from "./ports";
import { readCurrentProfiles } from "./currentProfiles";
export type PlayerProfileQuery = PlayerProfileTarget & {
  game: GameId;
  includeRating?: "1";
  includeBadges?: "1";
  includeStats?: "1";
  includeDetails?: "1";
  includeShogiRating?: "1";
  includeReversiRating?: "1";
};
type AccountCard = Extract<PlayerProfile, { kind: "account" }>;
export type ProfileFailure = { status: 400 | 404 | 410; message: string };
export type ProfileSource =
  | ProfileFailure
  | {
      accountId: string | null;
      rating?: ProfileRating;
      appearance?: Exclude<PlayerProfile, AccountCard>;
      retired?: boolean;
    };
export interface PlayerProfilePorts {
  profiles: AccountProfiles;
  policy: ProfilePolicy;
  validProfile(profile: CurrentProfile): boolean;
  source(target: Exclude<PlayerProfileQuery, { source: "profile" }>): Promise<ProfileSource>;
  stats(accountId: string, game: GameId): Promise<AccountStats>;
  rating(accountId: string, game: GameId): Promise<ProfileRating | undefined>;
  shogiRating(accountId: string): Promise<AccountCard["shogiRating"]>;
  reversiRating(accountId: string): Promise<AccountCard["reversiRating"]>;
  badges(game: GameId, stats: AccountStats): NonNullable<AccountCard["badges"]>;
}
const unavailable = (): ProfileFailure => ({
  status: 404,
  message: "プロフィールを表示できません。",
});
async function resolveSource(
  r: PlayerProfilePorts,
  target: PlayerProfileQuery,
): Promise<ProfileSource> {
  return target.source === "profile"
    ? { accountId: await r.profiles.accountId(target.profileId) }
    : r.source(target);
}
export async function readPlayerProfile(
  r: PlayerProfilePorts,
  target: PlayerProfileQuery,
): Promise<PlayerProfile | ProfileFailure> {
  const source = await resolveSource(r, target);
  if ("status" in source) return source;
  if (source.appearance?.kind === "cpu") return source.appearance;
  if (source.retired) return { status: 404, message: "退会したプレイヤーです。" };
  if (source.appearance && !source.accountId) return source.appearance;
  let accountId = source.accountId;
  if (accountId) accountId = (await r.profiles.mergedAccountId(accountId)) ?? accountId;
  const profile = accountId
    ? (await readCurrentProfiles(r.profiles, r.policy, [accountId])).get(accountId)
    : undefined;
  if (
    !accountId ||
    !profile ||
    !profile.profileCompleted ||
    (!profile.isAnonymous && !r.validProfile(profile))
  )
    return unavailable();
  if (!profile.publicProfileId) throw new Error("Public profile ID is missing");
  return readAccountCard(r, target, accountId, profile, source.rating);
}
async function readAccountCard(
  r: PlayerProfilePorts,
  target: PlayerProfileQuery,
  accountId: string,
  profile: CurrentProfile,
  rating?: ProfileRating,
): Promise<PlayerProfile> {
  const stats = await r.stats(accountId, target.game);
  if (target.includeRating === "1" && !profile.isAnonymous) {
    if (target.source === "profile") rating = await r.rating(accountId, target.game);
  } else rating = undefined;
  const shogiRating =
    target.game === "shogi" && target.includeShogiRating === "1" && !profile.isAnonymous
      ? await r.shogiRating(accountId)
      : undefined;
  const reversiRating =
    target.game === "reversi" && target.includeReversiRating === "1" && !profile.isAnonymous
      ? await r.reversiRating(accountId)
      : undefined;
  return {
    kind: "account",
    ...(profile.isAnonymous ? { isGuest: true } : {}),
    profileId: profile.publicProfileId!,
    name: profile.name,
    username: profile.username,
    avatarUrl: profile.avatarUrl,
    ...(target.includeDetails === "1" && !profile.isAnonymous
      ? { profileMessage: profile.profileMessage, favoriteGames: profile.favoriteGames }
      : {}),
    game: target.game,
    ...(shogiRating ? { shogiRating } : {}),
    ...(reversiRating ? { reversiRating } : {}),
    ...(rating ? { rating } : {}),
    ...(target.includeBadges === "1" ? { badges: r.badges(target.game, stats) } : {}),
    stats:
      target.includeStats === "1" || "wins" in stats
        ? stats
        : {
            singles: { total: stats.singles.total, first: stats.singles.first },
            doubles: { total: stats.doubles.total, wins: stats.doubles.wins },
          },
  };
}
