import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { afterEach, beforeAll, expect, test } from "vitest";
import { gameIds } from "@tetraboard/protocol/games";
import { tournamentListSchema, tournamentDetailSchema } from "@tetraboard/protocol";
import worker from "../src/worker";
import { publicTournamentList } from "../src/tournaments/store";
import { requestDeletion } from "../src/privacy/deletion";
import { mergeGuestAccounts } from "../src/accounts/guestLinking";
import { accountFixture, origin } from "./accountFixtures";

const db = (env as typeof env & { TOURNAMENT_PRIVACY_TEST_DB: D1Database })
  .TOURNAMENT_PRIVACY_TEST_DB;
const keys = new Set<string>();
const accounts = new Set<string>();
beforeAll(async () => {
  await applyD1Migrations(
    db,
    (env as typeof env & { TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1] })
      .TEST_MIGRATIONS,
  );
});
afterEach(async () => {
  for (const key of keys)
    await db.batch([
      db.prepare("DELETE FROM tournament_scores WHERE tournament_key=?").bind(key),
      db.prepare("DELETE FROM tournament_entries WHERE tournament_key=?").bind(key),
      db.prepare("DELETE FROM tournaments WHERE key=?").bind(key),
    ]);
  for (const id of accounts)
    await db.batch([
      db.prepare("DELETE FROM deletion_rooms WHERE account_id=?").bind(id),
      db.prepare("DELETE FROM deletion_images WHERE account_id=?").bind(id),
      db.prepare("DELETE FROM deleted_accounts WHERE id=?").bind(id),
      db.prepare("DELETE FROM guest_oauth_flows WHERE guest_id=? OR target_id=?").bind(id, id),
      db.prepare("DELETE FROM guest_sessions WHERE account_id=?").bind(id),
      db.prepare("DELETE FROM guest_account_merges WHERE guest_id=? OR account_id=?").bind(id, id),
      db.prepare("DELETE FROM session WHERE userId=?").bind(id),
      db.prepare("DELETE FROM account WHERE userId=?").bind(id),
      db.prepare("DELETE FROM legal_consents WHERE account_id=?").bind(id),
      db.prepare("DELETE FROM user WHERE id=?").bind(id),
    ]);
  keys.clear();
  accounts.clear();
});
async function tournament(id: number | null, startsAtMs: number, finished = false) {
  const key = crypto.randomUUID();
  keys.add(key);
  await db
    .prepare(
      "INSERT INTO tournaments(key,public_id,name,starts_at_ms,ends_at_ms,published,finalized_at_ms,created_at_ms,updated_at_ms) VALUES(?,?,?,?,?,?,?,?,?)",
    )
    .bind(
      key,
      id,
      `大会${id ?? "下書き"}`,
      startsAtMs,
      startsAtMs + 1000,
      id === null ? 0 : 1,
      finished ? startsAtMs + 2000 : null,
      startsAtMs,
      startsAtMs,
    )
    .run();
  return key;
}
async function player(name: string, guest = false) {
  const user = await accountFixture(true, crypto.randomUUID(), db);
  accounts.add(user.id);
  const avatar = crypto.randomUUID();
  await db
    .prepare("UPDATE user SET name=?,avatarKey=?,isAnonymous=? WHERE id=?")
    .bind(name, `avatars/${avatar}.webp`, guest ? 1 : 0, user.id)
    .run();
  return { ...user, name, avatar };
}
async function score(key: string, accountId: string, rank: number, games = 1) {
  const id = crypto.randomUUID();
  await db.batch([
    db
      .prepare(
        "INSERT INTO tournament_entries(id,tournament_key,account_id,entered_at_ms) VALUES(?,?,?,?)",
      )
      .bind(id, key, accountId, Date.now()),
    db
      .prepare(
        "INSERT INTO tournament_scores(entry_id,tournament_key,games,final_rank) VALUES(?,?,?,?)",
      )
      .bind(id, key, games, rank),
  ]);
  return id;
}
const request = (query = "") =>
  worker.fetch(
    new Request(`${origin}/api/tournaments${query}`),
    { ...env, APP_DB: db },
    {} as ExecutionContext,
  );
async function list(query = "") {
  const response = await request(query);
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  return tournamentListSchema.parse(await response.json());
}

test("公開大会一覧は過去を含め開始日時・番号の降順で20件ずつ返し、新規公開後も重複しない", async () => {
  const start = Date.now() - 100000;
  for (let id = 1; id <= 25; id++) await tournament(id, start + Math.floor(id / 2) * 1000, true);
  await tournament(null, start + 1000000);
  const first = await list("?game=all");
  expect(first.tournaments.map((item) => item.id)).toEqual(
    Array.from({ length: 20 }, (_, index) => 25 - index),
  );
  expect(
    first.tournaments.every((item) => item.game === "four-shogi" && item.status === "finished"),
  ).toBe(true);
  expect(first.tournaments.every((item) => item.entryCount === 0)).toBe(true);
  expect(first.nextCursor).not.toBeNull();
  await tournament(26, start + 1000000);
  const second = await list(`?game=four-shogi&cursor=${first.nextCursor}`);
  expect(second.tournaments.map((item) => item.id)).toEqual([5, 4, 3, 2, 1]);
  expect(second.nextCursor).toBeNull();
  expect(new Set([...first.tournaments, ...second.tournaments].map((item) => item.id)).size).toBe(
    25,
  );
  expect((await list()).tournaments[0]!.id).toBe(26);
  for (const game of gameIds.filter((game) => game !== "four-shogi"))
    expect((await list(`?game=${game}`)).tournaments).toEqual([]);
  for (const query of [
    "?game=unknown",
    "?cursor=bad",
    "?cursor=1:0",
    "?cursor=9007199254740992:1",
    "?cursor=1:9007199254740992",
    "?private=1",
  ])
    expect((await request(query)).status).toBe(400);
});

test("優勝者は確定した1位の全員だけを返し、未確定と0局の大会へ優勝者を作らない", async () => {
  const now = Date.now(),
    finished = await tournament(1, now - 10000, true);
  const tied = [await player("優勝者A"), await player("優勝者B", true)];
  const runner = await player("準優勝者");
  for (const champion of tied) await score(finished, champion.id, 1);
  await score(finished, runner.id, 3);
  const active = await tournament(2, now - 500);
  await score(active, runner.id, 1);
  const settling = await tournament(3, now - 5000);
  await score(settling, runner.id, 1);
  const noContest = await tournament(4, now - 20000, true);
  await score(noContest, runner.id, 1, 0);
  const upcoming = await tournament(5, now + 10000);
  await score(upcoming, runner.id, 1);
  const result = await list();
  const winners = result.tournaments.find((item) => item.id === 1)!.winners;
  expect(winners.map((winner) => winner.name).sort()).toEqual(["優勝者A", "優勝者B"]);
  for (const champion of tied)
    expect(winners.find((winner) => winner.name === champion.name)).toMatchObject({
      avatarUrl: `/api/avatars/${champion.avatar}`,
    });
  expect(winners.find((winner) => winner.name === "優勝者B")?.isGuest).toBe(true);
  for (const id of [2, 3, 4, 5])
    expect(result.tournaments.find((item) => item.id === id)!.winners).toEqual([]);
  const serialized = JSON.stringify(result);
  for (const secret of [
    finished,
    active,
    settling,
    noContest,
    upcoming,
    ...tied.flatMap((champion) => [champion.id, champion.username, champion.token]),
  ])
    expect(serialized).not.toContain(secret);
});

test("確定優勝者のプロフィール変更は反映し、退会受付直後と削除後も旧名・画像を出さず順位を繰り上げない", async () => {
  const key = await tournament(1, Date.now() - 10000, true);
  const champion = await player("旧優勝名"),
    other = await player("同率優勝者"),
    runner = await player("次順位");
  const entry = await score(key, champion.id, 1);
  await score(key, other.id, 1);
  await score(key, runner.id, 3);
  const updatedAvatar = crypto.randomUUID();
  await db
    .prepare("UPDATE user SET name='新優勝名',avatarKey=? WHERE id=?")
    .bind(`avatars/${updatedAvatar}.webp`, champion.id)
    .run();
  expect((await list()).tournaments[0]!.winners).toContainEqual({
    name: "新優勝名",
    avatarUrl: `/api/avatars/${updatedAvatar}`,
  });
  expect(await requestDeletion({ ...env, APP_DB: db }, champion.id, crypto.randomUUID())).toBe(
    true,
  );
  for (const detached of [false, true]) {
    if (detached)
      await db
        .prepare("UPDATE tournament_entries SET account_id=NULL WHERE id=?")
        .bind(entry)
        .run();
    const result = await list();
    expect(result.tournaments[0]!.winners).toContainEqual({
      name: "退会したプレイヤー",
      avatarUrl: null,
    });
    expect(result.tournaments[0]!.winners).toContainEqual({
      name: other.name,
      avatarUrl: `/api/avatars/${other.avatar}`,
    });
    expect(result.tournaments[0]!.winners).toHaveLength(2);
    expect(result.tournaments[0]!.entryCount).toBe(2);
    for (const secret of [
      champion.name,
      "新優勝名",
      champion.username,
      champion.avatar,
      updatedAvatar,
      champion.id,
      runner.name,
    ])
      expect(JSON.stringify(result)).not.toContain(secret);
  }
});

test("優勝者のゲスト統合後は同じ確定順位のまま統合先の現在名と画像を返す", async () => {
  const key = await tournament(1, Date.now() - 10000, true);
  const guest = await player("統合前のゲスト", true),
    target = await player("統合先の名前");
  const entry = await score(key, guest.id, 1);
  const tokenHash = crypto.randomUUID(),
    state = crypto.randomUUID();
  const session = await db
    .prepare("SELECT id FROM session WHERE userId=?")
    .bind(target.id)
    .first<{ id: string }>();
  await db.batch([
    db
      .prepare("INSERT INTO guest_sessions(token_hash,account_id,expires_at_ms) VALUES(?,?,?)")
      .bind(tokenHash, guest.id, Date.now() + 60000),
    db
      .prepare(
        "INSERT INTO guest_oauth_flows(state,guest_id,guest_token_hash,provider,started_at_ms,expires_at_ms,target_id,target_session_id,is_new_target) VALUES(?,?,?,'google',?,?,?,?,0)",
      )
      .bind(state, guest.id, tokenHash, Date.now(), Date.now() + 60000, target.id, session!.id),
  ]);
  await mergeGuestAccounts(
    { ...env, APP_DB: db },
    {
      state,
      guest_id: guest.id,
      target_id: target.id,
      target_session_id: session!.id,
      name: guest.name,
      is_new_target: 0,
    },
  );
  const result = await list();
  expect(result.tournaments[0]!.winners).toEqual([
    { name: target.name, avatarUrl: `/api/avatars/${target.avatar}` },
  ]);
  expect(JSON.stringify(result)).not.toContain(guest.name);
  expect(
    await db
      .prepare("SELECT final_rank FROM tournament_scores WHERE entry_id=?")
      .bind(entry)
      .first(),
  ).toEqual({ final_rank: 1 });
});

test("優勝者は表示する20大会分を一括取得し、一覧の大会数でD1往復を増やさない", async () => {
  const now = Date.now();
  for (let id = 1; id <= 25; id++) await tournament(id, now - id * 10000, true);
  let queries = 0;
  const counted = {
    prepare(query: string) {
      queries++;
      return db.prepare(query);
    },
  } as D1Database;
  const result = await publicTournamentList(counted, "all", undefined, now);
  expect(result.tournaments).toHaveLength(20);
  expect(queries).toBe(2);
});

test("開催前の実エントリー人数は0件・複数件と削除済み除外を扱い、既存詳細と一致する", async () => {
  const key = await tournament(1, Date.now() + 60000);
  expect((await list()).tournaments[0]).toMatchObject({ status: "upcoming", entryCount: 0 });
  const users = [await player("登録者"), await player("ゲスト", true), await player("削除済み")];
  await db.batch(
    users.map((user, index) =>
      db
        .prepare(
          "INSERT INTO tournament_entries(id,tournament_key,account_id,entered_at_ms,deleted) VALUES(?,?,?,?,?)",
        )
        .bind(crypto.randomUUID(), key, user.id, Date.now(), index === 2 ? 1 : 0),
    ),
  );
  expect((await list()).tournaments[0]).toMatchObject({
    status: "upcoming",
    entryCount: 2,
    winners: [],
  });
  const response = await worker.fetch(
    new Request(`${origin}/api/tournaments/1`),
    { ...env, APP_DB: db },
    {} as ExecutionContext,
  );
  expect(response.status).toBe(200);
  const detail = tournamentDetailSchema.parse(await response.json());
  expect(detail.tournament.entryCount).toBe(2);
});
