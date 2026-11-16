import { expect, mock, spyOn, test } from "bun:test";
import { RoomJob } from "../src/rooms/roomJobs";

function fixture(mode: "drain" | "single" | "snapshot" = "drain", stopOnFailure = true) {
  const pending = new Map<string, { revision: number; retryAtMs: number }>();
  const alarms = { sync: mock(async () => {}), afterFlush: mock(async () => {}) };
  const execute = mock(async (_entry: [string, { revision: number; retryAtMs: number }]) => {});
  const job = new RoomJob(alarms, {
    pending: () => pending,
    retryAt: ([, value]) => value.retryAtMs,
    execute,
    complete: ([key, value]) => {
      if (pending.get(key)?.revision === value.revision) pending.delete(key);
    },
    retry: ([key, value], retryAtMs) => {
      if (pending.get(key)?.revision === value.revision) pending.set(key, { ...value, retryAtMs });
    },
    mode,
    stopOnFailure,
  });
  return { pending, alarms, execute, job };
}

test("同じ種類の実行中Promiseを共有し、外部へのawaitの前と完了後にAlarmを合わせる", async () => {
  const { pending, alarms, execute, job } = fixture();
  pending.set("one", { revision: 1, retryAtMs: 0 });
  const gate = Promise.withResolvers<void>();
  execute.mockImplementation(async () => {
    expect(alarms.sync).toHaveBeenCalledTimes(1);
    expect(alarms.afterFlush).not.toHaveBeenCalled();
    await gate.promise;
  });
  const first = job.flush();
  expect(job.flush()).toBe(first);
  await Promise.resolve();
  expect(execute).toHaveBeenCalledTimes(1);
  gate.resolve();
  await first;
  expect(pending.size).toBe(0);
  expect(job.running).toBeNull();
  expect(alarms.afterFlush).toHaveBeenCalledTimes(1);
});

test("期限前は実行せず、到達したものだけ実行する。Alarm候補には過去も含める", async () => {
  const { pending, execute, job } = fixture();
  const now = Date.now();
  pending.set("future", { revision: 1, retryAtMs: now + 60_000 });
  pending.set("due", { revision: 2, retryAtMs: now });
  pending.set("past", { revision: 3, retryAtMs: -1 });
  expect(job.nextAlarmAt()).toBe(-1);
  await job.flush();
  expect(execute.mock.calls.map(([entry]) => entry[0])).toEqual(["due", "past"]);
  expect(job.nextAlarmAt()).toBe(now + 60_000);
  pending.clear();
  expect(job.nextAlarmAt()).toBeNull();
});

test("失敗時は5秒後へ残し、後続を進めず、完了後のAlarm候補を更新する", async () => {
  const { pending, alarms, execute, job } = fixture();
  pending.set("one", { revision: 1, retryAtMs: 0 });
  pending.set("two", { revision: 2, retryAtMs: 60_000 + Date.now() });
  execute.mockRejectedValueOnce(new Error("D1 unavailable"));
  const before = Date.now();
  await job.flush();
  const after = Date.now();
  expect(pending.get("one")!.retryAtMs).toBeGreaterThanOrEqual(before + 5_000);
  expect(pending.get("one")!.retryAtMs).toBeLessThanOrEqual(after + 5_000);
  expect(job.nextAlarmAt()).toBe(pending.get("one")!.retryAtMs);
  expect(alarms.afterFlush).toHaveBeenCalledTimes(1);
  await job.flush();
  expect(execute).toHaveBeenCalledTimes(1);
  pending.set("one", { revision: 1, retryAtMs: 0 });
  await job.flush();
  expect(pending.has("one")).toBe(false);
});

test.each([false, true])(
  "実行中に版が変わった保存待ちは、古い実行の片付けや再送で消さない（失敗=%s）",
  async (fail) => {
    const { pending, execute, job } = fixture("single");
    pending.set("one", { revision: 1, retryAtMs: 0 });
    execute.mockImplementationOnce(async () => {
      pending.set("one", { revision: 2, retryAtMs: 123 });
      if (fail) throw new Error("old revision failed");
    });
    await job.flush();
    expect(pending.get("one")).toEqual({ revision: 2, retryAtMs: 123 });
    expect(job.nextAlarmAt()).toBe(123);
  },
);

test.each(["drain", "single", "snapshot"] as const)(
  "%s の処理単位を守り、別の種類は並行実行する",
  async (mode) => {
    const { pending, execute, job } = fixture(mode, false);
    pending.set("one", { revision: 1, retryAtMs: 0 });
    pending.set("two", { revision: 2, retryAtMs: 0 });
    const gate = Promise.withResolvers<void>();
    execute.mockImplementationOnce(async () => {
      await gate.promise;
      pending.set("three", { revision: 3, retryAtMs: 0 });
      throw new Error("one failed");
    });
    const running = job.flush();
    const other = fixture();
    other.pending.set("other", { revision: 1, retryAtMs: 0 });
    await other.job.flush();
    expect(other.execute).toHaveBeenCalledTimes(1);
    gate.resolve();
    await running;
    expect(execute.mock.calls.map(([entry]) => entry[0])).toEqual(
      mode === "drain" ? ["one", "two", "three"] : mode === "single" ? ["one"] : ["one", "two"],
    );
  },
);

test("snapshotは一度飛ばした期限前のジョブへ戻らず、元の一覧順を守る", async () => {
  const { pending, execute, job } = fixture("snapshot", false);
  let now = 10;
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  try {
    pending.set("future", { revision: 1, retryAtMs: 20 });
    pending.set("due", { revision: 2, retryAtMs: 10 });
    execute.mockImplementationOnce(async () => {
      now = 30;
    });
    await job.flush();
    expect(execute.mock.calls.map(([entry]) => entry[0])).toEqual(["due"]);
    expect(job.nextAlarmAt()).toBe(20);
    await job.flush();
    expect(execute.mock.calls.map(([entry]) => entry[0])).toEqual(["due", "future"]);
  } finally {
    clock.mockRestore();
  }
});
