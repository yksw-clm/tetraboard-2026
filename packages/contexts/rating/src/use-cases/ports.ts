import type { EloGame, SkillGame, RatingGame, eloPolicy, TimeControl } from "../domain/policy";
export type LatestRating = {
  rating_after: number;
  sigma_after?: number;
  rated_games: number;
  human_games: number;
};
export type EloResultRow = {
  phase: "saved" | "pending";
  fallback: number | null;
  rating_before: number | null;
  rating_after: number | null;
  rated_games: number | null;
  human_games: number | null;
  cpu_rating: number | null;
  opponent_before: number | null;
  opponent_after: number | null;
  opponent_games: number | null;
};
export type SkillResultRow = {
  player_id: string | null;
  own: number | null;
  fallback: number | null;
  cpu_mu: number | null;
  mu_before: number | null;
  mu_after: number | null;
  rated_games: number | null;
  human_games: number | null;
  pending: number;
};
export type { CurrentSkill, SkillChange } from "../domain/skillChanges";
import type { CurrentSkill, SkillChange } from "../domain/skillChanges";
export type RankingRow = {
  accountId: string;
  profileId: string;
  username: string;
  name: string;
  avatarKey: string | null;
  avatarPresetId: string | null;
  value: number;
  rank: number;
};
export type PendingRating = {
  game: RatingGame;
  match_id: string;
  room_id: string | null;
  instance_id: string | null;
};

export interface RatingReader {
  latest(game: RatingGame, accountId: string): Promise<LatestRating | null>;
  before(
    game: RatingGame,
    matchId: string,
    accountId: string,
  ): Promise<{ rating: number; rated_games: number } | null>;
  eloResult(
    game: EloGame,
    accountId: string,
    matchId: string,
    includeOpponent: boolean,
  ): Promise<EloResultRow | null>;
  skillResult(game: SkillGame, accountId: string, matchId: string): Promise<SkillResultRow[]>;
  rankings(game: RatingGame): Promise<RankingRow[]>;
  pendingAccounts(accountIds: string[]): Promise<string[]>;
  previous(accountId: string, games: RatingGame[]): Promise<PendingRating | null>;
}
// Elo は棋譜の公開後の値を同じ batch 内で読むため、計算条件を渡して書き込みを返します。
export interface RatingPublication<Write> {
  eloChanges(
    game: EloGame,
    matchId: string,
    policy: typeof eloPolicy,
    clocks: TimeControl[],
  ): Write;
  reserve(game: RatingGame, matchId: string, accountId: string, operationId: string): Write;
  clearPending(game: RatingGame, matchId: string): Write;
  clearPublishedPending(game: RatingGame, matchId: string): Write;
  latest(game: RatingGame, accountId: string): Write;
}
export interface SkillRatingStore<Write> {
  applied(game: SkillGame, matchId: string): Promise<boolean>;
  current(game: SkillGame, ids: string[]): Promise<CurrentSkill[]>;
  changes(game: SkillGame, matchId: string, changes: SkillChange[]): Write;
  save(write: Write): Promise<number>;
}
