import type {
  TournamentSettings,
  TournamentStanding,
  TournamentPublic,
} from "@tetraboard/protocol";
export type TournamentRow = {
  key: string;
  public_id: number | null;
  name: string;
  description: string;
  rules_description: string;
  starts_at_ms: number | null;
  ends_at_ms: number | null;
  published: number;
  version: number;
  rule_version: 1 | 2;
  game: TournamentSettings["game"];
  settings_json: string | null;
  finalized_at_ms: number | null;
  created_at_ms: number;
  updated_at_ms: number;
};
export type ScoreRow = {
  entryId: string;
  accountId: string | null;
  deleted: number;
  name: string | null;
  username: string | null;
  publicProfileId: string | null;
  isAnonymous: number | null;
  avatarKey: string | null;
  avatarPresetId: string | null;
  pointsUnits: number;
  games: number;
  first: number;
  second: number;
  third: number;
  fourth: number;
  knockouts: number;
  rankSum: number;
  finalRank: number | null;
};
export type InternalStanding = TournamentStanding & { entryId: string; accountId: string | null };

export type PublicCounts = Pick<
  TournamentPublic,
  "entryCount" | "waitingCount" | "playingCount" | "pendingCount" | "completedCount"
>;
