import { isDeleted } from "../privacy/identity";
import { Hono, type MiddlewareHandler } from "hono";
import {
  feedbackInputSchema,
  feedbackReceiptSchema,
  feedbackQuerySchema,
  feedbackPatchSchema,
  feedbackDeleteSchema,
  feedbackTopicInputSchema,
  feedbackTopicPatchSchema,
  feedbackTopicsSchema,
  feedbackDetailSchema,
  feedbackListSchema,
  feedbackSummarySchema,
} from "@tetraboard/protocol";
import { accountIdentity, type StoredProfile } from "../accounts/auth";
import { adminIdentity, adminAccountIds, type AdminEnv } from "../admin/auth";
import { readLimitedBody, validFeedbackImage } from "./images";
import {
  reserveFeedback,
  submissionRow,
  feedbackRow,
  toFeedback,
  listFeedback,
  patchFeedback,
  feedbackSummary,
} from "./store";

export type FeedbackEnv = AdminEnv & { FEEDBACK_HASH_SECRET?: string };
const cookieName = "tetraboard-2026.feedback";
const validId = (id: string) =>
  /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/.test(id);
async function sha(bytes: Uint8Array) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
async function hash(secret: string, value: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return [...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
export const feedbackRoutes = new Hono<{ Bindings: FeedbackEnv }>();
feedbackRoutes.use("/feedback", async (c, next) => {
  c.header("Cache-Control", "no-store");
  await next();
});
feedbackRoutes.onError((_err, c) =>
  c.json(
    { message: "送信できませんでした。入力を残しています。時間をおいて再試行してください。" },
    503,
  ),
);
feedbackRoutes.post("/feedback", async (c) => {
  if (c.req.header("Origin") !== c.env.APP_ORIGIN)
    return c.json({ message: "操作元を確認できません。" }, 403);
  const secret =
    c.env.FEEDBACK_HASH_SECRET ??
    (new URL(c.env.APP_ORIGIN).protocol === "http:"
      ? "feedback-local-only-secret-at-least-32-characters"
      : "");
  if (secret.length < 32)
    return c.json({ message: "受付の設定がありません。時間をおいて再試行してください。" }, 503);
  const bytes = await readLimitedBody(c.req.raw, 1024 * 1024 + 64 * 1024);
  if (!bytes) return c.json({ message: "添付画像は変換後1MB以下にしてください。" }, 413);
  let data: FormData;
  try {
    data = await new Request(c.req.url, {
      method: "POST",
      headers: c.req.raw.headers,
      body: bytes,
    }).formData();
  } catch {
    return c.json({ message: "送信形式が正しくありません。" }, 400);
  }
  if (
    [...data.keys()].some((key) => !["input", "attachment"].includes(key)) ||
    data.getAll("input").length !== 1 ||
    data.getAll("attachment").length > 1
  )
    return c.json({ message: "送信形式が正しくありません。" }, 400);
  let raw: unknown;
  try {
    raw = JSON.parse(String(data.get("input")));
  } catch {
    return c.json({ message: "入力内容を確認してください。" }, 400);
  }
  const input = feedbackInputSchema.safeParse(raw);
  if (!input.success) return c.json({ message: "種別・内容・文字数を確認してください。" }, 400);
  const file = data.get("attachment");
  let image: Uint8Array | null = null;
  if (file !== null) {
    if (!(file instanceof File) || file.type !== "image/webp")
      return c.json({ message: "添付画像の形式が正しくありません。" }, 415);
    image = new Uint8Array(await file.arrayBuffer());
    if (!validFeedbackImage(image))
      return c.json({ message: "添付画像の形式・容量・寸法を確認してください。" }, 400);
  }
  // 認証障害をゲストとして処理せず、onErrorで503を返します。
  const user = await accountIdentity(c.req.raw, c.env);
  if (
    !user &&
    (input.data.accountRequired ||
      /(?:^|;\s*)(?:__Secure-)?tetraboard-2026\.session_token=/.test(c.req.header("Cookie") ?? ""))
  )
    return c.json(
      { message: "ログイン状態を確認できません。再ログイン後に送信してください。" },
      401,
    );
  const suppliedCookie = c.req
    .header("Cookie")
    ?.split(";")
    .map((v) => v.trim())
    .find((v) => v.startsWith(`${cookieName}=`))
    ?.slice(cookieName.length + 1);
  const browser = suppliedCookie && validId(suppliedCookie) ? suppliedCookie : crypto.randomUUID();
  c.header(
    "Set-Cookie",
    `${cookieName}=${browser}; Path=/; HttpOnly; SameSite=Lax; Max-Age=15552000${new URL(c.env.APP_ORIGIN).protocol === "https:" ? "; Secure" : ""}`,
  );
  const browserHash = await hash(secret, `browser:${browser}`);
  const reporterHash = user ? await hash(secret, `account:${user.id}`) : browserHash;
  const ipHash = await hash(secret, `ip:${c.req.header("CF-Connecting-IP") ?? "local"}`);
  const payloadHash = await sha(
    new TextEncoder().encode(JSON.stringify(input.data) + (image ? await sha(image) : "")),
  );
  let row = await submissionRow(c.env.APP_DB, input.data.submissionId);
  if (!row)
    row = await reserveFeedback(
      c.env.APP_DB,
      input.data,
      {
        reporterHash,
        browserHash,
        ipHash,
        author: user ? "account" : "guest",
        accountId: user?.id ?? null,
        internal: Boolean(user && (user.isTestUser || adminAccountIds(c.env)?.includes(user.id))),
      },
      payloadHash,
      image !== null,
    );
  if (!row) {
    c.header("Retry-After", "600");
    return c.json({ message: "送信が多いため、時間をおいて再試行してください。" }, 429);
  }
  if (row.deleted || row.expires_at_ms <= Date.now() || row.payload_hash !== payloadHash)
    return c.json(
      { message: "同じ送信IDでは内容を変更できません。新しい投稿として送信してください。" },
      409,
    );
  if (!row.ready) {
    if (row.attachment_key && image)
      await c.env.OBJECT_STORAGE.put(row.attachment_key, image, {
        httpMetadata: { contentType: "image/webp" },
      });
    if (user && (await isDeleted(c.env.APP_DB, user.id))) {
      if (row.attachment_key)
        await c.env.APP_DB.batch([
          c.env.APP_DB.prepare("INSERT OR IGNORE INTO deletion_images VALUES (?,?)").bind(
            user.id,
            row.attachment_key,
          ),
          c.env.APP_DB.prepare("UPDATE deleted_accounts SET completed_at_ms=NULL WHERE id=?").bind(
            user.id,
          ),
        ]);
      if (row.attachment_key) await c.env.OBJECT_STORAGE.delete(row.attachment_key);
      await c.env.APP_DB.prepare("DELETE FROM feedback_uploads WHERE key=?")
        .bind(row.attachment_key ?? "")
        .run();
      return c.body(null, 401);
    }
    await c.env.APP_DB.prepare(
      "UPDATE feedback SET ready = 1 WHERE id = ? AND deleted = 0 AND expires_at_ms > ?",
    )
      .bind(row.id, Date.now())
      .run();
    if (!(await feedbackRow(c.env.APP_DB, row.id))) throw new Error("incomplete");
  }
  return c.json(feedbackReceiptSchema.parse({ id: row.id }), 201);
});

export const feedbackAdminRoutes = new Hono<{
  Bindings: FeedbackEnv;
  Variables: { admin: StoredProfile };
}>();
const middleware: MiddlewareHandler<{
  Bindings: FeedbackEnv;
  Variables: { admin: StoredProfile };
}> = async (c, next) => {
  c.header("Cache-Control", "no-store");
  if (!["GET", "HEAD"].includes(c.req.method) && c.req.header("Origin") !== c.env.APP_ORIGIN)
    return c.json({ message: "操作元を確認できません。" }, 403);
  const identity = await adminIdentity(c.req.raw, c.env);
  if (identity.status !== 200) return c.json({ message: identity.message }, identity.status);
  c.set("admin", identity.user);
  await next();
};
feedbackAdminRoutes.use("/admin/feedback", middleware);
feedbackAdminRoutes.use("/admin/feedback/*", middleware);
feedbackAdminRoutes.onError((_err, c) =>
  c.json({ message: "処理できませんでした。時間をおいて再試行してください。" }, 503),
);
async function readJson(request: Request) {
  const bytes = await readLimitedBody(request, 32768);
  if (!bytes) return null;
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}
feedbackAdminRoutes.get("/admin/feedback", async (c) => {
  const query = feedbackQuerySchema.safeParse(c.req.query());
  if (!query.success) return c.json({ message: "検索条件が正しくありません。" }, 400);
  if (query.data.cursor) {
    try {
      const cursor = JSON.parse(atob(query.data.cursor));
      if (!Number.isSafeInteger(cursor.at) || cursor.at < 0 || !validId(cursor.id ?? ""))
        throw new Error();
    } catch {
      return c.json({ message: "続きの指定が正しくありません。" }, 400);
    }
  }
  return c.json(feedbackListSchema.parse(await listFeedback(c.env.APP_DB, query.data)));
});
feedbackAdminRoutes.get("/admin/feedback/summary", async (c) => {
  const include = c.req.query("includeInternal") ?? "false";
  if (!["true", "false"].includes(include))
    return c.json({ message: "集計条件が正しくありません。" }, 400);
  return c.json(
    feedbackSummarySchema.parse(await feedbackSummary(c.env.APP_DB, include === "true")),
  );
});
feedbackAdminRoutes.get("/admin/feedback/topics", async (c) => {
  const rows = await c.env.APP_DB.prepare(
    "SELECT id, name, version FROM feedback_topics ORDER BY name, id",
  ).all();
  return c.json(feedbackTopicsSchema.parse({ topics: rows.results }));
});
feedbackAdminRoutes.post("/admin/feedback/topics", async (c) => {
  const data = feedbackTopicInputSchema.safeParse(await readJson(c.req.raw));
  if (!data.success) return c.json({ message: "テーマ名は1〜80文字で入力してください。" }, 400);
  const id = crypto.randomUUID();
  const result = await c.env.APP_DB.prepare(
    "INSERT OR IGNORE INTO feedback_topics (id, name) VALUES (?, ?)",
  )
    .bind(id, data.data.name)
    .run();
  if (!result.meta.changes) return c.json({ message: "同じ名前のテーマがあります。" }, 409);
  return c.json({ id, name: data.data.name, version: 1 }, 201);
});
feedbackAdminRoutes.patch("/admin/feedback/topics/:id", async (c) => {
  const data = feedbackTopicPatchSchema.safeParse(await readJson(c.req.raw));
  if (!validId(c.req.param("id")) || !data.success)
    return c.json({ message: "テーマの指定が正しくありません。" }, 400);
  const result = await c.env.APP_DB.prepare(
    "UPDATE OR IGNORE feedback_topics SET name = ?, version = version + 1 WHERE id = ? AND version = ?",
  )
    .bind(data.data.name, c.req.param("id"), data.data.version)
    .run();
  if (!result.meta.changes)
    return c.json(
      { message: "テーマが更新されたか、同じ名前が存在します。再取得してください。" },
      409,
    );
  return c.json({ id: c.req.param("id"), name: data.data.name, version: data.data.version + 1 });
});
feedbackAdminRoutes.get("/admin/feedback/:id", async (c) => {
  const id = c.req.param("id");
  if (!validId(id)) return c.json({ message: "投稿IDが正しくありません。" }, 400);
  const row = await feedbackRow(c.env.APP_DB, id);
  if (!row)
    return c.json({ message: "投稿が見つかりません。削除済みまたは保存期限切れです。" }, 404);
  const history = await c.env.APP_DB.prepare(
    "SELECT at_ms, admin_name, changes FROM feedback_history WHERE feedback_id = ? ORDER BY at_ms, id",
  )
    .bind(id)
    .all<{ at_ms: number; admin_name: string; changes: string }>();
  return c.json(
    feedbackDetailSchema.parse({
      feedback: toFeedback(row),
      history: history.results.map((v) => ({
        atMs: v.at_ms,
        admin: v.admin_name,
        changes: JSON.parse(v.changes),
      })),
    }),
  );
});
feedbackAdminRoutes.get("/admin/feedback/:id/attachment", async (c) => {
  const row = validId(c.req.param("id"))
    ? await feedbackRow(c.env.APP_DB, c.req.param("id"))
    : null;
  if (!row?.attachment_key) return c.notFound();
  const file = await c.env.OBJECT_STORAGE.get(row.attachment_key);
  if (!file) return c.notFound();
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Content-Security-Policy", "default-src 'none'");
  return c.body(file.body, 200, { "Content-Type": "image/webp", "Cache-Control": "no-store" });
});
feedbackAdminRoutes.patch("/admin/feedback/:id", async (c) => {
  const data = feedbackPatchSchema.safeParse(await readJson(c.req.raw));
  if (!validId(c.req.param("id")) || !data.success)
    return c.json(
      { message: "入力を確認してください。完了には公開確認、見送りには理由が必要です。" },
      400,
    );
  const row = await feedbackRow(c.env.APP_DB, c.req.param("id"));
  if (!row) return c.notFound();
  if (
    data.data.topicId &&
    !(await c.env.APP_DB.prepare("SELECT id FROM feedback_topics WHERE id = ?")
      .bind(data.data.topicId)
      .first())
  )
    return c.json({ message: "テーマが見つかりません。" }, 400);
  if (!(await patchFeedback(c.env.APP_DB, row, data.data, c.get("admin"))))
    return c.json({ message: "別の操作で更新されました。入力を確認し、再取得してください。" }, 409);
  const next = await feedbackRow(c.env.APP_DB, row.id);
  if (!next) return c.notFound();
  return c.json(toFeedback(next));
});
feedbackAdminRoutes.delete("/admin/feedback/:id", async (c) => {
  const data = feedbackDeleteSchema.safeParse(await readJson(c.req.raw));
  if (!validId(c.req.param("id")) || !data.success)
    return c.json({ message: "削除の指定が正しくありません。" }, 400);
  const row = await feedbackRow(c.env.APP_DB, c.req.param("id"));
  if (!row) return c.notFound();
  const result = await c.env.APP_DB.prepare(
    "UPDATE feedback SET deleted = 1, version = version + 1 WHERE id = ? AND version = ? AND deleted = 0",
  )
    .bind(row.id, data.data.version)
    .run();
  if (!result.meta.changes)
    return c.json({ message: "別の操作で更新されました。再取得してください。" }, 409);
  return c.body(null, 204);
});
