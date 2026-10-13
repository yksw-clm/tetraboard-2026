import { Hono } from "hono";
import { z } from "zod";
import {
  lobbyChatSchema,
  lobbyPostSchema,
  lobbyPostResultSchema,
  lobbyReportSchema,
  lobbyModerationSchema,
  lobbyAdminSchema,
} from "@tetraboard/protocol/general-lobby";
import { accountIdentity, type StoredProfile } from "../accounts/auth";
import { adminIdentity } from "../admin/auth";
import { readLimitedBody } from "../feedback/images";
import { digest } from "../privacy/deletion";
import { chatPage, messageById, lobbyRetentionMs } from "./chatStore";
export const lobbyChatRoutes = new Hono<{
  Bindings: Env;
  Variables: { user: StoredProfile | null };
}>();
lobbyChatRoutes.use("/lobby/chat*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  if (c.req.method !== "GET" && c.req.header("Origin") !== c.env.APP_ORIGIN)
    return c.json({ message: "操作元を確認できません。" }, 403);
  c.set("user", await accountIdentity(c.req.raw, c.env));
  await next();
});
lobbyChatRoutes.use("/admin/lobby-chat*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  if (c.req.method !== "GET" && c.req.header("Origin") !== c.env.APP_ORIGIN)
    return c.json({ message: "操作元を確認できません。" }, 403);
  const identity = await adminIdentity(c.req.raw, c.env);
  if (identity.status !== 200) return c.json({ message: identity.message }, identity.status);
  await next();
});
lobbyChatRoutes.onError((_error, c) =>
  c.json({ message: "チャットを処理できませんでした。もう一度お試しください。" }, 503),
);
async function body(request: Request) {
  const bytes = await readLimitedBody(request, 4096);
  if (!bytes) return null;
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}
const pageQuery = z.object({
  before: z
    .string()
    .regex(/^\d{1,16}:[0-9a-f-]{36}$/)
    .refine(
      (v) =>
        Number.isSafeInteger(Number(v.split(":")[0])) &&
        z.uuid().safeParse(v.split(":")[1]).success,
    )
    .optional(),
  limit: z.coerce.number().int().min(50).max(500).default(50),
});
lobbyChatRoutes.get("/lobby/chat", async (c) => {
  const query = pageQuery.safeParse(c.req.query());
  if (!query.success) return c.json({ message: "取得条件が正しくありません。" }, 400);
  return c.json(
    lobbyChatSchema.parse(
      await chatPage(c.env.APP_DB, c.get("user")?.id, query.data.before, query.data.limit),
    ),
  );
});
lobbyChatRoutes.post("/lobby/chat", async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ message: "ログインしてください。" }, 401);
  if (!user.profileCompleted)
    return c.json({ message: "プロフィールの初回設定を完了してください。" }, 403);
  const input = lobbyPostSchema.safeParse(await body(c.req.raw));
  if (!input.success)
    return c.json({ message: "本文は100文字以内で入力してください。URLは投稿できません。" }, 400);
  const now = Date.now(),
    db = c.env.APP_DB,
    hash = await digest(input.data.text);
  await db
    .prepare(
      "INSERT OR IGNORE INTO lobby_chat_senders(account_id,public_id) SELECT id,? FROM user WHERE id=? AND NOT EXISTS(SELECT 1 FROM deleted_accounts d WHERE d.id=user.id)",
    )
    .bind(crypto.randomUUID(), user.id)
    .run();
  // 一つのSQLとトリガーで確定し、並行送信と再送にも同じ制限を適用します。
  await db
    .prepare(`INSERT OR IGNORE INTO lobby_chat_messages(id,account_id,body,sent_at_ms,request_id,body_hash)
 SELECT ?,u.id,?,?,?,? FROM user u JOIN lobby_chat_senders s ON s.account_id=u.id
 WHERE u.id=? AND u.profileCompleted=1 AND s.stopped=0 AND s.last_sent_at_ms<=?
 AND (SELECT accepting FROM lobby_chat_settings WHERE id=1)=1
 AND NOT EXISTS(SELECT 1 FROM deleted_accounts d WHERE d.id=u.id)
 AND NOT EXISTS(SELECT 1 FROM lobby_chat_requests r WHERE r.account_id=u.id AND r.request_id=?)`)
    .bind(
      crypto.randomUUID(),
      input.data.text,
      now,
      input.data.requestId,
      hash,
      user.id,
      now - 10000,
      input.data.requestId,
    )
    .run();
  const accepted = await db
    .prepare(
      "SELECT message_id,body_hash,sent_at_ms FROM lobby_chat_requests WHERE account_id=? AND request_id=? AND sent_at_ms>? AND NOT EXISTS(SELECT 1 FROM deleted_accounts WHERE id=?)",
    )
    .bind(user.id, input.data.requestId, now - lobbyRetentionMs, user.id)
    .first<{ message_id: string; body_hash: string; sent_at_ms: number }>();
  if (accepted) {
    if (accepted.body_hash !== hash)
      return c.json(
        { message: "再送する本文が変更されています。新しい投稿として送信してください。" },
        409,
      );
    return c.json(
      lobbyPostResultSchema.parse({
        message: await messageById(db, accepted.message_id, user.id),
        availableAtMs: accepted.sent_at_ms + 10000,
      }),
      200,
    );
  }
  const page = await chatPage(db, user.id);
  if (!page.acceptingPosts || page.postingStopped)
    return c.json({ message: "現在、公開チャットへの投稿は停止されています。" }, 403);
  return c.json(
    {
      message: "10秒に1件まで投稿できます。少し待ってから再試行してください。",
      availableAtMs: page.availableAtMs,
    },
    429,
  );
});
lobbyChatRoutes.post("/lobby/chat/reports", async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ message: "ログインしてください。" }, 401);
  const input = lobbyReportSchema.safeParse(await body(c.req.raw));
  if (!input.success) return c.json({ message: "通報する発言が正しくありません。" }, 400);
  const db = c.env.APP_DB,
    now = Date.now();
  const result = await db
    .prepare(`INSERT OR IGNORE INTO lobby_chat_reports(id,message_id,sender_account_id,sender_public_id,sender_name,body,sent_at_ms,reporter_account_id,reported_at_ms)
 SELECT ?,m.id,m.account_id,s.public_id,u.name,m.body,m.sent_at_ms,?,?
 FROM lobby_chat_messages m JOIN user u ON u.id=m.account_id JOIN lobby_chat_senders s ON s.account_id=u.id
 WHERE m.id=? AND m.sent_at_ms>? AND NOT EXISTS(SELECT 1 FROM deleted_accounts WHERE id IN(m.account_id,?))
 AND (SELECT COUNT(*) FROM lobby_chat_reports WHERE reporter_account_id=? AND reported_at_ms>?)<5`)
    .bind(
      crypto.randomUUID(),
      user.id,
      now,
      input.data.messageId,
      now - lobbyRetentionMs,
      user.id,
      user.id,
      now - 3600000,
    )
    .run();
  if (result.meta.changes) return c.json({ message: "通報を受け付けました。" }, 201);
  const existing = await db
    .prepare(
      "SELECT id FROM lobby_chat_reports WHERE message_id=? AND reporter_account_id=? AND reported_at_ms>?",
    )
    .bind(input.data.messageId, user.id, now - lobbyRetentionMs)
    .first();
  return existing
    ? c.json({ message: "通報を受け付けています。" }, 200)
    : c.json({ message: "発言が見つからないか、通報回数の上限に達しています。" }, 429);
});
lobbyChatRoutes.get("/admin/lobby-chat", async (c) => {
  const db = c.env.APP_DB;
  const settings = await db
    .prepare("SELECT accepting FROM lobby_chat_settings WHERE id=1")
    .first<{ accepting: number }>();
  const reports = await db
    .prepare(`SELECT id,message_id AS messageId,
 CASE WHEN sender_account_id IN(SELECT id FROM deleted_accounts) THEN NULL ELSE sender_public_id END AS senderId,
 CASE WHEN sender_account_id IN(SELECT id FROM deleted_accounts) THEN '退会したプレイヤー' ELSE sender_name END AS senderName,
 body AS text,sent_at_ms AS sentAtMs,reported_at_ms AS reportedAtMs,status FROM lobby_chat_reports WHERE reported_at_ms>? ORDER BY reported_at_ms DESC,id DESC LIMIT 500`)
    .bind(Date.now() - lobbyRetentionMs)
    .all();
  const stopped = await db
    .prepare(
      "SELECT s.public_id AS senderId,u.name AS senderName FROM lobby_chat_senders s JOIN user u ON u.id=s.account_id WHERE s.stopped=1 AND NOT EXISTS(SELECT 1 FROM deleted_accounts d WHERE d.id=u.id)",
    )
    .all();
  return c.json(
    lobbyAdminSchema.parse({
      acceptingPosts: Boolean(settings?.accepting),
      reports: reports.results,
      stoppedSenders: stopped.results,
    }),
  );
});
lobbyChatRoutes.post("/admin/lobby-chat", async (c) => {
  const input = lobbyModerationSchema.safeParse(await body(c.req.raw));
  if (!input.success) return c.json({ message: "操作内容が正しくありません。" }, 400);
  const value = input.data,
    db = c.env.APP_DB;
  if (value.action === "accepting")
    await db
      .prepare("UPDATE lobby_chat_settings SET accepting=? WHERE id=1")
      .bind(Number(value.accepting))
      .run();
  else if (value.action === "stop")
    await db
      .prepare("UPDATE lobby_chat_senders SET stopped=? WHERE public_id=?")
      .bind(Number(value.stopped), value.senderId)
      .run();
  else if (value.action === "delete")
    await db.prepare("DELETE FROM lobby_chat_messages WHERE id=?").bind(value.messageId).run();
  else
    await db
      .prepare("UPDATE lobby_chat_reports SET status='resolved' WHERE id=? AND reported_at_ms>?")
      .bind(value.reportId, Date.now() - lobbyRetentionMs)
      .run();
  return c.json({ message: "変更しました。" });
});
