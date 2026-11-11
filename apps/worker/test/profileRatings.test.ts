import { env, exports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, expect, test, vi } from "vitest";
import {
  getPlayerProfileContract,
  matchmakingQueues,
  type RatedMatchmakingGame,
} from "@tetraboard/protocol";
import { accountFixture, origin } from "./accountFixtures";
import { AcceptedGameRequest } from "./acceptedGameRequest";
import { standardShogiRecord } from "./standardShogiFixtures";
import { shogiRecord } from "./shogiMatchFixtures";
import { fixtureRecord } from "./matchFixtures";
import archive from "../../../test-fixtures/matches/reversi-standard-draw.json";
import { readStoredMatch } from "../src/accounts/matchDataContracts";
import { profileRatingsKey } from "../src/accounts/profileRatings";
import { redactRetiredParticipants } from "../src/privacy/identity";

const games = ["shogi", "reversi", "four-shogi", "four-reversi"] as const;
const savedMatches: string[] = [];
afterEach(async () => {
  for (const id of savedMatches.splice(0)) {
    await env.APP_DB.batch([
      ...games.map((game) =>
        env.APP_DB.prepare(
          `DELETE FROM ${game.replaceAll("-", "_")}_rating_changes WHERE match_id=?`,
        ).bind(id),
      ),
      env.APP_DB.prepare("DELETE FROM matches WHERE id=?").bind(id),
    ]);
  }
});
const request = (query: Record<string, string>) =>
  exports.default.fetch(
    new AcceptedGameRequest(`${origin}/api/player-profile?${new URLSearchParams(query)}`),
  );
async function profile(query: Record<string, string>) {
  const response = await request({ ...query, includeRating: "1" });
  expect(response.status).toBe(200);
  return getPlayerProfileContract.response.parse(await response.json());
}
function recordFor(game: RatedMatchmakingGame, accountId: string) {
  const base =
    game === "shogi"
      ? standardShogiRecord(accountId, "win", true).record
      : game === "four-shogi"
        ? shogiRecord(accountId).record
        : game === "four-reversi"
          ? fixtureRecord(accountId, 0)
          : {
              ...archive.detail,
              instanceId: crypto.randomUUID(),
              participants: archive.detail.participants.map((p, i) =>
                i === 0
                  ? {
                      id: p.id,
                      name: p.name,
                      color: p.color,
                      seat: p.seat,
                      kind: "human",
                      accountId,
                    }
                  : {
                      id: p.id,
                      name: "以前のCPU",
                      color: p.color,
                      seat: p.seat,
                      kind: "cpu",
                      level: 2,
                    },
              ),
            };
  const cpu = Object.fromEntries(
    base.participants
      .filter((p) => p.kind === "cpu")
      .map((p) => [
        "side" in p ? p.side : p.color,
        {
          mu: 25,
          sigma: 1,
          profileId: "preserved-profile",
          engineVersion: "v1",
          profileHash: "hash",
        },
      ]),
  );
  const ranked = game.startsWith("four-");
  const recordId = crypto.randomUUID();
  return readStoredMatch(
    JSON.stringify({
      ...base,
      id: recordId,
      ...("id" in base.replay ? { replay: { ...base.replay, id: recordId } } : {}),
      [ranked ? (game === "four-shogi" ? "fourShogiRating" : "fourReversiRating") : "rating"]:
        ranked
          ? {
              method: "openskill-5.0.1-plackett-luce",
              calibrationVersion: "saved-v1",
              cpu: Object.fromEntries(
                Object.entries(cpu).map(([key, value]) => {
                  const { engineVersion, profileHash, ...common } = value;
                  return [
                    key,
                    { ...common, ...(game === "four-shogi" ? { engineVersion } : { profileHash }) },
                  ];
                }),
              ),
            }
          : { kind: "cpu", profileId: "preserved-profile", referenceRating: 1499 },
    }),
    game,
  );
}
async function save(record: ReturnType<typeof recordFor>) {
  await env.APP_DB.prepare("INSERT INTO matches VALUES (?,?,?,?,?,?)")
    .bind(
      record.record.id,
      record.game,
      record.game.startsWith("four-") ? "singles" : "standard",
      record.record.startedAtMs,
      record.record.endedAtMs,
      JSON.stringify(record.record),
    )
    .run();
  savedMatches.push(record.record.id);
}

test("認定前の現在値は非公開とし、ゲストとレート非対応ゲームには欄を返さない", async () => {
  const user = await accountFixture();
  const profileId = await env.APP_DB.prepare("SELECT publicProfileId FROM user WHERE id=?")
    .bind(user.id)
    .first<string>("publicProfileId");
  for (const game of games) {
    expect(await profile({ source: "profile", profileId: profileId!, game })).toMatchObject({
      rating: { timing: "current", status: "placement" },
    });
  }
  for (const game of ["gomoku", "four-gomoku"]) {
    expect(await profile({ source: "profile", profileId: profileId!, game })).not.toHaveProperty(
      "rating",
    );
  }
  await env.APP_DB.prepare("UPDATE user SET isAnonymous=1 WHERE id=?").bind(user.id).run();
  for (const game of games) {
    expect(await profile({ source: "profile", profileId: profileId!, game })).not.toHaveProperty(
      "rating",
    );
  }
});
async function change(
  game: RatedMatchmakingGame,
  matchId: string,
  accountId: string,
  games: number,
) {
  const table = `${game.replaceAll("-", "_")}_rating_changes`;
  const ranked = game.startsWith("four-");
  await env.APP_DB.prepare(
    ranked
      ? `INSERT INTO ${table} (match_id,account_id,mu_before,sigma_before,mu_after,sigma_after,rated_games,human_games) VALUES (?,?,26,1,27,1,?,0)`
      : `INSERT INTO ${table} (match_id,account_id,rating_before,rating_after,rated_games,human_games) VALUES (?,?,1550,1600,?,0)`,
  )
    .bind(matchId, accountId, games)
    .run();
}

test.each(games)(
  "過去の%sの対局前レート・認定・CPU基準値を公開し、通常対局には出さない",
  async (game) => {
    const user = await accountFixture();
    const match = recordFor(game, user.id);
    await save(match);
    const human = match.record.participants.find((p) => p.kind === "human")!;
    const cpu = match.record.participants.find((p) => p.kind === "cpu")!;
    const query = { source: "match", game, matchId: match.record.id, playerId: human.id };
    expect(await profile(query)).toMatchObject({
      rating: { timing: "before", status: "unavailable" },
    });
    await change(game, match.record.id, user.id, 5);
    expect(await profile(query)).toMatchObject({
      rating: { timing: "before", status: "placement" },
    });
    const table = `${game.replaceAll("-", "_")}_rating_changes`;
    await env.APP_DB.prepare(`UPDATE ${table} SET rated_games=6 WHERE match_id=?`)
      .bind(match.record.id)
      .run();
    expect(await profile(query)).toMatchObject({
      rating: { timing: "before", status: "rated", rating: 1550 },
    });
    const publicId = await env.APP_DB.prepare("SELECT publicProfileId FROM user WHERE id=?")
      .bind(user.id)
      .first<string>("publicProfileId");
    expect(await profile({ source: "profile", profileId: publicId!, game })).toMatchObject({
      rating: { timing: "current", status: "rated", rating: 1600 },
    });
    expect(await profile({ ...query, playerId: cpu.id })).toMatchObject({
      rating: {
        timing: "reference",
        status: "rated",
        rating: game.startsWith("four-") ? 1500 : 1499,
      },
    });
    const legacy = await request(query);
    expect(legacy.status).toBe(200);
    expect(await legacy.json()).not.toHaveProperty("rating");
    const raw = JSON.parse(JSON.stringify(match.record));
    delete raw.rating;
    delete raw.fourReversiRating;
    delete raw.fourShogiRating;
    await env.APP_DB.prepare("UPDATE matches SET record_json=? WHERE id=?")
      .bind(JSON.stringify(raw), match.record.id)
      .run();
    expect(await profile(query)).not.toHaveProperty("rating");
    expect(await profile({ ...query, playerId: cpu.id })).not.toHaveProperty("rating");
  },
);

test.each(games)("新規%sの成立時のレートを固定し、後続の更新から分離する", async (game) => {
  const user = await accountFixture();
  const seed = recordFor(game, user.id);
  await save(seed);
  await change(game, seed.record.id, user.id, 5);
  let now = Date.now() + 60_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const queue = env.MATCHMAKING_COORDINATOR.getByName(matchmakingQueues[game].key);
  const controller = crypto.randomUUID();
  let roomId: string | undefined;
  try {
    expect((await queue.join(user.id, crypto.randomUUID(), controller)).ok).toBe(true);
    now += matchmakingQueues[game].fillAfterMs;
    await runInDurableObject(queue, (instance) => instance.alarm());
    const assignment = (await queue.status(user.id, controller)).assignment!;
    roomId = assignment.roomId;
    const room = await env.GAME_ROOM.getByName(roomId).getRoom();
    expect(room).not.toBeNull();
    const human = room!.players.find((p) => p.kind === "human")!;
    const cpu = room!.players.find((p) => p.kind === "cpu")!;
    const query = {
      source: "room",
      game,
      roomId,
      instanceId: room!.instanceId,
      playerId: human.id,
    };
    expect(await profile(query)).toMatchObject({
      rating: { timing: "before", status: "rated", rating: 1600 },
    });
    const table = `${game.replaceAll("-", "_")}_rating_changes`;
    await env.APP_DB.prepare(
      `UPDATE ${table} SET ${game.startsWith("four-") ? "mu_after=30" : "rating_after=1900"} WHERE account_id=?`,
    )
      .bind(user.id)
      .run();
    expect(await profile(query)).toMatchObject({
      rating: { timing: "before", status: "rated", rating: 1600 },
    });
    expect(await profile({ ...query, playerId: cpu.id })).toMatchObject({
      rating: { timing: "reference", status: "rated" },
    });
    const frozen = await runInDurableObject(env.GAME_ROOM.getByName(roomId), (_, ctx) =>
      ctx.storage.kv.get(profileRatingsKey(assignment.matchId)),
    );
    const stored = readStoredMatch(
      JSON.stringify({ ...seed.record, profileRatings: frozen }),
      game,
    );
    expect("profileRatings" in stored.record && stored.record.profileRatings?.[human.id]).toEqual({
      timing: "before",
      status: "rated",
      rating: 1600,
    });
  } finally {
    await queue.leaveAccount(user.id);
    if (roomId)
      await runInDurableObject(env.GAME_ROOM.getByName(roomId), (_, ctx) =>
        ctx.storage.deleteAll(),
      );
    vi.restoreAllMocks();
  }
});

test("退会者の保存済み対局前レートを匿名化で除去する", () => {
  const id = crypto.randomUUID();
  const other = crypto.randomUUID();
  const result = redactRetiredParticipants(
    {
      participants: [{ id, kind: "human", name: "本人", accountId: "account" }],
      profileRatings: {
        [id]: { timing: "before", status: "rated", rating: 1550 },
        [other]: { timing: "reference", status: "rated", rating: 1500 },
      },
    },
    new Set([id]),
    new Set(),
  );
  expect(result.profileRatings).not.toHaveProperty(id);
  expect(result.profileRatings).toHaveProperty(other);
});
