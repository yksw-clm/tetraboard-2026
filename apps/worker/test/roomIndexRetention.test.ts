import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, expect, test, vi } from "vitest";
import {
  indexRevisionKey,
  pendingIndexKey,
  type RoomIndexRetentionStatus,
} from "../src/adapters/room/indexJob";
import { D1DeletionJobs } from "../src/adapters/privacy/deletionJobs";
import type { RoomRuntime } from "../src/durableObjects/gameRoom/runtime";
import { accountKey, cpuCapacityKey } from "../src/durableObjects/gameRoom/storageKeys";
import { accountCleanupKey } from "../src/flows/accountSeats/types";
import { requestDeletion } from "../src/flows/accountPurge/requestDeletion";
import * as monthlyKpi from "../src/kpi/monthly";
import { guestClaimsKey } from "../src/flows/guestRegistration/claims";
import { writeMatch } from "../src/flows/matchSave/snapshot";
import { pendingMatchPrefix } from "../src/rooms/matchStore";
import { writeRoomIndex, type PendingRoomIndex } from "../src/rooms/roomIndex";
import {
  roomIndexRetentionCandidatesSql,
  runRoomIndexRetention,
} from "../src/rooms/roomIndexRetention";
import {
  pendingShogiMatchPrefix,
  pendingStandardShogiMatchPrefix,
} from "../src/rooms/shogiMatchStore";
import { waitingRoomFactories } from "../src/rooms/waitingRoomFactories";
import { runScheduledMaintenance } from "../src/scheduledMaintenance";
import { pendingTournamentStatePrefix } from "@tetraboard/context-tournament";
import { accountFixture } from "./accountFixtures";
import { fixTestTime } from "./fixedTimeFixture";
import { humanFixtureRecord, storedMatch } from "./matchFixtures";
import { unusedRoomId } from "./unusedRoomId";

const db = env.APP_DB;
const day = 86_400_000;
const retention = 30 * day;
const hour = day / 24;
const scanTime = Date.parse("2026-11-19T00:00:00Z");
const hostTokenHash = "a".repeat(64);

function readIndex(roomId: string) {
  return db
    .prepare(`SELECT closed, instance_id, revision, closed_at_ms, closed_observed_at_ms
    FROM room_index WHERE room_id=?`)
    .bind(roomId)
    .first();
}

function readLedger(roomId: string) {
  return db
    .prepare("SELECT deleted_through_revision FROM room_index_deleted_revisions WHERE room_id=?")
    .bind(roomId)
    .first<number>("deleted_through_revision");
}

function scan(at = scanTime, rooms = env.GAME_ROOM) {
  return runRoomIndexRetention(
    { APP_DB: db, GAME_ROOM: rooms },
    { deleteExpired: true, inspectCandidates: false },
    () => at,
  );
}

async function runMaintenance(bindings = env) {
  const kpi = vi.spyOn(monthlyKpi, "savePreviousMonthKpi").mockResolvedValue();
  try {
    await runScheduledMaintenance(bindings);
  } finally {
    kpi.mockRestore();
  }
}

async function seedClosed(closedAtMs: number | null, instanceId?: string) {
  const id = await unusedRoomId();
  const stub = env.GAME_ROOM.getByName(id);
  const job: PendingRoomIndex = {
    metadata: {
      id,
      instanceId,
      game: "reversi",
      status: "waiting",
      timeControl: { mainTimeMs: 300_000, byoyomiMs: 0 },
      hostName: "旧ホスト",
      hostAvatarUrl: null,
      humanCount: 1,
      cpuCount: 0,
      capacity: 2,
      openSeats: 1,
      updatedAtMs: scanTime - 100 * day,
    },
    revision: 5,
    closed: true,
    retryAtMs: 0,
  };
  await runInDurableObject(stub, (_, ctx) => ctx.storage.kv.put(indexRevisionKey, job.revision));
  await writeRoomIndex(db, job);
  await db
    .prepare("UPDATE room_index SET closed_at_ms=? WHERE room_id=?")
    .bind(closedAtMs, id)
    .run();
  return { id, job, stub };
}

async function createRoom(id: string) {
  const room = waitingRoomFactories.reversi({
    code: id,
    name: "ホスト",
    request: { game: "reversi", quickPlay: false },
  });
  const stub = env.GAME_ROOM.getByName(id);
  expect(await stub.createRoom(room, hostTokenHash)).not.toBeNull();
  await finishIndex(stub);
  return room;
}

function finishIndex(stub: ReturnType<typeof env.GAME_ROOM.getByName>) {
  return runInDurableObject(stub, async (instance) => {
    const runtime = Reflect.get(instance, "runtime") as RoomRuntime;
    await runtime.jobs.roomIndexJob.running;
  });
}

afterEach(async () => {
  await db.batch([
    db.prepare("DROP TRIGGER IF EXISTS retention_test_failure"),
    db.prepare("DELETE FROM room_index_retention_cursor"),
    db.prepare("DELETE FROM room_index_deleted_revisions"),
  ]);
});

test("閉鎖の送信が失敗しても Alarm は同じ閉鎖時刻を送り、番号再利用で時刻を消す", async () => {
  const openedAt = Date.now() + hour;
  const clock = fixTestTime(openedAt);
  const id = await unusedRoomId();
  const first = await createRoom(id);
  const stub = env.GAME_ROOM.getByName(id);
  await db
    .prepare(`CREATE TRIGGER retention_test_failure BEFORE INSERT ON room_index
    WHEN NEW.closed=1 BEGIN SELECT RAISE(ABORT, 'index write failed'); END`)
    .run();

  const closedAt = openedAt + 1000;
  clock.mockReturnValue(closedAt);
  expect(await stub.leaveRoom(hostTokenHash)).toBe("left");
  await finishIndex(stub);
  expect(await readIndex(id)).toMatchObject({ closed: 0 });
  expect(
    await runInDurableObject(stub, (_, ctx) => ctx.storage.kv.get(pendingIndexKey)),
  ).toMatchObject({ closed: true, closedAtMs: closedAt });
  await db.prepare("DROP TRIGGER retention_test_failure").run();

  clock.mockReturnValue(closedAt + hour);
  expect(await runDurableObjectAlarm(stub)).toBe(true);
  await finishIndex(stub);
  expect(await readIndex(id)).toMatchObject({ closed: 1, closed_at_ms: closedAt });

  const reused = await createRoom(id);
  expect(reused.instanceId).not.toBe(first.instanceId);
  expect(await readIndex(id)).toMatchObject({
    closed: 0,
    instance_id: reused.instanceId,
    closed_at_ms: null,
    closed_observed_at_ms: null,
  });
});

test("30 日ちょうどの閉鎖行だけを消し、遅れた同版・旧版の索引を拒否する", async () => {
  const due = await seedClosed(scanTime - retention, crypto.randomUUID());
  const recent = await seedClosed(scanTime - retention + 1, crypto.randomUUID());

  expect(await scan()).toMatchObject({ expired: 1, checked: 1, deleted: 1 });
  expect(await readIndex(recent.id)).toMatchObject({ closed: 1 });
  expect(await readIndex(due.id)).toBeNull();
  expect(await readLedger(due.id)).toBe(due.job.revision);
  for (const revision of [due.job.revision, due.job.revision - 1])
    await writeRoomIndex(db, { ...due.job, closed: false, revision });
  expect(await readIndex(due.id)).toBeNull();

  const reused = await createRoom(due.id);
  expect(await readIndex(due.id)).toMatchObject({
    closed: 0,
    instance_id: reused.instanceId,
    revision: due.job.revision + 1,
  });
});

test("行がないときも台帳以下の版は発行せず、台帳より新しい版を発行する", async () => {
  const { id, job } = await seedClosed(scanTime - retention);
  await db.batch([
    db.prepare("INSERT INTO room_index_deleted_revisions VALUES (?, ?)").bind(id, job.revision),
    db.prepare("DELETE FROM room_index WHERE room_id=?").bind(id),
  ]);

  await writeRoomIndex(db, { ...job, closed: false });
  expect(await readIndex(id)).toBeNull();
  await writeRoomIndex(db, { ...job, closed: false, revision: job.revision + 1 });
  expect(await readIndex(id)).toMatchObject({ closed: 0, revision: job.revision + 1 });
});

test("世代と閉鎖時刻が NULL の旧行を初回観測から 30 日残す", async () => {
  const { id, job } = await seedClosed(null);
  const legacyReused = await seedClosed(null);

  expect(await scan()).toMatchObject({ unknownClosure: 2, observed: 2, deleted: 0 });
  expect(await readIndex(id)).toMatchObject({
    instance_id: null,
    closed_at_ms: null,
    closed_observed_at_ms: scanTime,
  });
  expect(await readIndex(legacyReused.id)).toMatchObject({ closed_observed_at_ms: scanTime });
  const reused = await createRoom(legacyReused.id);
  expect(await readIndex(legacyReused.id)).toMatchObject({
    instance_id: reused.instanceId,
    closed_observed_at_ms: null,
  });
  expect(await scan(scanTime + retention - 1)).toMatchObject({ checked: 0, deleted: 0 });
  expect(await readIndex(id)).toMatchObject({ closed_observed_at_ms: scanTime });
  expect(await scan(scanTime + retention)).toMatchObject({ deleted: 1 });
  expect(await readLedger(id)).toBe(job.revision);
  expect(await readIndex(id)).toBeNull();
});

test.each([
  ["索引", pendingIndexKey, { retryAtMs: Number.MAX_SAFE_INTEGER }],
  ["棋譜", pendingMatchPrefix + "fixture", { retryAtMs: Number.MAX_SAFE_INTEGER }],
  [
    "四人将棋の分割保存",
    pendingShogiMatchPrefix + "fixture",
    { retryAtMs: Number.MAX_SAFE_INTEGER },
  ],
  [
    "将棋の分割保存",
    pendingStandardShogiMatchPrefix + "fixture",
    { retryAtMs: Number.MAX_SAFE_INTEGER },
  ],
  ["席解放", accountCleanupKey, [{ retryAtMs: Number.MAX_SAFE_INTEGER }]],
  ["大会反映", pendingTournamentStatePrefix + "fixture", { retryAtMs: Number.MAX_SAFE_INTEGER }],
  ["CPU 枠", cpuCapacityKey, { releaseAtMs: null }],
  ["ゲストの棋譜引き継ぎ", guestClaimsKey, { retryAtMs: null }],
] as const)("%s の保存待ちがある閉鎖行は残し、RPC で再送を起こさない", async (_, key, pending) => {
  const { id, stub } = await seedClosed(scanTime - retention);
  await runInDurableObject(stub, (_, ctx) => ctx.storage.kv.put(key, pending));

  expect(await scan()).toMatchObject({ checked: 1, deleted: 0 });
  expect(await readIndex(id)).toMatchObject({ closed: 1 });
  expect(await runInDurableObject(stub, (_, ctx) => ctx.storage.kv.get(key))).toEqual(pending);
  await runInDurableObject(stub, (_, ctx) => ctx.storage.kv.delete(key));
  expect(await scan(scanTime + hour)).toMatchObject({ deleted: 1 });
});

test("ルーム本体がある、DO の版が一致しない、RPC が失敗する場合は保留する", async () => {
  const open = await seedClosed(scanTime - retention);
  const mismatch = await seedClosed(null);
  const unreachable = await seedClosed(scanTime - retention);
  await createRoom(open.id);
  // 新世代の D1 への発行が遅れている状態にします。
  await db
    .prepare("UPDATE room_index SET closed=1, closed_at_ms=?, revision=? WHERE room_id=?")
    .bind(scanTime - retention, open.job.revision, open.id)
    .run();
  await runInDurableObject(mismatch.stub, (_, ctx) => ctx.storage.kv.put(indexRevisionKey, 6));

  const rooms = withRoomCheck(async (id, revision) => {
    if (id === unreachable.id) throw new Error("unavailable");
    return env.GAME_ROOM.getByName(id).checkRoomIndexRetention(revision);
  });
  expect(await scan(scanTime, rooms)).toMatchObject({
    checked: 3,
    deleted: 0,
    observed: 0,
    failures: 1,
    rpcResults: { "room-present": 1, "revision-mismatch": 1 },
  });
  expect(await readIndex(mismatch.id)).toMatchObject({ closed_observed_at_ms: null });
});

test("他の入口が応答待ちの間は閉鎖確認を保留し、Alarm を変更しない", async () => {
  const { job, stub } = await seedClosed(scanTime - retention);
  await runInDurableObject(stub, async (instance, ctx) => {
    const runtime = Reflect.get(instance, "runtime") as RoomRuntime;
    const parked = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const alarm = Date.now() + hour;
    await ctx.storage.setAlarm(alarm);
    const sync = vi.spyOn(runtime.alarms, "sync").mockImplementationOnce(async () => {
      parked.resolve();
      await release.promise;
    });
    const work = instance.getRoom();
    try {
      await parked.promise;
      expect(await instance.checkRoomIndexRetention(job.revision)).toBe("working");
      expect(await ctx.storage.getAlarm()).toBe(alarm);
      expect(sync).toHaveBeenCalledTimes(1);
    } finally {
      release.resolve();
      await work;
      sync.mockRestore();
    }
    expect(await instance.checkRoomIndexRetention(job.revision)).toBe("ready");
  });
});

test("保存待ちを消した後も flush が終わるまで閉鎖確認を保留する", async () => {
  const { job, stub } = await seedClosed(scanTime - retention);
  await runInDurableObject(stub, async (instance, ctx) => {
    const runtime = Reflect.get(instance, "runtime") as RoomRuntime;
    const parked = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const afterFlush = vi.spyOn(runtime.alarms, "afterFlush").mockImplementationOnce(async () => {
      parked.resolve();
      await release.promise;
    });
    ctx.storage.kv.put(pendingIndexKey, job);
    const work = runtime.jobs.roomIndexJob.flush();
    try {
      await parked.promise;
      expect(ctx.storage.kv.get(pendingIndexKey)).toBeUndefined();
      expect(await instance.checkRoomIndexRetention(job.revision)).toBe("roomIndexJob");
    } finally {
      release.resolve();
      await work;
      afterFlush.mockRestore();
    }
    expect(await instance.checkRoomIndexRetention(job.revision)).toBe("ready");
  });
});

function withRoomCheck(check: (id: string, revision: number) => Promise<RoomIndexRetentionStatus>) {
  return new Proxy(env.GAME_ROOM, {
    get(target, key) {
      if (key === "getByName")
        return (id: string) => ({
          checkRoomIndexRetention: (revision: number) => check(id, revision),
        });
      return Reflect.get(target, key);
    },
  });
}

test("DO の確認後に番号が再利用されても新しい行を削除せず、台帳を作らない", async () => {
  const { id, stub } = await seedClosed(scanTime - retention);
  const rooms = withRoomCheck(async (_, revision) => {
    const result = await stub.checkRoomIndexRetention(revision);
    await createRoom(id);
    return result;
  });

  expect(await scan(scanTime, rooms)).toMatchObject({ checked: 1, changed: 1, deleted: 0 });
  expect(await readIndex(id)).toMatchObject({ closed: 0, revision: 6 });
  expect(await readLedger(id)).toBeNull();
});

test("台帳を追加した後の削除失敗は batch 全体を戻し、次の巡回で再試行する", async () => {
  const { id, job } = await seedClosed(scanTime - retention);
  await db
    .prepare(`CREATE TRIGGER retention_test_failure BEFORE DELETE ON room_index
    WHEN EXISTS (SELECT 1 FROM room_index_deleted_revisions WHERE room_id=OLD.room_id)
    BEGIN SELECT RAISE(ABORT, 'index deletion failed'); END`)
    .run();

  expect(await scan()).toMatchObject({ checked: 1, failures: 1, deleted: 0 });
  expect(await readIndex(id)).toMatchObject({ revision: job.revision, closed: 1 });
  expect(await readLedger(id)).toBeNull();

  await db.prepare("DROP TRIGGER retention_test_failure").run();
  expect(await scan(scanTime + hour)).toMatchObject({ deleted: 1, failures: 0 });
  expect(await readLedger(id)).toBe(job.revision);
  expect(await readIndex(id)).toBeNull();
});

test("一度に 25 件まで確認し、保留を飛ばして残りを次回に確認する", async () => {
  const plan = await db
    .prepare(`EXPLAIN QUERY PLAN ${roomIndexRetentionCandidatesSql}`)
    .bind(-1, scanTime - retention, -1, "", 25)
    .all<{ detail: string }>();
  expect(plan.results.map(({ detail }) => detail)).toEqual([
    expect.stringContaining("SEARCH room_index USING INDEX room_index_closed_retention"),
  ]);
  const rows: Awaited<ReturnType<typeof seedClosed>>[] = [];
  for (let index = 0; index < 26; index++)
    rows.push(await seedClosed(scanTime - retention + index - 26));
  const rooms = withRoomCheck(async (id, revision) =>
    id === rows[0].id ? "working" : env.GAME_ROOM.getByName(id).checkRoomIndexRetention(revision),
  );

  expect(await scan(scanTime, rooms)).toMatchObject({ checked: 25, deleted: 24 });
  expect(await readIndex(rows[25].id)).toMatchObject({ closed: 1 });
  expect(await scan(scanTime + hour, rooms)).toMatchObject({ checked: 1, deleted: 1 });
  expect(await scan(scanTime + 2 * hour)).toMatchObject({ checked: 1, deleted: 1 });
});

test.each(["before", "after"])("索引削除の前後に受けた退会が対象を拾う（%s）", async (order) => {
  const { id, stub } = await seedClosed(scanTime - retention);
  const user = await accountFixture();
  const request = async () => {
    expect(await requestDeletion(env, user.id, crypto.randomUUID())).toBe(true);
  };
  const rooms = withRoomCheck(async (_, revision) => {
    const result = await stub.checkRoomIndexRetention(revision);
    if (order === "before") await request();
    return result;
  });

  expect(await scan(scanTime, rooms)).toMatchObject({ deleted: 1 });
  if (order === "after") await request();
  expect(await new D1DeletionJobs(db).readRooms(user.id, 100)).toContain(id);
});

test("索引削除後の退会定期処理で 0014 前の DO の旧名を消し、棋譜と結果を残す", async () => {
  const { id, stub } = await seedClosed(scanTime - retention);
  const user = await accountFixture();
  const record = { ...humanFixtureRecord(user.id, 1), roomId: id, instanceId: crypto.randomUUID() };
  const [player] = record.participants;
  if (player.kind !== "human") throw new Error("Human fixture expected");
  const key = accountKey(player.id);
  // 移行 0014 より前に退室した席は、D1 の席やプライバシー索引の補完対象になりません。
  await runInDurableObject(stub, (_, ctx) =>
    ctx.storage.kv.put(key, {
      accountId: user.id,
      operationId: crypto.randomUUID(),
      roomId: id,
      instanceId: record.instanceId,
      playerId: player.id,
      name: "DO にだけ残る旧名",
      avatarKey: null,
      occupying: false,
    }),
  );
  player.accountId = null;
  player.name = "対局者";
  await writeMatch(db, record);
  const saved = await storedMatch(record.id);
  expect(saved).not.toBeNull();
  expect(
    await db
      .prepare("SELECT room_id FROM privacy_room_accounts WHERE account_id=?")
      .bind(user.id)
      .first(),
  ).toBeNull();

  expect(await scan()).toMatchObject({ deleted: 1 });
  expect(await requestDeletion(env, user.id, crypto.randomUUID())).toBe(true);
  await runMaintenance();

  expect(await runInDurableObject(stub, (_, ctx) => ctx.storage.kv.get(key))).toBeUndefined();
  expect(await storedMatch(record.id)).toEqual(saved);
});

test("既定の毎時処理は候補を数え、RPC・行の更新・削除を行わない", async () => {
  const { id } = await seedClosed(Date.now() - retention);
  const legacy = await seedClosed(null);
  const log = vi.spyOn(console, "info").mockImplementation(() => {});
  const rpc = vi.fn(async () => "ready" as const);
  try {
    await runMaintenance({ ...env, GAME_ROOM: withRoomCheck(rpc) });

    expect(await readIndex(id)).toMatchObject({ closed: 1 });
    expect(await readIndex(legacy.id)).toMatchObject({ closed_observed_at_ms: null });
    expect(await readLedger(id)).toBeNull();
    expect(rpc).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      "Room index retention",
      expect.objectContaining({
        expired: 1,
        unknownClosure: 1,
        checked: 0,
        deleted: 0,
      }),
    );
  } finally {
    log.mockRestore();
  }
});

test("削除を止めたまま RPC で確認しても旧行の初回観測時刻と台帳は書かない", async () => {
  const { id } = await seedClosed(null);
  expect(
    await runRoomIndexRetention(
      env,
      {
        deleteExpired: false,
        inspectCandidates: true,
      },
      () => scanTime,
    ),
  ).toMatchObject({
    checked: 1,
    observed: 0,
    deleted: 0,
    rpcResults: { ready: 1 },
  });
  expect(await readIndex(id)).toMatchObject({ closed_observed_at_ms: null });
  expect(await readLedger(id)).toBeNull();
});
