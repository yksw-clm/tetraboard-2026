import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { expect, test } from "vitest";
import worker from "../src/worker";
import { accountFixture, origin } from "./accountFixtures";
import { humanFixtureRecord, fixtureRecord } from "./matchFixtures";
import { humanShogiRecord, saveShogiFixture } from "./shogiMatchFixtures";
import { createInitialState, eliminateColor } from "@tetraboard/four-reversi";
import { writeMatch } from "../src/rooms/matchStore";
import { badgeNotificationResponseSchema } from "@tetraboard/protocol";
import { badgeAwardsSql } from "../src/accounts/badgeAwards";

const db = env.APP_DB;
function winningRecord(accountId: string, index: number) {
  const record = humanFixtureRecord(accountId, index);
  let state = createInitialState("singles");
  const steps: typeof record.replay.steps = [];
  for (const color of ["white", "red", "blue"] as const) {
    const result = eliminateColor(state, color);
    if (!result.ok) throw new Error("Invalid fixture");
    state = result.state;
    steps.push({
      action: { type: "eliminate" as const, color, reason: "left" as const },
      game: JSON.parse(JSON.stringify(state)),
      passedColors: [...result.passedColors],
    });
  }
  if (state.status !== "finished") throw new Error("Unfinished fixture");
  record.game = state;
  record.eliminations = steps.map((s) => ({ color: s.action.color, reason: "left" as const }));
  record.replay.steps = steps;
  return record;
}
const awards = (id: string) =>
  db
    .prepare("SELECT * FROM account_badge_awards WHERE account_id = ? ORDER BY badge_id, tier")
    .bind(id)
    .all();
const operation = (
  user: Awaited<ReturnType<typeof accountFixture>>,
  name: string,
  token: string,
  id?: string,
  database = db,
) =>
  worker.fetch(
    new Request(`${origin}/api/account/badge-notifications/${name}`, {
      method: "POST",
      headers: user.headers,
      body: JSON.stringify({ token, ...(id ? { id } : {}) }),
    }),
    { ...env, APP_DB: database },
    {} as ExecutionContext,
  );
async function claim(user: Awaited<ReturnType<typeof accountFixture>>, token: string) {
  const response = await operation(user, "claim", token);
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  return badgeNotificationResponseSchema.parse(await response.json()).notification;
}

test("committed human singles cross thresholds once, including upgrades; CPU, doubles and guests do not award", async () => {
  const user = await accountFixture();
  const token = crypto.randomUUID();
  await writeMatch(db, fixtureRecord(user.id, 300));
  await writeMatch(db, humanFixtureRecord(user.id, 301, "doubles"));
  const guest = humanFixtureRecord(user.id, 302);
  guest.participants.forEach((p) => {
    if (p.kind === "human") p.accountId = null;
  });
  await writeMatch(db, guest);
  expect(await claim(user, token)).toBeNull();
  for (let i = 1; i <= 100; i++) {
    const record = winningRecord(user.id, i);
    await writeMatch(db, record);
    if (i === 3) {
      const notice = (await claim(user, token))!;
      expect(notice.badges).toEqual([{ id: "wins", tier: 1, previousTier: 0, value: 3 }]);
      const competitor = crypto.randomUUID();
      expect(await claim(user, competitor)).toBeNull();
      const same = await claim(user, token);
      expect(same?.id).toBe(notice.id);
      expect((await operation(user, "shown", competitor, notice.id)).status).toBe(409);
      expect((await operation(user, "shown", token, notice.id)).status).toBe(200);
      expect((await operation(user, "shown", token, notice.id)).status).toBe(200);
      expect(await claim(user, competitor)).toBeNull();
    }
    if (i === 5) {
      await writeMatch(db, record);
      const conflicting = structuredClone(record);
      conflicting.participants[0] = {
        ...conflicting.participants[0]!,
        kind: "human",
        accountId: "different-user",
      };
      await writeMatch(db, conflicting);
      expect((await awards("different-user")).results).toEqual([]);
    }
  }
  const rows = (await awards(user.id)).results;
  expect(rows).toHaveLength(6);
  expect(
    rows.filter((r) => r.badge_id === "games").map((r) => [r.tier, r.value, r.previous_tier]),
  ).toEqual([
    [1, 5, 0],
    [2, 20, 1],
    [3, 100, 2],
  ]);
  expect(
    rows.filter((r) => r.badge_id === "wins").map((r) => [r.tier, r.value, r.previous_tier]),
  ).toEqual([
    [1, 3, 0],
    [2, 15, 1],
    [3, 50, 2],
  ]);
  await writeMatch(db, winningRecord(user.id, 101));
  expect((await awards(user.id)).results).toHaveLength(6);
});

test("four-shogi publishes all simultaneous badges with its verified final batch and keeps games independent", async () => {
  const user = await accountFixture();
  for (let i = 0; i < 4; i++)
    await saveShogiFixture(humanShogiRecord(user.id, i < 2 ? "west" : "south"));
  const fifth = humanShogiRecord(user.id);
  fifth.record.knockouts.south = 3;
  await saveShogiFixture(fifth);
  const rows = (await awards(user.id)).results;
  expect(rows.map((r) => r.badge_id)).toEqual(["games", "knockouts", "perfect-wins", "wins"]);
  const token = crypto.randomUUID();
  const notification = (await claim(user, token))!;
  expect(notification.game).toBe("four-shogi");
  expect(notification.id).toBe(fifth.record.id);
  expect(notification.badges.map((b) => b.id)).toEqual([
    "games",
    "wins",
    "knockouts",
    "perfect-wins",
  ]);
  await saveShogiFixture(fifth);
  expect((await awards(user.id)).results).toHaveLength(4);
  await writeMatch(db, humanFixtureRecord(user.id, 1));
  expect((await awards(user.id)).results).toHaveLength(4);
});

test("failure to persist notification rolls back match, indexes and awards, and retry publishes exactly once", async () => {
  const user = await accountFixture();
  for (let i = 1; i <= 2; i++) await writeMatch(db, winningRecord(user.id, i));
  const record = winningRecord(user.id, 3);
  await db
    .prepare(`CREATE TRIGGER fail_badge_notification BEFORE INSERT ON account_badge_notifications
    WHEN NEW.account_id = '${user.id}' BEGIN SELECT RAISE(ABORT, 'notification failure'); END;`)
    .run();
  try {
    await expect(writeMatch(db, record)).rejects.toThrow();
    expect(
      await db.prepare("SELECT id FROM matches WHERE id = ?").bind(record.id).first(),
    ).toBeNull();
    expect((await awards(user.id)).results).toEqual([]);
  } finally {
    await db.exec("DROP TRIGGER fail_badge_notification");
  }
  await writeMatch(db, record);
  await writeMatch(db, record);
  expect((await awards(user.id)).results).toHaveLength(1);
});

test("leases serialize tabs/devices, expire or release without losing events, and cannot cross accounts", async () => {
  const user = await accountFixture();
  const other = await accountFixture();
  for (let i = 1; i <= 5; i++) await writeMatch(db, winningRecord(user.id, i));
  const token = crypto.randomUUID();
  const competitor = crypto.randomUUID();
  const [a, b] = await Promise.all([claim(user, token), claim(user, competitor)]);
  expect([a, b].filter(Boolean)).toHaveLength(1);
  const notification = (a ?? b)!;
  const winner = a ? token : competitor;
  const loser = a ? competitor : token;
  expect(await claim(user, loser)).toBeNull();
  expect((await operation(other, "shown", winner, notification.id)).status).toBe(409);
  expect((await operation(user, "renew", winner, notification.id)).status).toBe(200);
  await db
    .prepare("UPDATE account_badge_notifications SET claim_until_ms = 0 WHERE account_id = ?")
    .bind(user.id)
    .run();
  expect((await operation(user, "shown", winner, notification.id)).status).toBe(409);
  expect((await claim(user, loser))?.id).toBe(notification.id);
  await operation(user, "release", loser, notification.id);
  expect((await claim(user, winner))?.id).toBe(notification.id);
  await operation(user, "shown", winner, notification.id);
  expect((await claim(user, loser))?.badges.map((b) => b.id)).toEqual(["games"]);
  expect(await claim(other, crypto.randomUUID())).toBeNull();
});

test("API rejects anonymous, invalid origins and malformed input, preserving pending notifications", async () => {
  const user = await accountFixture();
  const token = crypto.randomUUID();
  for (const [headers, body, status] of [
    [{ Origin: origin, "Content-Type": "application/json" }, JSON.stringify({ token }), 401],
    [{ ...user.headers, Origin: "https://evil.test" }, JSON.stringify({ token }), 403],
    [user.headers, "{invalid", 400],
    [user.headers, JSON.stringify({ token: "invalid" }), 400],
  ] as const) {
    const response = await worker.fetch(
      new Request(`${origin}/api/account/badge-notifications/claim`, {
        method: "POST",
        headers,
        body,
      }),
      env,
      {} as ExecutionContext,
    );
    expect(response.status).toBe(status);
  }
});

test("migration snapshots historical badges without notifications and detects the next upgrade", async () => {
  const migrations = (
    env as typeof env & { TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1] }
  ).TEST_MIGRATIONS;
  const database = (env as typeof env & { BADGE_MIGRATION_TEST_DB: D1Database })
    .BADGE_MIGRATION_TEST_DB;
  const last = migrations.find((m) => m.name.includes("0013_badge_notifications"))!;
  await applyD1Migrations(
    database,
    migrations.filter((m) => m.name < last.name),
  );
  const user = await accountFixture(true, crypto.randomUUID(), database);
  for (let i = 1; i <= 19; i++) {
    const record = winningRecord(user.id, i);
    await database.batch([
      database
        .prepare("INSERT INTO matches VALUES (?, ?, ?, ?, ?, ?)")
        .bind(
          record.id,
          "four-reversi",
          "singles",
          record.startedAtMs,
          record.endedAtMs,
          JSON.stringify(record),
        ),
      database
        .prepare(
          "INSERT INTO account_match_history (account_id, match_id, mode, started_at_ms, game) VALUES (?, ?, ?, ?, ?)",
        )
        .bind(user.id, record.id, "singles", record.startedAtMs, "four-reversi"),
    ]);
  }
  await applyD1Migrations(
    database,
    migrations.filter((m) => m.name >= last.name),
  );
  const baseline = await database
    .prepare("SELECT badge_id, MAX(tier) AS tier FROM account_badge_awards GROUP BY badge_id")
    .all();
  expect(baseline.results).toEqual([
    { badge_id: "games", tier: 1 },
    { badge_id: "wins", tier: 2 },
  ]);
  expect(
    (await database.prepare("SELECT * FROM account_badge_notifications").all()).results,
  ).toEqual([]);
  // 過去migrationの固定SQLは維持し、新しい本人関係の集計でも基準行が増えないことを確認します。
  for (const game of ["four-reversi", "four-shogi"] as const)
    await database.prepare(badgeAwardsSql(game, true)).bind(game).run();
  expect(
    (
      await database
        .prepare("SELECT COUNT(*) AS n FROM account_badge_awards")
        .first<{ n: number }>()
    )?.n,
  ).toBe(3);
  await writeMatch(database, humanFixtureRecord(user.id, 20));
  const response = await operation(user, "claim", crypto.randomUUID(), undefined, database);
  expect(badgeNotificationResponseSchema.parse(await response.json()).notification?.badges).toEqual(
    [{ id: "games", tier: 2, previousTier: 1, value: 20 }],
  );
});
