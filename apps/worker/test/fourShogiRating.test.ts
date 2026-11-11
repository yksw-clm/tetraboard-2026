import { env } from "cloudflare:workers";
import { expect, test } from "vitest";
import { fourReversiRatingMethod } from "../../../packages/ai/fourReversiRating";
import { accountFixture } from "./accountFixtures";
import { saveShogiFixture, shogiRecord } from "./shogiMatchFixtures";

test.each([
  { mainTimeMs: 0, byoyomiMs: 30_000, counted: true },
  { mainTimeMs: 180_000, byoyomiMs: 0, counted: true },
  { mainTimeMs: 300_000, byoyomiMs: 30_000, counted: false },
] as const)(
  "四人将棋の新旧レート戦の時計だけを更新対象にする $mainTimeMs + $byoyomiMs",
  async ({ mainTimeMs, byoyomiMs, counted }) => {
    const user = await accountFixture();
    const fixture = shogiRecord(user.id);
    fixture.record.settings.timeControl = { mainTimeMs, byoyomiMs };
    fixture.record.fourShogiRating = {
      method: fourReversiRatingMethod,
      calibrationVersion: "test-v1",
      cpu: Object.fromEntries(
        fixture.record.participants.flatMap((player) =>
          player.kind === "cpu"
            ? [
                [
                  player.side,
                  {
                    mu: 25,
                    sigma: 1,
                    profileId: "test-v1",
                    engineVersion: "test-v1",
                  },
                ],
              ]
            : [],
        ),
      ),
    };
    await saveShogiFixture(fixture);
    await saveShogiFixture(fixture);
    const { results } = await env.APP_DB.prepare(
      "SELECT account_id, rated_games FROM four_shogi_rating_changes WHERE match_id=?",
    )
      .bind(fixture.record.id)
      .all();
    expect(results).toEqual(counted ? [{ account_id: user.id, rated_games: 1 }] : []);
  },
);
