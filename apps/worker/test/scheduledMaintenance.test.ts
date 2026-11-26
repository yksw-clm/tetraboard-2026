import { env as bindings } from "cloudflare:workers";
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import { applyD1Migrations } from "cloudflare:test";
import worker from "../src/worker";
import { runMaintenanceTasks } from "../src/scheduledMaintenance";
import * as monthlyKpi from "../src/kpi/monthly";
import { createAuth } from "../src/adapters/account/auth";
import { accountFixture } from "./accountFixtures";

const env = {
  ...bindings,
  APP_DB: (bindings as typeof bindings & { SCHEDULED_MAINTENANCE_TEST_DB: D1Database })
    .SCHEDULED_MAINTENANCE_TEST_DB,
};
beforeAll(async () => {
  await applyD1Migrations(
    env.APP_DB,
    (
      bindings as typeof bindings & {
        TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
      }
    ).TEST_MIGRATIONS,
  );
});
const unrelatedCredentials: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const id of unrelatedCredentials.splice(0))
    await bindings.APP_DB.prepare("DELETE FROM verification WHERE id=?").bind(id).run();
});

test("定期処理は順番を守り、失敗後のジョブも完了させて失敗名だけを報告する", async () => {
  const order: string[] = [];
  const log = vi.spyOn(console, "info").mockImplementation(() => {});
  let finish!: () => void;
  const pending = runMaintenanceTasks([
    {
      name: "first",
      run: () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    },
    {
      name: "failed",
      run: async () => {
        order.push("failed");
        throw new Error("private-token");
      },
    },
    {
      name: "last",
      run: async () => {
        order.push("last");
      },
    },
  ]);
  expect(order).toEqual([]);
  finish();
  await expect(pending).rejects.toThrow("Scheduled maintenance failed: failed");
  expect(order).toEqual(["failed", "last"]);
  expect(log.mock.calls.map((call) => call[1].status)).toEqual(["success", "failed", "success"]);
  expect(JSON.stringify(log.mock.calls)).not.toContain("private-token");
});

test("通報の期限削除が失敗しても後続の資格を削除し、次回は成功できる", async () => {
  const monthly = vi.spyOn(monthlyKpi, "savePreviousMonthKpi").mockResolvedValue();
  vi.spyOn(console, "info").mockImplementation(() => {});
  const id = crypto.randomUUID();
  const unrelatedId = crypto.randomUUID();
  unrelatedCredentials.push(unrelatedId);
  const expiredAt = new Date(1).toISOString();
  await bindings.APP_DB.prepare(
    "INSERT INTO verification(id,identifier,value,expiresAt,createdAt,updatedAt) VALUES (?,?,?,?,?,?)",
  )
    .bind(unrelatedId, unrelatedId, "unrelated", expiredAt, expiredAt, expiredAt)
    .run();
  await env.APP_DB.prepare(
    "INSERT INTO verification(id,identifier,value,expiresAt,createdAt,updatedAt) VALUES (?,?,?,?,?,?)",
  )
    .bind(id, id, "expired", expiredAt, expiredAt, expiredAt)
    .run();
  const database = new Proxy(env.APP_DB, {
    get(target, key) {
      if (key === "prepare")
        return (sql: string) => {
          if (sql === "DELETE FROM reports WHERE expires_at_ms <= ?")
            throw new Error("unavailable");
          return target.prepare(sql);
        };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  await expect(
    worker.scheduled({} as ScheduledController, { ...env, APP_DB: database }),
  ).rejects.toThrow("Scheduled maintenance failed: reports");
  // 他のfixtureが残した予約や再試行を、このテストの定期処理へ巻き込みません。
  expect(
    await bindings.APP_DB.prepare("SELECT value FROM verification WHERE id=?")
      .bind(unrelatedId)
      .first("value"),
  ).toBe("unrelated");
  expect(
    await env.APP_DB.prepare("SELECT id FROM verification WHERE id=?").bind(id).first(),
  ).toBeNull();
  await expect(worker.scheduled({} as ScheduledController, env)).resolves.toBeUndefined();
  expect(monthly).toHaveBeenCalledTimes(2);
});

test.each(["session", "verification"] as const)(
  "%s は better-auth が ISO text で保存し、掃除は期限切れだけを削除する",
  async (table) => {
    const now = Date.parse("2026-11-16T09:00:00.000Z");
    vi.spyOn(Date, "now").mockReturnValue(now);
    vi.spyOn(monthlyKpi, "savePreviousMonthKpi").mockResolvedValue();
    vi.spyOn(console, "info").mockImplementation(() => {});
    const user = await accountFixture(true, crypto.randomUUID(), env.APP_DB);
    const { internalAdapter } = await createAuth(env).$context;
    const ids: string[] = [];
    for (const offset of [-1, 0, 1]) {
      const expiresAt = new Date(now + offset);
      const row =
        table === "session"
          ? await internalAdapter.createSession(user.id, false, { expiresAt }, true)
          : await internalAdapter.createVerificationValue({
              identifier: crypto.randomUUID(),
              value: "test",
              expiresAt,
            });
      ids.push(row.id);
      expect(
        await env.APP_DB.prepare(
          `SELECT expiresAt,typeof(expiresAt) AS storageType FROM ${table} WHERE id=?`,
        )
          .bind(row.id)
          .first(),
      ).toEqual({ expiresAt: expiresAt.toISOString(), storageType: "text" });
    }

    await worker.scheduled({} as ScheduledController, env);

    for (const [index, id] of ids.entries()) {
      const row = await env.APP_DB.prepare(`SELECT id FROM ${table} WHERE id=?`).bind(id).first();
      expect(row).toEqual(index === 0 ? null : { id });
    }
  },
);

test("退会対象と横断棋譜一覧は検索順に対応する索引を使う", async () => {
  const room = await env.APP_DB.prepare(
    "EXPLAIN QUERY PLAN SELECT account_id FROM deletion_rooms WHERE room_id=?",
  )
    .bind("12345")
    .all<{ detail: string }>();
  expect(room.results.some((row) => row.detail.includes("deletion_rooms_by_room"))).toBe(true);
  const matches = await env.APP_DB.prepare(
    "EXPLAIN QUERY PLAN SELECT id,game,record_json FROM matches ORDER BY started_at_ms DESC,id DESC LIMIT 20",
  ).all<{ detail: string }>();
  expect(matches.results.some((row) => row.detail.includes("matches_recent"))).toBe(true);
  expect(matches.results.some((row) => row.detail.includes("TEMP B-TREE"))).toBe(false);
});

test("毎時処理が期限切れの掲示板通報を削除し、期限内の退会者の証拠を匿名化する", async () => {
  const now = Date.now();
  const cutoff = now - 7 * 86400000;
  vi.spyOn(Date, "now").mockReturnValue(now);
  vi.spyOn(monthlyKpi, "savePreviousMonthKpi").mockResolvedValue();
  vi.spyOn(console, "info").mockImplementation(() => {});
  const departed = crypto.randomUUID();
  const expired = crypto.randomUUID();
  const recent = crypto.randomUUID();
  await env.APP_DB.batch([
    env.APP_DB.prepare(
      "INSERT INTO deleted_accounts(id,requested_at_ms,receipt_hash,completed_at_ms) VALUES(?,?,?,?)",
    ).bind(departed, now, crypto.randomUUID(), now),
    ...[
      [expired, cutoff],
      [recent, cutoff + 1],
    ].map(([id, time]) =>
      env.APP_DB.prepare(`INSERT INTO board_reports(id,post_id,game_id,author_account_id,author_name,
        body,posted_at_ms,reason,reporter_account_id,reported_at_ms,moderator_deleted_at_ms)
        VALUES(?,?,'reversi',?,'退会前の名前','保存される本文',?,'abuse',?,?,?)`).bind(
        id,
        crypto.randomUUID(),
        departed,
        cutoff,
        departed,
        time,
        now,
      ),
    ),
  ]);
  await worker.scheduled({} as ScheduledController, env);
  const evidence = await env.APP_DB.prepare(
    "SELECT id,author_account_id,author_name,reporter_account_id,body,moderator_deleted_at_ms FROM board_reports WHERE id IN (?,?)",
  )
    .bind(expired, recent)
    .all();
  expect(evidence.results).toEqual([
    {
      id: recent,
      author_account_id: null,
      author_name: "退会したプレイヤー",
      reporter_account_id: null,
      body: "保存される本文",
      moderator_deleted_at_ms: now,
    },
  ]);
});
