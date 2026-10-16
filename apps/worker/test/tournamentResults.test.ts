import { env } from "cloudflare:workers";
import { afterEach, expect, test } from "vitest";
import { accountFixture } from "./accountFixtures";
import {
  allStandings,
  entryCount,
  finalizeTournament,
  readTournament,
  standingsPage,
  type TournamentRow,
} from "../src/tournaments/store";
import { requestDeletion } from "../src/privacy/deletion";

const fixtureKeys = new Set<string>();
const fixtureAccounts = new Set<string>();
afterEach(async () => {
  for (const key of fixtureKeys)
    await env.APP_DB.batch([
      env.APP_DB.prepare(
        "DELETE FROM tournament_point_events WHERE match_id IN (SELECT id FROM tournament_matches WHERE tournament_key=?)",
      ).bind(key),
      env.APP_DB.prepare("DELETE FROM tournament_scores WHERE tournament_key=?").bind(key),
      env.APP_DB.prepare(
        "DELETE FROM tournament_match_players WHERE match_id IN (SELECT id FROM tournament_matches WHERE tournament_key=?)",
      ).bind(key),
      env.APP_DB.prepare("DELETE FROM tournament_matches WHERE tournament_key=?").bind(key),
      env.APP_DB.prepare("DELETE FROM tournament_wait_reservations WHERE tournament_key=?").bind(
        key,
      ),
      env.APP_DB.prepare("DELETE FROM tournament_entries WHERE tournament_key=?").bind(key),
      env.APP_DB.prepare("DELETE FROM tournaments WHERE key=?").bind(key),
    ]);
  for (const id of fixtureAccounts)
    await env.APP_DB.batch([
      env.APP_DB.prepare("DELETE FROM deletion_rooms WHERE account_id=?").bind(id),
      env.APP_DB.prepare("DELETE FROM deletion_images WHERE account_id=?").bind(id),
      env.APP_DB.prepare("DELETE FROM deleted_accounts WHERE id=?").bind(id),
      env.APP_DB.prepare("DELETE FROM session WHERE userId=?").bind(id),
      env.APP_DB.prepare("DELETE FROM account WHERE userId=?").bind(id),
      env.APP_DB.prepare("DELETE FROM user WHERE id=?").bind(id),
    ]);
  fixtureKeys.clear();
  fixtureAccounts.clear();
});

async function fixture(count: number) {
  const key = crypto.randomUUID(),
    now = Date.now();
  fixtureKeys.add(key);
  await env.APP_DB.prepare(`INSERT INTO tournaments(key,public_id,name,starts_at_ms,ends_at_ms,published,created_at_ms,updated_at_ms)
    VALUES(?,(SELECT COALESCE(MAX(public_id),0)+1 FROM tournaments),'集計検証大会',?,?,1,?,?)`)
    .bind(key, now - 60_000, now + 60_000, now, now)
    .run();
  const players = [];
  for (let index = 0; index < count; index++) {
    const account = await accountFixture(),
      entryId = crypto.randomUUID();
    fixtureAccounts.add(account.id);
    const name = `参加者${index + 1}`,
      username = `player_${String(index + 1).padStart(2, "0")}_${key.slice(0, 8)}`;
    await env.APP_DB.batch([
      env.APP_DB.prepare("UPDATE user SET name=?,username=? WHERE id=?").bind(
        name,
        username,
        account.id,
      ),
      env.APP_DB.prepare("INSERT INTO tournament_entries VALUES(?,?,?,?,0)").bind(
        entryId,
        key,
        account.id,
        now,
      ),
    ]);
    players.push({ ...account, entryId, name, username });
  }
  const row = (await readTournament(env.APP_DB, key))!;
  return { key, row, players };
}
type Player = Awaited<ReturnType<typeof fixture>>["players"][number];
async function match(
  row: TournamentRow,
  phase: "reserved" | "playing" | "saving" | "saved" | "aborted" = "saved",
) {
  const id = crypto.randomUUID();
  await env.APP_DB.prepare("INSERT INTO tournament_matches VALUES(?,?,?,?,?,?,?,?)")
    .bind(
      id,
      row.key,
      "12345",
      crypto.randomUUID(),
      phase,
      row.starts_at_ms,
      phase === "saved" ? row.starts_at_ms! + 1000 : null,
      Date.now(),
    )
    .run();
  return id;
}
async function score(
  row: TournamentRow,
  player: Player,
  values: { points: number; games?: number; knockouts?: number; rankSum?: number },
) {
  const games = values.games ?? 10;
  await env.APP_DB.prepare(`INSERT INTO tournament_scores(entry_id,tournament_key,points_units,games,knockouts,rank_sum)
    VALUES(?,?,?,?,?,?)`)
    .bind(
      player.entryId,
      row.key,
      values.points,
      games,
      values.knockouts ?? 0,
      values.rankSum ?? games * 2,
    )
    .run();
}
async function fresh(row: TournamentRow) {
  return (await readTournament(env.APP_DB, row.key))!;
}

test("同順位の勝ち点イベントを累計し、再送で対局数・順位内訳・撃破・勝ち点を二重加算しない", async () => {
  const { row, players } = await fixture(4);
  const firstMatch = await match(row),
    secondMatch = await match(row);
  const first = [
    { rank: 1, points: 36, knockouts: 1 },
    { rank: 1, points: 36, knockouts: 1 },
    { rank: 3, points: 12, knockouts: 0 },
    { rank: 4, points: 0, knockouts: 0 },
  ];
  const events = [
    ...players.map((player, index) => ({
      matchId: firstMatch,
      entryId: player.entryId,
      ...first[index]!,
    })),
    ...players.map((player) => ({
      matchId: secondMatch,
      entryId: player.entryId,
      rank: 1,
      points: 21,
      knockouts: 0,
    })),
  ];
  for (let attempt = 0; attempt < 2; attempt++)
    await env.APP_DB.batch(
      events.map((event) =>
        env.APP_DB.prepare("INSERT OR IGNORE INTO tournament_point_events VALUES(?,?,?,?,?)").bind(
          event.matchId,
          event.entryId,
          event.rank,
          event.knockouts,
          event.points,
        ),
      ),
    );
  const values = await allStandings(env.APP_DB, row);
  expect(
    values.map((value) => ({
      rank: value.rank,
      points: value.pointsUnits,
      games: value.games,
      first: value.first,
      third: value.third,
      fourth: value.fourth,
      knockouts: value.knockouts,
      rankSum: value.rankSum,
    })),
  ).toEqual([
    { rank: 1, points: 57, games: 2, first: 2, third: 0, fourth: 0, knockouts: 1, rankSum: 2 },
    { rank: 1, points: 57, games: 2, first: 2, third: 0, fourth: 0, knockouts: 1, rankSum: 2 },
    { rank: 3, points: 33, games: 2, first: 1, third: 1, fourth: 0, knockouts: 0, rankSum: 4 },
    { rank: 4, points: 21, games: 2, first: 1, third: 0, fourth: 1, knockouts: 0, rankSum: 5 },
  ]);
  expect(
    await env.APP_DB.prepare(
      "SELECT COUNT(*) AS n FROM tournament_point_events WHERE match_id IN (?,?)",
    )
      .bind(firstMatch, secondMatch)
      .first(),
  ).toEqual({ n: 8 });
});

test("勝ち点・撃破・丸め前の平均順位で比較し、異なる対局数で同じ平均なら同順位にする", async () => {
  const { row, players } = await fixture(6);
  await score(row, players[0]!, { points: 120, knockouts: 5, games: 100, rankSum: 400 });
  await score(row, players[1]!, { points: 120, knockouts: 4, games: 100, rankSum: 333 });
  await score(row, players[2]!, { points: 120, knockouts: 4, games: 100, rankSum: 335 });
  await score(row, players[3]!, { points: 120, knockouts: 4, games: 300, rankSum: 1000 });
  await score(row, players[4]!, { points: 120, knockouts: 4, games: 300, rankSum: 999 });
  await score(row, players[5]!, { points: 121, knockouts: 0, games: 100, rankSum: 400 });
  const values = await allStandings(env.APP_DB, row);
  expect(values.map((value) => [value.username, value.rank])).toEqual([
    [players[5]!.username, 1],
    [players[0]!.username, 2],
    [players[1]!.username, 3],
    [players[4]!.username, 3],
    [players[3]!.username, 5],
    [players[2]!.username, 6],
  ]);
  const third = values.find((value) => value.entryId === players[1]!.entryId)!;
  const fifth = values.find((value) => value.entryId === players[3]!.entryId)!;
  expect((third.rankSum / third.games).toFixed(2)).toBe("3.33");
  expect((fifth.rankSum / fifth.games).toFixed(2)).toBe("3.33");
});

test("5位の同順位は全員を含め、本人を上位内で重複させず、上位外と未対局の本人も返す", async () => {
  const { row, players } = await fixture(8);
  const points = [120, 108, 96, 84, 72, 72, 60];
  for (let index = 0; index < points.length; index++)
    await score(row, players[index]!, { points: points[index]! });
  const inside = await standingsPage(env.APP_DB, row, players[4]!.id);
  expect(inside.standings.map((value) => value.rank)).toEqual([1, 2, 3, 4, 5, 5]);
  expect(inside.standings.filter((value) => value.self)).toHaveLength(1);
  expect(new Set(inside.standings.map((value) => value.username)).size).toBe(6);
  expect(inside.self?.rank).toBe(5);
  const outside = await standingsPage(env.APP_DB, row, players[6]!.id);
  expect(outside.standings.some((value) => value.self)).toBe(false);
  expect(outside.self).toMatchObject({ rank: 7, username: players[6]!.username, self: true });
  const unplayed = await standingsPage(env.APP_DB, row, players[7]!.id);
  expect(unplayed.self).toMatchObject({ rank: null, games: 0, pointsUnits: 0, self: true });
  const all = await standingsPage(env.APP_DB, row, players[7]!.id, true);
  expect(all.standings).toHaveLength(8);
  expect(all.standings.at(-1)).toMatchObject({ rank: null, games: 0, self: true });
  const serialized = JSON.stringify(all);
  for (const player of players) expect(serialized).not.toContain(player.id);
  expect(serialized).not.toContain("entryId");
  expect(serialized).not.toContain("accountId");
});

test.each(["reserved", "playing", "saving"] as const)(
  "%sが1件でも残ると結果を確定せず、解決後に一度だけ確定する",
  async (phase) => {
    const { row, players } = await fixture(2);
    await score(row, players[0]!, { points: 96 });
    await score(row, players[1]!, { points: 48 });
    const blocker = await match(row, phase);
    await finalizeTournament(env.APP_DB, row.key, row.ends_at_ms!);
    expect((await fresh(row)).finalized_at_ms).toBeNull();
    expect(
      await env.APP_DB.prepare(
        "SELECT COUNT(*) AS n FROM tournament_scores WHERE tournament_key=? AND final_rank IS NOT NULL",
      )
        .bind(row.key)
        .first(),
    ).toEqual({ n: 0 });
    await env.APP_DB.prepare("UPDATE tournament_matches SET phase='aborted' WHERE id=?")
      .bind(blocker)
      .run();
    await finalizeTournament(env.APP_DB, row.key, row.ends_at_ms!);
    const finalized = await fresh(row);
    expect(finalized.finalized_at_ms).toBe(row.ends_at_ms);
    expect((await allStandings(env.APP_DB, finalized)).map((value) => value.rank)).toEqual([1, 2]);
    await finalizeTournament(env.APP_DB, row.key, row.ends_at_ms! + 1000);
    expect((await fresh(row)).finalized_at_ms).toBe(row.ends_at_ms);
  },
);

test("終了時刻より前には確定せず、対象対局0局でも終了時刻に未対局のまま確定する", async () => {
  const { row } = await fixture(1);
  await finalizeTournament(env.APP_DB, row.key, row.ends_at_ms! - 1);
  expect((await fresh(row)).finalized_at_ms).toBeNull();
  await finalizeTournament(env.APP_DB, row.key, row.ends_at_ms!);
  const finalized = await fresh(row);
  expect(finalized.finalized_at_ms).toBe(row.ends_at_ms);
  expect(await allStandings(env.APP_DB, finalized)).toMatchObject([
    { rank: null, games: 0, pointsUnits: 0 },
  ]);
});

test("確定前の退会は本人・全順位・人数から即時除外し、残る人の順位で確定する", async () => {
  const { row, players } = await fixture(3);
  for (let index = 0; index < players.length; index++)
    await score(row, players[index]!, { points: 120 - index * 12 });
  const removed = players[0]!;
  expect(await requestDeletion(env, removed.id, crypto.randomUUID())).toBe(true);
  expect(await entryCount(env.APP_DB, row.key)).toBe(2);
  const page = await standingsPage(env.APP_DB, row, removed.id, true);
  expect(page.self).toBeNull();
  expect(page.standings.map((value) => value.rank)).toEqual([1, 2]);
  expect(JSON.stringify(page)).not.toContain(removed.name);
  expect(JSON.stringify(page)).not.toContain(removed.username);
  await finalizeTournament(env.APP_DB, row.key, row.ends_at_ms!);
  expect(
    (await allStandings(env.APP_DB, await fresh(row))).map((value) => [value.username, value.rank]),
  ).toEqual([
    [players[1]!.username, 1],
    [players[2]!.username, 2],
  ]);
});

test("確定後の退会とプロフィール変更でも最終順位を保ち、旧名・画像・公開IDを返さない", async () => {
  const { row, players } = await fixture(3);
  for (let index = 0; index < players.length; index++)
    await score(row, players[index]!, { points: 120 - index * 12 });
  const removed = players[0]!,
    avatarId = crypto.randomUUID();
  await env.APP_DB.prepare("UPDATE user SET avatarKey=? WHERE id=?")
    .bind(`avatars/${avatarId}.webp`, removed.id)
    .run();
  await finalizeTournament(env.APP_DB, row.key, row.ends_at_ms!);
  const finalized = await fresh(row);
  expect(await requestDeletion(env, removed.id, crypto.randomUUID())).toBe(true);
  await env.APP_DB.prepare("UPDATE user SET username=?,name='表記修正' WHERE id=?")
    .bind(`changed_${crypto.randomUUID().slice(0, 8)}`, players[1]!.id)
    .run();
  await finalizeTournament(env.APP_DB, row.key, row.ends_at_ms! + 1000);
  for (let step = 0; step < 2; step++) {
    const values = await allStandings(env.APP_DB, await fresh(row));
    expect(values.map((value) => value.rank)).toEqual([1, 2, 3]);
    expect(values[0]).toMatchObject({
      rank: 1,
      name: "退会したプレイヤー",
      username: null,
      avatarUrl: null,
      accountId: null,
      pointsUnits: 120,
    });
    const page = await standingsPage(env.APP_DB, await fresh(row), removed.id, true);
    expect(page.self).toBeNull();
    const serialized = JSON.stringify(page);
    for (const secret of [removed.name, removed.username, removed.id, avatarId])
      expect(serialized).not.toContain(secret);
    expect((await fresh(row)).finalized_at_ms).toBe(finalized.finalized_at_ms);
    if (step === 0)
      await env.APP_DB.batch([
        env.APP_DB.prepare("UPDATE tournament_entries SET account_id=NULL WHERE account_id=?").bind(
          removed.id,
        ),
        env.APP_DB.prepare("DELETE FROM session WHERE userId=?").bind(removed.id),
        env.APP_DB.prepare("DELETE FROM account WHERE userId=?").bind(removed.id),
        env.APP_DB.prepare("DELETE FROM user WHERE id=?").bind(removed.id),
      ]);
  }
});

function beforeNextBatch(run: () => Promise<void>): D1Database {
  let intercepted = false;
  return new Proxy(env.APP_DB, {
    get(target, property) {
      if (property === "batch")
        return async (statements: D1PreparedStatement[]) => {
          if (!intercepted) {
            intercepted = true;
            await run();
          }
          return target.batch(statements);
        };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

test("順位読取と確定batchの間の退会では一切確定せず、再計算後も退会者を復活させない", async () => {
  const { row, players } = await fixture(4);
  for (let index = 0; index < 3; index++)
    await score(row, players[index]!, { points: 120 - index * 12 });
  const raced = beforeNextBatch(async () => {
    expect(await requestDeletion(env, players[0]!.id, crypto.randomUUID())).toBe(true);
    expect(await requestDeletion(env, players[3]!.id, crypto.randomUUID())).toBe(true);
  });
  await finalizeTournament(raced, row.key, row.ends_at_ms!);
  expect((await fresh(row)).finalized_at_ms).toBeNull();
  expect(
    await env.APP_DB.prepare(
      "SELECT COUNT(*) AS n FROM tournament_scores WHERE tournament_key=? AND final_rank IS NOT NULL",
    )
      .bind(row.key)
      .first(),
  ).toEqual({ n: 0 });
  await finalizeTournament(env.APP_DB, row.key, row.ends_at_ms! + 1);
  const finalized = await fresh(row);
  expect(finalized.finalized_at_ms).toBe(row.ends_at_ms! + 1);
  const values = await allStandings(env.APP_DB, finalized);
  expect(values.map((value) => [value.username, value.rank])).toEqual([
    [players[1]!.username, 1],
    [players[2]!.username, 2],
  ]);
  expect(
    values.some(
      (value) => value.entryId === players[0]!.entryId || value.entryId === players[3]!.entryId,
    ),
  ).toBe(false);
});

test("順位読取後に未解決対局が増えた場合も確定batchが更新を拒否する", async () => {
  const { row, players } = await fixture(1);
  await score(row, players[0]!, { points: 48 });
  let pendingId = "";
  const raced = beforeNextBatch(async () => {
    pendingId = await match(row, "saving");
  });
  await finalizeTournament(raced, row.key, row.ends_at_ms!);
  expect((await fresh(row)).finalized_at_ms).toBeNull();
  expect(
    await env.APP_DB.prepare("SELECT final_rank FROM tournament_scores WHERE entry_id=?")
      .bind(players[0]!.entryId)
      .first(),
  ).toEqual({ final_rank: null });
  await env.APP_DB.prepare("UPDATE tournament_matches SET phase='aborted' WHERE id=?")
    .bind(pendingId)
    .run();
  await finalizeTournament(env.APP_DB, row.key, row.ends_at_ms!);
  expect((await fresh(row)).finalized_at_ms).toBe(row.ends_at_ms);
});

test("並行した別の確定処理が完了していれば、古い確定batchで日時・順位を上書きしない", async () => {
  const { row, players } = await fixture(1);
  await score(row, players[0]!, { points: 48 });
  const firstFinalizedAt = row.ends_at_ms! + 2;
  const raced = beforeNextBatch(async () => {
    await finalizeTournament(env.APP_DB, row.key, firstFinalizedAt);
  });
  await finalizeTournament(raced, row.key, row.ends_at_ms!);
  expect((await fresh(row)).finalized_at_ms).toBe(firstFinalizedAt);
  expect((await allStandings(env.APP_DB, await fresh(row)))[0]!.rank).toBe(1);
});
