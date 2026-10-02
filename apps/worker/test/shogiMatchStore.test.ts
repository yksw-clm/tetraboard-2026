import { env } from "cloudflare:workers";
import { expect, test } from "vitest";
import { createInitialState, eliminateSide, sides } from "@tetraboard/four-shogi";
import {
  finishedFourShogiStateSchema,
  roomTimeControl,
  type FourShogiReplayEvent,
} from "@tetraboard/protocol";
import {
  advanceShogiMatchSave,
  emptyKnockouts,
  readShogiMatchRecord,
  readShogiMatchReplayPage,
  type ShogiMatchRecord,
  type ShogiSaveProgress,
} from "../src/rooms/shogiMatchStore";
import { accountFixture } from "./accountFixtures";

function record(accountId: string | null, eventCount = 3): ShogiMatchRecord {
  const players = Object.fromEntries(sides.map((side) => [side, crypto.randomUUID()])) as Record<
    (typeof sides)[number],
    string
  >;
  const initial = { mode: "singles" as const, players, threePlayerAttackProhibited: true };
  let game = createInitialState(initial);
  for (const side of ["south", "west", "north"] as const) {
    const next = eliminateSide(game, side, "left");
    if (!next.ok) throw new Error(next.reason);
    game = next.state;
  }
  const { repetitions: _index, ...core } = game;
  if (core.status !== "finished") throw new Error("Fixture did not finish");
  return {
    id: crypto.randomUUID(),
    roomId: "12345",
    instanceId: crypto.randomUUID(),
    startedAtMs: 1000,
    endedAtMs: 2000,
    settings: {
      game: "four-shogi",
      mode: "singles",
      timeControl: roomTimeControl,
      threePlayerAttackProhibited: true,
    },
    participants: sides.map((side, seat) => ({
      id: players[side],
      side,
      seat,
      name: side,
      kind: "human",
      accountId: seat === 0 ? accountId : null,
    })),
    game: finishedFourShogiStateSchema.parse(core),
    knockouts: emptyKnockouts(),
    replay: { rulesVersion: 1, initial, eventCount },
  };
}
const departures: FourShogiReplayEvent[] = ["south", "west", "north"].map((side) => ({
  type: "eliminate",
  side: side as (typeof sides)[number],
  reason: "left",
}));
async function publish(record: ShogiMatchRecord, events: FourShogiReplayEvent[]) {
  let progress: ShogiSaveProgress | null = { phase: "upload", cursor: 0 };
  while (progress)
    progress = await advanceShogiMatchSave(env.APP_DB, record, progress, (cursor) =>
      events.slice(cursor, cursor + 100),
    );
}

test("将棋本体と本人索引は全棋譜検証後にだけ公開し、再送で上書きしない", async () => {
  const user = await accountFixture();
  const match = record(user.id);
  const source = (cursor: number) => departures.slice(cursor, cursor + 100);
  const next = await advanceShogiMatchSave(
    env.APP_DB,
    match,
    { phase: "upload", cursor: 0 },
    source,
  );
  expect(next).toEqual({ phase: "verify", cursor: 0 });
  expect(
    await env.APP_DB.prepare("SELECT id FROM matches WHERE id = ?").bind(match.id).first(),
  ).toBeNull();
  expect(await readShogiMatchReplayPage(env.APP_DB, match.id, 0)).toBeNull();
  expect(await advanceShogiMatchSave(env.APP_DB, match, next!, source)).toBeNull();
  const row = await env.APP_DB.prepare("SELECT record_json FROM matches WHERE id = ?")
    .bind(match.id)
    .first<{ record_json: string }>();
  expect(readShogiMatchRecord(row!.record_json)).toEqual(match);
  expect(
    (
      await env.APP_DB.prepare("SELECT game FROM account_match_history WHERE match_id = ?")
        .bind(match.id)
        .all()
    ).results,
  ).toEqual([{ game: "four-shogi" }]);
  const other = await accountFixture();
  const conflict = {
    ...match,
    endedAtMs: 3000,
    participants: match.participants.map((p) =>
      p.kind === "human" && p.accountId ? { ...p, accountId: other.id } : p,
    ),
  };
  await advanceShogiMatchSave(env.APP_DB, conflict, { phase: "upload", cursor: 0 }, source);
  expect(
    (await env.APP_DB.prepare("SELECT record_json FROM matches WHERE id = ?")
      .bind(match.id)
      .first<{ record_json: string }>())!.record_json,
  ).toBe(row!.record_json);
  expect(
    (
      await env.APP_DB.prepare("SELECT account_id FROM account_match_history WHERE match_id = ?")
        .bind(match.id)
        .all()
    ).results,
  ).toEqual([{ account_id: user.id }]);
  expect(
    await env.APP_DB.prepare("SELECT id FROM shogi_match_uploads WHERE id = ?")
      .bind(match.id)
      .first(),
  ).toBeNull();
});

test("長期イベント転送は1回400件までで、100件ページと任意cursorが連続する", async () => {
  // 保存転送の容量境界を検証します。受理する着手の合法性はルームテストで確認します。
  const action: FourShogiReplayEvent = {
    type: "action",
    side: "south",
    action: { type: "movePiece", from: { x: 4, y: 6 }, to: { x: 4, y: 5 }, promote: false },
  };
  const events = [...Array<FourShogiReplayEvent>(503).fill(action), ...departures];
  const match = record(null, events.length);
  const source = (cursor: number) => events.slice(cursor, cursor + 100);
  const first = await advanceShogiMatchSave(
    env.APP_DB,
    match,
    { phase: "upload", cursor: 0 },
    source,
  );
  expect(first).toEqual({ phase: "upload", cursor: 4 });
  expect(
    (await env.APP_DB.prepare(
      "SELECT SUM(event_count) AS n FROM shogi_match_chunks WHERE match_id = ?",
    )
      .bind(match.id)
      .first<{ n: number }>())!.n,
  ).toBe(400);
  await publish(match, events);
  const firstPage = await readShogiMatchReplayPage(env.APP_DB, match.id, 0);
  const overlap = await readShogiMatchReplayPage(env.APP_DB, match.id, 99);
  const last = await readShogiMatchReplayPage(env.APP_DB, match.id, 500);
  expect(firstPage!.events.map((e) => e.index)).toEqual(Array.from({ length: 100 }, (_, i) => i));
  expect(overlap!.events.map((e) => e.index)).toEqual(
    Array.from({ length: 100 }, (_, i) => i + 99),
  );
  expect(last!.events.map((e) => e.event)).toEqual(events.slice(500));
  expect(last!.nextCursor).toBeNull();
  expect((await readShogiMatchReplayPage(env.APP_DB, match.id, events.length))!.events).toEqual([]);
  expect(await readShogiMatchReplayPage(env.APP_DB, match.id, events.length + 1)).toBeNull();
});

test("棋譜欠損・異なる再送は公開せず、修復後は同じ保存待ちから再試行できる", async () => {
  const match = record(null);
  const source = (cursor: number) => departures.slice(cursor, cursor + 100);
  const progress = await advanceShogiMatchSave(
    env.APP_DB,
    match,
    { phase: "upload", cursor: 0 },
    source,
  );
  await env.APP_DB.prepare("UPDATE shogi_match_chunks SET events_json = '[]' WHERE match_id = ?")
    .bind(match.id)
    .run();
  await expect(advanceShogiMatchSave(env.APP_DB, match, progress!, source)).rejects.toThrow();
  expect(
    await env.APP_DB.prepare("SELECT id FROM matches WHERE id = ?").bind(match.id).first(),
  ).toBeNull();
  await expect(
    advanceShogiMatchSave(
      env.APP_DB,
      { ...match, endedAtMs: 3000 },
      { phase: "upload", cursor: 0 },
      source,
    ),
  ).rejects.toThrow("Conflicting");
  await env.APP_DB.prepare("UPDATE shogi_match_chunks SET events_json = ? WHERE match_id = ?")
    .bind(JSON.stringify(departures), match.id)
    .run();
  expect(await advanceShogiMatchSave(env.APP_DB, match, progress!, source)).toBeNull();
});

test("総棋譜がD1の1行2MBを超えても分割して保存・取得できる", async () => {
  // 合法性ではなく、単一JSONに収めない転送・格納の容量境界を検証します。
  const action: FourShogiReplayEvent = {
    type: "action",
    side: "south",
    action: {
      type: "movePiece",
      from: { x: 4, y: 6 },
      to: { x: 4, y: 5 },
      promote: false,
    },
  };
  const events = [...Array<FourShogiReplayEvent>(24000).fill(action), ...departures];
  expect(new TextEncoder().encode(JSON.stringify(events)).byteLength).toBeGreaterThan(2_000_000);
  const match = record(null, events.length);
  await publish(match, events);
  expect(
    await env.APP_DB.prepare(`SELECT SUM(event_count) AS n, MAX(length(events_json)) AS max
    FROM shogi_match_chunks WHERE match_id = ?`)
      .bind(match.id)
      .first(),
  ).toEqual({ n: events.length, max: JSON.stringify(events.slice(0, 100)).length });
  const first = await readShogiMatchReplayPage(env.APP_DB, match.id, 0);
  const last = await readShogiMatchReplayPage(env.APP_DB, match.id, 24000);
  expect(first!.events).toHaveLength(100);
  expect(last!.events.map((entry) => entry.event)).toEqual(departures);
  expect(last!.nextCursor).toBeNull();
}, 15000);

test("本人索引の保存失敗は本体も公開せず、ack喪失後の再送はmanifestを回収する", async () => {
  const user = await accountFixture();
  const match = record(user.id);
  await env.APP_DB.prepare(`CREATE TRIGGER reject_shogi_index BEFORE INSERT ON account_match_history
    WHEN NEW.match_id = '${match.id}' BEGIN SELECT RAISE(ABORT,'index unavailable'); END`).run();
  try {
    await expect(publish(match, departures)).rejects.toThrow();
    expect(
      await env.APP_DB.prepare("SELECT id FROM matches WHERE id = ?").bind(match.id).first(),
    ).toBeNull();
  } finally {
    await env.APP_DB.exec("DROP TRIGGER reject_shogi_index");
  }
  await publish(match, departures);
  await env.APP_DB.prepare("INSERT INTO shogi_match_uploads VALUES (?, ?, 3, 1)")
    .bind(match.id, JSON.stringify(match))
    .run();
  await publish(match, departures);
  expect(
    await env.APP_DB.prepare("SELECT id FROM shogi_match_uploads WHERE id = ?")
      .bind(match.id)
      .first(),
  ).toBeNull();
  expect(
    (await env.APP_DB.prepare("SELECT COUNT(*) AS n FROM account_match_history WHERE match_id = ?")
      .bind(match.id)
      .first<{ n: number }>())!.n,
  ).toBe(1);
});
