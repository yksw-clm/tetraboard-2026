import { env } from "cloudflare:workers";
import { beforeEach, afterEach, expect, test } from "vitest";
import {
  announcementInputSchema,
  announcementAdminListSchema,
  announcementListSchema,
  announcementRecordSchema,
  announcementDetailSchema,
  lobbyAnnouncementSchema,
  announcementFirstLine,
} from "@tetraboard/protocol";
import worker from "../src/worker";
import { accountFixture, origin } from "./accountFixtures";
import type { AdminEnv } from "../src/admin/auth";
const context = { waitUntil: () => {} } as unknown as ExecutionContext;
const input = (overrides = {}) => ({
  title: "CPUを強くしました",
  body: " 最初の行\r\n二行目 ",
  date: "2026-10-08",
  kind: "improvement",
  published: false,
  lobbyGames: [],
  ...overrides,
});
const fetchWith = (path: string, init?: RequestInit, bindings: AdminEnv = env) =>
  worker.fetch(new Request(origin + path, init), bindings as Env, context);
async function admin() {
  const user = await accountFixture();
  return { user, bindings: { ...env, ADMIN_ACCOUNT_IDS: JSON.stringify([user.id]) } };
}
async function create(a: Awaited<ReturnType<typeof admin>>, data = input()) {
  const response = await fetchWith(
    "/api/admin/announcements",
    { method: "POST", headers: a.user.headers, body: JSON.stringify(data) },
    a.bindings,
  );
  expect(response.status).toBe(201);
  return announcementRecordSchema.parse(await response.json());
}
async function lobby(game: string) {
  const response = await fetchWith(`/api/announcements/lobby?game=${game}`);
  expect(response.status).toBe(200);
  return lobbyAnnouncementSchema.parse(await response.json()).announcement;
}
beforeEach(async () => {
  await env.APP_DB.batch([
    env.APP_DB.prepare("DELETE FROM announcement_lobby_targets"),
    env.APP_DB.prepare("DELETE FROM announcements"),
  ]);
});
afterEach(async () => {
  await env.APP_DB.exec("DROP TRIGGER IF EXISTS fail_announcement_target");
});
test("文字数・実在日・掲載先・改行を検証する", () => {
  expect(announcementInputSchema.parse(input()).body).toBe("最初の行\n二行目");
  expect(announcementFirstLine("\r\n  最初\r続き ")).toBe("最初");
  expect(
    announcementInputSchema.safeParse(
      input({ title: "😀".repeat(80), body: "😀".repeat(2000), date: "2028-02-29" }),
    ).success,
  ).toBe(true);
  for (const value of [
    { title: "😀".repeat(81) },
    { body: "😀".repeat(2001) },
    { title: "  " },
    { body: "\n " },
    { date: "2026-02-29" },
    { date: "2026-04-31" },
    { lobbyGames: ["all"] },
    { lobbyGames: ["four-shogi", "four-shogi"] },
  ])
    expect(announcementInputSchema.safeParse(input(value)).success).toBe(false);
});
test("公開と掲載先を独立管理し非公開の内容・管理情報を返さない", async () => {
  const a = await admin();
  for (const games of [[], ["four-reversi"], ["four-shogi"], ["four-reversi", "four-shogi"]]) {
    const item = await create(a, input({ lobbyGames: games }));
    expect((await fetchWith(`/api/announcements/${item.id}`)).status).toBe(404);
    const update = await fetchWith(
      `/api/admin/announcements/${item.id}`,
      {
        method: "PATCH",
        headers: a.user.headers,
        body: JSON.stringify({
          ...input({ published: true, lobbyGames: games }),
          version: item.version,
        }),
      },
      a.bindings,
    );
    expect(update.status).toBe(200);
    for (const game of ["four-reversi", "four-shogi"]) {
      if (games.includes(game)) expect((await lobby(game))?.id).toBe(item.id);
    }
    const detailResponse = await fetchWith(`/api/announcements/${item.id}`);
    expect(detailResponse.headers.get("Cache-Control")).toBe("no-store");
    const body = await detailResponse.json();
    expect(Object.keys(body as object).sort()).toEqual(["body", "date", "id", "kind", "title"]);
    expect(announcementDetailSchema.parse(body).body).toBe("最初の行\n二行目");
    expect(
      (
        await fetchWith(
          `/api/admin/announcements/${item.id}`,
          { headers: { Cookie: a.user.cookie } },
          a.bindings,
        )
      ).status,
    ).toBe(200);
    const off = await fetchWith(
      `/api/admin/announcements/${item.id}`,
      {
        method: "PATCH",
        headers: a.user.headers,
        body: JSON.stringify({ ...input({ lobbyGames: games }), version: 2 }),
      },
      a.bindings,
    );
    expect(off.status).toBe(200);
    expect((await fetchWith(`/api/announcements/${item.id}`)).status).toBe(404);
    expect(await lobby("four-reversi")).toBeNull();
    expect(await lobby("four-shogi")).toBeNull();
  }
  expect((await fetchWith("/api/announcements/missing")).status).toBe(404);
  expect((await fetchWith("/api/announcements/lobby?game=all")).status).toBe(400);
});
test("日付・登録日時・IDで並べ、編集で登録日時を変えず最新を選ぶ", async () => {
  const a = await admin();
  const older = await create(
    a,
    input({ published: true, date: "2026-10-07", lobbyGames: ["four-shogi"] }),
  );
  const newer = await create(
    a,
    input({ published: true, date: "2026-10-08", lobbyGames: ["four-shogi"] }),
  );
  const response = await fetchWith(
    `/api/admin/announcements/${older.id}`,
    {
      method: "PATCH",
      headers: a.user.headers,
      body: JSON.stringify({
        ...input({
          title: "編集済み",
          published: true,
          date: "2026-10-07",
          lobbyGames: ["four-shogi"],
        }),
        version: 1,
      }),
    },
    a.bindings,
  );
  expect(announcementRecordSchema.parse(await response.json()).createdAtMs).toBe(older.createdAtMs);
  expect((await lobby("four-shogi"))?.id).toBe(newer.id);
  const rows = await fetchWith("/api/announcements");
  expect(announcementListSchema.parse(await rows.json()).announcements.map((r) => r.id)).toEqual([
    newer.id,
    older.id,
  ]);
});
test("公開20件・管理50件のカーソル境界と同日の同時刻の順序", async () => {
  const a = await admin();
  await env.APP_DB.batch(
    Array.from({ length: 55 }, (_, index) =>
      env.APP_DB.prepare(
        "INSERT INTO announcements (id,title,body,date,kind,published,created_at_ms,updated_at_ms) VALUES (?, '題', '本文', '2026-10-08', 'other', ?, ?, 1)",
      ).bind(`paged-${String(index).padStart(3, "0")}`, index < 25 ? 1 : 0, index < 5 ? 2 : 1),
    ),
  );
  const first = announcementListSchema.parse(await (await fetchWith("/api/announcements")).json());
  expect(first.announcements).toHaveLength(20);
  expect(first.announcements.slice(0, 5).map((r) => r.id)).toEqual([
    "paged-004",
    "paged-003",
    "paged-002",
    "paged-001",
    "paged-000",
  ]);
  const second = announcementListSchema.parse(
    await (
      await fetchWith(`/api/announcements?cursor=${encodeURIComponent(first.nextCursor!)}`)
    ).json(),
  );
  expect(second.announcements).toHaveLength(5);
  expect(second.nextCursor).toBeNull();
  expect(new Set([...first.announcements, ...second.announcements].map((r) => r.id)).size).toBe(25);
  const firstAdmin = announcementAdminListSchema.parse(
    await (
      await fetchWith(
        "/api/admin/announcements",
        { headers: { Cookie: a.user.cookie } },
        a.bindings,
      )
    ).json(),
  );
  expect(firstAdmin.announcements).toHaveLength(50);
  const nextAdmin = announcementAdminListSchema.parse(
    await (
      await fetchWith(
        `/api/admin/announcements?cursor=${encodeURIComponent(firstAdmin.nextCursor!)}`,
        { headers: { Cookie: a.user.cookie } },
        a.bindings,
      )
    ).json(),
  );
  expect(nextAdmin.announcements).toHaveLength(5);
  expect(nextAdmin.nextCursor).toBeNull();
  expect((await fetchWith("/api/announcements?cursor=bad")).status).toBe(400);
});
test("権限・Origin・入力不備を拒否し、同時編集で掲載先も上書きしない", async () => {
  const a = await admin();
  const other = await accountFixture();
  expect((await fetchWith("/api/admin/announcements", undefined, a.bindings)).status).toBe(401);
  expect(
    (await fetchWith("/api/admin/announcements", { headers: { Cookie: other.cookie } }, a.bindings))
      .status,
  ).toBe(403);
  expect(
    (
      await fetchWith(
        "/api/admin/announcements",
        { headers: { Cookie: a.user.cookie } },
        { ...a.bindings, ADMIN_ACCOUNT_IDS: "[]" },
      )
    ).status,
  ).toBe(503);
  expect(
    (
      await fetchWith(
        "/api/admin/announcements",
        {
          method: "POST",
          headers: { ...a.user.headers, Origin: "https://example.test" },
          body: JSON.stringify(input()),
        },
        a.bindings,
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await fetchWith(
        "/api/admin/announcements",
        { method: "POST", headers: a.user.headers, body: JSON.stringify(input({ title: "" })) },
        a.bindings,
      )
    ).status,
  ).toBe(400);
  const item = await create(a);
  const responses = await Promise.all(
    ["four-reversi", "four-shogi"].map((game) =>
      fetchWith(
        `/api/admin/announcements/${item.id}`,
        {
          method: "PATCH",
          headers: a.user.headers,
          body: JSON.stringify({
            ...input({ title: game, lobbyGames: [game], published: true }),
            version: 1,
          }),
        },
        a.bindings,
      ),
    ),
  );
  expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
  const result = announcementRecordSchema.parse(
    await (
      await fetchWith(
        `/api/admin/announcements/${item.id}`,
        { headers: { Cookie: a.user.cookie } },
        a.bindings,
      )
    ).json(),
  );
  expect(result.version).toBe(2);
  expect(result.lobbyGames).toEqual([result.title]);
});
test("掲載先保存失敗で記事の作成・更新もロールバックする", async () => {
  const a = await admin();
  const item = await create(a, input({ lobbyGames: ["four-reversi"] }));
  await env.APP_DB.exec(
    "CREATE TRIGGER fail_announcement_target BEFORE INSERT ON announcement_lobby_targets WHEN NEW.game = 'four-shogi' BEGIN SELECT RAISE(ABORT, 'test failure'); END",
  );
  const response = await fetchWith(
    `/api/admin/announcements/${item.id}`,
    {
      method: "PATCH",
      headers: a.user.headers,
      body: JSON.stringify({
        ...input({ title: "変更", published: true, lobbyGames: ["four-shogi"] }),
        version: 1,
      }),
    },
    a.bindings,
  );
  expect(response.status).toBe(503);
  const unchanged = announcementRecordSchema.parse(
    await (
      await fetchWith(
        `/api/admin/announcements/${item.id}`,
        { headers: { Cookie: a.user.cookie } },
        a.bindings,
      )
    ).json(),
  );
  expect(unchanged).toEqual(item);
  const failed = await fetchWith(
    "/api/admin/announcements",
    {
      method: "POST",
      headers: a.user.headers,
      body: JSON.stringify(input({ lobbyGames: ["four-shogi"] })),
    },
    a.bindings,
  );
  expect(failed.status).toBe(503);
  expect(
    (await env.APP_DB.prepare("SELECT COUNT(*) AS n FROM announcements").first<{ n: number }>())!.n,
  ).toBe(1);
});
test("既存記事を新規DBへ移し、既存DBの編集済み記事を上書きしない", async () => {
  const db = (env as typeof env & { PUBLIC_MATCH_TEST_DB: D1Database }).PUBLIC_MATCH_TEST_DB;
  await db.exec(
    "DROP TABLE IF EXISTS announcement_lobby_targets; DROP TABLE IF EXISTS announcements;",
  );
  const migrations = (
    env as typeof env & { TEST_MIGRATIONS: { name: string; queries: string[] }[] }
  ).TEST_MIGRATIONS;
  const migration = migrations.find((m) => m.name.includes("0012_announcements"))!;
  await db.batch(migration.queries.map((sql) => db.prepare(sql)));
  const row = await db
    .prepare("SELECT * FROM announcements WHERE id = 'feedback'")
    .first<{ title: string; date: string; published: number; body: string }>();
  expect(row).toMatchObject({
    title: "不具合やご意見を送れるようになりました",
    date: "2026-10-04",
    published: 1,
  });
  expect(row!.body).toBe(
    "登録なしで、不具合や機能のアイデアを送れます。画像も1枚添付できます。いただいた声を、これからの改善に役立てます。",
  );
  expect(
    (await db
      .prepare("SELECT COUNT(*) AS n FROM announcement_lobby_targets")
      .first<{ n: number }>())!.n,
  ).toBe(0);
  await db.prepare("UPDATE announcements SET title = '編集済み' WHERE id = 'feedback'").run();
  await db.batch(migration.queries.map((sql) => db.prepare(sql)));
  expect(
    (await db
      .prepare("SELECT title FROM announcements WHERE id = 'feedback'")
      .first<{ title: string }>())!.title,
  ).toBe("編集済み");
});
