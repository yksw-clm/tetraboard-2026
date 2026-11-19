import { prepareStoredMatchFixture } from "./snapshotMatchFixtures";
import { readMatchDetailRecord } from "../src/adapters/record/snapshotMatchStore";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, test } from "vitest";
import fourGomoku from "../../../test-fixtures/matches/four-gomoku-singles-ranked.json";
import gomoku from "../../../test-fixtures/matches/gomoku-on-five.json";
import reversi from "../../../test-fixtures/matches/reversi-standard-draw.json";
import { accountIdentity } from "../src/adapters/account/auth";
import { fourGomokuMatchData } from "../src/adapters/record/fourGomokuMatchData";
import { guestReplayTransferStatements } from "../src/adapters/record/guestMergeWrites";
import { gomokuMatchData } from "../src/adapters/record/gomokuMatchData";
import { publicMatchDetail } from "../src/adapters/record/matchDataContracts";
import {
  shogiHistoryStatement,
  snapshotHistoryStatement,
} from "../src/adapters/record/publication";
import { reversiMatchData } from "../src/adapters/record/reversiMatchData";
import type { RoomRuntime } from "../src/durableObjects/gameRoom/runtime";
import { writeMatch } from "../src/flows/matchSave/snapshot";
import { type ShogiSaveProgress } from "../src/adapters/record/shogiMatchStore";
import { advanceShogiMatchSave } from "../src/flows/matchSave/shogi";
import { accountFixture, origin } from "./accountFixtures";
import { humanFixtureRecord } from "./matchFixtures";
import { humanShogiRecord } from "./shogiMatchFixtures";
import { standardShogiRecord } from "./standardShogiFixtures";
import { tombstone, request } from "./privacyFixtures";

async function saved(id: string) {
  return (await env.APP_DB.prepare("SELECT record_json FROM matches WHERE id=?")
    .bind(id)
    .first<{ record_json: string }>())!.record_json;
}

test("全6ゲームの退会は本人だけを除去し、ゲスト名・盤面・相手履歴を保ち、古い再送も拒否する", async () => {
  const user = await accountFixture(),
    opponent = await accountFixture();
  const guestId = crypto.randomUUID();
  await env.APP_DB.prepare("INSERT INTO guest_account_merges VALUES (?,?,?)")
    .bind(guestId, user.id, Date.now())
    .run();
  const records = [
    humanFixtureRecord(user.id, 881),
    humanShogiRecord(user.id).record,
    reversiMatchData.read(
      JSON.stringify({
        ...reversi.detail,
        instanceId: crypto.randomUUID(),
        participants: reversi.detail.participants.map((p) => ({
          id: p.id,
          name: p.name,
          color: p.color,
          seat: p.seat,
          kind: "human",
          accountId: p.color === "black" ? user.id : null,
        })),
      }),
    ),
    standardShogiRecord(user.id, "win").record,
    gomokuMatchData.read(
      JSON.stringify({
        ...gomoku.detail,
        instanceId: crypto.randomUUID(),
        participants: gomoku.detail.participants.map((p) => ({
          id: p.id,
          name: p.name,
          color: p.color,
          seat: p.seat,
          kind: "human",
          accountId: p.color === "black" ? user.id : null,
        })),
      }),
    ),
    fourGomokuMatchData.read(fourGomoku.recordJson.replaceAll("fixture-self", user.id)),
  ];
  for (const record of records) {
    record.id = crypto.randomUUID();
    if ("id" in record.replay) record.replay.id = record.id;
    const self = record.participants.find((p) => p.kind === "human" && p.accountId === user.id)!;
    expect(self).toBeDefined();
    self.name = "削除する旧名";
    const other = record.participants.find((p) => p.kind === "human" && p !== self)!;
    if (other.kind !== "human") throw new Error("Human fixture missing");
    other.accountId = opponent.id;
    await env.APP_DB.prepare("INSERT INTO matches VALUES (?,?,?,?,?,?)")
      .bind(
        record.id,
        record.settings.game,
        "mode" in record.settings ? record.settings.mode : "singles",
        record.startedAtMs,
        record.endedAtMs,
        await prepareStoredMatchFixture(env.APP_DB, JSON.stringify(record)),
      )
      .run();
    await env.APP_DB.prepare(
      "INSERT INTO account_match_history(account_id,match_id,game,mode,started_at_ms) VALUES (?,?,?,?,?)",
    )
      .bind(opponent.id, record.id, record.settings.game, "singles", record.startedAtMs)
      .run();
  }
  expect(await tombstone(user.id)).toBe(true);
  expect(
    await accountIdentity(new Request(origin, { headers: { Cookie: user.cookie } }), env),
  ).toBeNull();
  for (const record of records) {
    const raw = await saved(record.id);
    expect(raw).not.toContain(user.id);
    expect(raw).not.toContain("削除する旧名");
    const parsed = JSON.parse(raw);
    expect(parsed.game).toEqual(record.game);
    const decoded = await readMatchDetailRecord(env.APP_DB, raw, record.settings.game);
    expect(decoded.record.replay).toEqual(record.replay);
    expect(parsed.settings).toEqual(record.settings);
    const self = parsed.participants.find((p: { retired?: boolean }) => p.retired);
    expect(self).toMatchObject({ name: "退会したプレイヤー", accountId: null, retired: true });
    expect(parsed.participants.filter((p: { retired?: boolean }) => !p.retired)).toEqual(
      record.participants.filter((p) => !(p.kind === "human" && p.accountId === user.id)),
    );
    const detail = publicMatchDetail(decoded, new Map());
    expect(detail.participants.find((p) => p.id === self.id)).toMatchObject({
      name: "退会したプレイヤー",
      retired: true,
    });
    // 統合前の参照が残る旧データから、遅延した履歴保存と棋譜の付け替えを再現します。
    const stale = {
      ...parsed,
      participants: record.participants.map((p) =>
        p.kind === "human" && p.accountId === user.id ? { ...p, accountId: guestId } : p,
      ),
    };
    await env.APP_DB.prepare("UPDATE matches SET record_json=? WHERE id=?")
      .bind(JSON.stringify(stale), record.id)
      .run();
    const game = record.settings.game;
    const history =
      game === "shogi" || game === "four-shogi" ? shogiHistoryStatement : snapshotHistoryStatement;
    await env.APP_DB.batch([
      history(env.APP_DB, record.id),
      ...guestReplayTransferStatements(env.APP_DB, guestId, user.id),
    ]);
    expect(JSON.parse(await saved(record.id))).toEqual(parsed);
  }
  expect(
    await env.APP_DB.prepare(
      "SELECT COUNT(*) count FROM account_match_history WHERE account_id IN (?,?)",
    )
      .bind(user.id, guestId)
      .first(),
  ).toEqual({ count: 0 });
  expect(
    await env.APP_DB.prepare("SELECT COUNT(*) count FROM account_match_history WHERE account_id=?")
      .bind(opponent.id)
      .first(),
  ).toEqual({ count: 6 });
  // 書込み関数に渡される古いDOメタデータもマスキングする。
  const late = humanFixtureRecord(user.id, 882);
  await writeMatch(env.APP_DB, late);
  expect(await saved(late.id)).not.toContain(user.id);
});

for (const standard of [false, true])
  test(`${standard ? "通常" : "四人"}将棋: 転送途中に退会しても照合・再送・相手索引を維持する`, async () => {
    const user = await accountFixture(),
      opponent = await accountFixture();
    const fixture = standard
      ? standardShogiRecord(user.id, "win", false, 110)
      : humanShogiRecord(user.id);
    const other = fixture.record.participants.find(
      (p) => p.kind === "human" && p.accountId !== user.id,
    )!;
    if (other.kind !== "human") throw new Error("Human fixture missing");
    other.accountId = opponent.id;
    const source = (cursor: number) => fixture.events.slice(cursor, cursor + 100);
    const next = await advanceShogiMatchSave(
      env.APP_DB,
      fixture.record,
      { phase: "upload", cursor: 0 },
      source,
    );
    expect(next).not.toBeNull();
    expect(await tombstone(user.id)).toBe(true);
    let progress: ShogiSaveProgress | null = next;
    for (let i = 0; progress && i < 10; i++)
      progress = await advanceShogiMatchSave(env.APP_DB, fixture.record, progress, source);
    expect(progress).toBeNull();
    const raw = await saved(fixture.record.id);
    expect(raw).not.toContain(user.id);
    expect(JSON.parse(raw).game).toEqual(fixture.record.game);
    expect(
      await env.APP_DB.prepare("SELECT account_id FROM account_match_history WHERE match_id=?")
        .bind(fixture.record.id)
        .all(),
    ).toMatchObject({ results: [{ account_id: opponent.id }] });
    expect(
      await advanceShogiMatchSave(
        env.APP_DB,
        fixture.record,
        { phase: "upload", cursor: 0 },
        source,
      ),
    ).toBeNull();
  });

test("複数退会者と元から存在しない参照を区別し、相手の公開棋譜・戦績を維持する", async () => {
  const first = await accountFixture(),
    second = await accountFixture(),
    opponent = await accountFixture();
  const record = humanFixtureRecord(first.id, 901);
  const people = record.participants.filter((p) => p.kind === "human");
  people[1].accountId = second.id;
  people[2].accountId = opponent.id;
  people[3].accountId = "preexisting-missing-account";
  people[3].name = "昔の保存名";
  await writeMatch(env.APP_DB, record);
  expect(await tombstone(first.id)).toBe(true);
  expect(await tombstone(second.id)).toBe(true);
  const response = await request(`/matches/${record.id}`);
  expect(response.status).toBe(200);
  const detail = (
    (await response.json()) as { match: { participants: { name: string; retired?: boolean }[] } }
  ).match;
  expect(detail.participants.filter((p) => p.retired)).toHaveLength(2);
  expect(detail.participants.some((p) => p.name === "昔の保存名" && !p.retired)).toBe(true);
  const history = await request("/account/matches?game=four-reversi&mode=singles", {
    headers: { Cookie: opponent.cookie },
  });
  expect(history.status).toBe(200);
  expect(JSON.stringify(await history.json())).toContain(record.id);
  const stats = await request("/account/stats?game=four-reversi", {
    headers: { Cookie: opponent.cookie },
  });
  expect(stats.status).toBe(200);
  expect(JSON.stringify(await stats.json())).toContain('"total":1');
});

test("退会と同時に失敗したDO棋譜保存は、現在のマスク済み保存待ちを保って再試行する", async () => {
  const user = await accountFixture(),
    record = humanFixtureRecord(user.id, 911);
  record.participants[0].name = "削除する保存名";
  expect(await tombstone(user.id)).toBe(true);
  const stub = env.GAME_ROOM.getByName("privacy-inflight-save");
  await runInDurableObject(stub, async (instance, state) => {
    const owned = instance as unknown as { env: Env; runtime: RoomRuntime };
    const original = owned.env;
    let start!: () => void, release!: () => void;
    const started = new Promise<void>((resolve) => (start = resolve)),
      gate = new Promise<void>((resolve) => (release = resolve));
    owned.env = {
      ...original,
      APP_DB: {
        prepare: (sql: string) => original.APP_DB.prepare(sql),
        batch: async () => {
          start();
          await gate;
          throw new Error("Unavailable");
        },
      } as unknown as D1Database,
    };
    const key = `match-pending:${record.id}`;
    state.storage.kv.put(key, { record, retryAtMs: Date.now() });
    try {
      const flushing = owned.runtime.jobs.matchJob.flush();
      await started;
      await instance.purgeAccount(user.id);
      release();
      await flushing;
      const stored = JSON.stringify(state.storage.kv.get(key));
      expect(stored).not.toContain(user.id);
      expect(stored).not.toContain("削除する保存名");
      expect(stored).toContain("退会したプレイヤー");
    } finally {
      release();
      owned.env = original;
    }
  });
});
