import { Hono, type MiddlewareHandler } from "hono";
import {
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
import { editFeedback } from "@tetraboard/context-community";
import type { StoredProfile } from "../accounts/auth";
import { adminIdentity } from "../admin/auth";
import {
  createFeedbackTopic,
  feedbackEditStore,
  feedbackHistory,
  feedbackTopics,
  hideFeedback,
  listFeedback,
  updateFeedbackTopic,
  feedbackSummary,
} from "../adapters/community/feedbackAdmin";
import { feedbackRow, toFeedback } from "../adapters/community/feedbackRecord";
import { validFeedbackId } from "./feedbackInput";
import type { FeedbackEnv } from "./feedbackRoutes";
import { readLimitedBody } from "./readLimitedBody";

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
      if (!Number.isSafeInteger(cursor.at) || cursor.at < 0 || !validFeedbackId(cursor.id ?? ""))
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
  return c.json(feedbackTopicsSchema.parse({ topics: await feedbackTopics(c.env.APP_DB) }));
});
feedbackAdminRoutes.post("/admin/feedback/topics", async (c) => {
  const data = feedbackTopicInputSchema.safeParse(await readJson(c.req.raw));
  if (!data.success) return c.json({ message: "テーマ名は1〜80文字で入力してください。" }, 400);
  const id = await createFeedbackTopic(c.env.APP_DB, data.data.name);
  if (!id) return c.json({ message: "同じ名前のテーマがあります。" }, 409);
  return c.json({ id, name: data.data.name, version: 1 }, 201);
});
feedbackAdminRoutes.patch("/admin/feedback/topics/:id", async (c) => {
  const data = feedbackTopicPatchSchema.safeParse(await readJson(c.req.raw));
  if (!validFeedbackId(c.req.param("id")) || !data.success)
    return c.json({ message: "テーマの指定が正しくありません。" }, 400);
  const updated = await updateFeedbackTopic(
    c.env.APP_DB,
    c.req.param("id"),
    data.data.name,
    data.data.version,
  );
  if (!updated)
    return c.json(
      { message: "テーマが更新されたか、同じ名前が存在します。再取得してください。" },
      409,
    );
  return c.json({ id: c.req.param("id"), name: data.data.name, version: data.data.version + 1 });
});
feedbackAdminRoutes.get("/admin/feedback/:id", async (c) => {
  const id = c.req.param("id");
  if (!validFeedbackId(id)) return c.json({ message: "投稿IDが正しくありません。" }, 400);
  const row = await feedbackRow(c.env.APP_DB, id);
  if (!row)
    return c.json({ message: "投稿が見つかりません。削除済みまたは保存期限切れです。" }, 404);
  const history = await feedbackHistory(c.env.APP_DB, id);
  return c.json(
    feedbackDetailSchema.parse({
      feedback: toFeedback(row),
      history,
    }),
  );
});
feedbackAdminRoutes.get("/admin/feedback/:id/attachment", async (c) => {
  const row = validFeedbackId(c.req.param("id"))
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
  const id = c.req.param("id");
  if (!validFeedbackId(id) || !data.success)
    return c.json(
      { message: "入力を確認してください。完了には公開確認、見送りには理由が必要です。" },
      400,
    );
  const result = await editFeedback(feedbackEditStore(c.env.APP_DB), id, data.data, c.get("admin"));
  if (result.status === "not_found") return c.notFound();
  if (result.status === "topic_not_found")
    return c.json({ message: "テーマが見つかりません。" }, 400);
  if (result.status === "conflict")
    return c.json({ message: "別の操作で更新されました。入力を確認し、再取得してください。" }, 409);
  return c.json(result.feedback);
});
feedbackAdminRoutes.delete("/admin/feedback/:id", async (c) => {
  const data = feedbackDeleteSchema.safeParse(await readJson(c.req.raw));
  if (!validFeedbackId(c.req.param("id")) || !data.success)
    return c.json({ message: "削除の指定が正しくありません。" }, 400);
  const row = await feedbackRow(c.env.APP_DB, c.req.param("id"));
  if (!row) return c.notFound();
  const deleted = await hideFeedback(c.env.APP_DB, row.id, data.data.version);
  if (!deleted) return c.json({ message: "別の操作で更新されました。再取得してください。" }, 409);
  return c.body(null, 204);
});
