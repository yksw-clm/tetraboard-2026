import { env } from "cloudflare:workers";
import { runInDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { expect, test, vi } from "vitest";
import * as tournamentStore from "../src/adapters/tournament/store";
import * as tournamentRoomPreparation from "../src/flows/tournamentRoom/prepare";
import type { State } from "@tetraboard/context-tournament";
import {
  useTournamentQueueFixtures,
  clock,
  expectOk,
  fixture,
  suspendDuringPreparation,
} from "./tournamentQueueFixtures";

useTournamentQueueFixtures();

test("本人状態の確認は他人の期限回収やAlarmの更新を行わない", async () => {
  const f = await fixture(2);
  await f.enqueueAll();
  const alarm = await runInDurableObject(f.stub, async (_instance, state) => {
    const stored = state.storage.kv.get<{
      waiting: { operationId: string; expiresAtMs: number }[];
    }>("state")!;
    stored.waiting.find((wait) => wait.operationId === f.operations[1]!.operationId)!.expiresAtMs =
      Date.now() - 1;
    state.storage.kv.put("state", stored);
    return state.storage.getAlarm();
  });
  const results = await Promise.all(Array.from({ length: 5 }, () => f.status(0)));
  for (const result of results) expect(result.status).toBe("waiting");
  expect((await f.status(1)).status).toBe("idle");
  await runInDurableObject(f.stub, async (_instance, state) => {
    expect(state.storage.kv.get<{ waiting: unknown[] }>("state")!.waiting).toHaveLength(2);
    expect(await state.storage.getAlarm()).toBe(alarm);
  });
  await runDurableObjectAlarm(f.stub);
  expect((await f.status(0)).status).toBe("waiting");
  expect((await f.status(1)).status).toBe("idle");
});

test("ルーム準備が失敗していても本人状態の確認と待機継続は再試行に巻き込まれない", async () => {
  const f = await fixture();
  for (let i = 0; i < 3; i++) await f.enqueue(i);
  await env.APP_DB.exec(
    "CREATE TRIGGER fail_tournament_transfer BEFORE INSERT ON account_room_seats BEGIN SELECT RAISE(ABORT,'test transfer fault'); END",
  );
  expect((await f.queue(3)).status).toBe(503);
  for (let i = 0; i < 4; i++) expect((await f.status(i)).status).toBe("waiting");
  await env.APP_DB.exec("DROP TRIGGER fail_tournament_transfer");
  await f.stub.refresh(f.key);
  for (let i = 0; i < 4; i++) expect((await f.status(i)).status).toBe("matched");
});

test("最後の待機継続から29秒で準備に失敗しても、30秒ちょうどで失効し再抽選から外れる", async () => {
  const f = await fixture();
  const now = Date.now();
  await f.enqueue(0);
  clock.mockReturnValue(now + 1000);
  const { operationId } = f.operations[0]!;
  await expectOk(await f.invoke(0, "queue", "PATCH", { operationId }), "準備前の待機継続");
  clock.mockReturnValue(now + 30_000);
  await f.enqueue(1);
  await f.enqueue(2);
  const prepare = vi
    .spyOn(tournamentRoomPreparation, "prepareTournamentRoom")
    .mockResolvedValueOnce({ status: "room_in_use" });
  try {
    await f.enqueue(3);
  } finally {
    prepare.mockRestore();
  }
  expect(await f.status(0)).toMatchObject({ status: "waiting", operationId });
  clock.mockReturnValue(now + 31_000);
  expect((await f.status(0)).status).toBe("idle");
  expect(await f.alarmTime()).toBe(Date.now());
  expect(await runDurableObjectAlarm(f.stub)).toBe(true);
  expect(
    await env.APP_DB.prepare("SELECT 1 FROM tournament_wait_reservations WHERE operation_id=?")
      .bind(operationId)
      .first(),
  ).toBeNull();

  clock.mockReturnValue(now + 35_000);
  await f.stub.refresh(f.key);
  expect((await f.status(0)).status).toBe("idle");
  for (const i of [1, 2, 3]) expect((await f.status(i)).status).toBe("waiting");
});

for (const phase of ["confirming", "preparing"] as const) {
  test(`保存済みの${phase}で操作元の待機継続を受け付け、準備失敗後に同じ操作を元の期限で復帰させる`, async () => {
    const f = await fixture();
    const now = Date.now();
    for (const i of [0, 1, 2]) await f.enqueue(i);
    clock.mockReturnValue(now + 29_000);
    await suspendDuringPreparation(f);
    const preparationDeadline = await runInDurableObject(f.stub, (_instance, state) => {
      const stored = state.storage.kv.get<State>("state")!;
      const group = stored.groups[0]!;
      group.phase = phase;
      state.storage.kv.put("state", stored);
      return group.expiresAtMs;
    });

    const { operationId } = f.operations[0]!;
    const lease = env.APP_DB.prepare(
      "SELECT lease_until_ms,match_operation_id FROM tournament_wait_reservations WHERE operation_id=?",
    ).bind(operationId);
    const preparationLease = await lease.first();
    expect(preparationLease).toMatchObject({ lease_until_ms: preparationDeadline });
    const alarmAt = await f.alarmTime();
    const heartbeatAt = now + 29_500;
    clock.mockReturnValue(heartbeatAt);
    expect(
      (await f.invoke(0, "queue", "PATCH", { operationId, controllerVersion: 0 })).status,
    ).toBe(409);
    const patch = await f.invoke(0, "queue", "PATCH", { operationId });
    await expectOk(patch, `${phase}の待機継続`);
    expect(await patch.json()).toEqual({ ok: true });
    expect(await f.alarmTime()).toBe(alarmAt);
    expect(await f.status(0)).toMatchObject({
      status: "waiting",
      expiresAtMs: preparationDeadline,
    });
    expect(await lease.first()).toEqual(preparationLease);

    const prepare = vi
      .spyOn(tournamentRoomPreparation, "prepareTournamentRoom")
      .mockResolvedValueOnce({ status: "room_in_use" });
    try {
      clock.mockReturnValue(now + 31_000);
      expect(await runDurableObjectAlarm(f.stub)).toBe(true);
      expect(prepare).toHaveBeenCalledTimes(1);
    } finally {
      prepare.mockRestore();
    }
    const expiresAtMs = heartbeatAt + 30_000;
    expect(await f.status(0)).toMatchObject({ status: "waiting", operationId, expiresAtMs });
    expect((await f.status(1)).status).toBe("idle");
    expect((await f.status(2)).status).toBe("idle");
    clock.mockReturnValue(expiresAtMs - 1);
    expect(await f.status(0)).toMatchObject({ status: "waiting", operationId, expiresAtMs });
    clock.mockReturnValue(expiresAtMs);
    expect(await runDurableObjectAlarm(f.stub)).toBe(true);
    expect((await f.status(0)).status).toBe("idle");
    expect(await lease.first()).toBeNull();
  });
}

test("復帰用の期限がない旧形式の組は、準備期限まで元の操作で待機に戻る", async () => {
  const f = await fixture();
  const now = Date.now();
  for (const i of [0, 1, 2]) await f.enqueue(i);
  await suspendDuringPreparation(f);
  const expiresAtMs = await runInDurableObject(f.stub, (_instance, state) => {
    const stored = state.storage.kv.get<State>("state")!;
    const group = stored.groups[0]!;
    for (const player of group.players) delete player.waitingExpiresAtMs;
    state.storage.kv.put("state", stored);
    return group.expiresAtMs;
  });
  clock.mockReturnValue(now + 20_000);
  expect(
    (await f.invoke(3, "queue", "DELETE", { operationId: f.operations[3]!.operationId })).status,
  ).toBe(200);
  const { operationId } = f.operations[0]!;
  expect(await f.status(0)).toMatchObject({ status: "waiting", operationId, expiresAtMs });
  clock.mockReturnValue(expiresAtMs);
  expect(await runDurableObjectAlarm(f.stub)).toBe(true);
  expect((await f.status(0)).status).toBe("idle");
});

test("待機の見直し中に期限が切れた予約を次のAlarmで回収する", async () => {
  const f = await fixture(2);
  const expiresAtMs = Date.now() + 30_000;
  await f.enqueue(0);
  const joinedAtMs = expiresAtMs - 1;
  clock.mockReturnValue(joinedAtMs);
  const finalize = tournamentStore.finalizeTournament;
  const finalizeWithClock = vi
    .spyOn(tournamentStore, "finalizeTournament")
    .mockImplementation(async (...args) => {
      await finalize(...args);
      // 待機の見直しを終えて次の予約を決めるまでに、参加者1の期限が切れます。
      clock.mockReturnValue(expiresAtMs);
    });
  try {
    await f.enqueue(1);
  } finally {
    finalizeWithClock.mockRestore();
  }

  const expiredLease = env.APP_DB.prepare(
    "SELECT 1 FROM tournament_wait_reservations WHERE operation_id=?",
  ).bind(f.operations[0]!.operationId);
  expect(await expiredLease.first()).not.toBeNull();
  expect((await f.status(0)).status).toBe("idle");
  expect(await f.alarmTime()).toBe(expiresAtMs);

  expect(await runDurableObjectAlarm(f.stub)).toBe(true);
  expect(await expiredLease.first()).toBeNull();
  expect(await f.status(1)).toMatchObject({
    status: "waiting",
    expiresAtMs: joinedAtMs + 30_000,
  });
  expect(await f.alarmTime()).toBe(joinedAtMs + 30_000);
});

test("一人の待機継続で他の参加者の待機期限の回収を遅らせない", async () => {
  const f = await fixture(2);
  await f.enqueueAll();
  const expiresAtMs = Date.now() + 30_000;
  expect(await f.status(0)).toMatchObject({ status: "waiting", expiresAtMs });
  expect(await f.alarmTime()).toBe(expiresAtMs);

  clock.mockReturnValue(expiresAtMs - 1000);
  await expectOk(
    await f.invoke(1, "queue", "PATCH", { operationId: f.operations[1]!.operationId }),
    "参加者2の待機継続 PATCH",
  );
  expect(await f.alarmTime()).toBe(expiresAtMs);
  clock.mockReturnValue(expiresAtMs);
  expect(await runDurableObjectAlarm(f.stub)).toBe(true);
  expect((await f.status(0)).status).toBe("idle");
  expect((await f.status(1)).status).toBe("waiting");
  expect(
    await env.APP_DB.prepare("SELECT 1 FROM tournament_wait_reservations WHERE operation_id=?")
      .bind(f.operations[0]!.operationId)
      .first(),
  ).toBeNull();
});

test("待機継続で大会終了時刻の待機回収と結果確定を遅らせない", async () => {
  const f = await fixture(1);
  const endsAtMs = Date.now() + 4000;
  await env.APP_DB.prepare("UPDATE tournaments SET ends_at_ms=? WHERE key=?")
    .bind(endsAtMs, f.key)
    .run();
  await f.enqueueAll();
  expect(await f.alarmTime()).toBe(endsAtMs);

  clock.mockReturnValue(endsAtMs - 1000);
  await expectOk(
    await f.invoke(0, "queue", "PATCH", { operationId: f.operations[0]!.operationId }),
    "参加者1の待機継続 PATCH",
  );
  expect(await f.alarmTime()).toBe(endsAtMs);
  clock.mockReturnValue(endsAtMs);
  expect(await runDurableObjectAlarm(f.stub)).toBe(true);
  expect((await f.status(0)).status).toBe("idle");
  expect(
    await env.APP_DB.prepare("SELECT finalized_at_ms FROM tournaments WHERE key=?")
      .bind(f.key)
      .first(),
  ).toEqual({ finalized_at_ms: endsAtMs });
});
