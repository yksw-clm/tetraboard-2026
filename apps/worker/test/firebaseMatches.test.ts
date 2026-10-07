import { env } from "cloudflare:workers";
import { afterEach, expect, test } from "vitest";
import {
  getMatchContract,
  getAccountStatsContract,
  createRoomContract,
} from "@tetraboard/protocol";
import fixture from "../../../test-fixtures/matches/firebase-four-reversi.json";
import incompatibleShogi from "../../../test-fixtures/matches/firebase-four-shogi.json";
import { prepareFirebaseMatches, type FirebaseMatchTarget } from "../scripts/firebaseMatchPlan";
import { accountFixture } from "./accountFixtures";
import { matchRequest } from "./matchFixtures";

const empty = (): FirebaseMatchTarget => ({ users: [], matches: [], chunks: [], history: [] });
const users: string[] = [];
afterEach(async () => {
  await env.APP_DB.prepare("DELETE FROM account_match_history WHERE match_id=?")
    .bind(fixture.source.match.id)
    .run();
  await env.APP_DB.prepare("DELETE FROM matches WHERE id=?").bind(fixture.source.match.id).run();
  for (const id of users.splice(0)) {
    await env.APP_DB.prepare("DELETE FROM session WHERE userId=?").bind(id).run();
    await env.APP_DB.prepare("DELETE FROM user WHERE id=?").bind(id).run();
  }
});
const plan = () => prepareFirebaseMatches([fixture.source], [], empty());
function statements(sql: string) {
  return sql
    .trim()
    .split(";\n")
    .map((statement) => env.APP_DB.prepare(statement.replace(/;$/, "")));
}

test("Firebase初期配置・元着手・順位を保持し、時間設定を推測しない", () => {
  const prepared = plan();
  expect(prepared.skipped).toEqual([]);
  expect(prepared.matches).toHaveLength(1);
  const match = prepared.matches[0];
  if (match.game !== "four-reversi") throw Error("Wrong game");
  expect(JSON.stringify(match.record)).toBe(fixture.recordJson);
  expect(match.record.settings).toEqual({
    game: "four-reversi",
    mode: "singles",
    timeControl: null,
  });
  expect(match.record.participants.every((p) => p.kind === "human" && p.accountId === null)).toBe(
    true,
  );
  expect(match.record.replay.steps).toHaveLength(fixture.source.match.moveCount);
  for (const point of fixture.checkpoints) {
    const state =
      point.index === 0
        ? match.record.replay.initial
        : match.record.replay.steps[point.index - 1].game;
    expect(state.board).toEqual(point.board);
  }
  expect(createRoomContract.request.safeParse({ name: "参加者", timeControl: null }).success).toBe(
    false,
  );
});

test("モード欠落と、旧版と異なる将棋の持ち駒を除外する", () => {
  const missing = structuredClone(incompatibleShogi.source);
  delete (missing.match.meta as { fourShogiMode?: string }).fourShogiMode;
  expect(prepareFirebaseMatches([missing], [], empty()).skipped[0].reason).toBe("missing_mode");
  expect(prepareFirebaseMatches([incompatibleShogi.source], [], empty()).skipped[0].reason).toBe(
    "legacy_state_mismatch",
  );
});

test("不足イベント・未終局・異なる結果を補完せず、元データ破損は停止する", () => {
  const turn = structuredClone(fixture.source);
  turn.moves[0].color = "red";
  turn.moveChunks[0].moves[0].color = "red";
  expect(prepareFirebaseMatches([turn], [], empty()).skipped[0].reason).toBe("turn_mismatch");
  const short = structuredClone(fixture.source);
  short.moves.pop();
  short.moveChunks[0].moves.pop();
  short.match.moveCount--;
  expect(prepareFirebaseMatches([short], [], empty()).skipped[0].reason).toBe("unfinished");
  const result = structuredClone(fixture.source);
  result.match.players[0].rank = 4;
  expect(prepareFirebaseMatches([result], [], empty()).skipped[0].reason).toBe("result_mismatch");
  expect(() => prepareFirebaseMatches([fixture.source, fixture.source], [], empty())).toThrow(
    /Duplicate/,
  );
  const corrupt = structuredClone(fixture.source);
  corrupt.moveChunks[0].moves.pop();
  expect(() => prepareFirebaseMatches([corrupt], [], empty())).toThrow(/chunks/);
});

test("指定UIDの本人だけを紐付け、D1保存・再実行・履歴・戦績を照合する", async () => {
  const user = await accountFixture();
  users.push(user.id);
  const source = structuredClone(fixture.source);
  source.match.playerSnapshots.find((p) => p.seat === 1)!.name = "O'Brien";
  const link = {
    sourceUid: "fixture-seat-1",
    sourceName: "O'Brien",
    accountId: user.id,
    username: user.username,
  };
  const target = empty();
  target.users.push({
    id: user.id,
    username: user.username,
    profileCompleted: 1,
    isAnonymous: null,
  });
  const prepared = prepareFirebaseMatches([source], [link], target);
  const match = prepared.matches[0];
  expect(
    match.record.participants.filter((p) => p.kind === "human" && p.accountId !== null),
  ).toHaveLength(1);
  await env.APP_DB.batch(statements(prepared.sql));
  await env.APP_DB.batch(statements(prepared.sql));
  expect(
    await env.APP_DB.prepare("SELECT count(*) AS n FROM matches WHERE id=?")
      .bind(match.record.id)
      .first(),
  ).toEqual({ n: 1 });
  target.matches = (
    await env.APP_DB.prepare("SELECT * FROM matches WHERE id=?")
      .bind(match.record.id)
      .all<FirebaseMatchTarget["matches"][number]>()
  ).results;
  target.history = (
    await env.APP_DB.prepare("SELECT * FROM account_match_history WHERE match_id=?")
      .bind(match.record.id)
      .all<FirebaseMatchTarget["history"][number]>()
  ).results;
  expect(prepareFirebaseMatches([source], [link], target).matches).toEqual(prepared.matches);
  const response = await matchRequest(`/account/matches/${match.record.id}`, {
    headers: { Cookie: user.cookie },
  });
  expect(response.status).toBe(200);
  const detail = getMatchContract.response.parse(await response.json()).match;
  expect(detail.settings.timeControl).toBeNull();
  expect(detail.participants.find((p) => p.seat === 1)?.name).toBe("登録名");
  expect(
    JSON.parse(target.matches[0]!.record_json).participants.find(
      (p: { seat: number }) => p.seat === 1,
    ).name,
  ).toBe("O'Brien");
  expect(JSON.stringify(detail)).not.toContain(user.id);
  expect(JSON.stringify(detail)).not.toContain("fixture-seat-");
  const statsResponse = await matchRequest("/account/stats?game=four-reversi", {
    headers: { Cookie: user.cookie },
  });
  const stats = getAccountStatsContract.response.parse(await statsResponse.json());
  expect(stats.singles).toEqual({ total: 1, first: 1, second: 0, third: 0, fourth: 0 });
  expect(() => prepareFirebaseMatches([source], [{ ...link, sourceName: "別人" }], target)).toThrow(
    /mapping/,
  );
  expect(() => prepareFirebaseMatches([source], [{ ...link, username: "別人" }], target)).toThrow(
    /mapping/,
  );
  target.matches[0].record_json = "{}";
  expect(() => prepareFirebaseMatches([source], [link], target)).toThrow(/Conflicting target/);
});

test("計画後の既存行の変更を上書きせず停止する", async () => {
  const prepared = plan();
  await env.APP_DB.batch(statements(prepared.sql));
  await env.APP_DB.prepare("UPDATE matches SET record_json='{}' WHERE id=?")
    .bind(fixture.source.match.id)
    .run();
  await expect(env.APP_DB.batch(statements(prepared.sql))).rejects.toThrow(/NOT NULL/);
  expect(
    await env.APP_DB.prepare("SELECT record_json FROM matches WHERE id=?")
      .bind(fixture.source.match.id)
      .first(),
  ).toEqual({ record_json: "{}" });
});

test("計画後に紐付け先が変わったら、対局と本人索引を保存しない", async () => {
  const user = await accountFixture();
  users.push(user.id);
  const target = empty();
  target.users.push({
    id: user.id,
    username: user.username,
    profileCompleted: 1,
    isAnonymous: null,
  });
  const prepared = prepareFirebaseMatches(
    [fixture.source],
    [
      {
        sourceUid: "fixture-seat-1",
        sourceName: "旧参加者1",
        accountId: user.id,
        username: user.username,
      },
    ],
    target,
  );
  await env.APP_DB.prepare("UPDATE user SET profileCompleted=0 WHERE id=?").bind(user.id).run();
  await expect(env.APP_DB.batch(statements(prepared.sql))).rejects.toThrow(/NOT NULL/);
  expect(
    await env.APP_DB.prepare("SELECT id FROM matches WHERE id=?")
      .bind(fixture.source.match.id)
      .first(),
  ).toBeNull();
});
