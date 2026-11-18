import { Hono, type Context } from "hono";
import { feedbackReceiptSchema } from "@tetraboard/protocol";
import { feedbackRetryAfterSeconds, submitFeedback } from "@tetraboard/context-community";
import { accountIdentity } from "../accounts/auth";
import { adminAccountIds, type AdminEnv } from "../admin/auth";
import { feedbackSubmissionWithPrivacy } from "../flows/feedbackSubmission";
import { readFeedbackForm, validFeedbackId } from "./feedbackInput";

export type FeedbackEnv = AdminEnv & { FEEDBACK_HASH_SECRET?: string };

const cookieName = "tetraboard-2026.feedback";

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
  const form = await readFeedbackForm(c.req.raw, c.req.url);
  if (form.status !== 200) return c.json({ message: form.message }, form.status);
  const { input, image } = form;
  // 認証障害をゲストとして処理せず、onErrorで503を返します。
  const user = await accountIdentity(c.req.raw, c.env);
  if (
    !user &&
    (input.accountRequired ||
      /(?:^|;\s*)(?:__Secure-)?tetraboard-2026\.session_token=/.test(c.req.header("Cookie") ?? ""))
  )
    return c.json(
      { message: "ログイン状態を確認できません。再ログイン後に送信してください。" },
      401,
    );
  const browser = setFeedbackCookie(c);
  const browserHash = await hash(secret, `browser:${browser}`);
  const reporterHash = user ? await hash(secret, `account:${user.id}`) : browserHash;
  const ipHash = await hash(secret, `ip:${c.req.header("CF-Connecting-IP") ?? "local"}`);
  const payloadHash = await sha(
    new TextEncoder().encode(JSON.stringify(input) + (image ? await sha(image) : "")),
  );
  const result = await submitFeedback(
    feedbackSubmissionWithPrivacy(c.env.APP_DB, c.env.OBJECT_STORAGE),
    {
      input,
      identity: {
        reporterHash,
        browserHash,
        ipHash,
        author: user && !user.isAnonymous ? "account" : "guest",
        accountId: user?.id ?? null,
        internal: Boolean(user && (user.isTestUser || adminAccountIds(c.env)?.includes(user.id))),
      },
      payloadHash,
      image,
    },
    Date.now,
  );
  if (result.status === "rate_limited") {
    c.header("Retry-After", String(feedbackRetryAfterSeconds));
    return c.json({ message: "送信が多いため、時間をおいて再試行してください。" }, 429);
  }
  if (result.status === "conflict")
    return c.json(
      { message: "同じ送信IDでは内容を変更できません。新しい投稿として送信してください。" },
      409,
    );
  if (result.status === "author_deleted") return c.body(null, 401);
  return c.json(feedbackReceiptSchema.parse({ id: result.id }), 201);
});

function setFeedbackCookie(c: Context<{ Bindings: FeedbackEnv }>) {
  const suppliedCookie = c.req
    .header("Cookie")
    ?.split(";")
    .map((v) => v.trim())
    .find((v) => v.startsWith(`${cookieName}=`))
    ?.slice(cookieName.length + 1);
  const browser =
    suppliedCookie && validFeedbackId(suppliedCookie) ? suppliedCookie : crypto.randomUUID();
  c.header(
    "Set-Cookie",
    `${cookieName}=${browser}; Path=/; HttpOnly; SameSite=Lax; Max-Age=15552000${new URL(c.env.APP_ORIGIN).protocol === "https:" ? "; Secure" : ""}`,
  );
  return browser;
}
