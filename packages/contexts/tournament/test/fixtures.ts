import type { TournamentSettings } from "@tetraboard/protocol";
import type {
  TournamentPolicy,
  TournamentRow,
  ScoreRow,
  TournamentRoomContext,
  TournamentMatchRecord,
} from "../src";
export const settings: Extract<TournamentSettings, { game: "four-shogi" }> = {
  game: "four-shogi",
  mode: "singles",
  timeControl: { mainTimeMs: 0, byoyomiMs: 30000 },
  threePlayerAttackProhibited: true,
};
// 検証済みの固定値を渡し、schema 自体の検証は Worker の既存テストで確かめます。
export const policy: TournamentPolicy = {
  settings: (definition) => (definition.ruleVersion === 1 ? settings : definition.settings!),
  parseSettings: (value) => value as TournamentSettings,
  pointsUnits: [48, 24, 12, 0],
  avatarUrl: (row) => `/avatar/${row.entryId}`,
};
export const row = (overrides: Partial<TournamentRow> = {}): TournamentRow => ({
  key: "tournament",
  public_id: 1,
  name: "大会",
  description: "説明",
  rules_description: "ルール",
  starts_at_ms: 1000,
  ends_at_ms: 2000,
  published: 1,
  version: 1,
  rule_version: 1,
  game: "four-shogi",
  settings_json: null,
  finalized_at_ms: null,
  created_at_ms: 0,
  updated_at_ms: 0,
  ...overrides,
});
export const score = (entryId: string, overrides: Partial<ScoreRow> = {}): ScoreRow => ({
  entryId,
  accountId: `account-${entryId}`,
  deleted: 0,
  name: entryId,
  username: entryId,
  publicProfileId: `profile-${entryId}`,
  isAnonymous: 0,
  avatarKey: null,
  avatarPresetId: null,
  pointsUnits: 48,
  games: 1,
  first: 1,
  second: 0,
  third: 0,
  fourth: 0,
  knockouts: 0,
  rankSum: 1,
  finalRank: null,
  ...overrides,
});
export const context: TournamentRoomContext = {
  tournamentId: 1,
  tournamentKey: "tournament",
  matchId: "match",
  startsAtMs: 1000,
  endsAtMs: 2000,
  ruleVersion: 1,
};
export function match(): TournamentMatchRecord {
  const sides = ["east", "south", "west", "north"];
  return {
    id: "match",
    roomId: "12345",
    instanceId: "instance",
    settings,
    startedAtMs: 1000,
    endedAtMs: 3000,
    game: {
      result: { mode: "singles", standings: sides.map((side, i) => ({ side, rank: i + 1 })) },
    },
    participants: sides.map((side, i) => ({ id: `player-${i}`, kind: "human", side })),
    knockouts: { east: 2, south: 1, west: 0, north: 0 },
  };
}
