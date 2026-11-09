import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, expect, test } from "vitest";
import { shogiRoomSchema } from "@tetraboard/protocol";
import { ShogiProgress, type ShogiCpuJob } from "../src/rooms/standardShogiProgress";
import {
  advanceShogiMatchSave,
  pendingStandardShogiMatchPrefix,
  type PendingStandardShogiMatch,
} from "../src/rooms/shogiMatchStore";
import { accountFixture } from "./accountFixtures";
import { boundaryRequest, RoomBoundaryFixtures } from "./roomBoundaryFixtures";
import { saveStandardShogiFixture, standardShogiRecord } from "./standardShogiFixtures";
import { getPlayerProfileContract, shogiRatingResultSchema } from "@tetraboard/protocol";

const cpuProfile = { kind: "cpu", profileId: "test-engine-v1", referenceRating: 1500 } as const;
type Change = {
  account_id: string;
  rating_before: number;
  rating_after: number;
  rated_games: number;
  human_games: number;
};

async function changes(matchId: string) {
  return (
    await env.APP_DB.prepare(
      `SELECT account_id, rating_before, rating_after, rated_games, human_games
       FROM shogi_rating_changes WHERE match_id = ?`,
    )
      .bind(matchId)
      .all<Change>()
  ).results;
}

function ratedCpuRecord(accountId: string, outcome: "win" | "loss" | "draw" = "win") {
  const fixture = standardShogiRecord(accountId, outcome, true);
  fixture.record.rating = cpuProfile;
  return fixture;
}

function ratedHumanRecord(south: string, north: string, outcome: "win" | "draw" = "win") {
  const fixture = standardShogiRecord(south, outcome);
  const opponent = fixture.record.participants[1];
  if (opponent.kind !== "human") throw new Error("Expected human opponent");
  opponent.accountId = north;
  fixture.record.rating = { kind: "human" };
  return fixture;
}

test("CPU戦の認定5局目にはK=48を使い、6局目には固定CPUレートとK=16を使う", async () => {
  const { id } = await accountFixture();
  for (let i = 0; i < 4; i++) await saveStandardShogiFixture(ratedCpuRecord(id, "draw"));
  const fifth = ratedCpuRecord(id);
  await saveStandardShogiFixture(fifth);
  expect(await changes(fifth.record.id)).toEqual([
    { account_id: id, rating_before: 1500, rating_after: 1524, rated_games: 5, human_games: 0 },
  ]);

  const sixth = ratedCpuRecord(id, "loss");
  sixth.record.rating = { ...cpuProfile, referenceRating: 1624 };
  await saveStandardShogiFixture(sixth);
  const rows = await changes(sixth.record.id);
  expect(rows).toEqual([
    {
      account_id: id,
      rating_before: 1524,
      rating_after: expect.any(Number),
      rated_games: 6,
      human_games: 0,
    },
  ]);
  expect(rows[0].rating_after).toBeCloseTo(1524 - 16 / (1 + 10 ** 0.25), 10);
});

test("認定中の進捗は本人だけに返し、5局目の保存後から公開プロフィールにレートを載せる", async () => {
  const user = await accountFixture();
  const other = await accountFixture();
  const { publicProfileId } = (await env.APP_DB.prepare(
    "SELECT publicProfileId FROM user WHERE id=?",
  )
    .bind(user.id)
    .first<{ publicProfileId: string }>())!;
  const publicProfile = async () =>
    getPlayerProfileContract.response.parse(
      await (
        await boundaryRequest(
          `/player-profile?source=profile&profileId=${publicProfileId}&game=shogi&includeShogiRating=1`,
        )
      ).json(),
    );
  const resultPath = (id: string) => `/matchmaking/shogi/results/${id}`;
  const summaryPath = "/matchmaking/shogi/rating";
  const summary = async (headers: HeadersInit) => {
    const response = await boundaryRequest(summaryPath, { headers });
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    return response.json();
  };
  const read = async (id: string) => {
    const response = await boundaryRequest(resultPath(id), { headers: user.headers });
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    return shogiRatingResultSchema.parse(await response.json());
  };
  const first = ratedCpuRecord(user.id, "draw");
  expect(await summary(user.headers)).toEqual({ status: "placement", games: 0 });
  expect((await boundaryRequest(summaryPath)).status).toBe(401);
  await saveStandardShogiFixture(first);
  expect(await summary(user.headers)).toEqual({ status: "placement", games: 1 });
  expect(await summary(other.headers)).toEqual({ status: "placement", games: 0 });
  expect(await read(first.record.id)).toEqual({ status: "placement", games: 1 });
  expect(await publicProfile()).not.toHaveProperty("shogiRating");
  expect(
    (await boundaryRequest(resultPath(first.record.id), { headers: other.headers })).status,
  ).toBe(404);
  expect((await boundaryRequest(resultPath(first.record.id))).status).toBe(401);

  for (let i = 0; i < 3; i++) await saveStandardShogiFixture(ratedCpuRecord(user.id, "draw"));
  const fifth = ratedCpuRecord(user.id);
  await env.APP_DB.prepare("INSERT INTO shogi_rating_pending VALUES (?,?)")
    .bind(user.id, fifth.record.id)
    .run();
  expect(await read(fifth.record.id)).toEqual({ status: "pending" });
  await saveStandardShogiFixture(fifth);
  expect(await summary(user.headers)).toEqual({ status: "rated", rating: 1524 });
  expect(await read(fifth.record.id)).toEqual({
    status: "rated",
    rating: 1524,
    previousRating: 1500,
    humanPlayed: false,
    placementCompleted: true,
  });
  expect(await publicProfile()).toMatchObject({
    shogiRating: { rating: 1524, humanPlayed: false },
  });

  const excluded = ratedCpuRecord(user.id);
  excluded.record.rating = { ...cpuProfile, usedFallback: true };
  await saveStandardShogiFixture(excluded);
  expect(await read(excluded.record.id)).toEqual({ status: "excluded", reason: "ai_fallback" });
});

test("対人戦では両者の更新前レートを使い、認定状態に応じてそれぞれ更新する", async () => {
  const { id: south } = await accountFixture();
  const { id: north } = await accountFixture();
  for (let i = 0; i < 5; i++) await saveStandardShogiFixture(ratedCpuRecord(south, "draw"));

  const win = ratedHumanRecord(south, north);
  await saveStandardShogiFixture(win);
  expect(await changes(win.record.id)).toEqual(
    expect.arrayContaining([
      {
        account_id: south,
        rating_before: 1500,
        rating_after: 1516,
        rated_games: 6,
        human_games: 1,
      },
      {
        account_id: north,
        rating_before: 1500,
        rating_after: 1468,
        rated_games: 1,
        human_games: 1,
      },
    ]),
  );

  const draw = ratedHumanRecord(south, north, "draw");
  await saveStandardShogiFixture(draw);
  const rows = await changes(draw.record.id);
  const expectedSouth = 1 / (1 + 10 ** (-48 / 400));
  expect(rows.find((row) => row.account_id === south)?.rating_after).toBeCloseTo(
    1516 + 32 * (0.5 - expectedSouth),
    10,
  );
  expect(rows.find((row) => row.account_id === north)?.rating_after).toBeCloseTo(
    1468 + 64 * (0.5 - (1 - expectedSouth)),
    10,
  );
});

test("棋譜検証までレートは動かず、確定後に同じ保存を再試行しても二重更新しない", async () => {
  const { id: south } = await accountFixture();
  const { id: north } = await accountFixture();
  const fixture = ratedHumanRecord(south, north);
  const readEvents = (cursor: number) => fixture.events.slice(cursor, cursor + 100);
  const upload = { phase: "upload", cursor: 0 } as const;
  const verify = await advanceShogiMatchSave(env.APP_DB, fixture.record, upload, readEvents);
  expect(verify).toEqual({ phase: "verify", cursor: 0 });
  expect(await changes(fixture.record.id)).toEqual([]);
  expect(await advanceShogiMatchSave(env.APP_DB, fixture.record, verify!, readEvents)).toBeNull();
  const applied = await changes(fixture.record.id);
  expect(applied).toHaveLength(2);
  for (const checkpoint of [verify!, upload]) {
    expect(
      await advanceShogiMatchSave(env.APP_DB, fixture.record, checkpoint, readEvents),
    ).toBeNull();
  }
  expect(await changes(fixture.record.id)).toEqual(applied);
  const next = ratedHumanRecord(south, north);
  await saveStandardShogiFixture(next);
  expect((await changes(next.record.id)).map((row) => row.rated_games)).toEqual([2, 2]);

  const response = await boundaryRequest(`/matches/${fixture.record.id}`);
  expect(response.status).toBe(200);
  expect((await response.json<{ match: unknown }>()).match).not.toHaveProperty("rating");
});

test("通常対局や登録アカウントが両側に揃わない対人戦はレートを更新しない", async () => {
  const { id } = await accountFixture();
  const regular = standardShogiRecord(id, "win", true);
  const missingOpponent = standardShogiRecord(id);
  missingOpponent.record.rating = { kind: "human" };
  for (const fixture of [regular, missingOpponent]) {
    await saveStandardShogiFixture(fixture);
    expect(await changes(fixture.record.id)).toEqual([]);
  }
});

let rooms: RoomBoundaryFixtures;
beforeEach(() => {
  rooms = new RoomBoundaryFixtures();
});
afterEach(async () => {
  await rooms.dispose();
});

test.each(["fallback", "external", "unplayed"] as const)(
  "CPU着手の結果が終局時のレート対象に反映される (%s)",
  async (scenario) => {
    const { id } = await accountFixture();
    const entry = await rooms.create({ game: "shogi", name: "人間", quickPlay: true });
    const fixture = await runInDurableObject(
      env.GAME_ROOM.getByName(entry.room.id),
      (_instance, context) => {
        const progress = new ShogiProgress({
          storage: context.storage,
          membership: () => ({ playerId: entry.membership.playerId, role: "host" }),
          accountId: () => id,
        });
        const waiting = shogiRoomSchema.parse({
          ...entry.room,
          settings: { game: "shogi", timeControl: { mainTimeMs: 300000, byoyomiMs: 30000 } },
          players: entry.room.players.map((p) => (p.kind === "cpu" ? { ...p, level: 2 } : p)),
        });
        if (waiting.status !== "waiting") throw new Error("Expected waiting room");
        let room = progress.start(waiting, cpuProfile).room;
        const cpu = room.players.find((p) => p.kind === "cpu")!;
        if (room.game.turn !== cpu.side) {
          const played = progress.play(room, "human", {
            type: "room.game.action",
            roundId: room.roundId,
            positionRevision: room.positionRevision,
            action: room.legalActions[0],
          });
          if (played.kind !== "playing") throw new Error("Expected human move");
          room = played.room;
        }
        const now = Date.now();
        const work = progress.prepareExternalCpu(room, now, 4000);
        if (!work) throw new Error("Expected external CPU job");
        progress.completeExternalCpu(
          room,
          work,
          scenario === "external" ? (cpu.side === "south" ? "7g7f" : "3c3d") : null,
          now,
        );
        const job = context.storage.kv.get<ShogiCpuJob>("standard-shogi-cpu-job")!;
        expect(job.external).toBe(scenario === "external" ? true : undefined);
        if (scenario !== "unplayed") {
          const played = progress.cpu(room, job.applyAt);
          if (played.kind !== "playing") throw new Error("Expected CPU move");
          room = played.room;
        }
        const ended = progress.eliminate(room, entry.membership.playerId, "left", job.applyAt + 1);
        if (ended.kind !== "finished") throw new Error("Expected finished game");
        progress.finalize(ended);
        const pending = context.storage.kv.get<PendingStandardShogiMatch>(
          pendingStandardShogiMatchPrefix + room.roundId,
        )!;
        return { record: pending.record, events: progress.store().replayEvents(room.roundId, 0) };
      },
    );
    await saveStandardShogiFixture(fixture);
    expect(fixture.record.rating).toEqual(
      scenario === "fallback" ? { ...cpuProfile, usedFallback: true } : cpuProfile,
    );
    expect((await boundaryRequest(`/matches/${fixture.record.id}`)).status).toBe(200);
    expect(await changes(fixture.record.id)).toEqual(
      scenario === "fallback"
        ? []
        : [
            {
              account_id: id,
              rating_before: 1500,
              rating_after: 1476,
              rated_games: 1,
              human_games: 0,
            },
          ],
    );
  },
);
