import { env } from "cloudflare:workers";
import { afterEach, expect, test } from "vitest";
import { gameIds } from "@tetraboard/protocol/games";
import { shogiArchives } from "../../../test-fixtures/matches";
import { accountCreatedAtMsSql, accountRegisteredAtMsSql } from "@tetraboard/context-account";
import { normalizeLegacyData } from "./legacyDataFixtures";

const db = env.APP_DB;
const prefix = `normalize-${crypto.randomUUID()}-`;
afterEach(async () => {
  await db.prepare("DELETE FROM matches WHERE id LIKE ?").bind(`${prefix}%`).run();
  await db.prepare("DELETE FROM user WHERE id LIKE ?").bind(`${prefix}%`).run();
});
const matchRows = async () =>
  (
    await db.prepare("SELECT * FROM matches WHERE id LIKE ? ORDER BY id").bind(`${prefix}%`).all<{
      id: string;
      game: string;
      record_json: string;
    }>()
  ).results;

test("0046: 四人将棋の欠落した引分提案だけを追加し、他の値・行・スキーマを保持する", async () => {
  const legacy = shogiArchives.find((fixture) => fixture.name === "shogi-legacy")!;
  const records = [
    { game: "four-shogi", json: legacy.recordJson },
    ...[[], ["south"], null].map((drawProposals) => ({
      game: "four-shogi",
      json: JSON.stringify({ game: { drawProposals }, other: [null, "棋譜", 1.25] }, null, 2),
    })),
    ...gameIds
      .filter((game) => game !== "four-shogi")
      .map((game) => ({
        game,
        json: '{ "game": { "moveNumber": 7 }, "replay": { "initial": {} } }',
      })),
  ];
  await db.batch(
    records.map(({ game, json }, index) =>
      db
        .prepare("INSERT INTO matches VALUES(?,?, 'singles',1,2,?)")
        .bind(`${prefix}${index}`, game, json),
    ),
  );
  const schema = async () =>
    (await db.prepare("SELECT * FROM sqlite_master ORDER BY type,name").all()).results;
  const beforeSchema = await schema();
  const before = await matchRows();

  await normalizeLegacyData(db);

  const after = await matchRows();
  expect(after).toHaveLength(before.length);
  for (const row of after) {
    const previous = before.find((value) => value.id === row.id)!;
    if (row.id === `${prefix}0`) {
      const original = JSON.parse(previous.record_json);
      expect(JSON.parse(row.record_json)).toEqual({
        ...original,
        game: { ...original.game, drawProposals: [] },
      });
      expect({ ...row, record_json: previous.record_json }).toEqual(previous);
    } else expect(row).toEqual(previous);
  }
  expect(await schema()).toEqual(beforeSchema);
  await normalizeLegacyData(db);
  expect(await matchRows()).toEqual(after);
});

test("0046: userの両日時をミリ秒を保ったISO textへ統一し、他の列を保持する", async () => {
  const dates = [
    [Date.parse("2026-10-02T15:38:11.458Z"), Date.parse("2026-11-15T00:00:00.001Z"), 1],
    ["2026-10-02T15:38:11.458Z", Date.parse("2026-11-15T00:00:00.999Z"), null],
    [Date.parse("2024-02-29T23:59:59.999Z"), "2026-11-15T00:00:01.010Z", 0],
    ["2026-10-02T15:38:11.458Z", "2026-11-15T00:00:01.010Z", 0],
    [-1, 0, 1],
    [1, 999, 0],
    [1000, Date.parse("2027-01-01T00:00:00.000Z"), 1],
  ] as const;
  await db.batch(
    dates.map(([created, updated, anonymous], index) =>
      db
        .prepare(`INSERT INTO user(id,name,email,emailVerified,createdAt,updatedAt,isAnonymous,
      username,profileCompleted,publicProfileId,guestRegisteredAt,profileMessage,favoriteGames)
      VALUES(?, ?, ?,1,?,?,?, ?,1,?,123,'保持する名前','["four-shogi"]')`)
        .bind(
          `${prefix}${index}`,
          "利用者",
          `${prefix}${index}@test.invalid`,
          created,
          updated,
          anonymous,
          `${prefix}${index}`,
          `${prefix}public-${index}`,
        ),
    ),
  );
  const rows = async () =>
    (
      await db
        .prepare("SELECT * FROM user WHERE id LIKE ? ORDER BY id")
        .bind(`${prefix}%`)
        .all<{ id: string; createdAt: number | string; updatedAt: number | string }>()
    ).results;
  const before = await rows();

  await normalizeLegacyData(db);

  const after = await rows();
  expect(after).toEqual(
    before.map((row) => ({
      ...row,
      createdAt:
        typeof row.createdAt === "number" ? new Date(row.createdAt).toISOString() : row.createdAt,
      updatedAt:
        typeof row.updatedAt === "number" ? new Date(row.updatedAt).toISOString() : row.updatedAt,
    })),
  );
  expect(
    (
      await db
        .prepare(`SELECT typeof(createdAt) AS created,typeof(updatedAt) AS updated
    FROM user WHERE id LIKE ?`)
        .bind(`${prefix}%`)
        .all()
    ).results,
  ).toEqual(dates.map(() => ({ created: "text", updated: "text" })));
  await normalizeLegacyData(db);
  expect(await rows()).toEqual(after);
});

test("0046: 全1000種類のミリ秒がtoISOStringと一致し、SQLの時刻変換と並べ替えも一致する", async () => {
  const start = Date.parse("2026-12-31T23:59:59.000Z");
  await db
    .prepare(`WITH RECURSIVE ms(n) AS (
    SELECT 0 UNION ALL SELECT n+1 FROM ms WHERE n<999
  ) INSERT INTO user(id,name,email,emailVerified,createdAt,updatedAt,isAnonymous)
    SELECT ?||n,'ゲスト',?||n||'@test.invalid',0,?+n,?+999-n,1 FROM ms`)
    .bind(prefix, prefix, start, start)
    .run();

  await normalizeLegacyData(db);

  const rows = await db
    .prepare(`SELECT createdAt,updatedAt,
    ${accountCreatedAtMsSql("u.createdAt")} AS createdMs,
    ${accountRegisteredAtMsSql()} AS registeredMs
    FROM user u WHERE id LIKE ? AND createdAt>=? AND createdAt<? ORDER BY createdAt`)
    .bind(`${prefix}%`, new Date(start).toISOString(), new Date(start + 1000).toISOString())
    .all<{ createdAt: string; updatedAt: string; createdMs: number; registeredMs: number }>();
  expect(rows.results).toHaveLength(1000);
  for (const [index, row] of rows.results.entries()) {
    expect(row).toEqual({
      createdAt: new Date(start + index).toISOString(),
      updatedAt: new Date(start + 999 - index).toISOString(),
      createdMs: start + index,
      registeredMs: start + index,
    });
  }
  await db
    .prepare("UPDATE user SET guestRegisteredAt=? WHERE id=?")
    .bind(start + 1000, `${prefix}0`)
    .run();
  expect(
    await db
      .prepare(`SELECT ${accountRegisteredAtMsSql()} AS registeredMs FROM user u WHERE id=?`)
      .bind(`${prefix}0`)
      .first("registeredMs"),
  ).toBe(start + 1000);
});
