import { env } from "cloudflare:workers";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  feedbackDetailSchema,
  feedbackListSchema,
  feedbackSummarySchema,
} from "@tetraboard/protocol";
import { cleanupFeedback } from "../src/adapters/community/feedbackCleanup";
import { feedbackRetentionMs } from "@tetraboard/context-community";
import { accountFixture } from "./accountFixtures";
import {
  admin,
  fetchWith,
  post,
  form,
  input,
  getAdmin,
  webp,
  resetFeedback,
} from "./feedbackFixtures";

const changeAdmin = (
  path: string,
  method: string,
  body: unknown,
  a: Awaited<ReturnType<typeof admin>>,
) =>
  fetchWith(
    `/api/admin/feedback${path}`,
    { method, headers: a.user.headers, body: JSON.stringify(body) },
    a.bindings,
  );

const patch = (overrides = {}) => ({
  version: 1,
  status: "reviewing",
  priority: "normal",
  topicId: null,
  note: "再現確認中",
  issueUrl: "",
  published: false,
  ...overrides,
});

beforeEach(resetFeedback);
afterEach(() => vi.restoreAllMocks());

test("詳細・画像・一覧・テーマ・集計・更新・削除は管理者本人だけに許可する", async () => {
  const a = await admin();
  const other = await accountFixture();
  const id = ((await (await post()).json()) as { id: string }).id;
  for (const path of ["", "/summary", "/topics", `/${id}`, `/${id}/attachment`]) {
    expect((await fetchWith(`/api/admin/feedback${path}`, undefined, a.bindings)).status).toBe(401);
    expect(
      (
        await fetchWith(
          `/api/admin/feedback${path}`,
          { headers: { Cookie: other.cookie } },
          a.bindings,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await fetchWith(
          `/api/admin/feedback${path}`,
          { headers: { Authorization: "Bearer test-moderator-token" } },
          a.bindings,
        )
      ).status,
    ).toBe(401);
  }
  for (const method of ["PATCH", "DELETE"]) {
    expect(
      (
        await fetchWith(
          `/api/admin/feedback/${id}`,
          { method, headers: { ...other.headers }, body: JSON.stringify(patch()) },
          a.bindings,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await fetchWith(
          `/api/admin/feedback/${id}`,
          {
            method,
            headers: { ...a.user.headers, Origin: "https://other.test" },
            body: JSON.stringify(patch()),
          },
          a.bindings,
        )
      ).status,
    ).toBe(403);
  }
  expect(
    (
      await fetchWith(
        "/api/admin/feedback/topics",
        { method: "POST", headers: other.headers, body: JSON.stringify({ name: "表示" }) },
        a.bindings,
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await fetchWith("/api/feedback", {
        method: "POST",
        headers: { Origin: "https://other.test" },
        body: form(input()),
      })
    ).status,
  ).toBe(403);
  expect(
    (await fetchWith("/api/admin/feedback", undefined, { ...env, ADMIN_ACCOUNT_IDS: "broken" }))
      .status,
  ).toBe(503);
});

test("テーマの作成・改名と投稿の変更は競合を検出し、初回確認時刻と編集履歴を保つ", async () => {
  const a = await admin();
  const id = ((await (await post()).json()) as { id: string }).id;
  const t = await changeAdmin("/topics", "POST", { name: "スマホ操作" }, a);
  expect(t.status).toBe(201);
  const topic = (await t.json()) as { id: string };
  expect((await changeAdmin("/topics", "POST", { name: "スマホ操作" }, a)).status).toBe(409);
  expect(
    (await changeAdmin(`/topics/${topic.id}`, "PATCH", { name: "スマホ表示", version: 1 }, a))
      .status,
  ).toBe(200);
  expect(
    (await changeAdmin(`/topics/${topic.id}`, "PATCH", { name: "古い変更", version: 1 }, a)).status,
  ).toBe(409);
  const updated = await changeAdmin(
    `/${id}`,
    "PATCH",
    patch({
      topicId: topic.id,
      priority: "high",
      issueUrl: "https://github.com/yksw-clm/tetraboard-2026/issues/52",
    }),
    a,
  );
  expect(updated.status).toBe(200);
  const reviewed = feedbackDetailSchema.parse(await (await getAdmin(`/${id}`, a)).json());
  expect(reviewed.feedback.firstReviewedAtMs).not.toBeNull();
  expect(reviewed.history).toHaveLength(1);
  expect(reviewed.history[0]!.admin).toBe("登録名");
  expect((await changeAdmin(`/${id}`, "PATCH", patch(), a)).status).toBe(409);
  expect(
    (await changeAdmin(`/${id}`, "PATCH", patch({ version: 2, status: "done" }), a)).status,
  ).toBe(400);
  expect(
    (await changeAdmin(`/${id}`, "PATCH", patch({ version: 2, status: "declined", note: "" }), a))
      .status,
  ).toBe(400);
  expect(
    (await changeAdmin(`/${id}`, "PATCH", patch({ version: 2, topicId: crypto.randomUUID() }), a))
      .status,
  ).toBe(400);
  expect(
    (
      await changeAdmin(
        `/${id}`,
        "PATCH",
        patch({ version: 2, status: "done", published: true }),
        a,
      )
    ).status,
  ).toBe(200);
  const final = feedbackDetailSchema.parse(await (await getAdmin(`/${id}`, a)).json());
  expect(final.feedback.firstReviewedAtMs).toBe(reviewed.feedback.firstReviewedAtMs);
  expect(final.history).toHaveLength(2);
});

test("集計は報告者を重複排除し、内部・迷惑・削除・期限切れを除き確認時間の中央値を返す", async () => {
  const a = await admin();
  const now = Date.now();
  const browser = `tetraboard-2026.feedback=${crypto.randomUUID()}`;
  for (let i = 0; i < 3; i++) await post(input(), browser);
  await post(input(), a.user.cookie, undefined, a.bindings);
  const list = feedbackListSchema.parse(await (await getAdmin("", a)).json());
  expect(list.feedback).toHaveLength(4);
  const guestIds = list.feedback.filter((r) => !r.internal).map((r) => r.id);
  await env.APP_DB.prepare(
    "UPDATE feedback SET first_reviewed_at_ms = received_at_ms + 1000, status = 'reviewing' WHERE id = ?",
  )
    .bind(guestIds[0])
    .run();
  await env.APP_DB.prepare(
    "UPDATE feedback SET first_reviewed_at_ms = received_at_ms + 3000, status = 'reviewing' WHERE id = ?",
  )
    .bind(guestIds[1])
    .run();
  const summary = feedbackSummarySchema.parse(await (await getAdmin("/summary", a)).json());
  expect(summary.topics[0]).toMatchObject({ posts: 3, reporters: 1 });
  expect(summary.unreviewed).toBe(1);
  expect(summary.medianReviewMs).toBe(2000);
  expect(
    feedbackSummarySchema.parse(await (await getAdmin("/summary?includeInternal=true", a)).json())
      .topics[0]?.posts,
  ).toBe(4);
  await env.APP_DB.prepare("UPDATE feedback SET status = 'spam' WHERE id = ?")
    .bind(guestIds[0])
    .run();
  await env.APP_DB.prepare("UPDATE feedback SET expires_at_ms = ? WHERE id = ?")
    .bind(now - 1, guestIds[1])
    .run();
  await env.APP_DB.prepare("UPDATE feedback SET deleted = 1 WHERE id = ?").bind(guestIds[2]).run();
  expect(
    feedbackSummarySchema.parse(await (await getAdmin("/summary", a)).json()).topics,
  ).toHaveLength(0);
});

test("一覧は同時刻でも50件ずつ重複なくページングし、各条件で絞り込める", async () => {
  const now = Date.now();
  const ids = Array.from({ length: 53 }, () => crypto.randomUUID());
  await env.APP_DB.batch(
    ids.map((id, i) =>
      env.APP_DB.prepare(`INSERT INTO feedback (id, submission_id, payload_hash, author, reporter_hash, internal, kind, game, body, expectation, steps, received_at_ms, expires_at_ms, ready, status, priority)
    VALUES (?, ?, 'hash', 'guest', 'guest', 0, ?, ?, '投稿', '', '', ?, ?, 1, ?, ?)`).bind(
        id,
        crypto.randomUUID(),
        i === 0 ? "request" : "bug",
        i === 0 ? "four-shogi" : "all",
        now,
        now + feedbackRetentionMs,
        i === 0 ? "planned" : "new",
        i === 0 ? "high" : "normal",
      ),
    ),
  );
  const a = await admin();
  const first = feedbackListSchema.parse(await (await getAdmin("", a)).json());
  expect(first.feedback).toHaveLength(50);
  const second = feedbackListSchema.parse(
    await (await getAdmin(`?cursor=${encodeURIComponent(first.nextCursor!)}`, a)).json(),
  );
  expect(second.feedback).toHaveLength(3);
  expect(new Set([...first.feedback, ...second.feedback].map((r) => r.id)).size).toBe(53);
  expect(
    feedbackListSchema.parse(
      await (
        await getAdmin("?kind=request&game=four-shogi&status=planned&priority=high&topicId=none", a)
      ).json(),
    ).feedback,
  ).toHaveLength(1);
  expect((await getAdmin("?cursor=invalid", a)).status).toBe(400);
});

test("削除は直ちに非表示にし、R2失敗後の毎時処理で画像・本文・履歴を物理削除する", async () => {
  const a = await admin();
  const id = ((await (await post(input(), "", webp())).json()) as { id: string }).id;
  await changeAdmin(`/${id}`, "PATCH", patch(), a);
  expect((await changeAdmin(`/${id}`, "DELETE", { version: 1 }, a)).status).toBe(409);
  expect((await changeAdmin(`/${id}`, "DELETE", { version: 2 }, a)).status).toBe(204);
  expect((await getAdmin(`/${id}`, a)).status).toBe(404);
  expect((await getAdmin(`/${id}/attachment`, a)).status).toBe(404);
  const key = `feedback/${id}.webp`;
  await cleanupFeedback({
    ...env,
    OBJECT_STORAGE: {
      delete: async () => {
        throw new Error("R2 unavailable");
      },
    } as unknown as R2Bucket,
  });
  expect(await env.OBJECT_STORAGE.get(key)).not.toBeNull();
  expect(
    await env.APP_DB.prepare("SELECT id FROM feedback WHERE id = ?").bind(id).first(),
  ).not.toBeNull();
  await cleanupFeedback(env);
  expect(await env.OBJECT_STORAGE.get(key)).toBeNull();
  expect(
    await env.APP_DB.prepare("SELECT id FROM feedback WHERE id = ?").bind(id).first(),
  ).toBeNull();
  expect(
    await env.APP_DB.prepare("SELECT id FROM feedback_history WHERE feedback_id = ?")
      .bind(id)
      .first(),
  ).toBeNull();
});

test("180日ちょうどで閲覧・集計から外し、24時間以上の中断アップロードを削除する", async () => {
  const a = await admin();
  const now = Date.now();
  const id = ((await (await post(input(), "", webp())).json()) as { id: string }).id;
  await env.APP_DB.prepare("UPDATE feedback SET expires_at_ms = ? WHERE id = ?")
    .bind(now, id)
    .run();
  expect((await getAdmin(`/${id}`, a)).status).toBe(404);
  expect((await getAdmin(`/${id}/attachment`, a)).status).toBe(404);
  const orphan = `feedback/${crypto.randomUUID()}.webp`;
  await env.OBJECT_STORAGE.put(orphan, webp());
  await env.APP_DB.prepare("INSERT INTO feedback_uploads (key, created_at_ms) VALUES (?, ?)")
    .bind(orphan, now - 86400000)
    .run();
  const pending = input();
  await post(pending, "", webp(), {
    ...env,
    OBJECT_STORAGE: {
      put: async () => {
        throw new Error();
      },
    } as unknown as R2Bucket,
  });
  await env.APP_DB.prepare("UPDATE feedback SET received_at_ms = ? WHERE submission_id = ?")
    .bind(now - 86400000, pending.submissionId)
    .run();
  await cleanupFeedback(env, now);
  expect(await env.OBJECT_STORAGE.get(orphan)).toBeNull();
  expect(
    await env.APP_DB.prepare("SELECT id FROM feedback WHERE submission_id = ?")
      .bind(pending.submissionId)
      .first(),
  ).toBeNull();
});
