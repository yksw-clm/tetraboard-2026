import { env } from "cloudflare:workers";
import { afterEach, expect, test, vi } from "vitest";
import worker from "../src/worker";
import { runMaintenanceTasks } from "../src/scheduledMaintenance";

afterEach(() => vi.restoreAllMocks());

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
  vi.spyOn(console, "info").mockImplementation(() => {});
  const id = crypto.randomUUID();
  await env.APP_DB.prepare(
    "INSERT INTO verification(id,identifier,value,expiresAt,createdAt,updatedAt) VALUES (?,?,?,1,1,1)",
  )
    .bind(id, id, "expired")
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
  expect(
    await env.APP_DB.prepare("SELECT id FROM verification WHERE id=?").bind(id).first(),
  ).toBeNull();
  await expect(worker.scheduled({} as ScheduledController, env)).resolves.toBeUndefined();
});

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
