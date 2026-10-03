import { env } from "cloudflare:workers";
import { beforeEach, expect, test } from "vitest";
import {
  getAccountStatsContract,
  getMatchContract,
  getMatchReplayContract,
  listMatchesContract,
} from "@tetraboard/protocol";
import { accountFixture } from "./accountFixtures";
import { humanFixtureRecord, matchRequest } from "./matchFixtures";
import { humanShogiRecord, saveShogiFixture } from "./shogiMatchFixtures";
import { writeMatch } from "../src/rooms/matchStore";
import { readGameRankings } from "../src/rooms/rankingRoutes";

beforeEach(async () => {
  await env.APP_DB.batch([
    env.APP_DB.prepare("DELETE FROM account_match_history"),
    env.APP_DB.prepare("DELETE FROM matches"),
    env.APP_DB.prepare("DELETE FROM shogi_match_uploads"),
    env.APP_DB.prepare("DELETE FROM shogi_match_chunks"),
  ]);
});

for (const game of ["four-reversi", "four-shogi"] as const) {
  test(game + ": CPU戦の全順位・同率優勝・敗北・引き分けも集計しない", async () => {
    const user = await accountFixture();
    for (const [index, rank] of [1, 2, 3, 4, 1].entries()) {
      if (game === "four-shogi") {
        const fixture = humanShogiRecord(user.id);
        if (fixture.record.game.result.mode !== "singles") throw new Error("Wrong mode");
        fixture.record.game.result.standings = fixture.record.game.result.standings.map(
          (standing) => ({
            ...standing,
            rank: standing.side === "south" ? rank : index === 4 ? 1 : standing.rank,
          }),
        );
        const guest = fixture.record.participants[1]!;
        fixture.record.participants[1] = {
          id: guest.id,
          name: "CPU Lv1",
          seat: guest.seat,
          side: guest.side,
          kind: "cpu",
          level: 1,
        };
        fixture.record.knockouts.south = 3;
        await saveShogiFixture(fixture);
      } else {
        const record = humanFixtureRecord(user.id, index + 1);
        if (record.game.result.mode !== "singles") throw new Error("Wrong mode");
        record.game.result.standings = record.game.result.standings.map((standing) => ({
          ...standing,
          rank: standing.color === "black" ? rank : index === 4 ? 1 : standing.rank,
        }));
        const guest = record.participants[1]!;
        record.participants[1] = {
          id: guest.id,
          name: "CPU Lv1",
          seat: guest.seat,
          color: guest.color,
          kind: "cpu",
          level: 1,
        };
        await writeMatch(env.APP_DB, record);
      }
    }
    for (const draw of [false, true]) {
      if (game === "four-shogi") {
        const fixture = humanShogiRecord(user.id, "west", "doubles");
        if (fixture.record.game.result.mode !== "doubles") throw new Error("Wrong mode");
        if (draw)
          fixture.record.game.result = { mode: "doubles", reason: "repetition", winner: null };
        const guest = fixture.record.participants[0]!;
        fixture.record.participants[0] = {
          id: guest.id,
          name: "CPU Lv1",
          seat: guest.seat,
          side: guest.side,
          kind: "cpu",
          level: 1,
        };
        await saveShogiFixture(fixture);
      } else {
        const record = humanFixtureRecord(user.id, draw ? 8 : 7, "doubles");
        if (record.game.result.mode !== "doubles") throw new Error("Wrong mode");
        if (draw) record.game.result.winner = null;
        const guest = record.participants[1]!;
        record.participants[1] = {
          id: guest.id,
          name: "CPU Lv1",
          seat: guest.seat,
          color: guest.color,
          kind: "cpu",
          level: 1,
        };
        await writeMatch(env.APP_DB, record);
      }
    }
    const response = await matchRequest("/account/stats?game=" + game, {
      headers: { Cookie: user.cookie },
    });
    expect(response.status).toBe(200);
    expect(getAccountStatsContract.response.parse(await response.json())).toEqual({
      singles: {
        total: 0,
        first: 0,
        second: 0,
        third: 0,
        fourth: 0,
        ...(game === "four-shogi" ? { knockouts: 0 } : {}),
      },
      doubles: { total: 0, wins: 0, losses: 0, draws: 0 },
    });
    expect(await readGameRankings(env.APP_DB, game)).toEqual({
      singles: { first: [], total: [] },
      doubles: { wins: [], total: [] },
    });
  });
  for (const mode of ["singles", "doubles"] as const) {
    test(`${game} ${mode}: CPU1〜3人の過去局は戦績・ランキングから外し、履歴と棋譜を残す`, async () => {
      const user = await accountFixture();
      const headers = { Cookie: user.cookie };
      const readStats = async () => {
        const response = await matchRequest(`/account/stats?game=${game}`, { headers });
        expect(response.status).toBe(200);
        return getAccountStatsContract.response.parse(await response.json());
      };
      const empty = await readStats();
      const cpuIds: string[] = [];
      const expectedKnockouts = 2;
      for (const cpuCount of [1, 2, 3, 0]) {
        const shogi = humanShogiRecord(user.id, "south", mode);
        const record =
          game === "four-shogi" ? shogi.record : humanFixtureRecord(user.id, cpuCount + 1, mode);
        // リバーシも本人が勝者になるよう開始時の担当色を割り当てます。
        if (record.settings.game === "four-reversi") {
          const reversi = record as ReturnType<typeof humanFixtureRecord>;
          for (const player of reversi.participants) {
            if (player.color === "black") player.color = "blue";
            else if (player.color === "blue") player.color = "black";
          }
        } else if (mode === "singles")
          shogi.record.knockouts.south = cpuCount ? 3 : expectedKnockouts;
        record.participants = record.participants.map((player, index) =>
          index > 0 && index <= cpuCount
            ? {
                id: player.id,
                name: "CPU Lv1",
                seat: player.seat,
                ...("side" in player ? { side: player.side } : { color: player.color }),
                kind: "cpu" as const,
                level: 1 as const,
              }
            : player,
        ) as typeof record.participants;
        if (game === "four-shogi") await saveShogiFixture(shogi);
        else await writeMatch(env.APP_DB, record as ReturnType<typeof humanFixtureRecord>);
        if (cpuCount) {
          cpuIds.push(record.id);
          expect(await readStats()).toEqual(empty);
          expect(await readGameRankings(env.APP_DB, game)).toEqual({
            singles: { first: [], total: [] },
            doubles: { wins: [], total: [] },
          });
        }
      }
      const stats = await readStats();
      if (mode === "singles") {
        expect(stats.singles).toEqual({
          total: 1,
          first: 1,
          second: 0,
          third: 0,
          fourth: 0,
          ...(game === "four-shogi" ? { knockouts: expectedKnockouts } : {}),
        });
        expect(stats.doubles).toEqual(empty.doubles);
      } else {
        expect(stats.doubles).toEqual({ total: 1, wins: 1, losses: 0, draws: 0 });
        expect(stats.singles).toEqual(empty.singles);
      }
      const rankings = await readGameRankings(env.APP_DB, game);
      expect(rankings[mode].total.map((entry) => [entry.username, entry.value])).toEqual([
        [user.username, 1],
      ]);
      expect(
        (mode === "singles" ? rankings.singles.first : rankings.doubles.wins).map(
          (entry) => entry.value,
        ),
      ).toEqual([1]);
      const response = await matchRequest(`/account/matches?game=${game}&mode=${mode}`, {
        headers,
      });
      expect(response.status).toBe(200);
      const history = listMatchesContract.response.parse(await response.json());
      expect(history.matches).toHaveLength(4);
      for (const id of cpuIds) {
        expect(history.matches.some((match) => match.id === id)).toBe(true);
        const detail = await matchRequest(`/account/matches/${id}`, { headers });
        expect(detail.status).toBe(200);
        const { match } = getMatchContract.response.parse(await detail.json());
        expect(match.participants.some((player) => player.kind === "cpu")).toBe(true);
        if (game === "four-shogi") {
          expect("knockouts" in match && match.knockouts.south).toBe(mode === "singles" ? 3 : 0);
          const replay = await matchRequest(`/account/matches/${id}/replay`, { headers });
          expect(replay.status).toBe(200);
          expect(
            getMatchReplayContract.response.parse(await replay.json()).events.length,
          ).toBeGreaterThan(0);
        } else expect("replay" in match && match.replay).toBeTruthy();
      }
    });
  }
}
