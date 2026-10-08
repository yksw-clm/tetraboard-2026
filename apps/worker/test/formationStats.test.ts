import { env } from "cloudflare:workers";
import { beforeEach, expect, test } from "vitest";
import { sides } from "@tetraboard/four-shogi";
import {
  getFourShogiFormationStatsContract,
  fourShogiAccountStatsSchema,
} from "@tetraboard/protocol";
import { accountFixture } from "./accountFixtures";
import { humanShogiRecord, shogiRecord, saveShogiFixture } from "./shogiMatchFixtures";
import { matchRequest } from "./matchFixtures";
import { advanceShogiMatchSave, type ShogiSaveProgress } from "../src/rooms/shogiMatchStore";
import { emptyFormationUsage, type ShogiFormationUsage } from "../src/rooms/shogiFormationUsage";

beforeEach(async () => {
  await env.APP_DB.batch([
    env.APP_DB.prepare("DELETE FROM account_match_history"),
    env.APP_DB.prepare("DELETE FROM matches"),
    env.APP_DB.prepare("DELETE FROM shogi_match_uploads"),
    env.APP_DB.prepare("DELETE FROM shogi_match_chunks"),
  ]);
});
async function publish(fixture: ReturnType<typeof humanShogiRecord>, usage: ShogiFormationUsage) {
  let progress: ShogiSaveProgress | null = { phase: "upload", cursor: 0 };
  while (progress)
    progress = await advanceShogiMatchSave(
      env.APP_DB,
      fixture.record,
      progress,
      (cursor) => fixture.events.slice(cursor, cursor + 100),
      usage,
    );
}
async function stats(cookie: string) {
  const response = await matchRequest(getFourShogiFormationStatsContract.path, {
    headers: { Cookie: cookie },
  });
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  return getFourShogiFormationStatsContract.response.parse(await response.json());
}

test("戦法別は本人・方向・全件・保存済みだけ集計し、複数戦法と同率優勝を数える", async () => {
  const user = await accountFixture(),
    other = await accountFixture();
  for (const [index, side] of sides.entries()) {
    const fixture = humanShogiRecord(user.id, side);
    const usage = emptyFormationUsage();
    usage.bySide[side] = ["tenshukaku", "batto-silver"];
    fixture.record.game.result = {
      mode: "singles",
      reason: "agreement",
      standings: sides.map((s, i) => ({ side: s, rank: s === side ? index + 1 : i + 1 })),
    };
    // 方向割当と最終順位の対応をAPIで確認するための保存済み結果fixture。
    await publish(fixture, usage);
    await publish(fixture, usage);
  }
  for (let i = 0; i < 21; i++) {
    const usage = emptyFormationUsage();
    usage.bySide.south = ["e-shape"];
    await publish(humanShogiRecord(user.id), usage);
  }
  const ignoredUsage = emptyFormationUsage();
  ignoredUsage.bySide.south = ["right-king"];
  await publish(humanShogiRecord(other.id), ignoredUsage);
  await publish(humanShogiRecord(null), ignoredUsage);
  await publish(humanShogiRecord(user.id), emptyFormationUsage());
  await saveShogiFixture(humanShogiRecord(user.id)); // 導入前の記録。
  await saveShogiFixture(shogiRecord(user.id));
  await saveShogiFixture(humanShogiRecord(user.id, "south", "doubles"));
  const pending = humanShogiRecord(user.id);
  await advanceShogiMatchSave(
    env.APP_DB,
    pending.record,
    { phase: "upload", cursor: 0 },
    (cursor) => pending.events.slice(cursor, cursor + 100),
    ignoredUsage,
  );
  const result = await stats(user.cookie);
  expect(result.sort((a, b) => a.id.localeCompare(b.id))).toEqual([
    { id: "batto-silver", total: 4, first: 1, second: 1, third: 1, fourth: 1 },
    { id: "e-shape", total: 21, first: 21, second: 0, third: 0, fourth: 0 },
    { id: "tenshukaku", total: 4, first: 1, second: 1, third: 1, fourth: 1 },
  ]);
  expect(JSON.stringify(result)).not.toContain(user.id);
  expect(JSON.stringify(result)).not.toContain("record_json");
});

test("完全優勝は過去分を含み、3撃破かつ単独優勝だけ加算する", async () => {
  const user = await accountFixture();
  for (const [knockouts, kind] of [
    [3, "win"],
    [2, "win"],
    [3, "draw"],
    [3, "loss"],
  ] as const) {
    const fixture = humanShogiRecord(user.id);
    fixture.record.knockouts.south = knockouts;
    if (kind === "draw")
      fixture.record.game.result = {
        mode: "singles",
        reason: "agreement",
        standings: sides.map((side) => ({ side, rank: 1 })),
      };
    if (kind === "loss")
      fixture.record.game.result = {
        mode: "singles",
        reason: "last_player",
        standings: sides.map((side, i) => ({
          side,
          rank: side === "south" ? 2 : side === "west" ? 1 : i + 1,
        })),
      };
    await saveShogiFixture(fixture);
  }
  const cpu = shogiRecord(user.id);
  cpu.record.knockouts.south = 3;
  await saveShogiFixture(cpu);
  const response = await matchRequest("/account/stats?game=four-shogi", {
    headers: { Cookie: user.cookie },
  });
  expect(fourShogiAccountStatsSchema.parse(await response.json()).singles).toEqual({
    total: 4,
    first: 3,
    second: 1,
    third: 0,
    fourth: 0,
    knockouts: 11,
    perfectWins: 1,
  });
  expect(await stats(user.cookie)).toEqual([]);
});

test("成立履歴の保存失敗は本体・索引も公開せず、再試行・ack喪失後は一度だけ保存する", async () => {
  const user = await accountFixture(),
    fixture = humanShogiRecord(user.id),
    usage = emptyFormationUsage();
  usage.bySide.south = ["tenshukaku"];
  await env.APP_DB.prepare(`CREATE TRIGGER reject_formations BEFORE INSERT ON shogi_match_formations
    BEGIN SELECT RAISE(ABORT, 'formations unavailable'); END`).run();
  try {
    await expect(publish(fixture, usage)).rejects.toThrow();
    expect(await stats(user.cookie)).toEqual([]);
    expect(
      await env.APP_DB.prepare("SELECT id FROM matches WHERE id = ?")
        .bind(fixture.record.id)
        .first(),
    ).toBeNull();
    expect(
      await env.APP_DB.prepare("SELECT match_id FROM account_match_history WHERE match_id = ?")
        .bind(fixture.record.id)
        .first(),
    ).toBeNull();
  } finally {
    await env.APP_DB.exec("DROP TRIGGER reject_formations");
  }
  await publish(fixture, usage);
  await publish(fixture, usage);
  expect(await stats(user.cookie)).toEqual([
    { id: "tenshukaku", total: 1, first: 1, second: 0, third: 0, fourth: 0 },
  ]);
  expect(
    (await env.APP_DB.prepare("SELECT record_json FROM matches WHERE id = ?")
      .bind(fixture.record.id)
      .first<{ record_json: string }>())!.record_json,
  ).toBe(JSON.stringify(fixture.record));
});

test("未認証・無効Cookieは401、認証と集計障害は503、初回0件は空一覧", async () => {
  for (const headers of [
    new Headers(),
    new Headers({ Cookie: "better-auth.session_token=invalid" }),
  ]) {
    const response = await matchRequest(getFourShogiFormationStatsContract.path, { headers });
    expect(response.status).toBe(401);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  }
  const user = await accountFixture();
  expect(await stats(user.cookie)).toEqual([]);
  for (const table of ["session", "shogi_match_formations"]) {
    await env.APP_DB.exec(`ALTER TABLE ${table} RENAME TO ${table}_unavailable`);
    try {
      const response = await matchRequest(getFourShogiFormationStatsContract.path, {
        headers: { Cookie: user.cookie },
      });
      expect(response.status).toBe(503);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
    } finally {
      await env.APP_DB.exec(`ALTER TABLE ${table}_unavailable RENAME TO ${table}`);
    }
  }
});
