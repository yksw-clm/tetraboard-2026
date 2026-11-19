import { env } from "cloudflare:workers";
import { afterEach, expect, test } from "vitest";
import type { TournamentRoomContext } from "@tetraboard/context-tournament";
import type { ShogiSaveProgress } from "../src/adapters/record/shogiMatchStore";
import { advanceShogiMatchSave } from "../src/flows/matchSave/shogi";
import { finalizeTournament, readTournament } from "../src/adapters/tournament/store";
import { humanShogiRecord } from "./shogiMatchFixtures";
import { resultPublication } from "./tournamentResultFixtures";
import { D1TournamentPublication } from "../src/adapters/tournament/publication";

const db = env.APP_DB;

const keys = new Set<string>();
afterEach(async () => {
  for (const key of keys)
    await db.batch([
      db
        .prepare(
          "DELETE FROM tournament_point_events WHERE match_id IN (SELECT id FROM tournament_matches WHERE tournament_key=?)",
        )
        .bind(key),
      db.prepare("DELETE FROM tournament_scores WHERE tournament_key=?").bind(key),
      db
        .prepare(
          "DELETE FROM tournament_match_players WHERE match_id IN (SELECT id FROM tournament_matches WHERE tournament_key=?)",
        )
        .bind(key),
      db
        .prepare(
          "DELETE FROM match_event_chunks WHERE match_id IN (SELECT id FROM tournament_matches WHERE tournament_key=?)",
        )
        .bind(key),
      db
        .prepare(
          "DELETE FROM match_uploads WHERE id IN (SELECT id FROM tournament_matches WHERE tournament_key=?)",
        )
        .bind(key),
      db
        .prepare(
          "DELETE FROM matches WHERE id IN (SELECT id FROM tournament_matches WHERE tournament_key=?)",
        )
        .bind(key),
      db.prepare("DELETE FROM tournament_matches WHERE tournament_key=?").bind(key),
      db.prepare("DELETE FROM tournament_entries WHERE tournament_key=?").bind(key),
      db.prepare("DELETE FROM tournaments WHERE key=?").bind(key),
    ]);
  keys.clear();
});

async function fixture() {
  const key = crypto.randomUUID();
  keys.add(key);
  const entries = Array.from({ length: 4 }, () => crypto.randomUUID());
  await db.batch([
    db
      .prepare(
        "INSERT INTO tournaments(key,public_id,name,starts_at_ms,ends_at_ms,published,created_at_ms,updated_at_ms) VALUES(?,(SELECT COALESCE(MAX(public_id),0)+1 FROM tournaments),'保存検証',1700000000000,1700000060000,1,1,1)",
      )
      .bind(key),
    ...entries.map((entry) =>
      db
        .prepare("INSERT INTO tournament_entries(id,tournament_key,entered_at_ms) VALUES(?,?,1)")
        .bind(entry, key),
    ),
  ]);
  return { db, key, entries };
}

async function match(f: Awaited<ReturnType<typeof fixture>>) {
  const db = f.db;
  const source = humanShogiRecord(null);
  const { record } = source;
  record.settings.timeControl = { mainTimeMs: 0, byoyomiMs: 30000 };
  const context: TournamentRoomContext = {
    tournamentKey: f.key,
    tournamentId: 1,
    matchId: record.id,
    startsAtMs: 1700000000000,
    endsAtMs: 1700000060000,
    ruleVersion: 1,
  };
  await db.batch([
    db
      .prepare(
        "INSERT INTO tournament_matches(id,tournament_key,room_id,instance_id,phase,updated_at_ms) VALUES(?,?,?,?,'saving',1)",
      )
      .bind(record.id, f.key, record.roomId, record.instanceId),
    ...record.participants.map((p, i) =>
      db
        .prepare(
          "INSERT INTO tournament_match_players(match_id,entry_id,player_id,operation_id) VALUES(?,?,?,?)",
        )
        .bind(record.id, f.entries[i], p.id, crypto.randomUUID()),
    ),
  ]);
  return { ...source, context, db: f.db };
}

async function save(m: Awaited<ReturnType<typeof match>>) {
  let progress: ShogiSaveProgress | null = { phase: "upload", cursor: 0 };
  while (progress)
    progress = await advanceShogiMatchSave(
      m.db,
      m.record,
      progress,
      (cursor) => m.events.slice(cursor, cursor + 100),
      undefined,
      m.context,
    );
}

async function scores(db: D1Database, key: string) {
  return (
    await db
      .prepare("SELECT * FROM tournament_scores WHERE tournament_key=? ORDER BY entry_id")
      .bind(key)
      .all()
  ).results;
}
async function events(db: D1Database, key: string) {
  return (
    await db
      .prepare(
        "SELECT e.* FROM tournament_point_events e JOIN tournament_matches m ON m.id=e.match_id WHERE m.tournament_key=? ORDER BY e.match_id,e.entry_id",
      )
      .bind(key)
      .all()
  ).results;
}

test(`終局保存で全成績を集計し、再送は不変、2局目は加算する`, async () => {
  expect(
    (
      await db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='trigger' AND name='tournament_score_apply'",
        )
        .all()
    ).results,
  ).toEqual([]);
  const f = await fixture(),
    first = await match(f);
  await save(first);
  const initial = await scores(db, f.key);
  for (const [i, entry] of f.entries.entries())
    expect(initial.find((s) => s.entry_id === entry)).toEqual({
      entry_id: entry,
      tournament_key: f.key,
      points_units: [48, 24, 12, 0][i],
      games: 1,
      first: Number(i === 0),
      second: Number(i === 1),
      third: Number(i === 2),
      fourth: Number(i === 3),
      knockouts: 0,
      rank_sum: i + 1,
      final_rank: null,
    });
  expect(await events(db, f.key)).toHaveLength(4);
  expect(
    await db
      .prepare("SELECT phase FROM tournament_matches WHERE id=?")
      .bind(first.record.id)
      .first(),
  ).toEqual({ phase: "saved" });
  await save(first);
  expect(await scores(db, f.key)).toEqual(initial);
  expect(await events(db, f.key)).toHaveLength(4);
  const second = await match(f);
  await save(second);
  expect(await scores(db, f.key)).toEqual(
    initial.map((s) => ({
      ...s,
      points_units: Number(s.points_units) * 2,
      games: 2,
      first: Number(s.first) * 2,
      second: Number(s.second) * 2,
      third: Number(s.third) * 2,
      fourth: Number(s.fourth) * 2,
      rank_sum: Number(s.rank_sum) * 2,
    })),
  );
  expect(await events(db, f.key)).toHaveLength(8);
});

test(`結果確定後の再送・未記録局の公開で勝ち点記録と成績・最終順位を変えない`, async () => {
  const f = await fixture(),
    first = await match(f),
    late = await match(f);
  await save(first);
  await db
    .prepare("UPDATE tournament_matches SET phase='aborted' WHERE id=?")
    .bind(late.record.id)
    .run();
  await finalizeTournament(db, f.key, first.context.endsAtMs);
  const beforeScores = await scores(db, f.key),
    beforeEvents = await events(db, f.key);
  expect(beforeScores.every((s) => s.final_rank !== null)).toBe(true);
  await save(first);
  await db
    .prepare("UPDATE tournament_matches SET phase='saving' WHERE id=?")
    .bind(late.record.id)
    .run();
  await expect(save(late)).rejects.toThrow("Tournament result publication was incomplete");
  expect(await scores(db, f.key)).toEqual(beforeScores);
  expect(await events(db, f.key)).toEqual(beforeEvents);
});

test(`同順位と撃破数を累計し、再送でも増やさない`, async () => {
  const f = await fixture();
  const row = (await readTournament(db, f.key))!;
  const ids = [crypto.randomUUID(), crypto.randomUUID()];
  await db.batch(
    ids.map((id) =>
      db
        .prepare(
          "INSERT INTO tournament_matches(id,tournament_key,room_id,instance_id,phase,updated_at_ms) VALUES(?,?,'12345',?,'saving',1)",
        )
        .bind(id, f.key, crypto.randomUUID()),
    ),
  );
  const players = f.entries.map((entryId) => ({ entryId }));
  const first = await resultPublication(row, players, ids[0]!, [1, 1, 3, 4], [1, 1, 0, 0], db);
  const second = await resultPublication(row, players, ids[1]!, [1, 1, 1, 1], [0, 0, 0, 0], db);
  await first();
  await second();
  const initial = await scores(db, f.key);
  expect(f.entries.map((entry) => initial.find((s) => s.entry_id === entry))).toEqual(
    f.entries.map((entry, i) => ({
      entry_id: entry,
      tournament_key: f.key,
      points_units: [57, 57, 33, 21][i],
      games: 2,
      first: i < 2 ? 2 : 1,
      second: 0,
      third: Number(i === 2),
      fourth: Number(i === 3),
      knockouts: Number(i < 2),
      rank_sum: [2, 2, 4, 5][i],
      final_rank: null,
    })),
  );
  await first();
  await second();
  expect(await scores(db, f.key)).toEqual(initial);
  expect(await events(db, f.key)).toHaveLength(8);
});

test(`集計の実行計画はentry_idの索引を使う`, async () => {
  const f = await fixture(),
    m = await match(f);
  const explain = new D1TournamentPublication(
    new Proxy(db, {
      get(target, property) {
        if (property === "prepare")
          return (sql: string) => target.prepare(`EXPLAIN QUERY PLAN ${sql}`);
        return Reflect.get(target, property);
      },
    }),
  );
  const plan = await explain
    .scores(m.context, {
      playerId: m.record.participants[0]!.id,
      rank: 1,
      knockouts: 0,
      units: 48,
    })
    .all<{ detail: string }>();
  const details = plan.results.map((step) => step.detail);
  expect(details).toContain("SEARCH e USING INDEX tournament_point_events_entry (entry_id=?)");
  expect(details.some((detail) => /^SCAN e\b/.test(detail))).toBe(false);
});
