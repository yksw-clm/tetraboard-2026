import { env } from "cloudflare:workers";
import { afterEach, expect, test } from "vitest";
import { ratedMatchmakingGameIds } from "@tetraboard/protocol";
import { requestDeletion, digest } from "../src/privacy/deletion";
import { deletionRoutes } from "../src/privacy/deletionRoutes";
import { ratedMatchmakingPolicy } from "../src/matchmaking/ratedMatchmaking";
import { accountFixture, origin } from "./accountFixtures";

const accounts: string[] = [];
const matches: string[] = [];
const tables = [
  "elo_rating_changes",
  "skill_rating_changes",
  "elo_rating_pending",
  "skill_rating_pending",
];
afterEach(async () => {
  for (const id of matches.splice(0))
    await env.APP_DB.prepare("DELETE FROM matches WHERE id=?").bind(id).run();
  for (const id of accounts.splice(0))
    await env.APP_DB.batch([
      env.APP_DB.prepare("DELETE FROM account_room_seats WHERE account_id=?").bind(id),
      env.APP_DB.prepare("DELETE FROM deletion_rooms WHERE account_id=?").bind(id),
      env.APP_DB.prepare("DELETE FROM user WHERE id=?").bind(id),
      env.APP_DB.prepare("DELETE FROM deleted_accounts WHERE id=?").bind(id),
    ]);
});
async function seed() {
  const user = await accountFixture();
  accounts.push(user.id);
  for (const game of ratedMatchmakingGameIds) {
    const match = crypto.randomUUID();
    matches.push(match);
    const store = ratedMatchmakingPolicy(game).store;
    await env.APP_DB.batch([
      env.APP_DB.prepare("INSERT INTO matches VALUES (?,?,'singles',1,2,'{}')").bind(match, game),
      env.APP_DB.prepare(
        game.startsWith("four-")
          ? `INSERT INTO ${store.changesTable} VALUES (?, ?, ?, 25, 8, 26, 7, 1, 0)`
          : `INSERT INTO ${store.changesTable} VALUES (?, ?, ?, 1500, 1524, 1, 0)`,
      ).bind(game, match, user.id),
      env.APP_DB.prepare(
        `INSERT INTO ${store.pendingTable}(game,account_id,match_id) VALUES (?,?,?)`,
      ).bind(game, user.id, match),
    ]);
  }
  return user;
}
async function rows(accountId: string) {
  return Promise.all(
    tables.map(
      async (table) =>
        (
          await env.APP_DB.prepare(`SELECT * FROM ${table} WHERE account_id=? ORDER BY game`)
            .bind(accountId)
            .all()
        ).results,
    ),
  );
}

test("退会受付のbatchで全4ゲームのchangesとpendingを消し、他人の全行と本人のuserを残す", async () => {
  const retiring = await seed();
  const other = await seed();
  const preserved = await rows(other.id);
  expect(preserved.map((entries) => entries.length)).toEqual([2, 2, 2, 2]);
  expect((await rows(retiring.id)).map((entries) => entries.length)).toEqual([2, 2, 2, 2]);
  expect(await requestDeletion(env, retiring.id, crypto.randomUUID())).toBe(true);
  expect(await rows(retiring.id)).toEqual([[], [], [], []]);
  expect(await rows(other.id)).toEqual(preserved);
  expect(
    await env.APP_DB.prepare("SELECT 1 FROM user WHERE id=?").bind(retiring.id).first(),
  ).not.toBeNull();
});

test("在室で退会受付が失敗するとレートの全行を残す", async () => {
  const user = await seed();
  const before = await rows(user.id);
  await env.APP_DB.prepare(
    "INSERT INTO account_room_seats(account_id,operation_id,room_id,instance_id,player_id,name,created_at_ms) VALUES (?,?, '12345',?,?,'登録名',1)",
  )
    .bind(user.id, crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID())
    .run();
  expect(await requestDeletion(env, user.id, crypto.randomUUID())).toBe(false);
  expect(await rows(user.id)).toEqual(before);
});

test("既存の退会行のreceiptが今回と違うとレートを消さない", async () => {
  const user = await seed();
  await env.APP_DB.prepare(
    "INSERT INTO deleted_accounts(id,requested_at_ms,receipt_hash) VALUES (?,1,?)",
  )
    .bind(user.id, await digest("previous-receipt"))
    .run();
  const before = await rows(user.id);
  expect(await requestDeletion(env, user.id, "different-receipt")).toBe(false);
  expect(await rows(user.id)).toEqual(before);
});

test("再認証の確認が失敗した退会リクエストはレートを消さない", async () => {
  const user = await seed();
  const before = await rows(user.id);
  const response = await deletionRoutes.request(
    new Request(`${origin}/account/deletion/confirm`, {
      method: "POST",
      headers: user.headers,
      body: JSON.stringify({ confirm: true }),
    }),
    {},
    env,
  );
  expect(response.status).toBe(403);
  expect(await rows(user.id)).toEqual(before);
});

test("レート削除が失敗すると退会受付と他のレート削除もbatch全体でロールバックする", async () => {
  const user = await seed();
  const before = await rows(user.id);
  await env.APP_DB.exec(
    "CREATE TRIGGER rating_deletion_failure BEFORE DELETE ON skill_rating_pending BEGIN SELECT RAISE(ABORT,'rating deletion failed'); END",
  );
  try {
    await expect(requestDeletion(env, user.id, crypto.randomUUID())).rejects.toThrow();
    expect(
      await env.APP_DB.prepare("SELECT 1 FROM deleted_accounts WHERE id=?").bind(user.id).first(),
    ).toBeNull();
    expect(await rows(user.id)).toEqual(before);
  } finally {
    await env.APP_DB.exec("DROP TRIGGER rating_deletion_failure");
  }
});
