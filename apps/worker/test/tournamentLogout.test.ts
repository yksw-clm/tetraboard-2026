import { env, exports } from "cloudflare:workers";
import { afterEach, expect, test } from "vitest";
import { runInDurableObject } from "cloudflare:test";
import { accountFixture, origin } from "./accountFixtures";
import { AcceptedGameRequest } from "./acceptedGameRequest";
import { accountRoutes } from "../src/accounts/accountRoutes";

const request = (path: string, init?: RequestInit) =>
  exports.default.fetch(new AcceptedGameRequest(`${origin}/api${path}`, init));
const fixtures: { key: string; accountIds: string[] }[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    const coordinator = env.TOURNAMENT_COORDINATOR.getByName(fixture.key);
    for (const accountId of fixture.accountIds) await coordinator.cancelForAccount(accountId);
    await runInDurableObject(coordinator, async (_instance, state) => state.storage.deleteAlarm());
    await env.APP_DB.batch([
      env.APP_DB.prepare(
        "DELETE FROM tournament_point_events WHERE match_id IN (SELECT id FROM tournament_matches WHERE tournament_key=?)",
      ).bind(fixture.key),
      env.APP_DB.prepare("DELETE FROM tournament_scores WHERE tournament_key=?").bind(fixture.key),
      env.APP_DB.prepare(
        "DELETE FROM tournament_match_players WHERE match_id IN (SELECT id FROM tournament_matches WHERE tournament_key=?)",
      ).bind(fixture.key),
      env.APP_DB.prepare("DELETE FROM tournament_matches WHERE tournament_key=?").bind(fixture.key),
      env.APP_DB.prepare("DELETE FROM tournament_wait_reservations WHERE tournament_key=?").bind(
        fixture.key,
      ),
      env.APP_DB.prepare("DELETE FROM tournament_entries WHERE tournament_key=?").bind(fixture.key),
      env.APP_DB.prepare("DELETE FROM tournaments WHERE key=?").bind(fixture.key),
    ]);
  }
});
async function fixture(players: number) {
  const key = crypto.randomUUID(),
    now = Date.now();
  const cleanup = { key, accountIds: [] as string[] };
  fixtures.push(cleanup);
  await env.APP_DB.prepare(`INSERT INTO tournaments(key,public_id,name,starts_at_ms,ends_at_ms,published,created_at_ms,updated_at_ms)
    VALUES(?,(SELECT COALESCE(MAX(public_id),0)+1 FROM tournaments),'大会',?,?,1,?,?)`)
    .bind(key, now - 60_000, now + 3_600_000, now, now)
    .run();
  const coordinator = env.TOURNAMENT_COORDINATOR.getByName(key);
  const accounts = [];
  for (let index = 0; index < players; index++) {
    const account = await accountFixture(),
      operationId = crypto.randomUUID();
    cleanup.accountIds.push(account.id);
    accounts.push({ ...account, operationId });
    expect(await coordinator.enroll(key, account.id)).toEqual({ ok: true });
    expect(
      await coordinator.enqueue(key, account.id, operationId, `${index + 1}`.repeat(64)),
    ).toEqual({ ok: true });
  }
  return { key, coordinator, accounts };
}
test("ログアウトは本人の大会待機を解除してから認証を失効させる", async () => {
  const {
    key,
    coordinator,
    accounts: [account],
  } = await fixture(1);
  expect((await coordinator.status(key, account!.id)).status).toBe("waiting");
  const response = await request("/auth/sign-out", {
    method: "POST",
    headers: account!.headers,
    body: "{}",
  });
  expect(response.status).toBe(200);
  expect((await coordinator.status(key, account!.id)).status).toBe("idle");
  expect(
    await env.APP_DB.prepare("SELECT 1 FROM tournament_wait_reservations WHERE account_id=?")
      .bind(account!.id)
      .first(),
  ).toBeNull();
  expect(await (await request("/account/session", { headers: account!.headers })).json()).toEqual({
    user: null,
  });
});
test("入室待ちのログアウトは専用ルームを取り消し、残り3人を待機へ戻す", async () => {
  const { key, coordinator, accounts } = await fixture(4);
  const before = await coordinator.status(key, accounts[0]!.id);
  expect(before.status).toBe("matched");
  const response = await request("/auth/sign-out", {
    method: "POST",
    headers: accounts[0]!.headers,
    body: "{}",
  });
  expect(response.status).toBe(200);
  expect((await coordinator.status(key, accounts[0]!.id)).status).toBe("idle");
  for (const account of accounts.slice(1)) {
    expect((await coordinator.status(key, account.id)).status).toBe("waiting");
    const confirmation = await coordinator.confirm(
      key,
      account.id,
      account.operationId,
      before.matchId!,
      true,
    );
    expect(confirmation.ok).toBe(false);
  }
  expect(
    await env.APP_DB.prepare("SELECT 1 FROM account_room_seats WHERE account_id IN (?,?,?,?)")
      .bind(...accounts.map((account) => account.id))
      .first(),
  ).toBeNull();
});
test("待機解除に必要なDB取得が失敗したら503とし、セッションを失効させない", async () => {
  const {
    accounts: [account],
  } = await fixture(1);
  const database = new Proxy(env.APP_DB, {
    get(target, property) {
      if (property === "prepare")
        return (sql: string) => {
          if (sql.includes("SELECT DISTINCT e.tournament_key"))
            throw new Error("temporary database failure");
          return target.prepare(sql);
        };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const response = await accountRoutes.request(
    `${origin}/auth/sign-out`,
    { method: "POST", headers: account!.headers, body: "{}" },
    { ...env, APP_DB: database },
  );
  expect(response.status).toBe(503);
  expect(
    await (await request("/account/session", { headers: account!.headers })).json(),
  ).toMatchObject({ user: { username: account!.username } });
});
