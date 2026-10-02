import { env } from "cloudflare:workers";
import { afterEach, expect, test, vi } from "vitest";
import { getMatchContract, listMatchesContract } from "@tetraboard/protocol";
import { accountFixture } from "./accountFixtures";
import {
  fixtureRecord,
  matchClients,
  matchSetup,
  matchStart,
  matchLeave,
  matchRequest,
} from "./matchFixtures";
import { writeMatch } from "../src/rooms/matchStore";

const detail = (id: string, cookie?: string) =>
  matchRequest(`/account/matches/${id}`, { headers: cookie ? { Cookie: cookie } : {} });
afterEach(() => {
  for (const client of matchClients.splice(0)) client.close();
});

for (const mode of ["singles", "doubles"] as const) {
  test(`${mode}の本人の棋譜と色・席順を返し、非公開情報を含めない`, async () => {
    const user = await accountFixture();
    const other = await accountFixture();
    const record = fixtureRecord(user.id, 1, mode);
    await writeMatch(env.APP_DB, record);
    const response = await detail(record.id, user.cookie);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body = await response.json();
    const { match } = getMatchContract.response.parse(body);
    expect(match.selfPlayerId).toBe(record.participants[0].id);
    expect(match.game).toEqual(record.game);
    expect(match.replay).toEqual(record.replay);
    expect(match.eliminations).toEqual(record.eliminations);
    expect(match.settings).toEqual(record.settings);
    expect(match.participants.map((p) => [p.id, p.seat, p.color])).toEqual(
      record.participants.map((p) => [p.id, p.seat, p.color]),
    );
    for (const value of [user.id, record.instanceId, '"accountId"', '"token"', '"chat"'])
      expect(JSON.stringify(body)).not.toContain(value);
    for (const id of [record.id, crypto.randomUUID()]) {
      const missing = await detail(id, other.cookie);
      expect(missing.status).toBe(404);
      expect(missing.headers.get("Cache-Control")).toBe("no-store");
      expect(await missing.json()).toEqual({ message: "この棋譜は閲覧できません。" });
    }
  });
}

test("名前は開始時、アイコンは現在のプロフィールを使う", async () => {
  const user = await accountFixture();
  const record = fixtureRecord(user.id, 2);
  await writeMatch(env.APP_DB, record);
  const key = `avatars/${crypto.randomUUID()}.webp`;
  await env.APP_DB.prepare("UPDATE user SET name = ?, avatarKey = ? WHERE id = ?")
    .bind("変更後", key, user.id)
    .run();
  const read = async () =>
    getMatchContract.response.parse(await (await detail(record.id, user.cookie)).json()).match;
  expect((await read()).participants[0]).toMatchObject({
    name: "開始時の名前",
    avatarUrl: `/api/avatars/${key.slice(8, -5)}`,
  });
  await env.APP_DB.prepare("UPDATE user SET avatarKey = NULL WHERE id = ?").bind(user.id).run();
  expect((await read()).participants[0]).toMatchObject({ avatarUrl: null });
});

test("未認証・不正IDを拒否し、認証とD1の障害を503にする", async () => {
  const user = await accountFixture();
  const record = fixtureRecord(user.id, 3);
  await writeMatch(env.APP_DB, record);
  expect((await detail(record.id)).status).toBe(401);
  const invalid = await detail("bad-id", user.cookie);
  expect(invalid.status).toBe(400);
  expect(invalid.headers.get("Cache-Control")).toBe("no-store");
  for (const table of ["session", "matches"]) {
    await env.APP_DB.exec(`ALTER TABLE ${table} RENAME TO ${table}_unavailable`);
    try {
      const response = await detail(record.id, user.cookie);
      expect(response.status).toBe(503);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
    } finally {
      await env.APP_DB.exec(`ALTER TABLE ${table}_unavailable RENAME TO ${table}`);
    }
  }
});

test("実終局から部屋閉鎖後も同じ保存済み棋譜を取得できる", async () => {
  const setup = await matchSetup("doubles");
  const started = await matchStart(setup);
  await matchLeave(setup.id, setup.memberships[0]);
  let id = "";
  await vi.waitFor(async () => {
    const response = await matchRequest("/account/matches?mode=doubles", {
      headers: { Cookie: setup.user.cookie },
    });
    const { matches } = listMatchesContract.response.parse(await response.json());
    expect(matches).toHaveLength(1);
    id = matches[0].id;
  });
  for (const membership of setup.memberships.slice(1)) await matchLeave(setup.id, membership);
  expect((await matchRequest(`/rooms/${setup.id}`)).status).toBe(404);
  const response = await detail(id, setup.user.cookie);
  expect(response.status).toBe(200);
  const { match } = getMatchContract.response.parse(await response.json());
  expect(match.participants.map((p) => p.color)).toEqual(started.players.map((p) => p.color));
  expect(match.game.status).toBe("finished");
  expect(match.replay.steps.at(-1)?.action).toMatchObject({ type: "eliminate", reason: "left" });
});
