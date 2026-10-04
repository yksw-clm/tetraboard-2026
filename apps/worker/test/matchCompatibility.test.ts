import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, expect, test } from "vitest";
import { getMatchContract, listMatchesContract } from "@tetraboard/protocol";
import { reversiArchives, shogiArchives } from "../../../test-fixtures/matches";
import { accountFixture } from "./accountFixtures";
import { matchRequest } from "./matchFixtures";
import {
  advanceShogiMatchSave,
  readShogiMatchRecord,
  type ShogiMatchRecord,
  type ShogiSaveProgress,
} from "../src/rooms/shogiMatchStore";
import { fourShogiReplayEventSchema } from "@tetraboard/protocol";
// 旧形式は実DO storageに残る元データを保存処理へ渡します。読取り正規化の結果を再保存しません。
async function persistedRecord(json: string) {
  readShogiMatchRecord(json);
  return runInDurableObject(
    env.GAME_ROOM.getByName("compatibility-save-fixture"),
    async (_, state) => {
      const raw: unknown = JSON.parse(json);
      await state.storage.put("compatibility-record", raw);
      const record = await state.storage.get<ShogiMatchRecord>("compatibility-record");
      await state.storage.delete("compatibility-record");
      if (!record) throw new Error("Missing stored fixture");
      return record;
    },
  );
}
const users: string[] = [];
afterEach(async () => {
  for (const id of new Set([...reversiArchives, ...shogiArchives].map((f) => f.detail.id))) {
    for (const [table, column] of [
      ["account_match_history", "match_id"],
      ["shogi_match_chunks", "match_id"],
      ["shogi_match_uploads", "id"],
      ["matches", "id"],
    ])
      await env.APP_DB.prepare(`DELETE FROM ${table} WHERE ${column}=?`).bind(id).run();
  }
  for (const id of users.splice(0)) {
    await env.APP_DB.prepare("DELETE FROM session WHERE userId=?").bind(id).run();
    await env.APP_DB.prepare("DELETE FROM user WHERE id=?").bind(id).run();
  }
});
for (const fixture of [...reversiArchives, ...shogiArchives]) {
  test(`${fixture.name}: 固定保存記録を本人限定で取得する`, async () => {
    const user = await accountFixture();
    users.push(user.id);
    const json = fixture.recordJson.replaceAll("fixture-self", user.id);
    const match = fixture.detail;
    if (match.settings.game === "four-shogi") {
      const record = await persistedRecord(json);
      const events = fixture.events.map((entry) => fourShogiReplayEventSchema.parse(entry.event));
      let progress: ShogiSaveProgress | null = { phase: "upload", cursor: 0 };
      while (progress)
        progress = await advanceShogiMatchSave(env.APP_DB, record, progress, (cursor) =>
          events.slice(cursor, cursor + 100),
        );
    } else {
      await env.APP_DB.prepare(
        "INSERT INTO matches (id,game,mode,started_at_ms,ended_at_ms,record_json) VALUES (?,?,?,?,?,?)",
      )
        .bind(
          match.id,
          match.settings.game,
          match.settings.mode,
          match.startedAtMs,
          match.endedAtMs,
          json,
        )
        .run();
    }
    await env.APP_DB.prepare(
      "INSERT INTO account_match_history (account_id,match_id,game,mode,started_at_ms) VALUES (?,?,?,?,?) ON CONFLICT DO NOTHING",
    )
      .bind(user.id, match.id, match.settings.game, match.settings.mode, match.startedAtMs)
      .run();
    const response = await matchRequest(`/account/matches/${match.id}`, {
      headers: { Cookie: user.cookie },
    });
    expect(response.status).toBe(200);
    const body = getMatchContract.response.parse(await response.json());
    expect(body.match).toEqual(getMatchContract.response.parse({ match }).match);
    expect(JSON.stringify(body)).not.toContain(user.id);
    const history = await matchRequest(
      `/account/matches?game=${match.settings.game}&mode=${match.settings.mode}`,
      { headers: { Cookie: user.cookie } },
    );
    expect(
      listMatchesContract.response.parse(await history.json()).matches.map((m) => m.id),
    ).toEqual([match.id]);
    const stored = await env.APP_DB.prepare("SELECT record_json FROM matches WHERE id=?")
      .bind(match.id)
      .first<{ record_json: string }>();
    expect(stored?.record_json).toBe(json);
  });
}
test("旧形式の保存待ちは元JSONとmanifestを保持したまま再開する", async () => {
  const fixture = shogiArchives.find((f) => f.name === "shogi-legacy");
  if (!fixture) throw new Error("Missing frozen legacy archive");
  const record = await persistedRecord(fixture.recordJson);
  const events = fixture.events.map((entry) => fourShogiReplayEventSchema.parse(entry.event));
  const source = (cursor: number) => events.slice(cursor, cursor + 100);
  const progress = await advanceShogiMatchSave(
    env.APP_DB,
    record,
    { phase: "upload", cursor: 0 },
    source,
  );
  expect(progress).toEqual({ phase: "verify", cursor: 0 });
  expect(
    await env.APP_DB.prepare("SELECT id FROM matches WHERE id=?").bind(record.id).first(),
  ).toBeNull();
  const manifest = await env.APP_DB.prepare(
    "SELECT record_json FROM shogi_match_uploads WHERE id=?",
  )
    .bind(record.id)
    .first<{ record_json: string }>();
  expect(manifest?.record_json).toBe(fixture.recordJson);
  if (!progress) throw new Error("Expected incomplete upload");
  expect(
    await advanceShogiMatchSave(
      env.APP_DB,
      await persistedRecord(manifest!.record_json),
      progress,
      source,
    ),
  ).toBeNull();
  const stored = await env.APP_DB.prepare("SELECT record_json FROM matches WHERE id=?")
    .bind(record.id)
    .first<{ record_json: string }>();
  expect(stored?.record_json).toBe(fixture.recordJson);
});

const corruptions = [
  {
    name: "未知ゲーム",
    json: (json: string) => json.replace('"game":"four-shogi"', '"game":"unknown"'),
    game: "four-shogi",
  },
  { name: "ゲーム列の取り違え", json: (json: string) => json, game: "four-reversi" },
  {
    name: "未知ルール版",
    json: (json: string) => json.replace('"rulesVersion":1', '"rulesVersion":2'),
    game: "four-shogi",
  },
  { name: "不正JSON", json: () => "{", game: "four-shogi" },
  {
    name: "内部ID欠落",
    json: (json: string) =>
      json.replace('"instanceId":"77777777-7777-4777-8777-777777777777",', ""),
    game: "four-shogi",
  },
  {
    name: "内部アカウントID不正",
    json: (json: string) => json.replace('"accountId":"fixture-other"', '"accountId":""'),
    game: "four-shogi",
  },
  {
    name: "未対応の保存形状",
    json: (json: string) => json.replace('"knockouts":', '"unsupportedKnockouts":'),
    game: "four-shogi",
  },
];
for (const corruption of corruptions) {
  test(`${corruption.name}の保存記録は履歴・詳細の取得失敗として扱う`, async () => {
    const fixture = shogiArchives[0];
    const user = await accountFixture();
    users.push(user.id);
    const json = corruption.json(fixture.recordJson.replaceAll("fixture-self", user.id));
    const match = fixture.detail;
    await env.APP_DB.prepare(
      "INSERT INTO matches (id,game,mode,started_at_ms,ended_at_ms,record_json) VALUES (?,?,?,?,?,?)",
    )
      .bind(
        match.id,
        corruption.game,
        match.settings.mode,
        match.startedAtMs,
        match.endedAtMs,
        json,
      )
      .run();
    await env.APP_DB.prepare(
      "INSERT INTO account_match_history (account_id,match_id,game,mode,started_at_ms) VALUES (?,?,?,?,?)",
    )
      .bind(user.id, match.id, corruption.game, match.settings.mode, match.startedAtMs)
      .run();
    for (const path of [
      `/account/matches/${match.id}`,
      `/account/matches?game=${corruption.game}&mode=singles`,
      `/account/matches/${match.id}/replay`,
    ]) {
      const response = await matchRequest(path, { headers: { Cookie: user.cookie } });
      expect(response.status).toBe(503);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(await response.json()).toEqual({
        message: path.includes("?game=")
          ? "対局履歴を取得できませんでした。もう一度お試しください。"
          : "棋譜を取得できませんでした。もう一度お試しください。",
      });
    }
  });
}
