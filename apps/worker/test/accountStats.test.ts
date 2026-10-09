import { env } from "cloudflare:workers";
import { afterEach, expect, test, vi } from "vitest";
import { getAccountStatsContract, type AccountStats } from "@tetraboard/protocol";
import { accountFixture } from "./accountFixtures";
import {
  humanFixtureRecord as fixtureRecord,
  matchClients,
  matchLeave,
  matchRequest,
  matchSetup,
  matchStart,
} from "./matchFixtures";
import { writeMatch } from "../src/rooms/matchStore";

const emptyStats: AccountStats = {
  singles: { total: 0, first: 0, second: 0, third: 0, fourth: 0 },
  doubles: { total: 0, wins: 0, losses: 0, draws: 0 },
};
async function stats(user: Awaited<ReturnType<typeof accountFixture>>) {
  const response = await matchRequest("/account/stats", { headers: { Cookie: user.cookie } });
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  return parseLegacyStats(await response.json());
}
afterEach(() => {
  for (const client of matchClients.splice(0)) client.close();
});

test("保存履歴がない本人は両モードの件数がすべて0になる", async () => {
  expect(await stats(await accountFixture())).toEqual(emptyStats);
});

test("全色の本人を確定順位で集計し、同率優勝と順位の飛びを保持する", async () => {
  const user = await accountFixture();
  const colors = ["black", "white", "red", "blue"] as const;
  // The account occupies each color, including a position other than the first participant.
  for (let index = 0; index < 4; index++) {
    const record = fixtureRecord(user.id, index + 1);
    const account = record.participants[0];
    if (account.kind !== "human") throw new Error("Missing account");
    account.accountId = null;
    record.participants[index] = {
      ...record.participants[index],
      kind: "human",
      accountId: user.id,
    };
    if (record.game.result.mode !== "singles") throw new Error("Wrong mode");
    record.game.result.standings = colors.map((color, i) => ({
      color,
      rank: i + 1,
      stoneCount: 25 - i * 6,
    }));
    await writeMatch(env.APP_DB, record);
  }
  const tied = fixtureRecord(user.id, 5);
  if (tied.game.result.mode !== "singles") throw new Error("Wrong mode");
  tied.game.result.standings = colors.map((color, i) => ({
    color,
    rank: [1, 1, 3, 4][i],
    stoneCount: [20, 20, 15, 9][i],
  }));
  await writeMatch(env.APP_DB, tied);
  expect((await stats(user)).singles).toEqual({
    total: 5,
    first: 2,
    second: 1,
    third: 1,
    fourth: 1,
  });
});

test("黒赤・白青の両チームで勝敗を求め、引き分けも対局数に含める", async () => {
  const user = await accountFixture();
  const colors = ["black", "red", "white", "blue"] as const;
  for (let index = 0; index < 4; index++) {
    const record = fixtureRecord(user.id, index + 1, "doubles");
    // Swap colors rather than assuming the account is always black.
    const teammate = record.participants.find((p) => p.color === colors[index])!;
    teammate.color = "black";
    record.participants[0].color = colors[index];
    if (record.game.result.mode !== "doubles") throw new Error("Wrong mode");
    record.game.result.winner = index % 2 === 0 ? "black-red" : "white-blue";
    await writeMatch(env.APP_DB, record);
  }
  const draw = fixtureRecord(user.id, 5, "doubles");
  if (draw.game.result.mode !== "doubles") throw new Error("Wrong mode");
  draw.game.result.winner = null;
  draw.game.result.reason = "board_full";
  draw.game.result.teamTotals = { "black-red": 32, "white-blue": 32 };
  await writeMatch(env.APP_DB, draw);
  expect((await stats(user)).doubles).toEqual({ total: 5, wins: 2, losses: 2, draws: 1 });
  expect((await stats(user)).singles).toEqual(emptyStats.singles);
});

test("20件を超える全保存履歴を集計し、別人・ゲスト・再送は件数を増やさない", async () => {
  const user = await accountFixture();
  const other = await accountFixture();
  for (let index = 1; index <= 41; index++)
    await writeMatch(env.APP_DB, fixtureRecord(user.id, index));
  await writeMatch(env.APP_DB, fixtureRecord(user.id, 41));
  const conflicting = fixtureRecord(other.id, 1);
  conflicting.id = fixtureRecord(user.id, 41).id;
  await writeMatch(env.APP_DB, conflicting);
  await writeMatch(env.APP_DB, fixtureRecord(other.id, 2));
  const guest = fixtureRecord(user.id, 42);
  for (const participant of guest.participants)
    if (participant.kind === "human") participant.accountId = null;
  await writeMatch(env.APP_DB, guest);
  expect((await stats(user)).singles).toEqual({
    total: 41,
    first: 0,
    second: 0,
    third: 0,
    fourth: 41,
  });
  expect((await stats(other)).singles.total).toBe(1);
  const response = await matchRequest(`/account/stats?accountId=${other.id}`, {
    headers: { Cookie: user.cookie },
  });
  const body = await response.json();
  expect(body).toEqual(await stats(user));
  expect(JSON.stringify(body)).not.toContain(user.id);
  expect(JSON.stringify(body)).not.toContain("record_json");
});

test("未終局は含めず、実際の終局が保存された後に戦績を更新する", async () => {
  const setup = await matchSetup("doubles");
  await matchStart(setup);
  expect(await stats(setup.user)).toEqual(emptyStats);
  await matchLeave(setup.id, setup.memberships[0]);
  await vi.waitFor(async () =>
    expect((await stats(setup.user)).doubles).toEqual({ total: 1, wins: 0, losses: 1, draws: 0 }),
  );
});

test("未認証・無効Cookieは401、D1と認証取得の失敗は503にする", async () => {
  const user = await accountFixture();
  for (const headers of [
    new Headers(),
    new Headers({ Cookie: "better-auth.session_token=invalid" }),
  ]) {
    const response = await matchRequest("/account/stats", { headers });
    expect(response.status).toBe(401);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  }
  for (const table of ["matches", "session"]) {
    await env.APP_DB.exec(`ALTER TABLE ${table} RENAME TO ${table}_unavailable`);
    try {
      const response = await matchRequest("/account/stats", { headers: { Cookie: user.cookie } });
      expect(response.status).toBe(503);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(await response.json()).toHaveProperty(
        "message",
        "戦績を取得できませんでした。もう一度お試しください。",
      );
    } finally {
      await env.APP_DB.exec(`ALTER TABLE ${table}_unavailable RENAME TO ${table}`);
    }
  }
});

function parseLegacyStats(value: unknown) {
  const stats = getAccountStatsContract.response.parse(value);
  if (!("singles" in stats)) throw Error("Expected four-player stats");
  return stats;
}
