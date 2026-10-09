import { env } from "cloudflare:workers";
import { afterEach, beforeEach, expect, test } from "vitest";
import { gameRankingContracts } from "@tetraboard/protocol";
import { boundaryRequest } from "./roomBoundaryFixtures";
import { accountFixture } from "./accountFixtures";
import { humanFixtureRecord } from "./matchFixtures";
import { humanShogiRecord, saveShogiFixture } from "./shogiMatchFixtures";
import { writeMatch } from "../src/rooms/matchStore";
const users: Awaited<ReturnType<typeof accountFixture>>[] = [];
const records: string[] = [];
beforeEach(async () => {
  await env.APP_DB.batch([
    env.APP_DB.prepare("DELETE FROM account_match_history"),
    env.APP_DB.prepare("DELETE FROM matches"),
  ]);
});
afterEach(async () => {
  for (const id of records.splice(0))
    await env.APP_DB.batch([
      env.APP_DB.prepare("DELETE FROM account_match_history WHERE match_id = ?").bind(id),
      env.APP_DB.prepare("DELETE FROM shogi_match_chunks WHERE match_id = ?").bind(id),
      env.APP_DB.prepare("DELETE FROM shogi_match_uploads WHERE id = ?").bind(id),
      env.APP_DB.prepare("DELETE FROM matches WHERE id = ?").bind(id),
    ]);
  for (const user of users.splice(0))
    await env.APP_DB.batch([
      env.APP_DB.prepare("DELETE FROM session WHERE userId = ?").bind(user.id),
      env.APP_DB.prepare("DELETE FROM user WHERE id = ?").bind(user.id),
    ]);
});
test("公開ランキング両経路は両モードをゲーム別に集計する", async () => {
  const reversi = await accountFixture();
  const shogi = await accountFixture();
  users.push(reversi, shogi);
  let index = 0;
  for (const mode of ["singles", "doubles"] as const) {
    const record = humanFixtureRecord(reversi.id, ++index, mode);
    records.push(record.id);
    await writeMatch(env.APP_DB, record);
    for (let at = 0; at < 2; at++) {
      const fixture = humanShogiRecord(shogi.id, "south", mode);
      records.push(fixture.record.id);
      await saveShogiFixture(fixture);
    }
  }
  for (const game of ["four-reversi", "four-shogi"] as const) {
    const contract = gameRankingContracts[game];
    const response = await boundaryRequest(contract.path);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const result = contract.response.parse(await response.json());
    const expected = game === "four-reversi" ? reversi : shogi;
    for (const mode of ["singles", "doubles"] as const) {
      expect(result[mode].total.map((entry) => [entry.username, entry.value])).toEqual([
        [expected.username, game === "four-reversi" ? 1 : 2],
      ]);
    }
    expect(result.singles.first).toHaveLength(game === "four-reversi" ? 0 : 1);
    expect(result.doubles.wins).toHaveLength(game === "four-reversi" ? 0 : 1);
  }
});
