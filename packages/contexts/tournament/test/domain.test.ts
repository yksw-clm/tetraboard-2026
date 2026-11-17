import { expect, test } from "bun:test";
import {
  stage,
  settingsForTournament,
  tournamentSettingsMatch,
  standingFromRow,
  visibleStanding,
  rankTournamentStandings,
  tournamentRankPointsUnits,
  tournamentReservationKey,
  tournamentCredentialVersionKey,
  activeTournamentContextKey,
} from "../src";
import { row, score, policy, settings } from "./fixtures";

test("開始と終了の境界、下書きと確定の優先順位を保つ", () => {
  expect([999, 1000, 1999, 2000].map((now) => stage(row(), now))).toEqual([
    "upcoming",
    "active",
    "active",
    "settling",
  ]);
  expect(stage(row({ published: 0, finalized_at_ms: 2500 }), 3000)).toBe("draft");
  expect(stage(row({ finalized_at_ms: 2500 }), 3000)).toBe("finished");
});

test("旧定義と版2の保存設定を読み、ゲームとルール差を照合する", () => {
  expect(settingsForTournament(row(), policy)).toEqual(settings);
  const newer = row({ rule_version: 2, settings_json: JSON.stringify(settings) });
  expect(settingsForTournament(newer, policy)).toEqual(settings);
  expect(tournamentSettingsMatch(newer, { ruleVersion: 2, settings }, policy)).toBe(true);
  expect(tournamentSettingsMatch(newer, { ruleVersion: 1 }, policy)).toBe(false);
  expect(
    tournamentSettingsMatch(
      newer,
      { ruleVersion: 2, settings: { ...settings, threePlayerAttackProhibited: false } },
      policy,
    ),
  ).toBe(false);
  expect(() => settingsForTournament(row({ game: "four-reversi" }), policy)).toThrow(
    "Tournament game does not match settings",
  );
});

test("勝ち点の整数単位を2人・3人・4人の同順位へ分配する", () => {
  expect([1, 2, 3, 4].map((rank) => tournamentRankPointsUnits(policy.pointsUnits, rank))).toEqual([
    48, 24, 12, 0,
  ]);
  expect([2, 3, 4].map((tied) => tournamentRankPointsUnits(policy.pointsUnits, 1, tied))).toEqual([
    36, 28, 21,
  ]);
  expect(tournamentRankPointsUnits(policy.pointsUnits, 2, 3)).toBe(12);
  for (const [rank, tied] of [
    [0, 1],
    [1, 0],
    [4, 2],
    [1.5, 1],
  ])
    expect(() => tournamentRankPointsUnits(policy.pointsUnits, rank!, tied!)).toThrow(RangeError);
});

test("丸め前の平均順位とゲーム別の撃破比較、未対局の順位を保つ", () => {
  const values = [
    score("a", { pointsUnits: 120, games: 100, rankSum: 333, knockouts: 4 }),
    score("b", { pointsUnits: 120, games: 300, rankSum: 999, knockouts: 4 }),
    score("c", { pointsUnits: 120, games: 300, rankSum: 1000, knockouts: 4 }),
    score("d", { pointsUnits: 120, games: 100, rankSum: 400, knockouts: 5 }),
    score("e", { pointsUnits: 0, games: 0 }),
  ].map((s) => standingFromRow(s, policy.avatarUrl));
  expect(rankTournamentStandings(values).map((s) => [s.entryId, s.rank])).toEqual([
    ["d", 1],
    ["a", 2],
    ["b", 2],
    ["c", 4],
    ["e", null],
  ]);
  expect(rankTournamentStandings(values, "four-reversi").map((s) => [s.entryId, s.rank])).toEqual([
    ["a", 1],
    ["b", 1],
    ["c", 3],
    ["d", 4],
    ["e", null],
  ]);
});

test("内部IDを公開せず、指定時だけ公開プロフィールと本人印を付ける", () => {
  const standing = standingFromRow(score("a", { isAnonymous: 1 }), policy.avatarUrl);
  expect(visibleStanding(standing)).not.toHaveProperty("entryId");
  expect(visibleStanding(standing)).not.toHaveProperty("accountId");
  expect(visibleStanding(standing)).not.toHaveProperty("profileId");
  expect(visibleStanding(standing, "account-a", true)).toMatchObject({
    self: true,
    profileId: "profile-a",
    isGuest: true,
  });
  expect(
    standingFromRow(score("a", { deleted: 1, name: null, username: null }), policy.avatarUrl),
  ).toMatchObject({
    name: "退会したプレイヤー",
    accountId: null,
    profileId: null,
    avatarUrl: null,
  });
});

test("保存済みの大会キーを変えない", () => {
  expect(tournamentReservationKey("old-match")).toBe("tournament-reservation:old-match");
  expect(tournamentCredentialVersionKey("old-player")).toBe(
    "tournament-credential-version:old-player",
  );
  expect(activeTournamentContextKey).toBe("active-tournament-context");
});
