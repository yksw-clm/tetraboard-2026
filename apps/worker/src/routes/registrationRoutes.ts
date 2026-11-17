import { Hono } from "hono";
import { z } from "zod";
import {
  startRegistrationSchema,
  registrationStatusSchema,
  membershipTokenSchema,
} from "@tetraboard/protocol";
import { MatchClaimError } from "../accounts/matchClaims";
import {
  RegistrationError,
  registrationFromRequest,
  registrationStatus,
} from "../flows/guestRegistration/account";
import { beginAccountRegistration } from "../flows/guestRegistration/startAccount";
import { completeAccountRegistration } from "../flows/guestRegistration/completeAccount";
import { cancelAccountRegistration } from "../flows/guestRegistration/cancelAccount";

export const registrationRoutes = new Hono<{ Bindings: Env }>();
registrationRoutes.use("*", async (c, next) => {
  if (
    !/\/(registrations\/[^/]+(?:\/(?:complete|cancel))?|rooms\/[^/]+\/registration)$/.test(
      new URL(c.req.url).pathname,
    )
  ) {
    await next();
    return;
  }
  c.header("Cache-Control", "no-store");
  if (c.req.method !== "GET" && c.req.header("Origin") !== c.env.APP_ORIGIN)
    return c.json({ error: "unauthorized", message: "操作元を確認できません。" }, 403);
  await next();
});
registrationRoutes.onError((error, c) => {
  if (error instanceof RegistrationError)
    return c.json({ error: error.code, message: error.message }, error.status);
  if (error instanceof MatchClaimError)
    return c.json({ error: error.code, message: "この対局は引き継げません。" }, 409);
  console.error("Registration handoff failed");
  return c.json(
    {
      error: "internal_error",
      message: "登録の引き継ぎを完了できませんでした。もう一度お試しください。",
    },
    503,
  );
});

registrationRoutes.post("/rooms/:roomId/registration", async (c) => {
  const input = startRegistrationSchema.safeParse(await c.req.json().catch(() => null));
  const roomId = c.req.param("roomId");
  const authorization = c.req.header("Authorization");
  const token = membershipTokenSchema.safeParse(
    authorization?.startsWith("Bearer ") ? authorization.slice(7) : null,
  );
  if (!input.success || !/^\d{5}$/.test(roomId))
    throw new RegistrationError("invalid_request", 400, "登録情報が正しくありません。");
  if (!token.success)
    throw new RegistrationError("unauthorized", 401, "参加資格を確認できません。");
  return c.json(
    registrationStatusSchema.parse(
      await beginAccountRegistration(c.req.raw, c.env, roomId, input.data, token.data),
    ),
  );
});
registrationRoutes.get("/registrations/:registrationId", async (c) => {
  const flow = await registrationFromRequest(c.req.raw, c.env, c.req.param("registrationId"));
  return c.json(registrationStatusSchema.parse(await registrationStatus(c.req.raw, c.env, flow)));
});

registrationRoutes.post("/registrations/:registrationId/complete", async (c) => {
  const flow = await registrationFromRequest(c.req.raw, c.env, c.req.param("registrationId"));
  return c.json(
    registrationStatusSchema.parse(await completeAccountRegistration(c.req.raw, c.env, flow)),
  );
});
registrationRoutes.post("/registrations/:registrationId/cancel", async (c) => {
  const flow = await registrationFromRequest(c.req.raw, c.env, c.req.param("registrationId"));
  const body = z
    .object({ signOut: z.boolean().optional() })
    .safeParse(await c.req.json().catch(() => ({})));
  if (!body.success)
    throw new RegistrationError("invalid_request", 400, "中止の指定が正しくありません。");
  const status = await cancelAccountRegistration(
    c.req.raw,
    c.env,
    flow,
    Boolean(body.data.signOut),
    (cookie) => c.header("Set-Cookie", cookie, { append: true }),
  );
  return status ? c.json(registrationStatusSchema.parse(status)) : c.body(null, 204);
});
