import {
  confirmDeletion,
  readDeletionConfirmation,
  startDeletionChallenge,
  validDeletionReceipt,
} from "@tetraboard/context-privacy";
import { Hono } from "hono";
import { accountIdentity, createAuth, type AuthEnv } from "../adapters/account/auth";
import { startDeletionAuthentication } from "../adapters/privacy/deletionAuthentication";
import { D1DeletionConfirmation } from "../adapters/privacy/deletionConfirmation";
import { challengeCookie, cookieValue, flowCookie } from "../adapters/privacy/deletionCookies";
import { processDeletions } from "../flows/accountPurge/processDeletions";
import { requestDeletion } from "../flows/accountPurge/requestDeletion";
import { privacyInput } from "./privacyInput";

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
  const store = new D1DeletionConfirmation(c.env.APP_DB);
  const result = await startDeletionChallenge(
    store,
    user.id,
    cookieValue(c.req.raw, flowCookie),
    Date.now,
    () => crypto.randomUUID(),
  );
  if (result.status === "wrong_account")
    return c.json(
      {
        message:
          "削除するアカウントと異なるか、手続きの期限が切れています。元のアカウントでログインするか、手続きをやめてから始め直してください。",
      },
      409,
    );
  if (result.status === "rate_limited") return c.json({ message: "1分ほど待ってください。" }, 429);
  if (result.status === "no_provider")
    return c.json({ message: "登録に使用した認証方法を確認できません。" }, 409);
  const { challengeId, flowId, provider } = result;
  const response = await startDeletionAuthentication(c.req.raw, c.env, provider);
  const data = (await response.clone().json()) as { url?: string };
  if (!response.ok || !data.url) return response;
  const state = new URL(data.url).searchParams.get("state");
  if (!state) throw new Error("OAuth state missing");
  await store.rememberOAuthState(challengeId, state);
  const headers = new Headers(response.headers);
  const secure = new URL(c.env.APP_ORIGIN).protocol === "https:" ? "; Secure" : "";
  headers.append(
    "Set-Cookie",
    `${flowCookie}=${flowId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400${secure}`,
  );
  headers.append(
    "Set-Cookie",
    `${challengeCookie}=${challengeId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600${secure}`,
  );
  return new Response(response.body, { status: response.status, headers });
});

deletionRoutes.get("/account/deletion/confirmation", async (c) => {
  const user = await accountIdentity(c.req.raw, c.env);
  if (!user) return c.body(null, 401);
  return c.json(
    await readDeletionConfirmation(
      new D1DeletionConfirmation(c.env.APP_DB),
      user.id,
      cookieValue(c.req.raw, flowCookie) ?? "",
      cookieValue(c.req.raw, challengeCookie) ?? "",
      () => currentSessionId(c.req.raw, c.env),
      Date.now,
    ),
  );
});

deletionRoutes.post("/account/deletion/confirm", async (c) => {
  if (c.req.header("Origin") !== c.env.APP_ORIGIN) return c.body(null, 403);
  const user = await accountIdentity(c.req.raw, c.env);
  if (!user) return c.body(null, 401);
  const db = new D1DeletionConfirmation(c.env.APP_DB);
  const result = await confirmDeletion(
    {
      readFlowAccount: (id, now) => db.readFlowAccount(id, now),
      consumeChallenge: (id, accountId, sessionId, now) =>
        db.consumeChallenge(id, accountId, sessionId, now),
      requestDeletion: (id, receipt) => requestDeletion(c.env, id, receipt),
    },
    {
      accountId: user.id,
      flowId: cookieValue(c.req.raw, flowCookie) ?? "",
      challengeId: cookieValue(c.req.raw, challengeCookie) ?? "",
      confirmed: async () => (await privacyInput(c.req.raw))?.confirm === true,
      sessionId: () => currentSessionId(c.req.raw, c.env),
    },
    Date.now,
    () => crypto.randomUUID() + crypto.randomUUID(),
  );
  if (result.status === "wrong_account")
    return c.json({ message: "削除する本人として手続きを始め直してください。" }, 403);
  if (result.status === "unconfirmed") return c.body(null, 400);
  if (result.status === "unverified") return c.json({ message: "再認証してください。" }, 403);
  if (result.status === "rejected")
    return c.json({ message: "退室してから再認証してください。" }, 409);
  c.executionCtx.waitUntil(processDeletions(c.env));
  const secure = new URL(c.env.APP_ORIGIN).protocol === "https:";
  for (const name of [
    flowCookie,
    challengeCookie,
    `${secure ? "__Secure-" : ""}tetraboard-2026.session_token`,
  ])
    c.header("Set-Cookie", expiredCookie(name, secure), { append: true });
  return c.json({ receipt: result.receipt, status: "processing" }, 202);
});

deletionRoutes.post("/account/deletion/status", async (c) => {
  if (c.req.header("Origin") !== c.env.APP_ORIGIN) return c.body(null, 403);
  const data = await privacyInput(c.req.raw);
  if (!validDeletionReceipt(data?.receipt)) return c.body(null, 400);
  const status = await new D1DeletionConfirmation(c.env.APP_DB).readDeletionStatus(data.receipt);
  if (!status) return c.body(null, 404);
  return c.json({ status });
});

deletionRoutes.post("/account/deletion/cancel", async (c) => {
  if (c.req.header("Origin") !== c.env.APP_ORIGIN) return c.body(null, 403);
  const flow = cookieValue(c.req.raw, flowCookie);
  const challenge = cookieValue(c.req.raw, challengeCookie);
  await new D1DeletionConfirmation(c.env.APP_DB).cancel(flow ?? "", challenge ?? "");
  for (const name of [flowCookie, challengeCookie])
    c.header("Set-Cookie", expiredCookie(name, new URL(c.env.APP_ORIGIN).protocol === "https:"), {
      append: true,
    });
  return c.body(null, 204);
});

async function currentSessionId(request: Request, env: AuthEnv) {
  const session = await createAuth(env).api.getSession({ headers: request.headers });
  return session?.session.id ?? "";
}

function expiredCookie(name: string, secure: boolean) {
  return `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT${secure ? "; Secure" : ""}`;
}
