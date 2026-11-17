import { expect, test } from "bun:test";
import {
  readRatingSummary,
  readPublicRating,
  readProfileRating,
  readBeforeRating,
  readRatingRankings,
  readPendingRating,
  readPendingRatingAccounts,
  readEloRatingResult,
  readSkillRatingResult,
  type EloResultRow,
  type SkillResultRow,
} from "../src";
import { MemoryRatings } from "./memoryPorts";

test.each(["shogi", "reversi", "four-shogi", "four-reversi"] as const)(
  "%s の配置戦と現在・開始前の公開値",
  async (game) => {
    const store = new MemoryRatings();
    expect(await readRatingSummary(store, game, "a")).toEqual({ status: "placement", games: 0 });
    for (const games of [4, 5, 6]) {
      const elo = game === "shogi" || game === "reversi";
      store.latestRows.set(`${game}:a`, {
        rating_after: elo ? 1520 : 25.4,
        rated_games: games,
        human_games: 1,
      });
      expect(await readProfileRating(store, game, "a", "current")).toEqual(
        games === 4
          ? { timing: "current", status: "placement" }
          : { timing: "current", status: "rated", rating: 1520, humanPlayed: true },
      );
      expect(await readProfileRating(store, game, "a", "before")).toEqual(
        games === 4
          ? { timing: "before", status: "placement" }
          : { timing: "before", status: "rated", rating: 1520 },
      );
      expect(await readPublicRating(store, game, "a")).toEqual(
        games === 4 ? undefined : { rating: 1520, humanPlayed: true },
      );
      expect(await readRatingSummary(store, game, "a")).toEqual(
        games === 4
          ? { status: "placement", games: 4 }
          : { status: "rated", rating: 1520, ...(!elo ? { humanPlayed: true } : {}) },
      );
      store.beforeRow = { rating: elo ? 1520 : 25.4, rated_games: games };
      expect(await readBeforeRating(store, game, "match", "a")).toEqual(
        games <= 5
          ? { timing: "before", status: "placement" }
          : { timing: "before", status: "rated", rating: 1520 },
      );
    }
    store.beforeRow = null;
    expect(await readBeforeRating(store, game, "match", "a")).toEqual({
      timing: "before",
      status: "unavailable",
    });
  },
);

function eloRow(): EloResultRow {
  return {
    phase: "saved",
    fallback: null,
    rating_before: 1500,
    rating_after: 1516,
    rated_games: 5,
    human_games: 1,
    cpu_rating: null,
    opponent_before: 1500,
    opponent_after: 1468,
    opponent_games: 1,
  };
}
test("Elo の結果は保存待ち・除外・認定・対戦相手の形を保つ", async () => {
  const store = new MemoryRatings();
  const read = () => readEloRatingResult(store, "shogi", "a", "match", true);
  expect(await read()).toBeNull();
  store.eloRow = { ...eloRow(), phase: "pending" };
  expect(await read()).toEqual({ status: "pending" });
  store.eloRow = { ...eloRow(), rated_games: null, fallback: 1 };
  expect(await read()).toEqual({ status: "excluded", reason: "ai_fallback" });
  store.eloRow.fallback = null;
  expect(await read()).toEqual({ status: "excluded", reason: "unavailable" });
  store.eloRow = eloRow();
  expect(await read()).toEqual({
    status: "rated",
    rating: 1516,
    previousRating: 1500,
    humanPlayed: true,
    placementCompleted: true,
    opponent: { status: "placement" },
  });
  store.eloRow = { ...eloRow(), rated_games: 4, cpu_rating: 1600 };
  expect(await read()).toEqual({
    status: "placement",
    games: 4,
    opponent: { status: "cpu", rating: 1600 },
  });
  store.eloRow = { ...eloRow(), rated_games: 6, opponent_games: 5 };
  expect(await read()).toMatchObject({
    placementCompleted: false,
    opponent: { status: "rated", rating: 1468, previousRating: 1500 },
  });
});
function own(): SkillResultRow {
  return {
    player_id: "own",
    own: 1,
    fallback: null,
    cpu_mu: null,
    mu_before: 25,
    mu_after: 25.4,
    rated_games: 5,
    human_games: 1,
    pending: 0,
  };
}
test("skill の結果は保存待ちを優先し、要求された相手だけ返す", async () => {
  const store = new MemoryRatings();
  const read = (include = false) =>
    readSkillRatingResult(store, "four-shogi", "a", "match", include);
  expect(await read()).toBeNull();
  store.skillRows = [
    own(),
    { ...own(), own: 0, player_id: "cpu", cpu_mu: 27 },
    { ...own(), own: 0, player_id: "placement", rated_games: 4 },
    { ...own(), own: 0, player_id: "rated" },
  ];
  expect(await read()).toEqual({
    status: "rated",
    rating: 1520,
    previousRating: 1500,
    humanPlayed: true,
    placementCompleted: true,
    players: {},
  });
  expect(await read(true)).toMatchObject({
    players: {
      cpu: { status: "cpu", rating: 1600 },
      placement: { status: "placement" },
      rated: { status: "rated", rating: 1520, previousRating: 1500 },
    },
  });
  store.skillRows.push({ ...own(), pending: 1 });
  expect(await read(true)).toEqual({ status: "pending" });
  store.skillRows = [{ ...own(), mu_after: null, fallback: 1 }];
  expect(await read()).toEqual({ status: "excluded", reason: "ai_fallback" });
  store.skillRows = [{ ...own(), mu_before: null }];
  expect(await read()).toEqual({ status: "excluded", reason: "unavailable" });
  store.skillRows = [{ ...own(), rated_games: 4 }];
  expect(await read()).toEqual({ status: "placement", games: 4, players: {} });
});

test("ランキングは公開整数の降順・username の昇順で10人、同率で順位を飛ばす", async () => {
  const store = new MemoryRatings();
  const values = [1500, 1700, 1600, 1600, 1550, 1400, 1300, 1200, 1100, 1000, 900, -1];
  store.rankingRows = values
    .map((value, i) => ({
      accountId: String(i),
      profileId: String(i),
      username: String(i).padStart(2, "0"),
      name: "name",
      avatarKey: null,
      avatarPresetId: null,
      value,
      rank: 0,
    }))
    .reverse();
  const rows = await readRatingRankings(store, "shogi");
  expect(rows.map((r) => [r.rank, r.username, r.value])).toEqual([
    [1, "01", 1700],
    [2, "02", 1600],
    [2, "03", 1600],
    [4, "04", 1550],
    [5, "00", 1500],
    [6, "05", 1400],
    [7, "06", 1300],
    [8, "07", 1200],
    [9, "08", 1100],
    [10, "09", 1000],
  ]);
  expect(store.rankingRows[0]!.username).toBe("11");
});
test("前局は要求ゲームを優先し、なければ元のゲーム順で探す", async () => {
  const store = new MemoryRatings();
  const games = ["reversi", "shogi", "four-reversi", "four-shogi"] as const;
  store.pending = [
    { accountId: "a", game: "shogi", match_id: "shogi", room_id: null, instance_id: null },
    {
      accountId: "a",
      game: "reversi",
      match_id: "reversi",
      room_id: "room",
      instance_id: "instance",
    },
  ];
  expect((await readPendingRating(store, "a", "shogi", [...games]))?.match_id).toBe("shogi");
  expect((await readPendingRating(store, "a", "four-shogi", [...games]))?.match_id).toBe("reversi");
  store.pending.push({
    game: "four-shogi",
    accountId: "b",
    match_id: "b",
    room_id: null,
    instance_id: null,
  });
  expect(await readPendingRatingAccounts(store, ["a", "absent"])).toEqual(new Set(["a"]));
  expect((await readPendingRating(store, "b", "shogi", [...games]))?.match_id).toBe("b");
  store.pending = [];
  expect(await readPendingRating(store, "a", "shogi", [...games])).toBeNull();
});
