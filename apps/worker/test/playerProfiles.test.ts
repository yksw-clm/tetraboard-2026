import { AcceptedGameRequest } from "./acceptedGameRequest";
import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeAll, afterEach, expect, test } from "vitest";
import worker from "../src/worker";
import {
  getPlayerProfileContract,
  getAccountStatsContract,
  createRoomContract,
  joinRoomContract,
  listRoomsContract,
  previewRoomListSchema,
  previewRankingsSchema,
  gameRankingContracts,
  type GameId,
  type PlayerProfileTarget,
  playerProfileTargetSchema,
} from "@tetraboard/protocol";
import { accountFixture, origin } from "./accountFixtures";
import { fixtureRecord, humanFixtureRecord } from "./matchFixtures";
import { humanShogiRecord, saveShogiFixture, shogiRecord } from "./shogiMatchFixtures";
import { type MatchRecord, writeMatch } from "../src/rooms/matchStore";
const db = (env as typeof env & { PUBLIC_MATCH_TEST_DB: D1Database }).PUBLIC_MATCH_TEST_DB;
const ids: string[] = [];
const request = (path: string, init?: RequestInit, database = db) =>
  worker.fetch(
    new AcceptedGameRequest(`${origin}/api${path}`, init),
    { ...env, APP_DB: database },
    {} as ExecutionContext,
  );
const lookup = (target: PlayerProfileTarget, game: GameId, database = db, includeBadges = false) =>
  request(
    `/player-profile?${new URLSearchParams({ ...target, game, ...(includeBadges ? { includeBadges: "1" } : {}) })}`,
    undefined,
    database,
  );
async function allRooms(preview = false) {
  const rooms = [];
  let cursor: string | null = null;
  do {
    const query = new URLSearchParams(preview ? { profilePreview: "1" } : {});
    if (cursor) query.set("cursor", cursor);
    const response = await request(`/rooms?${query}`, undefined, env.APP_DB);
    expect(response.status).toBe(200);
    const page = previewRoomListSchema.parse(await response.json());
    rooms.push(...page.rooms);
    cursor = page.nextCursor;
  } while (cursor);
  return rooms;
}
beforeAll(async () => {
  await applyD1Migrations(
    db,
    (env as typeof env & { TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1] })
      .TEST_MIGRATIONS,
  );
});
afterEach(async () => {
  for (const id of ids.splice(0))
    await db.batch([
      db.prepare("DELETE FROM account_match_history WHERE match_id = ?").bind(id),
      db.prepare("DELETE FROM matches WHERE id = ?").bind(id),
      db.prepare("DELETE FROM shogi_match_chunks WHERE match_id = ?").bind(id),
      db.prepare("DELETE FROM shogi_match_uploads WHERE id = ?").bind(id),
    ]);
});
test("extended stats rejects unsupported opt-in values", async () => {
  expect(
    (
      await request(
        `/player-profile?source=profile&profileId=${crypto.randomUUID()}&game=four-shogi&includeStats=0`,
      )
    ).status,
  ).toBe(400);
});

test("migration assigns unique UUIDs to existing accounts and keeps previous-code inserts compatible", async () => {
  const migrations = (
    env as typeof env & {
      TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
    }
  ).TEST_MIGRATIONS;
  const migration = migrations.find((item) => item.name.includes("0010_player_profiles"))!;
  await db.exec(
    "CREATE TABLE preview_migration_user (id TEXT PRIMARY KEY, name TEXT); CREATE TABLE preview_migration_rooms (room_id TEXT PRIMARY KEY);",
  );
  try {
    await db.exec(
      "INSERT INTO preview_migration_user VALUES ('one', '同名'), ('two', '同名'); INSERT INTO preview_migration_rooms VALUES ('12345');",
    );
    const sql = migration.queries
      .join("\n")
      .replace(/\buser\b/g, "preview_migration_user")
      .replace(/\broom_index\b/g, "preview_migration_rooms")
      .replace("user_public_profile_id_idx", "preview_migration_public_id_idx");
    await db.exec(sql);
    const rows = await db
      .prepare("SELECT publicProfileId FROM preview_migration_user ORDER BY id")
      .all<{ publicProfileId: string }>();
    expect(new Set(rows.results.map((r) => r.publicProfileId)).size).toBe(2);
    for (const row of rows.results)
      expect(
        playerProfileTargetSchema.safeParse({ source: "profile", profileId: row.publicProfileId })
          .success,
      ).toBe(true);
    await db.exec(
      "INSERT INTO preview_migration_user (id, name) VALUES ('old-worker', '登録者'); UPDATE preview_migration_user SET name = '変更名' WHERE id = 'one';",
    );
    expect(
      (
        await db
          .prepare("SELECT publicProfileId FROM preview_migration_user WHERE id = 'old-worker'")
          .first()
      )?.publicProfileId,
    ).toBeNull();
    expect(
      (
        await db
          .prepare("SELECT publicProfileId FROM preview_migration_user WHERE id = 'one'")
          .first()
      )?.publicProfileId,
    ).toBe(rows.results[0]!.publicProfileId);
    await expect(
      db
        .prepare("UPDATE preview_migration_user SET publicProfileId = ? WHERE id = 'two'")
        .bind(rows.results[0]!.publicProfileId)
        .run(),
    ).rejects.toThrow();
    expect(
      await db.prepare("SELECT instance_id, host_player_id FROM preview_migration_rooms").first(),
    ).toEqual({ instance_id: null, host_player_id: null });
  } finally {
    await db.exec("DROP TABLE preview_migration_user; DROP TABLE preview_migration_rooms;");
  }
});
for (const game of ["four-reversi", "four-shogi"] as const) {
  test(`${game}: anonymous preview shares committed account stats and follows the immutable identity after rename`, async () => {
    const user = await accountFixture(true, crypto.randomUUID(), db);
    const other = await accountFixture(true, crypto.randomUUID(), db);
    const shogi = game === "four-shogi" ? humanShogiRecord(user.id, "south", "singles") : null;
    const record = shogi?.record ?? humanFixtureRecord(user.id, 1);
    ids.push(record.id);
    if (shogi) await saveShogiFixture(shogi, db);
    else await writeMatch(db, record as MatchRecord);
    const target = {
      source: "match" as const,
      matchId: record.id,
      playerId: record.participants[0]!.id,
    };
    const response = await lookup(target, game);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const profile = getPlayerProfileContract.response.parse(await response.json());
    if (profile.kind !== "account" || !("singles" in profile.stats))
      throw new Error("Account preview expected");
    expect(profile.profileId).not.toBe(user.id);
    const stats = parseLegacyStats(
      await (
        await request(`/account/stats?game=${game}`, { headers: { Cookie: user.cookie } })
      ).json(),
    );
    expect(profile.stats.singles).toEqual({
      total: stats.singles.total,
      first: stats.singles.first,
    });
    expect(profile.stats.doubles).toEqual({ total: stats.doubles.total, wins: stats.doubles.wins });
    const extendedResponse = await request(
      `/player-profile?${new URLSearchParams({ ...target, game, includeStats: "1" })}`,
    );
    expect(extendedResponse.status).toBe(200);
    const extended = getPlayerProfileContract.response.parse(await extendedResponse.json());
    if (extended.kind !== "account") throw new Error("Account preview expected");
    expect(extended.stats).toEqual(stats);
    for (const secret of [user.id, "accountId", "email", "replay", "token"])
      expect(JSON.stringify(extended)).not.toContain(secret);
    for (const secret of [user.id, "accountId", "email", "second", "knockouts", "replay", "token"])
      expect(JSON.stringify(profile)).not.toContain(secret);
    await db
      .prepare("UPDATE user SET name = ?, username = ? WHERE id = ?")
      .bind("新しい名前", `new_${user.username.slice(2)}`, user.id)
      .run();
    await db
      .prepare("UPDATE user SET username = ? WHERE id = ?")
      .bind(user.username, other.id)
      .run();
    const current = getPlayerProfileContract.response.parse(
      await (await lookup({ source: "profile", profileId: profile.profileId }, game)).json(),
    );
    expect(current).toMatchObject({
      kind: "account",
      profileId: profile.profileId,
      name: "新しい名前",
    });
    expect(
      getPlayerProfileContract.response.parse(await (await lookup(target, game)).json()),
    ).toEqual(current);
    expect(
      (await lookup(target, game === "four-reversi" ? "four-shogi" : "four-reversi")).status,
    ).toBe(400);
    const legacyRanking = await request(`/games/${game}/rankings`);
    gameRankingContracts[game].response.parse(await legacyRanking.json());
    const ranking = previewRankingsSchema.parse(
      await (await request(`/games/${game}/rankings?profilePreview=1`)).json(),
    );
    expect(ranking.singles.total.find((p) => p.name === "新しい名前")?.profileId).toBe(
      profile.profileId,
    );
  });
}
test("guest, CPU, missing account, invalid target and D1 failure stay distinct", async () => {
  const record = humanFixtureRecord(crypto.randomUUID(), 1);
  ids.push(record.id);
  const first = record.participants[0]!;
  if (first.kind !== "human") throw new Error("Human expected");
  first.accountId = null;
  const cpu = record.participants[1]!;
  record.participants[1] = {
    id: cpu.id,
    name: "CPU Lv2",
    color: cpu.color,
    seat: cpu.seat,
    kind: "cpu",
    level: 2,
  };
  await writeMatch(db, record);
  const target = (index: number) => ({
    source: "match" as const,
    matchId: record.id,
    playerId: record.participants[index]!.id,
  });
  expect(await (await lookup(target(0), "four-reversi")).json()).toEqual({
    kind: "guest",
    name: first.name,
    avatarUrl: null,
  });
  expect(await (await lookup(target(1), "four-reversi")).json()).toEqual({ kind: "cpu", level: 2 });
  expect(await (await lookup(target(0), "four-reversi", db, true)).json()).not.toHaveProperty(
    "badges",
  );
  expect(await (await lookup(target(1), "four-reversi", db, true)).json()).not.toHaveProperty(
    "badges",
  );
  // The remaining human has a saved account reference whose current account is absent.
  const missing = record.participants[2]!;
  if (missing.kind !== "human") throw new Error("Human expected");
  missing.accountId = crypto.randomUUID();
  await db
    .prepare("UPDATE matches SET record_json = ? WHERE id = ?")
    .bind(JSON.stringify(record), record.id)
    .run();
  expect((await lookup(target(2), "four-reversi")).status).toBe(404);
  expect((await request("/player-profile?source=profile&profileId=bad&game=all")).status).toBe(400);
  await db.exec("ALTER TABLE user RENAME COLUMN avatarKey TO avatarKey_unavailable");
  try {
    expect((await lookup(target(2), "four-reversi")).status).toBe(503);
  } finally {
    await db.exec("ALTER TABLE user RENAME COLUMN avatarKey_unavailable TO avatarKey");
  }
});
test("room generation, host handoff and legacy room indexes preserve identity and default wire shape", async () => {
  const user = await accountFixture();
  const created = createRoomContract.response.parse(
    await (
      await request(
        "/rooms",
        {
          method: "POST",
          headers: user.headers,
          body: JSON.stringify({ mode: "singles", quickPlay: false }),
        },
        env.APP_DB,
      )
    ).json(),
  );
  const room = created.room;
  const target = {
    source: "room" as const,
    roomId: room.id,
    instanceId: room.instanceId,
    playerId: created.membership.playerId,
  };
  try {
    expect((await lookup(target, "four-reversi", env.APP_DB)).status).toBe(200);
    expect(await (await lookup(target, "four-reversi", env.APP_DB, true)).json()).toMatchObject({
      kind: "account",
      badges: [],
    });
    expect(
      (await lookup({ ...target, instanceId: crypto.randomUUID() }, "four-reversi", env.APP_DB))
        .status,
    ).toBe(410);
    const plain = listRoomsContract.response.parse(
      await (await request("/rooms", undefined, env.APP_DB)).json(),
    );
    for (const listed of plain.rooms) expect(listed).not.toHaveProperty("profileTarget");
    await env.APP_DB.prepare(
      "UPDATE room_index SET instance_id = NULL, host_player_id = NULL WHERE room_id = ?",
    )
      .bind(room.id)
      .run();
    const enhanced = { rooms: await allRooms(true) };
    expect(enhanced.rooms.find((r) => r.id === room.id)?.profileTarget).toEqual(target);
    const joined = joinRoomContract.response.parse(
      await (
        await request(
          `/rooms/${room.id}/players`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: "ゲスト" }),
          },
          env.APP_DB,
        )
      ).json(),
    );
    await request(
      `/rooms/${room.id}/leave`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${created.membership.token}` },
      },
      env.APP_DB,
    );
    expect((await lookup(target, "four-reversi", env.APP_DB)).status).toBe(404);
    const updated = (await allRooms(true)).find((r) => r.id === room.id)!;
    expect(updated.profileTarget).toMatchObject({ playerId: joined.membership.playerId });
    await request(
      `/rooms/${room.id}/leave`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${joined.membership.token}` },
      },
      env.APP_DB,
    );
  } finally {
    await request(
      `/rooms/${room.id}/leave`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${created.membership.token}` },
      },
      env.APP_DB,
    );
  }
});

test("badge opt-in derives independent games from historical human singles including ties, excluding CPU and doubles", async () => {
  const user = await accountFixture(true, crypto.randomUUID(), db);
  let reversiTarget: PlayerProfileTarget | undefined;
  let shogiTarget: PlayerProfileTarget | undefined;
  for (let index = 1; index <= 5; index++) {
    const record = humanFixtureRecord(user.id, index);
    if (record.game.result.mode !== "singles") throw new Error("Singles expected");
    record.game.result.standings = record.game.result.standings.map((entry) => ({
      ...entry,
      rank: entry.color === "black" ? 1 : entry.rank,
    }));
    ids.push(record.id);
    await writeMatch(db, record);
    reversiTarget = { source: "match", matchId: record.id, playerId: record.participants[0]!.id };
  }
  for (const record of [fixtureRecord(user.id, 6), humanFixtureRecord(user.id, 7, "doubles")]) {
    ids.push(record.id);
    await writeMatch(db, record);
  }
  for (const [knockouts, kind] of [
    [3, "win"],
    [2, "win"],
    [3, "draw"],
    [3, "loss"],
    [0, "win"],
  ] as const) {
    const fixture = humanShogiRecord(user.id);
    fixture.record.knockouts.south = knockouts;
    if (kind === "draw")
      fixture.record.game.result = {
        mode: "singles",
        reason: "agreement",
        standings: fixture.record.participants.map(({ side }) => ({ side, rank: 1 })),
      };
    if (kind === "loss")
      fixture.record.game.result = {
        mode: "singles",
        reason: "last_player",
        standings: fixture.record.participants.map(({ side }, index) => ({
          side,
          rank: side === "south" ? 2 : side === "west" ? 1 : index + 1,
        })),
      };
    ids.push(fixture.record.id);
    await saveShogiFixture(fixture, db);
    shogiTarget = {
      source: "match",
      matchId: fixture.record.id,
      playerId: fixture.record.participants[0]!.id,
    };
  }
  for (const fixture of [shogiRecord(user.id), humanShogiRecord(user.id, "south", "doubles")]) {
    if (fixture.record.settings.mode === "singles") fixture.record.knockouts.south = 3;
    ids.push(fixture.record.id);
    await saveShogiFixture(fixture, db);
  }
  for (const [game, target, expected] of [
    [
      "four-reversi",
      reversiTarget!,
      [
        { id: "games", tier: 1, value: 5 },
        { id: "wins", tier: 1, value: 5 },
      ],
    ],
    [
      "four-shogi",
      shogiTarget!,
      [
        { id: "games", tier: 1, value: 5 },
        { id: "wins", tier: 1, value: 4 },
        { id: "knockouts", tier: 1, value: 11 },
        { id: "perfect-wins", tier: 1, value: 1 },
      ],
    ],
  ] as const) {
    const legacy = (await (await lookup(target, game)).json()) as { profileId: string };
    expect(legacy).not.toHaveProperty("badges");
    const response = await lookup(target, game, db, true);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const result = getPlayerProfileContract.response.parse(await response.json());
    expect(result).toMatchObject({ kind: "account", badges: expected });
    expect(JSON.stringify(result)).not.toContain(user.id);
    expect(JSON.stringify(result)).not.toContain("accountId");
    expect(
      await (
        await lookup({ source: "profile", profileId: legacy.profileId }, game, db, true)
      ).json(),
    ).toEqual(result);
  }
  expect(
    (
      await request(
        `/player-profile?source=profile&profileId=${crypto.randomUUID()}&game=four-shogi&includeBadges=0`,
      )
    ).status,
  ).toBe(400);
});

function parseLegacyStats(value: unknown) {
  const stats = getAccountStatsContract.response.parse(value);
  if (!("singles" in stats)) throw Error("Expected four-player stats");
  return stats;
}
