import { env } from "cloudflare:workers";
import { beforeEach, afterEach, expect, test, vi } from "vitest";
import { getFourReversiRankingsContract } from "@tetraboard/protocol";
import { accountFixture } from "./accountFixtures";
import {
  fixtureRecord,
  matchClients,
  matchLeave,
  matchRequest,
  matchSetup,
  matchStart,
} from "./matchFixtures";
import { writeMatch } from "../src/rooms/matchStore";

const empty = { singles: { first: [], total: [] }, doubles: { wins: [], total: [] } };
async function rankings() {
  const response = await matchRequest(getFourReversiRankingsContract.path);
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  return getFourReversiRankingsContract.response.parse(await response.json());
}
function champion(accountId: string, index: number) {
  const record = fixtureRecord(accountId, index);
  if (record.game.result.mode !== "singles") throw new Error("Wrong mode");
  record.game.result.standings = ["black", "white", "red", "blue"].map((color, i) => ({
    color: color as "black" | "white" | "red" | "blue",
    rank: [1, 1, 3, 4][i],
    stoneCount: [20, 20, 15, 9][i],
  }));
  return record;
}
beforeEach(async () => {
  // 全アカウントを対象にするため、各ケースの保存履歴を独立させます。
  await env.APP_DB.batch([
    env.APP_DB.prepare("DELETE FROM account_match_history"),
    env.APP_DB.prepare("DELETE FROM matches"),
  ]);
});
afterEach(() => {
  for (const client of matchClients.splice(0)) client.close();
});

test("匿名で両モードの空ランキングを取得できる", async () => {
  expect(await rankings()).toEqual(empty);
  const response = await matchRequest(getFourReversiRankingsContract.path, {
    headers: { Cookie: "invalid=invalid" },
  });
  expect(response.status).toBe(200);
});

test("CPU戦・全色・同率優勝を集計し、0回・ゲスト・CPU・未設定プロフィールを掲載しない", async () => {
  const black = await accountFixture();
  const white = await accountFixture();
  const loser = await accountFixture();
  const incomplete = await accountFixture(false);
  const record = champion(black.id, 1);
  record.participants[1] = { ...record.participants[1], kind: "human", accountId: white.id };
  await writeMatch(env.APP_DB, record);
  for (const color of ["red", "blue"] as const) {
    const win = champion(black.id, color === "red" ? 2 : 3);
    win.participants[0].color = color;
    win.participants.find((p, i) => i !== 0 && p.color === color)!.color = "black";
    if (win.game.result.mode !== "singles") throw new Error("Wrong mode");
    win.game.result.standings = win.game.result.standings.map((s) => ({
      ...s,
      rank: s.color === color ? 1 : 2,
    }));
    await writeMatch(env.APP_DB, win);
  }
  await writeMatch(env.APP_DB, fixtureRecord(loser.id, 1));
  await writeMatch(env.APP_DB, champion(incomplete.id, 1));
  const guest = champion(black.id, 4);
  for (const p of guest.participants) if (p.kind === "human") p.accountId = null;
  await writeMatch(env.APP_DB, guest);
  const result = await rankings();
  expect(result.singles.first.map((p) => [p.username, p.value])).toEqual([
    [black.username, 3],
    [white.username, 1],
  ]);
  expect(result.singles.total).toHaveLength(3);
  expect(result.singles.total.find((p) => p.username === loser.username)?.value).toBe(1);
  expect(JSON.stringify(result)).not.toContain(black.id);
  expect(JSON.stringify(result)).not.toContain("record_json");
  expect(JSON.stringify(result)).not.toContain("ゲスト");
  expect(result.doubles).toEqual(empty.doubles);
});

test("ダブルスの両チーム・全色の勝利を数え、引き分けと敗北は対局数だけに数える", async () => {
  const user = await accountFixture();
  const colors = ["black", "red", "white", "blue"] as const;
  for (const [index, color] of colors.entries()) {
    const record = fixtureRecord(user.id, index + 1, "doubles");
    record.participants.find((p) => p.color === color)!.color = "black";
    record.participants[0].color = color;
    if (record.game.result.mode !== "doubles") throw new Error("Wrong mode");
    record.game.result.winner = index < 2 ? "black-red" : "white-blue";
    await writeMatch(env.APP_DB, record);
  }
  const draw = fixtureRecord(user.id, 5, "doubles");
  if (draw.game.result.mode !== "doubles") throw new Error("Wrong mode");
  draw.game.result.winner = null;
  await writeMatch(env.APP_DB, draw);
  const loss = fixtureRecord(user.id, 6, "doubles");
  if (loss.game.result.mode !== "doubles") throw new Error("Wrong mode");
  loss.game.result.winner = "white-blue";
  await writeMatch(env.APP_DB, loss);
  const result = await rankings();
  expect(result.doubles.wins[0]?.value).toBe(4);
  expect(result.doubles.total[0]?.value).toBe(6);
});

test("同数は1・1・3位とし、10人目の同数も公開ID順で最大10人に制限する", async () => {
  const users = [];
  for (let index = 0; index < 12; index++) {
    const user = await accountFixture();
    const username = `rank_${String(index).padStart(2, "0")}`;
    await env.APP_DB.prepare("UPDATE user SET username = ? WHERE id = ?")
      .bind(username, user.id)
      .run();
    users.push(username);
    for (let count = 1; count <= (index < 2 ? 2 : 1); count++)
      await writeMatch(env.APP_DB, champion(user.id, count));
  }
  const result = await rankings();
  for (const list of [result.singles.first, result.singles.total]) {
    expect(list.map((p) => p.username)).toEqual(users.slice(0, 10));
    expect(list.map((p) => p.rank)).toEqual([1, 1, 3, 3, 3, 3, 3, 3, 3, 3]);
  }
});

test("全履歴を集計し、再送を重複させず、最新の名前・公開ID・アイコンを表示する", async () => {
  const user = await accountFixture();
  for (let index = 1; index <= 41; index++) await writeMatch(env.APP_DB, champion(user.id, index));
  await writeMatch(env.APP_DB, champion(user.id, 41));
  expect((await rankings()).singles.first[0]?.value).toBe(41);
  const avatarKey = `avatars/${crypto.randomUUID()}.webp`;
  await env.APP_DB.prepare("UPDATE user SET name = ?, username = ?, avatarKey = ? WHERE id = ?")
    .bind("最新の名前", "latest_id", avatarKey, user.id)
    .run();
  const entry = (await rankings()).singles.first[0];
  expect(entry).toEqual({
    rank: 1,
    username: "latest_id",
    name: "最新の名前",
    avatarUrl: `/api/avatars/${avatarKey.slice(8, -5)}`,
    value: 41,
  });
  await env.APP_DB.prepare("UPDATE user SET avatarKey = NULL WHERE id = ?").bind(user.id).run();
  expect((await rankings()).singles.first[0]?.avatarUrl).toBeNull();
});

test("実際の未終局は含めず、終局保存後に対局数を反映する", async () => {
  const setup = await matchSetup("doubles");
  await matchStart(setup);
  expect(await rankings()).toEqual(empty);
  await matchLeave(setup.id, setup.memberships[0]);
  await vi.waitFor(async () => expect((await rankings()).doubles.total[0]?.value).toBe(1));
  expect((await rankings()).doubles.wins).toEqual([]);
});

test("D1取得失敗はゼロ件にせず503を返す", async () => {
  await env.APP_DB.exec("ALTER TABLE matches RENAME TO matches_unavailable");
  try {
    const response = await matchRequest(getFourReversiRankingsContract.path);
    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toHaveProperty(
      "message",
      "ランキングを取得できませんでした。もう一度お試しください。",
    );
  } finally {
    await env.APP_DB.exec("ALTER TABLE matches_unavailable RENAME TO matches");
  }
});
