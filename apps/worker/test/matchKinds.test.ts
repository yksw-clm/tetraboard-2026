import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, expect, test } from "vitest";
import {
  gameIds,
  gameCatalog,
  getPublicMatchContract,
  listPublicMatchesContract,
  getMatchContract,
  listMatchesContract,
  type GameId,
  type MatchKind,
} from "@tetraboard/protocol";
import worker from "../src/worker";
import { accountFixture, origin } from "./accountFixtures";
import { readStoredMatch } from "../src/accounts/matchDataContracts";
import { standardShogiRecord } from "./standardShogiFixtures";
import { reversiArchives, shogiArchives } from "../../../test-fixtures/matches";
import reversi from "../../../test-fixtures/matches/reversi-standard-draw.json";
import gomoku from "../../../test-fixtures/matches/gomoku-on-five.json";
import fourGomoku from "../../../test-fixtures/matches/four-gomoku-singles-ranked.json";

type FixtureRecord = Record<string, unknown> & {
  id: string;
  instanceId: string;
  startedAtMs: number;
  endedAtMs: number;
  settings: { game: GameId; mode?: "singles" | "doubles" };
  participants: Record<string, unknown>[];
  replay: { id?: string };
};
const db = (env as typeof env & { PUBLIC_MATCH_TEST_DB: D1Database }).PUBLIC_MATCH_TEST_DB;
const ids: string[] = [],
  users: string[] = [],
  tournaments: string[] = [];
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
      db.prepare("DELETE FROM tournament_matches WHERE id=?").bind(id),
      db.prepare("DELETE FROM account_match_history WHERE match_id=?").bind(id),
      db.prepare("DELETE FROM matches WHERE id=?").bind(id),
    ]);
  for (const key of tournaments.splice(0))
    await db.prepare("DELETE FROM tournaments WHERE key=?").bind(key).run();
  for (const id of users.splice(0))
    await db.batch([
      db.prepare("DELETE FROM session WHERE userId=?").bind(id),
      db.prepare("DELETE FROM user WHERE id=?").bind(id),
    ]);
});
const request = (path: string, cookie?: string) =>
  worker.fetch(
    new Request(`${origin}/api${path}`, { headers: cookie ? { Cookie: cookie } : {} }),
    { ...env, APP_DB: db },
    {} as ExecutionContext,
  );
async function seed(
  game: GameId,
  kind: "normal" | "rated" | "tournament",
  fallback = false,
  existingUser?: Awaited<ReturnType<typeof accountFixture>>,
) {
  const user = existingUser ?? (await accountFixture(true, crypto.randomUUID(), db));
  if (!existingUser) users.push(user.id);
  const source =
    game === "shogi"
      ? standardShogiRecord(user.id).record
      : (game === "four-reversi"
          ? reversiArchives[0]
          : game === "four-shogi"
            ? shogiArchives[0]
            : game === "four-gomoku"
              ? fourGomoku
              : game === "gomoku"
                ? gomoku
                : reversi
        ).detail;
  const record = structuredClone(source) as unknown as FixtureRecord;
  delete record.selfPlayerId;
  record.id = crypto.randomUUID();
  record.instanceId = crypto.randomUUID();
  ids.push(record.id);
  if ("id" in record.replay) record.replay.id = record.id;
  record.participants = record.participants.map((p, index) => {
    const { avatarUrl: _avatar, ...player } = p;
    return p.kind === "cpu" ? player : { ...player, accountId: index === 0 ? user.id : null };
  });
  if (kind === "rated") {
    if (game === "four-shogi" || game === "four-reversi") {
      record[game === "four-shogi" ? "fourShogiRating" : "fourReversiRating"] = {
        method: "openskill-5.0.1-plackett-luce",
        calibrationVersion: "fixture",
        cpu: {},
        ...(fallback ? { usedFallback: true } : {}),
      };
    } else
      record.rating = fallback
        ? { kind: "cpu", profileId: "fixture", referenceRating: 1500, usedFallback: true }
        : { kind: "human" };
  }
  // 公開読取りの正規パーサーで、保存形式として有効な固定データだけを投入します。
  readStoredMatch(JSON.stringify(record), game);
  await db
    .prepare(
      "INSERT INTO matches(id,game,mode,started_at_ms,ended_at_ms,record_json) VALUES (?,?,?,?,?,?)",
    )
    .bind(
      record.id,
      game,
      record.settings.mode ?? "standard",
      record.startedAtMs,
      record.endedAtMs,
      JSON.stringify(record),
    )
    .run();
  await db
    .prepare(
      "INSERT INTO account_match_history(account_id,match_id,mode,started_at_ms,game) VALUES (?,?,?,?,?)",
    )
    .bind(user.id, record.id, record.settings.mode ?? "standard", record.startedAtMs, game)
    .run();
  if (kind === "tournament") await linkTournament(record.id, game);
  return { id: record.id as string, user, record };
}
async function linkTournament(id: string, game: GameId = "four-reversi") {
  const key = crypto.randomUUID();
  tournaments.push(key);
  await db
    .prepare(
      "INSERT INTO tournaments(key,name,created_at_ms,updated_at_ms,game) VALUES (?,'非公開の大会名',1,1,?)",
    )
    .bind(key, game)
    .run();
  await db
    .prepare(
      "INSERT INTO tournament_matches(id,tournament_key,room_id,instance_id,phase,started_at_ms,finished_at_ms,updated_at_ms) VALUES (?,?,'12345',?,'saved',1,2,2)",
    )
    .bind(id, key, crypto.randomUUID())
    .run();
}
async function verify(
  game: GameId,
  fixture: Awaited<ReturnType<typeof seed>>,
  expected: MatchKind,
) {
  expect(() =>
    readStoredMatch(JSON.stringify({ ...fixture.record, matchKind: expected }), game),
  ).toThrow();
  const mode = gameCatalog[game].hasModes ? "&mode=singles" : "";
  for (const path of [
    `/matches?game=${game}`,
    "/lobby/matches?humanOnly=false",
    `/account/matches?game=${game}${mode}`,
  ]) {
    const legacy = await request(path, fixture.user.cookie);
    expect(legacy.status).toBe(200);
    expect(
      ((await legacy.json()) as { matches: { id: string; matchKind?: MatchKind }[] }).matches.find(
        (m) => m.id === fixture.id,
      ),
    ).not.toHaveProperty("matchKind");
    const response = await request(`${path}&includeMatchKind=1`, fixture.user.cookie);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const result = (
      path.startsWith("/account/") ? listMatchesContract : listPublicMatchesContract
    ).response.parse(await response.json());
    expect(result.matches.find((m) => m.id === fixture.id)?.matchKind).toBe(expected);
  }
  for (const contract of [getPublicMatchContract, getMatchContract]) {
    const legacy = await request(contract.pathFor(fixture.id), fixture.user.cookie);
    expect(legacy.status).toBe(200);
    expect(((await legacy.json()) as { match: object }).match).not.toHaveProperty("matchKind");
    const response = await request(
      `${contract.pathFor(fixture.id)}?includeMatchKind=1`,
      fixture.user.cookie,
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(contract.response.parse(body).match.matchKind).toBe(expected);
    expect(JSON.stringify(body)).not.toContain(fixture.user.id);
    expect(JSON.stringify(body)).not.toContain("非公開の大会名");
  }
  const saved = await db
    .prepare("SELECT record_json FROM matches WHERE id=?")
    .bind(fixture.id)
    .first<{ record_json: string }>();
  expect(JSON.parse(saved!.record_json)).toEqual(fixture.record);
}
for (const game of gameIds)
  test(`${game}: 過去の通常対局を公開・総合・本人一覧と両棋譜で同じ種別にし、要求しない応答を維持する`, async () => {
    await verify(game, await seed(game, "normal"), "normal");
  });
for (const game of ["four-reversi", "four-shogi", "reversi", "shogi"] as const)
  test(`${game}: 認定前・更新対象外でも成立記録があればレート戦にする`, async () => {
    await verify(game, await seed(game, "rated", true), "rated");
  });
for (const game of ["four-reversi", "four-shogi", "four-gomoku"] as const)
  test(`${game}: 大会が非公開でも保存済み大会台帳から大会戦にする`, async () => {
    await verify(game, await seed(game, "tournament"), "tournament");
  });
test("矛盾する成立記録は種別不明とし、本人棋譜の権限と取得条件を維持する", async () => {
  const fixture = await seed("four-reversi", "rated");
  await linkTournament(fixture.id);
  await verify("four-reversi", fixture, "unknown");
  expect((await request(`${getMatchContract.pathFor(fixture.id)}?includeMatchKind=1`)).status).toBe(
    401,
  );
  for (const path of [
    `/matches?game=four-reversi&includeMatchKind=0`,
    `/lobby/matches?includeMatchKind=0`,
    `${getPublicMatchContract.pathFor(fixture.id)}?includeMatchKind=0`,
    `${getMatchContract.pathFor(fixture.id)}?includeMatchKind=0`,
    `${listMatchesContract.path}?mode=singles&includeMatchKind=0`,
  ])
    expect((await request(path, fixture.user.cookie)).status).toBe(400);
});
test("大会台帳の取得失敗を通常対局に置き換えず503にする", async () => {
  const fixture = await seed("four-reversi", "normal");
  await db.exec("ALTER TABLE tournament_matches RENAME TO tournament_matches_unavailable");
  try {
    expect((await request(`/matches?game=four-reversi&includeMatchKind=1`)).status).toBe(503);
    expect(
      (await request(`${getPublicMatchContract.pathFor(fixture.id)}?includeMatchKind=1`)).status,
    ).toBe(503);
    expect((await request(getPublicMatchContract.pathFor(fixture.id))).status).toBe(200);
  } finally {
    await db.exec("ALTER TABLE tournament_matches_unavailable RENAME TO tournament_matches");
  }
});

async function updateHistoryFixture(fixture: Awaited<ReturnType<typeof seed>>) {
  readStoredMatch(JSON.stringify(fixture.record), fixture.record.settings.game);
  await db.batch([
    db
      .prepare("UPDATE matches SET record_json=?, started_at_ms=?, ended_at_ms=? WHERE id=?")
      .bind(
        JSON.stringify(fixture.record),
        fixture.record.startedAtMs,
        fixture.record.endedAtMs,
        fixture.id,
      ),
    db
      .prepare("UPDATE account_match_history SET started_at_ms=? WHERE match_id=?")
      .bind(fixture.record.startedAtMs, fixture.id),
  ]);
}
async function makeHuman(fixture: Awaited<ReturnType<typeof seed>>) {
  fixture.record.participants = fixture.record.participants.map((player, index) => {
    const { level: _level, cpuProfile: _profile, ...identity } = player;
    return { ...identity, kind: "human", accountId: index === 0 ? fixture.user.id : null };
  });
  await updateHistoryFixture(fixture);
}
async function makeCpu(fixture: Awaited<ReturnType<typeof seed>>) {
  const last = fixture.record.participants.at(-1)!;
  const { accountId: _account, retired: _retired, ...identity } = last;
  fixture.record.participants[fixture.record.participants.length - 1] = {
    ...identity,
    kind: "cpu",
    level: 1,
  };
  await updateHistoryFixture(fixture);
}
async function filteredHistory(game: GameId, cookie: string, filter: string, cursor?: string) {
  const query = new URLSearchParams({ game, filter, includeMatchKind: "1" });
  if (gameCatalog[game].hasModes) query.set("mode", "singles");
  if (cursor) query.set("cursor", cursor);
  const response = await request(`/account/matches?${query}`, cookie);
  expect(response.status).toBe(200);
  return listMatchesContract.response.parse(await response.json());
}

test.each(gameIds)("%sの本人棋譜は通常の対人・CPUとレート戦を重複なく絞り込む", async (game) => {
  const human = await seed(game, "normal");
  await makeHuman(human);
  const cpu = await seed(game, "normal", false, human.user);
  await makeCpu(cpu);
  const ratedGame = ["four-reversi", "four-shogi", "shogi", "reversi"].includes(game);
  const rated = ratedGame ? await seed(game, "rated", true, human.user) : null;
  if (rated) await makeCpu(rated);
  const getIds = async (filter: string) =>
    (await filteredHistory(game, human.user.cookie, filter)).matches.map((m) => m.id);
  expect(await getIds("human")).toEqual([human.id]);
  expect(await getIds("cpu")).toEqual([cpu.id]);
  expect(await getIds("rated")).toEqual(rated ? [rated.id] : []);
  expect(new Set(await getIds("all"))).toEqual(
    new Set([human.id, cpu.id, ...(rated ? [rated.id] : [])]),
  );
  const outsider = await seed(game, "normal");
  expect(await getIds("human")).not.toContain(outsider.id);
});

test("大会は対人戦に含み、矛盾した成立記録はすべてでだけ表示する", async () => {
  const tournament = await seed("four-reversi", "tournament");
  await makeHuman(tournament);
  const unknown = await seed("four-reversi", "rated", false, tournament.user);
  await linkTournament(unknown.id);
  const human = await filteredHistory("four-reversi", tournament.user.cookie, "human");
  expect(human.matches.map((m) => m.id)).toEqual([tournament.id]);
  expect(human.matches[0]!.matchKind).toBe("tournament");
  expect(
    (await filteredHistory("four-reversi", tournament.user.cookie, "all")).matches,
  ).toHaveLength(2);
  for (const filter of ["rated", "cpu"])
    expect((await filteredHistory("four-reversi", tournament.user.cookie, filter)).matches).toEqual(
      [],
    );
});

test("絞り込みは20件の区切りより前に適用し、同時刻の続きと再送で欠落・重複しない", async () => {
  const first = await seed("four-reversi", "rated");
  const rated = [first];
  for (let i = 0; i < 24; i++) rated.push(await seed("four-reversi", "rated", false, first.user));
  for (const item of rated) {
    item.record.startedAtMs = 1_000;
    item.record.endedAtMs = 2_000;
    await updateHistoryFixture(item);
  }
  for (let i = 0; i < 21; i++) {
    const item = await seed("four-reversi", "normal", false, first.user);
    item.record.startedAtMs = 3_000 + i;
    item.record.endedAtMs = 4_000 + i;
    await updateHistoryFixture(item);
  }
  const page = await filteredHistory("four-reversi", first.user.cookie, "rated");
  expect(page.filter).toBe("rated");
  expect(page.matches).toHaveLength(20);
  expect(page.nextCursor).not.toBeNull();
  const next = await filteredHistory("four-reversi", first.user.cookie, "rated", page.nextCursor!);
  expect(next.matches).toHaveLength(5);
  expect(next.nextCursor).toBeNull();
  expect([...page.matches, ...next.matches].map((m) => m.id)).toEqual(
    rated
      .map((m) => m.id)
      .sort()
      .reverse(),
  );
  expect(
    await filteredHistory("four-reversi", first.user.cookie, "rated", page.nextCursor!),
  ).toEqual(next);
  expect(
    (await request("/account/matches?mode=singles&filter=invalid", first.user.cookie)).status,
  ).toBe(400);
  expect((await request("/account/matches?mode=singles&filter=rated")).status).toBe(401);
});
