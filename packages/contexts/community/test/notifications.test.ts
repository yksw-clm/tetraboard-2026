import { expect, test } from "bun:test";
import type { Notification } from "@tetraboard/protocol";
import {
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
} from "@tetraboard/context-community";

const announcement = (id: number): Notification => ({
  id,
  createdAtMs: 1,
  read: false,
  legacy: false,
  kind: "announcement",
  announcement: { id: "update", title: "更新", body: "内容", date: "2026-11-18" },
});

test("一覧は20件まで返し、取得中に増えた通知を番号上限に含める", async () => {
  const rows = Array.from({ length: 21 }, (_, index) => announcement(25 - index));
  const query = { after: 4, announcementId: "update" };
  const result = await listNotifications(
    {
      upperBound: async () => 24,
      async list(accountId, options) {
        expect(accountId).toBe("reader");
        expect(options).toEqual(query);
        return rows;
      },
    },
    "reader",
    query,
  );

  expect(result).toEqual({ notifications: rows.slice(0, 20), upperBound: 25, nextCursor: "6" });
});

test("既読の再送は同じ通知を閲覧できる場合に成功する", async () => {
  const result = await markNotificationRead(
    {
      insertRead: async () => false,
      list: async (accountId, { id }) =>
        accountId === "reader" && id === 8 ? [{ ...announcement(id), read: true }] : [],
    },
    "reader",
    8,
  );

  expect(result).toBe(true);
});

test("閲覧できない通知を既読にできない", async () => {
  expect(
    await markNotificationRead(
      {
        insertRead: async () => false,
        list: async () => [],
      },
      "reader",
      8,
    ),
  ).toBe(false);
});

test("初回に一括既読を実行すると、全体通知の基準を作って本人の既読上限を保存する", async () => {
  const states = new Map<string, { baseline: number; readAll: number }>();
  const store = {
    async initializeReadState(accountId: string) {
      if (!states.has(accountId)) states.set(accountId, { baseline: 7, readAll: 0 });
    },
    issuedThrough: async () => 11,
    async advanceReadAll(accountId: string, through: number) {
      const state = states.get(accountId);
      if (state) state.readAll = Math.max(state.readAll, through);
    },
  };

  const result = await markAllNotificationsRead(store, "reader", 10);

  expect(result).toBe(true);
  expect(states.get("reader")).toEqual({ baseline: 7, readAll: 10 });
});

test.each([
  { through: 11, saved: true },
  { through: 12, saved: false },
])("一括既読は発行済みの上限11までを受け付ける ($through)", async ({ through, saved }) => {
  const writes: { accountId: string; through: number }[] = [];
  let preparedAccount: string | undefined;
  const result = await markAllNotificationsRead(
    {
      async initializeReadState(accountId) {
        preparedAccount = accountId;
      },
      async issuedThrough() {
        expect(preparedAccount).toBe("reader");
        return 11;
      },
      async advanceReadAll(accountId, through) {
        writes.push({ accountId, through });
      },
    },
    "reader",
    through,
  );

  expect(result).toBe(saved);
  expect(writes).toEqual(saved ? [{ accountId: "reader", through }] : []);
});
