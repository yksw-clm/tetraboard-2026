import { privacyInput } from "./input";
import { Hono } from "hono";
import { accountIdentity, createAuth, type AuthEnv } from "../accounts/auth";
import {
  challengeCookie,
  flowCookie,
  cookieValue,
  digest,
  processDeletions,
  requestDeletion,
} from "./deletion";
export const deletionRoutes = new Hono<{ Bindings: AuthEnv }>();
deletionRoutes.use("/account/deletion/*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  await next();
});
deletionRoutes.onError((_error, c) =>
  c.json({ message: "削除処理を確認できません。時間をおいて再試行してください。" }, 503),
);
deletionRoutes.post("/account/deletion/reauth", async (c) => {
  if (c.req.header("Origin") !== c.env.APP_ORIGIN) return c.body(null, 403);
  const user = await accountIdentity(c.req.raw, c.env);
  if (!user) return c.body(null, 401);
  const suppliedFlow = cookieValue(c.req.raw, flowCookie);
  const flow = suppliedFlow
    ? await c.env.APP_DB.prepare(
        "SELECT account_id FROM deletion_flows WHERE id=? AND expires_at_ms>?",
      )
        .bind(suppliedFlow, Date.now())
        .first<{ account_id: string }>()
    : null;
  if (suppliedFlow && flow?.account_id !== user.id)
    return c.json(
      {
        message:
          "削除するアカウントと異なるか、手続きの期限が切れています。元のアカウントでログインするか、手続きをやめてから始め直してください。",
      },
      409,
    );
  const flowId = suppliedFlow ?? crypto.randomUUID();
  const count = await c.env.APP_DB.prepare(
    "SELECT COUNT(*) AS count FROM deletion_challenges WHERE account_id=? AND created_at_ms>?",
  )
    .bind(user.id, Date.now() - 60000)
    .first<{ count: number }>();
  if ((count?.count ?? 0) >= 5) return c.json({ message: "1分ほど待ってください。" }, 429);
  const account = await c.env.APP_DB.prepare(
    "SELECT providerId FROM account WHERE userId=? AND providerId IN ('google','discord')",
  )
    .bind(user.id)
    .first<{ providerId: "google" | "discord" }>();
  if (!account) return c.json({ message: "登録に使用した認証方法を確認できません。" }, 409);
  const id = crypto.randomUUID();
  const now = Date.now();
  const inserted = await c.env.APP_DB.prepare(
    "INSERT INTO deletion_challenges(id,account_id,provider,created_at_ms,expires_at_ms) VALUES (?,?,?,?,?)",
  )
    .bind(id, user.id, account.providerId, now, now + 600000)
    .run();
  if (inserted.meta.changes !== 1) return c.json({ message: "1分ほど待ってください。" }, 429);
  if (!suppliedFlow)
    await c.env.APP_DB.prepare("INSERT INTO deletion_flows VALUES (?,?,?)")
      .bind(flowId, user.id, Date.now() + 86400000)
      .run();
  const authHeaders = new Headers(c.req.raw.headers);
  authHeaders.set("Content-Type", "application/json");
  const response = await createAuth(c.env).handler(
    new Request(`${c.env.APP_ORIGIN}/api/auth/sign-in/social`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        provider: account.providerId,
        callbackURL: "/account/deletion",
        newUserCallbackURL: "/account/deletion",
        errorCallbackURL: "/account/deletion",
        additionalParams:
          account.providerId === "google"
            ? { prompt: "select_account", max_age: "0" }
            : { prompt: "consent" },
      }),
    }),
  );
  const data = (await response.clone().json()) as { url?: string };
  if (!response.ok || !data.url) return response;
  const state = new URL(data.url).searchParams.get("state");
  if (!state) throw new Error("OAuth state missing");
  await c.env.APP_DB.prepare("UPDATE deletion_challenges SET oauth_state=? WHERE id=?")
    .bind(state, id)
    .run();
  const headers = new Headers(response.headers);
  headers.append(
    "Set-Cookie",
    `${flowCookie}=${flowId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400${new URL(c.env.APP_ORIGIN).protocol === "https:" ? "; Secure" : ""}`,
  );
  headers.append(
    "Set-Cookie",
    `${challengeCookie}=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600${new URL(c.env.APP_ORIGIN).protocol === "https:" ? "; Secure" : ""}`,
  );
  return new Response(response.body, { status: response.status, headers });
});
deletionRoutes.get("/account/deletion/confirmation", async (c) => {
  const user = await accountIdentity(c.req.raw, c.env);
  if (!user) return c.body(null, 401);
  const flow = await c.env.APP_DB.prepare(
    "SELECT account_id FROM deletion_flows WHERE id=? AND expires_at_ms>?",
  )
    .bind(cookieValue(c.req.raw, flowCookie) ?? "", Date.now())
    .first<{ account_id: string }>();
  if (flow && flow.account_id !== user.id)
    return c.json({ verified: false, seated: false, changedAccount: true });
  const session = await createAuth(c.env).api.getSession({ headers: c.req.raw.headers });
  const row = await c.env.APP_DB.prepare(
    "SELECT id FROM deletion_challenges WHERE id=? AND account_id=? AND verified_session_id=? AND verified_at_ms IS NOT NULL AND expires_at_ms>?",
  )
    .bind(
      cookieValue(c.req.raw, challengeCookie) ?? "",
      user.id,
      session?.session.id ?? "",
      Date.now(),
    )
    .first();
  const seated = Boolean(
    await c.env.APP_DB.prepare("SELECT 1 FROM account_room_seats WHERE account_id=?")
      .bind(user.id)
      .first(),
  );
  return c.json({ verified: Boolean(row), seated });
});
deletionRoutes.post("/account/deletion/confirm", async (c) => {
  if (c.req.header("Origin") !== c.env.APP_ORIGIN) return c.body(null, 403);
  const user = await accountIdentity(c.req.raw, c.env);
  if (!user) return c.body(null, 401);
  const flow = await c.env.APP_DB.prepare(
    "SELECT account_id FROM deletion_flows WHERE id=? AND expires_at_ms>?",
  )
    .bind(cookieValue(c.req.raw, flowCookie) ?? "", Date.now())
    .first<{ account_id: string }>();
  if (!flow || flow.account_id !== user.id)
    return c.json({ message: "削除する本人として手続きを始め直してください。" }, 403);
  const input = await privacyInput(c.req.raw);
  if (input?.confirm !== true) return c.body(null, 400);
  const session = await createAuth(c.env).api.getSession({ headers: c.req.raw.headers });
  const result = await c.env.APP_DB.prepare(
    "UPDATE deletion_challenges SET verified_at_ms=NULL,verified_session_id=NULL,oauth_state=NULL WHERE id=? AND account_id=? AND verified_session_id=? AND verified_at_ms IS NOT NULL AND expires_at_ms>? RETURNING id",
  )
    .bind(
      cookieValue(c.req.raw, challengeCookie) ?? "",
      user.id,
      session?.session.id ?? "",
      Date.now(),
    )
    .first();
  if (!result) return c.json({ message: "再認証してください。" }, 403);
  const receipt = crypto.randomUUID() + crypto.randomUUID();
  if (!(await requestDeletion(c.env, user.id, receipt)))
    return c.json({ message: "退室してから再認証してください。" }, 409);
  c.executionCtx.waitUntil(processDeletions(c.env));
  const secure = new URL(c.env.APP_ORIGIN).protocol === "https:";
  for (const name of [
    flowCookie,
    challengeCookie,
    `${secure ? "__Secure-" : ""}tetraboard-2026.session_token`,
  ])
    c.header(
      "Set-Cookie",
      `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT${secure ? "; Secure" : ""}`,
      { append: true },
    );
  return c.json({ receipt, status: "processing" }, 202);
});
deletionRoutes.post("/account/deletion/status", async (c) => {
  if (c.req.header("Origin") !== c.env.APP_ORIGIN) return c.body(null, 403);
  const data = await privacyInput(c.req.raw);
  if (typeof data?.receipt !== "string" || !/^([0-9a-f-]{36}){2}$/.test(data.receipt))
    return c.body(null, 400);
  const row = await c.env.APP_DB.prepare(
    "SELECT completed_at_ms FROM deleted_accounts WHERE receipt_hash=?",
  )
    .bind(await digest(data.receipt))
    .first<{ completed_at_ms: number | null }>();
  if (!row) return c.body(null, 404);
  return c.json({ status: row.completed_at_ms === null ? "processing" : "complete" });
});

deletionRoutes.post("/account/deletion/cancel", async (c) => {
  if (c.req.header("Origin") !== c.env.APP_ORIGIN) return c.body(null, 403);
  const flow = cookieValue(c.req.raw, flowCookie),
    challenge = cookieValue(c.req.raw, challengeCookie);
  await c.env.APP_DB.batch([
    c.env.APP_DB.prepare("DELETE FROM deletion_flows WHERE id=?").bind(flow ?? ""),
    c.env.APP_DB.prepare(
      "UPDATE deletion_challenges SET verified_at_ms=NULL,verified_session_id=NULL,oauth_state=NULL WHERE id=?",
    ).bind(challenge ?? ""),
  ]);
  for (const name of [flowCookie, challengeCookie])
    c.header(
      "Set-Cookie",
      `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT${new URL(c.env.APP_ORIGIN).protocol === "https:" ? "; Secure" : ""}`,
      { append: true },
    );
  return c.body(null, 204);
});
