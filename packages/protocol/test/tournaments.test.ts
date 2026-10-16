import { expect, test } from "bun:test";
import {
  compareTournamentScores,
  formatTournamentPoints,
  rankTournamentStandings,
  tournamentAdminEntrySchema,
  tournamentConfirmationSchema,
  tournamentInputSchema,
  tournamentOperationSchema,
  tournamentPatchSchema,
  tournamentPublicSchema,
  tournamentPublishSchema,
  tournamentQueueInputSchema,
  tournamentRankPointsUnits,
  tournamentRules,
  type TournamentStanding,
} from "../src/tournaments";

const operationId = "00000000-0000-4000-8000-000000000001";
const matchId = "00000000-0000-4000-8000-000000000002";
const input = {
  name: "四人将棋大会",
  description: "",
  rulesDescription: "",
  startsAtMs: 1000,
  endsAtMs: 2000,
};
function standing(patch: Partial<TournamentStanding> = {}): TournamentStanding {
  return {
    rank: null,
    username: "tetra",
    name: "てとら",
    avatarUrl: null,
    pointsUnits: 48,
    games: 1,
    first: 1,
    second: 0,
    third: 0,
    fourth: 0,
    knockouts: 0,
    rankSum: 1,
    ...patch,
  };
}

test("同順位の人数にかかわらず各対局の合計7点を1/12点単位で正確に分ける", () => {
  expect(tournamentRankPointsUnits(1)).toBe(48);
  expect(tournamentRankPointsUnits(2)).toBe(24);
  expect(tournamentRankPointsUnits(3)).toBe(12);
  expect(tournamentRankPointsUnits(4)).toBe(0);
  expect(tournamentRankPointsUnits(1, 4)).toBe(21);
  expect(tournamentRankPointsUnits(1, 3)).toBe(28);
  expect(tournamentRankPointsUnits(3, 2)).toBe(6);
  for (const groups of [
    [1, 1, 1, 1],
    [4],
    [3, 1],
    [1, 3],
    [2, 2],
    [2, 1, 1],
    [1, 2, 1],
    [1, 1, 2],
  ]) {
    let rank = 1;
    let total = 0;
    for (const count of groups) {
      const units = tournamentRankPointsUnits(rank, count);
      expect(Number.isInteger(units)).toBe(true);
      total += units * count;
      rank += count;
    }
    expect(total).toBe(7 * tournamentRules.pointUnit);
  }
});

test("順位・人数が対局の4席に収まらない配点要求を拒否する", () => {
  for (const [rank, count] of [
    [0, 1],
    [5, 1],
    [1.5, 1],
    [1, 0],
    [1, 5],
    [3, 3],
    [1, 2.5],
  ]) {
    expect(() => tournamentRankPointsUnits(rank!, count!)).toThrow(RangeError);
  }
});

test("勝ち点、撃破、丸め前平均順位の優先順で比較し対局数自体を優先しない", () => {
  const a = standing({ games: 3, rankSum: 4, pointsUnits: 100, knockouts: 2 });
  expect(
    compareTournamentScores(a, standing({ ...a, pointsUnits: 99, knockouts: 100 })),
  ).toBeLessThan(0);
  expect(compareTournamentScores(a, standing({ ...a, knockouts: 1, rankSum: 3 }))).toBeLessThan(0);
  expect(compareTournamentScores(a, standing({ ...a, games: 4, rankSum: 5 }))).toBeGreaterThan(0);
  expect(
    compareTournamentScores(
      standing({ ...a, rankSum: 6 }),
      standing({ ...a, games: 2, rankSum: 4 }),
    ),
  ).toBe(0);
  const slightlyBetter = standing({ ...a, games: 1000, rankSum: 1999 });
  const slightlyWorse = standing({ ...a, games: 1000, rankSum: 2000 });
  expect((slightlyBetter.rankSum / slightlyBetter.games).toFixed(2)).toBe("2.00");
  expect((slightlyWorse.rankSum / slightlyWorse.games).toFixed(2)).toBe("2.00");
  expect(compareTournamentScores(slightlyBetter, slightlyWorse)).toBeLessThan(0);
});

test("完全同順位は順位を飛ばして公開ID順に並べ、0局には順位を付けず入力を変更しない", () => {
  const rows = [
    standing({ username: "second", pointsUnits: 24 }),
    standing({ username: "zulu" }),
    standing({ username: "unplayed", games: 0, pointsUnits: 0, rankSum: 0, first: 0 }),
    standing({ username: "alpha" }),
    standing({ username: "last", pointsUnits: 0, rankSum: 4, first: 0, fourth: 1 }),
  ];
  const ranked = rankTournamentStandings(rows);
  expect(ranked.map((row) => [row.username, row.rank])).toEqual([
    ["alpha", 1],
    ["zulu", 1],
    ["second", 3],
    ["last", 4],
    ["unplayed", null],
  ]);
  expect(rows.every((row) => row.rank === null)).toBe(true);
  expect(rankTournamentStandings([])).toEqual([]);
  expect(
    rankTournamentStandings([standing({ games: 0, pointsUnits: 0, rankSum: 0 })])[0]!.rank,
  ).toBeNull();
});

test("点数表示は最大小数2桁とし、正確な内部単位から順位を判定する", () => {
  expect([0, 6, 12, 21, 28, 48, 1200].map(formatTournamentPoints)).toEqual([
    "0",
    "0.5",
    "1",
    "1.75",
    "2.33",
    "4",
    "100",
  ]);
  expect(formatTournamentPoints(28 * 3)).toBe("7");
  expect(
    compareTournamentScores(standing({ pointsUnits: 28 }), standing({ pointsUnits: 27 })),
  ).toBeLessThan(0);
});

test("大会名と説明はUnicode文字数で制限し、改行を正規化して空欄下書きと日時順を検証する", () => {
  expect(tournamentInputSchema.parse({ ...input, name: "😀".repeat(80) }).name).toBe(
    "😀".repeat(80),
  );
  expect(tournamentInputSchema.safeParse({ ...input, name: "😀".repeat(81) }).success).toBe(false);
  expect(tournamentInputSchema.safeParse({ ...input, name: "  \n " }).success).toBe(false);
  for (const field of ["description", "rulesDescription"] as const) {
    expect(tournamentInputSchema.safeParse({ ...input, [field]: "😀".repeat(2000) }).success).toBe(
      true,
    );
    expect(tournamentInputSchema.safeParse({ ...input, [field]: "😀".repeat(2001) }).success).toBe(
      false,
    );
  }
  expect(
    tournamentInputSchema.parse({ ...input, description: "一行目\r\n二行目\r三行目" }).description,
  ).toBe("一行目\n二行目\n三行目");
  expect(
    tournamentInputSchema.safeParse({ ...input, startsAtMs: null, endsAtMs: null }).success,
  ).toBe(true);
  expect(tournamentInputSchema.safeParse({ ...input, startsAtMs: 2000 }).success).toBe(false);
  expect(tournamentInputSchema.safeParse({ ...input, startsAtMs: 3000 }).success).toBe(false);
  expect(tournamentInputSchema.safeParse({ ...input, startsAtMs: -1 }).success).toBe(false);
});

test("管理編集は許可された自由文と日時だけを受け付け、版なし・版不正・機械条件の混入を拒否する", () => {
  expect(tournamentPatchSchema.safeParse({ ...input, version: 1 }).success).toBe(true);
  expect(tournamentPatchSchema.safeParse(input).success).toBe(false);
  expect(tournamentPublishSchema.safeParse({ version: 1 }).success).toBe(true);
  expect(tournamentPublishSchema.safeParse({}).success).toBe(false);
  for (const version of [-1, 1.5, "1", null]) {
    expect(tournamentPatchSchema.safeParse({ ...input, version }).success).toBe(false);
    expect(tournamentPublishSchema.safeParse({ version }).success).toBe(false);
  }
  for (const [field, value] of Object.entries({
    byoyomiMs: 1000,
    pointsUnits: [1, 2, 3, 4],
    ruleVersion: 2,
    published: true,
    id: 1,
    key: operationId,
  })) {
    expect(tournamentInputSchema.safeParse({ ...input, [field]: value }).success).toBe(false);
    expect(tournamentPatchSchema.safeParse({ ...input, version: 1, [field]: value }).success).toBe(
      false,
    );
    expect(tournamentPublishSchema.safeParse({ version: 1, [field]: value }).success).toBe(false);
  }
});

test("待機・取消・参加確認は有効な操作IDを要求し、tokenや別の対局への混入を拒否する", () => {
  const queue = { operationId, token: "ab".repeat(32) };
  expect(tournamentQueueInputSchema.safeParse(queue).success).toBe(true);
  for (const token of [
    "a".repeat(63),
    "a".repeat(65),
    "G".repeat(64),
    "a".repeat(63) + " ",
    null,
  ]) {
    expect(tournamentQueueInputSchema.safeParse({ ...queue, token }).success).toBe(false);
  }
  expect(tournamentQueueInputSchema.safeParse({ ...queue, operationId: "invalid" }).success).toBe(
    false,
  );
  expect(tournamentQueueInputSchema.safeParse({ ...queue, accountId: "other" }).success).toBe(
    false,
  );
  expect(tournamentOperationSchema.safeParse({ operationId }).success).toBe(true);
  expect(tournamentOperationSchema.safeParse({ operationId, token: queue.token }).success).toBe(
    false,
  );
  expect(
    tournamentConfirmationSchema.safeParse({ operationId, matchId, accept: true }).success,
  ).toBe(true);
  expect(
    tournamentConfirmationSchema.safeParse({ operationId, matchId, accept: false }).success,
  ).toBe(true);
  expect(
    tournamentConfirmationSchema.safeParse({ operationId, matchId, accept: "true" }).success,
  ).toBe(false);
  expect(tournamentConfirmationSchema.safeParse({ operationId, accept: true }).success).toBe(false);
  expect(
    tournamentConfirmationSchema.safeParse({
      operationId,
      matchId,
      accept: true,
      token: queue.token,
    }).success,
  ).toBe(false);
});

test("公開詳細と管理名簿の契約へメール・内部アカウントID・資格を混入させない", () => {
  const published = {
    id: 1,
    ...input,
    status: "upcoming",
    entryCount: 0,
    waitingCount: 0,
    playingCount: 0,
    pendingCount: 0,
    completedCount: 0,
    ruleVersion: 1,
    finalizedAtMs: null,
  };
  expect(tournamentPublicSchema.safeParse(published).success).toBe(true);
  const adminEntry = {
    name: "てとら",
    username: "tetra",
    avatarUrl: null,
    enteredAtMs: 1000,
    status: "idle",
    games: 0,
    pointsUnits: 0,
    knockouts: 0,
    rank: null,
  };
  expect(tournamentAdminEntrySchema.safeParse(adminEntry).success).toBe(true);
  for (const extra of [
    { email: "private@example.com" },
    { accountId: operationId },
    { token: "a".repeat(64) },
    { key: operationId },
  ]) {
    expect(tournamentPublicSchema.safeParse({ ...published, ...extra }).success).toBe(false);
    expect(tournamentAdminEntrySchema.safeParse({ ...adminEntry, ...extra }).success).toBe(false);
  }
  expect(tournamentPublicSchema.safeParse({ ...published, status: "draft" }).success).toBe(false);
});
