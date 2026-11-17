import { expect, test } from "bun:test";
import { compareWaits, orderWaits, nearestRankedCpu, estimatedMatchAt, type Wait } from "../src";
import { fourReversi, fourShogi, policies } from "./policies";
import { MemoryMatchmaking } from "./memory";

const wait = (operationId: string, sequence: number, joinedAtMs: number): Wait => ({
  accountId: operationId,
  operationId,
  controllerId: "tab",
  version: 1,
  sequence,
  joinedAtMs,
  expiresAtMs: 145_000,
});

test("旧列は採番順、四人リバーシのレート列は開始時刻・操作IDで順序を保つ", () => {
  const entries = [wait("b", 3, 100), wait("c", 1, 200), wait("a", 2, 100)];
  expect([...entries].sort(compareWaits).map((w) => w.operationId)).toEqual(["c", "a", "b"]);
  const state = { key: "rated", waiting: entries, groups: [] };
  orderWaits({ game: "four-reversi", legacy: false }, state);
  expect(state.waiting.map((w) => w.operationId)).toEqual(["a", "b", "c"]);
  expect(
    [wait("later", 1, 200), wait("earlier", 1, 100)].sort(compareWaits).map((w) => w.operationId),
  ).toEqual(["earlier", "later"]);
});

test("四人の安定した推定は最古を含む最も近い組を選び、10秒・20秒で範囲を広げる", () => {
  const players = [25, 28, 25.5, 27, 26].map((rating, id) => ({
    id,
    rating,
    sigma: 2,
    ratedGames: 10,
  }));
  expect(fourReversi.selectFourReversi(players, 0)?.selected.map((p) => p.id)).toEqual([
    0, 2, 3, 4,
  ]);
  const wide = [25, 30, 31, 32].map((rating) => ({ rating, sigma: 2, ratedGames: 10 }));
  expect(fourReversi.selectFourReversi(wide, 9_999)).toBeUndefined();
  expect(fourReversi.selectFourReversi(wide, 10_000)?.selected).toEqual(wide);
  const far = [25, 40, 50, 60].map((rating) => ({ rating, sigma: 2, ratedGames: 10 }));
  expect(fourReversi.selectFourReversi(far, 19_999)).toBeUndefined();
  expect(fourReversi.selectFourReversi(far, 20_000)?.selected).toEqual(far);
});

test("認定前の参加者を含む4人は待機順で成立し、候補は先頭16人に限る", () => {
  const provisional = [25, 40, 50, 60].map((rating) => ({ rating }));
  expect(fourReversi.selectFourReversi(provisional, 0)?.selected).toEqual(provisional);
  const candidates = [25, ...Array(15).fill(60), 25, 25, 25].map((rating) => ({
    rating,
    sigma: 2,
    ratedGames: 10,
  }));
  expect(fourReversi.selectFourReversi(candidates, 0)).toBeUndefined();
});

test("四人ゲームは20秒到達時だけCPUを補充し、較正済みプロフィールを保存する", () => {
  expect(fourReversi.selectFourReversi([{}], 19_999)).toBeUndefined();
  expect(fourReversi.selectFourReversi([{}], 20_000)?.rating).toEqual({
    kind: "four-reversi",
    calibrationVersion: "four-reversi-lv1-lv5-v1",
    cpu: {
      profileId: "lv3-v1",
      profileHash: "c2b327ed2e4beebdaee84931b35cea50bf8cbaf54831e6e116219a5913cbc748",
      mu: 25,
      sigma: 1,
    },
  });
  expect(fourShogi.selectFourShogi([{}], 20_000)?.rating.cpu).toEqual({
    profileId: "four-shogi-lv3-work16384-v1",
    engineVersion: "four-shogi-lv3-v1",
    mu: 25,
    sigma: 1,
  });
});

test("CPUは認定済みの中央値に近い順で、同距離なら低いmu・profile ID順に選ぶ", () => {
  const profiles = [
    { mu: 26, profileId: "c" },
    { mu: 24, profileId: "b" },
    { mu: 24, profileId: "a" },
  ];
  expect(nearestRankedCpu([], profiles, 5)?.profileId).toBe("a");
  expect(
    nearestRankedCpu(
      [
        { rating: 24, ratedGames: 5 },
        { rating: 28, ratedGames: 5 },
        { rating: 100, ratedGames: 4 },
      ],
      profiles,
      5,
    )?.profileId,
  ).toBe("c");
});

test("二人戦は100・200・300のレート差で範囲を広げ、15秒でCPUへ進む", () => {
  const players = [{ rating: 1500 }, { rating: 1750 }, { rating: 1680 }];
  expect(policies.shogi.select(players, 4_999)).toBeUndefined();
  expect(policies.shogi.select(players, 5_000)?.selected).toEqual([players[0]!, players[2]!]);
  expect(policies.reversi.select(players.slice(0, 2), 10_000)?.rating).toEqual({
    kind: "reversi",
    source: { kind: "human" },
  });
  expect(policies.shogi.select([{ rating: 1500 }], 15_000)?.rating).toEqual({
    kind: "cpu",
    profileId: "yaneuraou-material-faeb37f0-n256-standard-book-v1",
    referenceRating: 1488,
  });
});

test("目安は先行するCPU対局枠を差し引き、枠不明・再試行中・期限後には返さない", () => {
  const m = new MemoryMatchmaking();
  m.r.ratingPolicy = policies.shogi;
  m.r.queueRules = { ...m.r.queueRules, seats: 2, fillAfterMs: 15_000 };
  m.state.waiting = [wait("one", 1, 100_000), wait("two", 2, 102_000)];
  m.state.waiting[0]!.rating = 1000;
  m.state.waiting[1]!.rating = 2000;
  expect(estimatedMatchAt(m.r, m.state, m.state.waiting[0]!, 103_000, 1)).toBe(115_000);
  expect(estimatedMatchAt(m.r, m.state, m.state.waiting[1]!, 103_000, 1)).toBeUndefined();
  expect(estimatedMatchAt(m.r, m.state, m.state.waiting[1]!, 103_000, 2)).toBe(117_000);
  expect(estimatedMatchAt(m.r, m.state, m.state.waiting[0]!, 115_000, 2)).toBeUndefined();
  expect(estimatedMatchAt(m.r, m.state, m.state.waiting[0]!, 103_000)).toBeUndefined();
  m.state.cpuRetryAtMs = 104_000;
  expect(estimatedMatchAt(m.r, m.state, m.state.waiting[0]!, 103_000, 2)).toBeUndefined();
});
