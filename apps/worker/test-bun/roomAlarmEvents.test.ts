import { expect, test, mock } from "bun:test";
import { RoomAlarmEvents } from "../src/adapters/room/roomAlarmEvents";

function scheduler() {
  let alarm: number | null = null;
  let next: number | null = 100;
  const storage = {
    getAlarm: mock(async () => alarm),
    setAlarm: mock(async (at: number | Date) => {
      alarm = Number(at);
    }),
    deleteAlarm: mock(async () => {
      alarm = null;
    }),
  };
  const background: Promise<void>[] = [];
  const events = new RoomAlarmEvents(
    {},
    storage,
    () => next,
    (task) => {
      background.push(task);
      void task.catch(() => {});
    },
  );
  return {
    events,
    storage,
    background,
    next: (at: number | null) => {
      next = at;
    },
  };
}

test("イベント外の印は、その場で同期を始めてwaitUntilに渡す", async () => {
  const { events, storage, background } = scheduler();
  events.mark();
  expect(storage.getAlarm).toHaveBeenCalledTimes(1);
  expect(background).toHaveLength(1);
  await Promise.all(background);
  expect(storage.setAlarm).toHaveBeenCalledWith(100);
});

test("終了したイベントの文脈が残っていても、印を付ければ同期する", async () => {
  const { events, storage, background } = scheduler();
  const resume = Promise.withResolvers<void>();
  let continuation: Promise<void> | undefined;
  await events.run(async () => {
    continuation = resume.promise.then(() => events.mark());
  });
  expect(storage.getAlarm).not.toHaveBeenCalled();
  resume.resolve();
  await continuation;
  await Promise.all(background);
  expect(background).toHaveLength(1);
  expect(storage.setAlarm).toHaveBeenCalledWith(100);
});

test("イベント外のflush完了は、予備の同期と二重にAlarmを読まない", async () => {
  const { events, storage, background } = scheduler();
  await events.afterFlush();
  await Promise.all(background);
  expect(background).toHaveLength(1);
  expect(storage.getAlarm).toHaveBeenCalledTimes(1);
  expect(storage.setAlarm).toHaveBeenCalledTimes(1);
});

test("印の後に状態が変わっても、同期時の保存済みの期限を使う", async () => {
  const { events, storage, next } = scheduler();
  await events.run(async () => {
    events.mark();
    next(200);
  });
  expect(storage.setAlarm).toHaveBeenCalledWith(200);
});

test("印の後の変更が戻って例外で抜けても、戻した状態から期限を計算する", async () => {
  const { events, storage, next } = scheduler();
  const error = Error("transaction rollback");
  await expect(
    events.run(async () => {
      try {
        next(200);
        events.mark();
        throw error;
      } finally {
        next(100);
      }
    }),
  ).rejects.toBe(error);
  expect(storage.setAlarm).toHaveBeenCalledWith(100);
});

test("印がなければAlarmを読まず、入れ子の入口では最後に一度だけ合わせる", async () => {
  const { events, storage } = scheduler();
  await events.run(async () => {});
  expect(storage.getAlarm).not.toHaveBeenCalled();
  await events.run(async () => {
    events.mark();
    await events.run(async () => {
      events.mark();
    });
    expect(storage.getAlarm).not.toHaveBeenCalled();
  });
  expect(storage.getAlarm).toHaveBeenCalledTimes(1);
  expect(storage.setAlarm).toHaveBeenCalledWith(100);
});

test("例外で入口を抜けても保存済みの期限を合わせ、元の例外を返す", async () => {
  const { events, storage } = scheduler();
  const error = Error("操作失敗");
  await expect(
    events.run(async () => {
      events.mark();
      throw error;
    }),
  ).rejects.toBe(error);
  expect(storage.setAlarm).toHaveBeenCalledWith(100);
});

test("外部awaitの前に合わせたあと保存がなければ、入口末尾では合わせない", async () => {
  const { events, storage } = scheduler();
  await events.run(async () => {
    events.mark();
    await events.sync();
  });
  expect(storage.getAlarm).toHaveBeenCalledTimes(1);
  await events.afterFlush();
  expect(storage.getAlarm).toHaveBeenCalledTimes(2);
  expect(storage.setAlarm).toHaveBeenCalledTimes(1);
});

test("外部応答待ちの間に届く別イベントは、そのイベントの末尾で合わせる", async () => {
  const { events, storage, next } = scheduler();
  const wait = Promise.withResolvers<void>();
  const first = events.run(async () => {
    events.mark();
    await events.sync();
    await wait.promise;
    next(300);
    events.mark();
  });
  await events.run(async () => {
    next(200);
    events.mark();
  });
  expect(storage.setAlarm).toHaveBeenLastCalledWith(200);
  wait.resolve();
  await first;
  expect(storage.setAlarm).toHaveBeenLastCalledWith(300);
});

test("getAlarm待ちの間の変更も次の同期に残し、古い期限の上書きを防ぐ", async () => {
  const { events, storage, next } = scheduler();
  const read = Promise.withResolvers<number | null>();
  storage.getAlarm.mockImplementationOnce(() => read.promise);
  events.mark();
  const first = events.sync();
  next(200);
  events.mark();
  const second = events.sync();
  read.resolve(null);
  await Promise.all([first, second]);
  expect(storage.setAlarm.mock.calls).toEqual([[100], [200]]);
});

test("同期の失敗は次のイベントで再試行し、候補が空ならAlarmを削除する", async () => {
  const { events, storage, next } = scheduler();
  storage.getAlarm.mockRejectedValueOnce(Error("読取失敗"));
  events.mark();
  await expect(events.sync()).rejects.toThrow("読取失敗");
  await events.run(async () => {});
  expect(storage.setAlarm).toHaveBeenCalledWith(100);
  next(null);
  events.mark();
  await events.sync();
  expect(storage.deleteAlarm).toHaveBeenCalledTimes(1);
});
