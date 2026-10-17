import { env } from "cloudflare:workers";
import { beforeEach, afterEach, expect, test, vi } from "vitest";
import {
  feedbackDetailSchema,
  feedbackListSchema,
  feedbackSummarySchema,
  feedbackInputSchema,
} from "@tetraboard/protocol";
import worker from "../src/worker";
import type { FeedbackEnv } from "../src/feedback/routes";
import { cleanupFeedback, feedbackRetentionMs } from "../src/feedback/store";
import { validFeedbackImage } from "../src/feedback/images";
import { accountFixture, origin } from "./accountFixtures";
const context = { waitUntil: () => {} } as unknown as ExecutionContext;
const fetchWith = (path: string, init?: RequestInit, bindings: FeedbackEnv = env) =>
  worker.fetch(new Request(origin + path, init), bindings, context);
const input = (overrides = {}) => ({
  submissionId: crypto.randomUUID(),
  kind: "bug",
  game: "four-reversi",
  body: "画面の表示が崩れました",
  expectation: "石数を読める",
  steps: "スマホを横にする",
  technical: null,
  ...overrides,
});
function webp(width = 256, height = 256) {
  const bytes = new Uint8Array(32);
  bytes.set(new TextEncoder().encode("RIFF"), 0);
  bytes.set(new TextEncoder().encode("WEBPVP8L"), 8);
  const view = new DataView(bytes.buffer);
  view.setUint32(4, 24, true);
  view.setUint32(16, 12, true);
  bytes[20] = 0x2f;
  view.setUint32(21, (width - 1) | ((height - 1) << 14), true);
  return bytes;
}
function form(data: unknown, image?: Uint8Array) {
  const body = new FormData();
  body.set("input", JSON.stringify(data));
  if (image) body.set("attachment", new File([image], "capture.webp", { type: "image/webp" }));
  return body;
}
const post = (
  data: unknown = input(),
  cookie = "",
  image?: Uint8Array,
  bindings: FeedbackEnv = env,
  ip = "192.0.2.1",
) =>
  fetchWith(
    "/api/feedback",
    {
      method: "POST",
      headers: { Origin: origin, Cookie: cookie, "CF-Connecting-IP": ip },
      body: form(data, image),
    },
    bindings,
  );
const cookieOf = (r: Response) => r.headers.get("Set-Cookie")!.split(";")[0]!;
async function admin() {
  const user = await accountFixture();
  return { user, bindings: { ...env, ADMIN_ACCOUNT_ID: user.id } };
}
const getAdmin = (path: string, a: Awaited<ReturnType<typeof admin>>) =>
  fetchWith(`/api/admin/feedback${path}`, { headers: { Cookie: a.user.cookie } }, a.bindings);
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
beforeEach(async () => {
  await env.APP_DB.batch(
    ["feedback_history", "feedback", "feedback_topics", "feedback_limits", "feedback_uploads"].map(
      (t) => env.APP_DB.prepare(`DELETE FROM ${t}`),
    ),
  );
});
afterEach(() => vi.restoreAllMocks());

test("終局評価は任意コメントと星1〜5・CPU戦/対人戦を保存し、投稿者はサーバー認証で区別する", async () => {
  const a = await admin();
  const user = await accountFixture();
  for (const [opponent, cookie, rating] of [
    ["cpu", "", 1],
    ["human", user.cookie, 5],
  ] as const) {
    const data = input({ kind: "opinion", body: "", expectation: "", steps: "", rating, opponent });
    const response = await post(data, cookie);
    expect(response.status).toBe(201);
    const { id } = (await response.json()) as { id: string };
    const detail = feedbackDetailSchema.parse(await (await getAdmin(`/${id}`, a)).json()).feedback;
    expect(detail).toMatchObject({
      rating,
      opponent,
      body: "",
      author: cookie ? "account" : "guest",
    });
    expect((await post(data, cookie)).status).toBe(201);
    expect((await post({ ...data, rating: 3 }, cookie)).status).toBe(409);
  }
  for (const query of [
    "?author=guest&opponent=cpu&rating=1",
    "?author=account&opponent=human&rating=5",
  ]) {
    expect(feedbackListSchema.parse(await (await getAdmin(query, a)).json()).feedback).toHaveLength(
      1,
    );
  }
  expect(
    feedbackListSchema.parse(await (await getAdmin("?author=guest&opponent=human", a)).json())
      .feedback,
  ).toHaveLength(0);
  for (const query of [
    "?rating=0",
    "?rating=6",
    "?rating=1.5",
    "?opponent=invalid",
    "?author=invalid",
  ]) {
    expect((await getAdmin(query, a)).status).toBe(400);
  }
});

test("星評価の範囲・整数・対戦区分・任意コメントの上限を検証し、従来投稿の本文必須を維持する", async () => {
  const base = {
    kind: "opinion",
    expectation: "",
    steps: "",
    body: "",
    rating: 3,
    opponent: "cpu",
  };
  for (const change of [
    { rating: 0 },
    { rating: 6 },
    { rating: 2.5 },
    { rating: "3" },
    { rating: undefined },
    { opponent: undefined },
    { opponent: "other" },
    { kind: "bug" },
    { game: "all" },
    { body: "a".repeat(2001) },
  ]) {
    expect((await post(input({ ...base, ...change }))).status).toBe(400);
  }
  expect((await post(input({ body: "" }))).status).toBe(400);
  expect((await post(input({ ...base, body: "よかったです" }))).status).toBe(201);
  const legacy = await post();
  const { id } = (await legacy.json()) as { id: string };
  const a = await admin();
  expect(
    feedbackDetailSchema.parse(await (await getAdmin(`/${id}`, a)).json()).feedback,
  ).toMatchObject({ rating: null, opponent: null });
});

test("ゲスト受付は本文と画像を非公開に保存し、応答には受付番号だけを返す", async () => {
  const a = await admin();
  const r = await post(input(), "", webp());
  expect(r.status).toBe(201);
  expect(r.headers.get("Cache-Control")).toBe("no-store");
  expect(r.headers.get("Set-Cookie")).toContain("HttpOnly; SameSite=Lax");
  const receipt = (await r.json()) as { id: string };
  expect(Object.keys(receipt)).toEqual(["id"]);
  const detail = feedbackDetailSchema.parse(await (await getAdmin(`/${receipt.id}`, a)).json());
  expect(detail.feedback).toMatchObject({
    body: "画面の表示が崩れました",
    author: "guest",
    hasAttachment: true,
    status: "new",
  });
  const image = await getAdmin(`/${receipt.id}/attachment`, a);
  expect(image.status).toBe(200);
  expect(image.headers.get("Cache-Control")).toBe("no-store");
  expect(image.headers.get("Content-Type")).toBe("image/webp");
  expect(new Uint8Array(await image.arrayBuffer())).toEqual(webp());
  const row = await env.APP_DB.prepare("SELECT * FROM feedback WHERE id = ?")
    .bind(receipt.id)
    .first();
  expect(JSON.stringify(row)).not.toContain("192.0.2.1");
  expect(JSON.stringify(row)).not.toContain(cookieOf(r).split("=")[1]);
  expect((await fetchWith(`/api/feedback/${receipt.id}`)).status).toBe(404);
  expect((await fetchWith(`/api/avatars/${receipt.id}`)).status).toBe(404);
});

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

test("登録者・プロフィール未完了・内部投稿はサーバー認証で区別し、認証失敗をゲストにしない", async () => {
  const a = await admin();
  const incomplete = await accountFixture(false);
  const r = await post(input({ accountRequired: true }), incomplete.cookie);
  expect(r.status).toBe(201);
  const id = ((await r.json()) as { id: string }).id;
  expect(
    feedbackDetailSchema.parse(await (await getAdmin(`/${id}`, a)).json()).feedback.author,
  ).toBe("account");
  const internal = await post(input(), a.user.cookie, undefined, a.bindings);
  const iid = ((await internal.json()) as { id: string }).id;
  expect(
    feedbackDetailSchema.parse(await (await getAdmin(`/${iid}`, a)).json()).feedback.internal,
  ).toBe(true);
  expect((await post(input({ accountRequired: true }))).status).toBe(401);
  expect((await post(input(), "tetraboard-2026.session_token=invalid")).status).toBe(401);
  const broken = {
    ...env,
    APP_DB: {
      prepare: () => {
        throw new Error("database unavailable");
      },
    } as unknown as D1Database,
  };
  expect((await post(input(), incomplete.cookie, undefined, broken)).status).toBe(503);
});

test("同一内容の並行送信・再送は投稿と添付を一件にし、内容変更は409にする", async () => {
  const data = input();
  const browser = `tetraboard-2026.feedback=${crypto.randomUUID()}`;
  const replies = await Promise.all([post(data, browser, webp()), post(data, browser, webp())]);
  expect(replies.map((r) => r.status)).toEqual([201, 201]);
  const ids = await Promise.all(replies.map(async (r) => ((await r.json()) as { id: string }).id));
  expect(ids[0]).toBe(ids[1]);
  expect(
    (await env.APP_DB.prepare("SELECT COUNT(*) AS n FROM feedback").first<{ n: number }>())?.n,
  ).toBe(1);
  expect((await env.OBJECT_STORAGE.list({ prefix: `feedback/${ids[0]}` })).objects).toHaveLength(1);
  expect((await post(data, browser, webp())).status).toBe(201);
  expect((await post({ ...data, body: "変更した内容" }, browser, webp())).status).toBe(409);
});

test("R2保存失敗は成功応答を返さず、再送で同じ予約を回復する", async () => {
  const data = input();
  const failure = {
    ...env,
    OBJECT_STORAGE: {
      put: async () => {
        throw new Error("R2 unavailable");
      },
    } as unknown as R2Bucket,
  };
  const first = await post(data, "", webp(), failure);
  expect(first.status).toBe(503);
  const pending = await env.APP_DB.prepare("SELECT id, ready FROM feedback WHERE submission_id = ?")
    .bind(data.submissionId)
    .first<{ id: string; ready: number }>();
  expect(pending?.ready).toBe(0);
  const a = await admin();
  expect((await getAdmin(`/${pending!.id}`, a)).status).toBe(404);
  const retry = await post(data, cookieOf(first), webp());
  expect(retry.status).toBe(201);
  expect(((await retry.json()) as { id: string }).id).toBe(pending!.id);
});

test("D1受付失敗は投稿と画像を増やさず503にする", async () => {
  const bindings = {
    ...env,
    APP_DB: {
      prepare: () => {
        throw new Error("D1 unavailable");
      },
    } as unknown as D1Database,
  };
  const r = await post(input(), "", webp(), bindings);
  expect(r.status).toBe(503);
  expect(
    (await env.APP_DB.prepare("SELECT COUNT(*) AS n FROM feedback").first<{ n: number }>())?.n,
  ).toBe(0);
});

test("本文・任意項目・技術情報の上限、余分な情報、形式を検査する", async () => {
  for (const data of [
    input({ body: "  " }),
    input({ body: "あ".repeat(2001) }),
    input({ expectation: "a".repeat(501) }),
    input({ steps: "a".repeat(1001) }),
    input({ token: "secret" }),
    input({ technical: { url: "https://secret.test" } }),
    input({ kind: "request" }),
  ]) {
    expect((await post(data)).status).toBe(400);
  }
  expect(feedbackInputSchema.safeParse(input({ body: "😀".repeat(2000) })).success).toBe(true);
  const r = await post(
    input({ body: "あ".repeat(2000), expectation: "a".repeat(500), steps: "a".repeat(1000) }),
  );
  expect(r.status).toBe(201);
  const huge = new FormData();
  huge.set("input", "x".repeat(1024 * 1024 + 65537));
  expect(
    (await fetchWith("/api/feedback", { method: "POST", headers: { Origin: origin }, body: huge }))
      .status,
  ).toBe(413);
  expect(
    (
      await fetchWith("/api/feedback", {
        method: "POST",
        headers: { Origin: origin },
        body: "invalid",
      })
    ).status,
  ).toBe(400);
});

test("添付は静止WebP・長辺1600px・1MiBまでで、メタデータと偽装を拒否する", async () => {
  expect(validFeedbackImage(webp(1600, 900))).toBe(true);
  const metadata = new Uint8Array(40);
  metadata.set(webp());
  metadata.set(new TextEncoder().encode("EXIF"), 32);
  new DataView(metadata.buffer).setUint32(4, 32, true);
  for (const bytes of [
    webp(1601, 900),
    new Uint8Array(20),
    metadata,
    new Uint8Array(1024 * 1024 + 1),
  ]) {
    expect(validFeedbackImage(bytes)).toBe(false);
    expect((await post(input(), "", bytes)).status).not.toBe(201);
  }
  const animated = metadata.slice();
  animated.set(new TextEncoder().encode("ANIM"), 32);
  expect(validFeedbackImage(animated)).toBe(false);
  const wrong = form(input());
  wrong.set("attachment", new File([webp()], "capture.svg", { type: "image/svg+xml" }));
  expect(
    (await fetchWith("/api/feedback", { method: "POST", headers: { Origin: origin }, body: wrong }))
      .status,
  ).toBe(415);
});

test("ブラウザとアカウントの送信上限は並行送信でも超えず、既存送信の再送は許す", async () => {
  const user = await accountFixture();
  const data = input();
  const first = await post(data, user.cookie);
  const browser = cookieOf(first);
  expect(first.status).toBe(201);
  const replies = await Promise.all(
    Array.from({ length: 7 }, () => post(input(), `${user.cookie}; ${browser}`)),
  );
  expect(replies.filter((r) => r.status === 201)).toHaveLength(4);
  expect(replies.filter((r) => r.status === 429)).toHaveLength(3);
  expect((await post(data, `${user.cookie}; ${browser}`)).status).toBe(201);
  expect((await post(input(), user.cookie)).status).toBe(429);
});

test("IP上限を別ブラウザで回避できず、固定窓の10分・24時間境界で更新する", async () => {
  const now = Math.floor(Date.now() / 86400000) * 86400000 + 60000;
  const clock = vi.spyOn(Date, "now").mockReturnValue(now);
  let cookie = `tetraboard-2026.feedback=${crypto.randomUUID()}`;
  for (let block = 0; block < 4; block++) {
    clock.mockReturnValue(now + block * 600000);
    for (let i = 0; i < 5; i++) expect((await post(input(), cookie)).status).toBe(201);
  }
  clock.mockReturnValue(now + 4 * 600000);
  expect((await post(input(), cookie)).status).toBe(429);
  clock.mockReturnValue(now + 86400000);
  expect((await post(input(), cookie)).status).toBe(201);
  await env.APP_DB.prepare("DELETE FROM feedback_limits").run();
  for (let i = 0; i < 30; i++) {
    cookie = `tetraboard-2026.feedback=${crypto.randomUUID()}`;
    expect((await post(input(), cookie)).status).toBe(201);
  }
  expect((await post(input(), `tetraboard-2026.feedback=${crypto.randomUUID()}`)).status).toBe(429);
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
